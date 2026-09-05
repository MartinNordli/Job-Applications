/* ============================================================
   Brukere (Node) — registeret, øktene og lagrene under dem.

   Reglene ligger i src/brukerlogikk.mjs, delt med nettleseren og
   appmodus. Her er det som trenger et filsystem og node:crypto:
   registerfilen med sin egen skrivekø, hemmeligheten øktene
   signeres med, PBKDF2, ratebegrenserne, migreringen av den gamle
   enbrukerfilen, og cachen av lagerinstanser.

   Fire avgjørelser det er verdt å kjenne til:

   * Registeret settes ALDRI i karantene automatisk, slik datafilen
     blir. Det bærer passordhashene: mister vi det, er brukeren låst
     ute av sine egne søknader for godt. En fil vi ikke forstår blir
     liggende, og alt som trenger registeret nekter å svare.

   * Skrivekøen ligger her, som i lagerlogikken, og av samme grunn.
     Hele registreringen — «er registeret tomt», hashingen, sjekken
     mot duplikat e-post og selve skrivingen — skjer inne i køen.
     Ellers kan to samtidige registreringer begge tro at de er først.

   * crypto.pbkdf2, aldri pbkdf2Sync. 600 000 iterasjoner tar
     200–400 ms, og synkront ville det blokkert hele hendelsesløkken.
     Den asynkrone kjører på libuvs trådpulje, som deles med fs —
     derfor er ratebegrenseren på innlogging ikke valgfri.

   * Ukjent e-post og feil passord gir samme svar og samme tidsbruk.
     Ved ukjent e-post kjøres et ekte PBKDF2-kall mot en fast
     dummy-hash, så svartiden ikke røper hvilke kontoer som finnes.
   ============================================================ */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { lagFiler, lagLager as lagJobblager } from "./lager.mjs";
import { FILNAVN, FORRIGE } from "../src/lagerlogikk.mjs";
import { LOGGFIL } from "../src/importlogg.mjs";
import { NOKKELFIL } from "./nokkel.mjs";
import {
  ITERASJONER, ALGORITME, SALT_BYTES, NOKKEL_BYTES, ID_BYTES, OKT_LEVETID,
  MAKS, formaterHash, tolkHash, måHashesPåNytt, lagBrukerId, erGyldigBrukerId,
  validerRegistrering, validerInnlogging, validerPassord, offentligBruker,
  migrerRegister, tomtRegister, tilBase64url, fraBase64url,
  lagNyttelast, kodNyttelast, tolkNyttelast, delToken, erUtløpt,
  REGISTERFIL, REGISTER_FORRIGE, BRUKERKATALOG, MAKS_BRUKERE
} from "../src/brukerlogikk.mjs";

const pbkdf2 = promisify(crypto.pbkdf2);

/* Filnavnene er delt med appmodus og ligger i src/brukerlogikk.mjs.
   Hemmeligheten er ikke: appmodus signerer ingen økt, fordi
   webviewet kunne lest hemmeligheten selv. */
export { REGISTERFIL, REGISTER_FORRIGE, BRUKERKATALOG } from "../src/brukerlogikk.mjs";
export const HEMMELIGHETSFIL  = "okthemmelighet.txt";

/* ASCII, fordi et cookienavn er et RFC 6265-token. Filnavn og
   JS-identifikatorer kan gjerne ha ø; dette kan ikke. */
export const COOKIE = "okt";

/* Hardt tak på antall kontoer; taket binder også lagercachen under.
   Tallet er en regel og ligger i src/brukerlogikk.mjs, der appmodus
   når det. */
export { MAKS_BRUKERE } from "../src/brukerlogikk.mjs";

/* ---------- cookier ---------- */

/* Ingen Secure. Appen kjører http på loopback, og Secure ville gjort
   cookien ubrukelig — nettleseren ville nektet å sende den tilbake.
   Bevisst avveining, ikke en forglemmelse.

   Ingen egen CSRF-token heller. SameSite=Strict gjør at cookien ikke
   følger med en forespørsel utløst fra et annet nettsted, og
   Host/Origin-sjekken øverst i serveren avviser resten. En token i
   tillegg ville vært to mekanismer for samme hull, og den som legger
   den til senere «for sikkerhets skyld» bør lese dette først. */
export function byggØktcookie(token, maksAlder = OKT_LEVETID){
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maksAlder}`;
}

export function byggSlettcookie(){
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/* Cookie-hodet er ubundet utenfra, så det leses med tak. Vi ser bare
   etter ett navn og bryr oss ikke om resten. */
const MAKS_COOKIEHODE = 8 * 1024;

export function tolkCookies(hode){
  const ut = Object.create(null);
  if(typeof hode !== "string" || !hode || hode.length > MAKS_COOKIEHODE) return ut;
  for(const bit of hode.split(";")){
    const i = bit.indexOf("=");
    if(i < 1) continue;
    const navn = bit.slice(0, i).trim();
    if(!navn || Object.hasOwn(ut, navn)) continue;      /* første vinner */
    ut[navn] = bit.slice(i + 1).trim();
  }
  return ut;
}

/* ---------- ratebegrenser ---------- */
/*
   Et skyvevindu per nøkkel. Kartet er bundet: uten et tak er selve
   begrenseren en måte å bruke opp minnet på, som er samme angrep en
   etasje ned. Eldste nøkkel faller ut når taket nås.
*/
export function lagRatebegrenser({ tak, vindu, maksNøkler = 500 }){
  const kart = new Map();

  const friske = (nøkkel, nå) => {
    const t = (kart.get(nøkkel) ?? []).filter(x => nå - x < vindu);
    if(t.length) kart.set(nøkkel, t); else kart.delete(nøkkel);
    return t;
  };

  return {
    /* Teller ikke opp — spør bare om det er plass. */
    sjekk(nøkkel, nå = Date.now()){
      const t = friske(nøkkel, nå);
      if(t.length < tak) return { ok: true };
      return { ok: false, retryEtter: Math.max(1, Math.ceil((vindu - (nå - t[0])) / 1000)) };
    },
    tell(nøkkel, nå = Date.now()){
      const t = friske(nøkkel, nå);
      t.push(nå);
      kart.delete(nøkkel);
      kart.set(nøkkel, t);                       /* nyeste bakerst i innsettingsrekkefølgen */
      while(kart.size > maksNøkler) kart.delete(kart.keys().next().value);
    },
    nullstill(nøkkel){ kart.delete(nøkkel); },
    get størrelse(){ return kart.size; }
  };
}

/* ---------- lageret ---------- */

/* `nå` og `iterasjoner` injiseres av samme grunn som `filer` gjør det i
   lagerlogikken: testene skal kunne styre klokken og slippe å bruke et
   halvt sekund på hvert eneste PBKDF2-kall. I drift står de på sine
   ekte verdier, og en hash skrevet med et lavere tall blir uansett
   skrevet om ved neste innlogging — det er det måHashesPåNytt er til. */
export function lagBrukere({ katalog, nå = () => new Date(),
                             iterasjoner = ITERASJONER } = {}){
  if(!katalog) throw new Error("lagBrukere trenger en katalog");

  const rotFiler = lagFiler(katalog);

  /* All skriving til registeret serialiseres her. Egen kø, atskilt
     fra lagerlogikkens: de to filene har ingenting med hverandre. */
  let kø = Promise.resolve();
  function iKø(fn){
    const oppgave = kø.then(fn);
    kø = oppgave.then(() => {}, () => {});       /* en feilet skriving låser ikke køen */
    return oppgave;
  }

  /* ---------- hemmeligheten ---------- */

  let hemmeligLøfte = null;

  async function hemmelighet(){
    if(!hemmeligLøfte){
      hemmeligLøfte = lesEllerLagHemmelighet();
      /* En feilet lesing skal ikke bli permanent: fikser brukeren
         filen, skal neste forespørsel få prøve på nytt. */
      hemmeligLøfte.catch(() => { hemmeligLøfte = null; });
    }
    return hemmeligLøfte;
  }

  async function lesEllerLagHemmelighet(){
    const sti = path.join(katalog, HEMMELIGHETSFIL);
    const les = async () => {
      try{ return (await fs.readFile(sti, "utf8")).trim(); }
      catch(e){ if(e.code === "ENOENT") return null; throw e; }
    };

    const finnes = await les();
    if(finnes){
      if(!/^[0-9a-f]{64}$/.test(finnes))
        throw new Error(`${HEMMELIGHETSFIL} har ikke forventet form.`);
      return Buffer.from(finnes, "hex");
    }

    await fs.mkdir(katalog, { recursive: true });
    const ny = crypto.randomBytes(32).toString("hex");
    let fh = null;
    try{
      /* «wx» og modus i samme kall: filen opprettes bare hvis den ikke
         finnes, og den er 0600 fra første byte. To servere som starter
         samtidig kan ikke skrive hver sin hemmelighet oppå hverandre. */
      fh = await fs.open(sti, "wx", 0o600);
      await fh.writeFile(ny + "\n", "utf8");
      await fh.sync();
      return Buffer.from(ny, "hex");
    }catch(e){
      if(e.code !== "EEXIST") throw e;
      const igjen = await les();
      if(!igjen || !/^[0-9a-f]{64}$/.test(igjen))
        throw new Error(`${HEMMELIGHETSFIL} har ikke forventet form.`);
      return Buffer.from(igjen, "hex");
    }finally{
      if(fh) await fh.close().catch(() => {});
    }
  }

  /* ---------- registeret ---------- */

  const registerSti = rotFiler.stiTil(REGISTERFIL);

  async function lesRegister(){
    const rå = await rotFiler.lesTekst(REGISTERFIL);
    if(rå == null) return tomtRegister();

    let dok;
    try{ dok = JSON.parse(rå); }
    catch{ return { ødelagt: true, grunn: "Brukerregisteret er ikke gyldig JSON.", sti: registerSti }; }

    const m = migrerRegister(dok);
    if(!m.ok) return { ødelagt: true, grunn: m.grunn, sti: registerSti };
    return m.register;
  }

  /* Kalles bare inne i køen. Modus 0600 på tempfilen: registeret
     bærer passordhasher og skal aldri ligge lesbart for andre. */
  async function skrivRegister(reg){
    const dok = {
      versjon: reg.versjon,
      oppdatert: nå().toISOString(),
      brukere: reg.brukere
    };
    await rotFiler.skrivAtomisk(REGISTERFIL, JSON.stringify(dok, null, 2) + "\n",
                                { kopiTil: REGISTER_FORRIGE, modus: 0o600 });
  }

  /* ---------- passord ---------- */

  async function hashPassord(passord, salt = crypto.randomBytes(SALT_BYTES)){
    const nøkkel = await pbkdf2(Buffer.from(passord, "utf8"), salt, iterasjoner, NOKKEL_BYTES, ALGORITME);
    return formaterHash({ iterasjoner, salt, nøkkel, algoritme: ALGORITME });
  }

  async function sjekkPassord(passord, hash){
    const h = tolkHash(hash);
    if(!h.ok) return false;
    const utledet = await pbkdf2(Buffer.from(passord, "utf8"), Buffer.from(h.salt),
                                 h.iterasjoner, h.nøkkel.length, h.algoritme);
    const fasit = Buffer.from(h.nøkkel);
    return utledet.length === fasit.length && crypto.timingSafeEqual(utledet, fasit);
  }

  /* Fast hash med tilfeldig innhold: den kan aldri stemme, men å
     verifisere mot den koster nøyaktig ett PBKDF2-kall. Det er hele
     poenget — ukjent e-post skal ta like lang tid som feil passord. */
  const DUMMYHASH = formaterHash({
    iterasjoner,
    salt: crypto.randomBytes(SALT_BYTES),
    nøkkel: crypto.randomBytes(NOKKEL_BYTES),
    algoritme: ALGORITME
  });

  /* ---------- øktene ---------- */

  async function signer(kropp){
    const h = await hemmelighet();
    return tilBase64url(crypto.createHmac("sha256", h).update(kropp).digest());
  }

  async function lagToken(bruker, tid = nå()){
    const utstedt = Math.floor(tid.getTime() / 1000);
    const kropp = kodNyttelast(lagNyttelast({ id: bruker.id, generasjon: bruker.generasjon, utstedt }));
    return `${kropp}.${await signer(kropp)}`;
  }

  /* Alle fire må stemme: signatur, utløp, generasjon, og at brukeren
     finnes. Rekkefølgen er billigst først, men ingen av dem er
     valgfrie — en gyldig signatur på en slettet bruker er ingen økt. */
  async function verifiserToken(token){
    const delt = delToken(token);
    if(!delt) return null;

    const fikk = fraBase64url(delt.signatur);
    if(!fikk) return null;
    const ventet = crypto.createHmac("sha256", await hemmelighet()).update(delt.kropp).digest();
    if(fikk.length !== ventet.length) return null;
    if(!crypto.timingSafeEqual(Buffer.from(fikk), ventet)) return null;

    const n = tolkNyttelast(delt.kropp);
    if(!n) return null;
    if(erUtløpt(n, Math.floor(nå().getTime() / 1000))) return null;

    const reg = await lesRegister();
    if(reg.ødelagt) return null;
    const bruker = reg.brukere.find(b => b.id === n.b);
    if(!bruker || bruker.generasjon !== n.g) return null;

    return { bruker, erFørste: reg.brukere[0]?.id === bruker.id, nyttelast: n };
  }

  /* ---------- lagerinstanser ---------- */
  /*
     Skrivekøen ligger i closuren i lagerlogikk.mjs. To instanser for
     samme bruker gir to køer, og da kan to samtidige lagringer flette
     seg inn i hverandre eller tape hverandre. Derfor: én instans per
     bruker-id, cachet.

     Cachen er bundet av kontotaket — bare id-er som har passert
     verifiserToken havner her, og registeret kan ikke ha flere enn
     MAKS_BRUKERE rader. Utkastingen under er et belte i tillegg til
     de bukseselene, og den rører aldri en instans som har en skriving
     i lufta: det ville vært å kaste bort køen vi nettopp beskyttet.
  */
  const lagre = new Map();

  function lagerFor(id){
    if(!erGyldigBrukerId(id)) throw new Error("ugyldig bruker-id");

    let e = lagre.get(id);
    if(e){
      lagre.delete(id); lagre.set(id, e);        /* sist brukt bakerst */
      return e;
    }

    const egenKatalog = path.join(katalog, BRUKERKATALOG, id);
    const filer  = lagFiler(egenKatalog);
    const indre  = lagJobblager({ katalog: egenKatalog });

    let ivente = 0;
    const lager = {
      ...indre,
      skriv(...a){
        ivente++;
        const p = indre.skriv(...a);
        const ferdig = () => { ivente--; };
        p.then(ferdig, ferdig);
        return p;
      }
    };

    e = { id, katalog: egenKatalog, filer, lager, get ledig(){ return ivente === 0; } };
    lagre.set(id, e);

    while(lagre.size > MAKS_BRUKERE){
      const offer = [...lagre.values()].find(x => x !== e && x.ledig);
      if(!offer) break;                          /* alle er opptatt — vent heller enn å tape en skriving */
      lagre.delete(offer.id);
    }
    return e;
  }

  /* ---------- migrering av enbrukerfilen ---------- */
  /*
     Rå tekst, kopiert, aldri parset og aldri flyttet. Originalen skal
     være bit for bit uendret etterpå: den er sikkerhetskopien vår hvis
     noe her er feil. Rekkefølgen er datafilen først — den er det som
     betyr noe — så sikkerhetskopien, så loggen, så nøkkelen. En
     halvferdig migrering skal aldri etterlate operatøren uten nøkkel,
     derfor kopi og ikke flytting også der.
  */
  const MIGRERES = [
    { fra: FILNAVN, til: FILNAVN },
    { fra: FORRIGE, til: FORRIGE },
    { fra: LOGGFIL, til: LOGGFIL },
    { fra: NOKKELFIL, til: NOKKELFIL, modus: 0o600 }
  ];

  async function migrerTil(id){
    const { filer } = lagerFor(id);
    const flyttet = [];
    for(const f of MIGRERES){
      const rå = await rotFiler.lesTekst(f.fra);
      if(rå == null) continue;
      await filer.skrivAtomisk(f.til, rå, f.modus ? { modus: f.modus } : {});
      flyttet.push(f.til);
    }
    return flyttet;
  }

  /* ---------- de utadvendte operasjonene ---------- */

  async function status(){
    const reg = await lesRegister();
    if(reg.ødelagt) return { ødelagt: true, grunn: reg.grunn };
    return { harBrukere: reg.brukere.length > 0, antall: reg.brukere.length };
  }

  async function erFørste(id){
    const reg = await lesRegister();
    if(reg.ødelagt) return false;
    return reg.brukere[0]?.id === id;
  }

  /* Hele registreringen ligger i køen: tomhetssjekken, duplikatsjekken,
     hashingen og skrivingen. To samtidige registreringer kan da ikke
     begge tro at de er først — og bare én av dem migrerer. */
  function registrer(inn){
    return iKø(async () => {
      const v = validerRegistrering(inn);
      if(!v.ok) return { ok: false, feil: "ugyldig", detaljer: v.feil };

      const reg = await lesRegister();
      if(reg.ødelagt) return { ok: false, feil: "ødelagt-register", grunn: reg.grunn };

      if(reg.brukere.length >= MAKS_BRUKERE)
        return { ok: false, feil: "stengt" };
      if(reg.brukere.some(b => b.epost === v.verdi.epost))
        return { ok: false, feil: "finnes" };

      const først = reg.brukere.length === 0;
      const hash  = await hashPassord(v.verdi.passord);
      const tid   = nå().toISOString();

      let id;
      do{ id = lagBrukerId(crypto.randomBytes(ID_BYTES)); }
      while(reg.brukere.some(b => b.id === id));

      const bruker = { id, epost: v.verdi.epost, navn: v.verdi.navn, hash,
                       generasjon: 1, opprettet: tid, sistInnlogget: tid };

      /* Migreringen skjer før registeret skrives. Feiler den, står
         kontoen der uten de gamle radene — og originalen er urørt, så
         den kan hentes for hånd. Motsatt rekkefølge kunne gitt en
         migrering uten en konto å migrere til. */
      let migrert = null, migreringsfeil = null;
      if(først){
        try{ migrert = await migrerTil(id); }
        catch(e){ migreringsfeil = String(e?.message || e); }
      }

      await skrivRegister({ versjon: reg.versjon, brukere: [...reg.brukere, bruker] });

      return { ok: true, bruker, erFørste: først, token: await lagToken(bruker),
               ...(migrert && migrert.length ? { migrert } : {}),
               ...(migreringsfeil ? { migreringsfeil } : {}) };
    });
  }

  /* Ett svar, én tidsbruk. Ukjent e-post går gjennom nøyaktig samme
     PBKDF2-kall som feil passord, mot en hash som aldri kan stemme. */
  async function loggInn(inn){
    const v = validerInnlogging(inn);
    const reg = await lesRegister();
    if(reg.ødelagt) return { ok: false, feil: "ødelagt-register", grunn: reg.grunn };

    const bruker = v.ok ? reg.brukere.find(b => b.epost === v.verdi.epost) : null;
    const passord = v.ok ? v.verdi.passord : "";
    const treff = await sjekkPassord(passord, bruker ? bruker.hash : DUMMYHASH);

    if(!bruker || !treff) return { ok: false, feil: "feil-innlogging" };

    /* Innloggingen som nettopp lyktes er det ene tidspunktet passordet
       finnes i klartekst. Er hashen svakere enn dagens innstilling,
       skrives den om nå — ellers aldri. */
    const oppdatert = { ...bruker, sistInnlogget: nå().toISOString() };
    if(måHashesPåNytt(bruker.hash)) oppdatert.hash = await hashPassord(passord);

    await iKø(async () => {
      const fersk = await lesRegister();
      if(fersk.ødelagt) return;
      const i = fersk.brukere.findIndex(b => b.id === bruker.id);
      if(i < 0) return;
      /* Generasjonen kan ha blitt hevet mens vi hashet. Da er det den
         ferske som gjelder — vi skal ikke gjenopplive en tilbakekalt økt. */
      fersk.brukere[i] = { ...fersk.brukere[i],
                           hash: oppdatert.hash,
                           sistInnlogget: oppdatert.sistInnlogget };
      await skrivRegister(fersk);
      oppdatert.generasjon = fersk.brukere[i].generasjon;
    }).catch(() => { /* sist innlogget er en bekvemmelighet, ikke et krav */ });

    return { ok: true, bruker: oppdatert,
             erFørste: reg.brukere[0]?.id === bruker.id,
             token: await lagToken(oppdatert) };
  }

  /* Én økt kan ikke tilbakekalles, alle kan. Å heve generasjonen gjør
     hvert utstedte token ugyldig i samme øyeblikk — det er prisen for
     å slippe en øktfil på disk, og den betales her. */
  function loggUtAlle(id){
    return iKø(async () => {
      const reg = await lesRegister();
      if(reg.ødelagt) return { ok: false, feil: "ødelagt-register" };
      const i = reg.brukere.findIndex(b => b.id === id);
      if(i < 0) return { ok: false, feil: "ukjent" };
      reg.brukere[i] = { ...reg.brukere[i], generasjon: reg.brukere[i].generasjon + 1 };
      await skrivRegister(reg);
      return { ok: true, bruker: reg.brukere[i] };
    });
  }

  /* Passordbytte hever generasjonen: alle andre økter faller, og den
     som byttet får en ny cookie i samme svar. */
  function byttPassord(id, gammelt, nytt){
    return iKø(async () => {
      const p = validerPassord(nytt);
      if(!p.ok) return { ok: false, feil: "ugyldig", detaljer: [{ felt: "nytt", melding: p.melding }] };

      const reg = await lesRegister();
      if(reg.ødelagt) return { ok: false, feil: "ødelagt-register" };
      const i = reg.brukere.findIndex(b => b.id === id);
      if(i < 0) return { ok: false, feil: "ukjent" };

      if(!(await sjekkPassord(typeof gammelt === "string" ? gammelt : "", reg.brukere[i].hash)))
        return { ok: false, feil: "feil-passord" };

      const oppdatert = { ...reg.brukere[i],
                          hash: await hashPassord(p.verdi),
                          generasjon: reg.brukere[i].generasjon + 1 };
      reg.brukere[i] = oppdatert;
      await skrivRegister(reg);
      return { ok: true, bruker: oppdatert, token: await lagToken(oppdatert) };
    });
  }

  return {
    katalog,
    rotFiler,
    registerSti,
    status, erFørste, lesRegister,
    registrer, loggInn, loggUtAlle, byttPassord,
    lagToken, verifiserToken,
    lagerFor,
    /* Bare til tester og feilsøking — aldri til et svar. */
    _hemmelighet: hemmelighet,
    get antallLagre(){ return lagre.size; }
  };
}

export { offentligBruker };
export default lagBrukere;
