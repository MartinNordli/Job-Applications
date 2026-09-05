/* ============================================================
   Økt i appmodus — det server/brukere.mjs gjør for nettleseren,
   gjort i webviewet i stedet.

   Appen har ingen server. Registeret ligger i datakatalogen og
   leses over Rust; passordet verifiseres med crypto.subtle mot
   nøyaktig samme hashformat som Node skriver, fordi begge følger
   src/brukerlogikk.mjs. Reglene er delt; det er bare hvem som
   utfører dem som skifter.

   ------------------------------------------------------------
   Hva denne låsen er, og ikke er
   ------------------------------------------------------------

   Den er en profilbytter med hengelås. Passordet sjekkes i
   webviewet, mot data webviewet også kan lese direkte, og en linje
   i konsollen hopper over hele sjekken. Det er ikke en
   sikkerhetsgrense, og skal ikke beskrives som en.

   Derfor er flere av forsvarene fra Node-siden utelatt med vilje,
   ikke glemt:

   * Ingen signert økt. «Økten» er {id, utløper} i localStorage.
     Å HMAC-e den ville vært teater: hemmeligheten måtte ligget i
     en fil webviewet kan lese, så den som kan forfalske økten kan
     også lese nøkkelen den signeres med.
   * Ingen dummy-hash ved ukjent e-post. Den finnes på serveren for
     at svartiden ikke skal røpe hvilke kontoer som finnes — her
     ligger hele registeret åpent i samme prosess.
   * Ingen ratebegrenser. Den beskytter en server mot mange
     forsøk; her er det ett menneske foran én maskin, og PBKDF2 med
     600 000 iterasjoner er selv den bremsen som betyr noe.

   Det som IKKE er utelatt: registeret settes aldri i karantene, en
   fil vi ikke forstår blir liggende urørt, skrivingene går gjennom
   én kø, og migreringen kopierer — den flytter ikke.

   ------------------------------------------------------------
   Svarene
   ------------------------------------------------------------

   Nøyaktig de samme formene som nettlesergrenen i src/okt.js, så
   flaten ikke kan se forskjell. Ingen funksjon kaster.
   ============================================================ */

import {
  ITERASJONER, ALGORITME, SALT_BYTES, NOKKEL_BYTES, ID_BYTES,
  OKT_LEVETID, MAKS_BRUKERE, REGISTERFIL, REGISTER_FORRIGE, NOKKELFIL,
  formaterHash, tolkHash, måHashesPåNytt, likeBytes, tilBytes,
  lagBrukerId, erGyldigBrukerId, offentligBruker,
  validerRegistrering, validerInnlogging, validerPassord,
  validerNokkel, hale, migrerRegister, tomtRegister
} from "./brukerlogikk.mjs";

import { FILNAVN, FORRIGE } from "./lagerlogikk.mjs";
import { LOGGFIL } from "./importlogg.mjs";

/* Nøkkelen økten ligger under i localStorage. Ren ASCII, som
   cookienavnet i nettlesermodus — av vane, ikke av tvang. */
export const ØKTNØKKEL = "jobbsoknader-okt";

/* Samme rekkefølge som MIGRERES i server/brukere.mjs, og av samme
   grunn: datafilen først, fordi den er det som betyr noe, så
   sikkerhetskopien, så loggen, så nøkkelen. Rå tekst, aldri parset.
   Originalen blir liggende urørt — den er sikkerhetskopien vår hvis
   noe her er feil. */
const MIGRERES = [FILNAVN, FORRIGE, LOGGFIL, NOKKELFIL];

/* `filerFor`, `minne`, `nå` og `iterasjoner` kommer utenfra av samme
   grunn som `filer` gjør det i lagerlogikken: alt som rører verden
   skal kunne byttes ut i en test. I drift er filerFor en
   lagTauriFiler-innpakning og minne er window.localStorage. */
export function lagAppØkt({ filerFor, minne, nå = () => new Date(),
                            iterasjoner = ITERASJONER,
                            krypto = globalThis.crypto } = {}){
  if(typeof filerFor !== "function") throw new Error("lagAppØkt trenger filerFor");
  if(!minne) throw new Error("lagAppØkt trenger et minne");

  /* Én filer-instans per katalog. Ikke av hensyn til ytelse, men
     fordi hver av dem har spurt Rust om en sti og svaret ikke endrer
     seg. Bundet av kontotaket. */
  const filerCache = new Map();
  function filer(bruker){
    const nøkkel = bruker ?? "";
    if(!filerCache.has(nøkkel)){
      const løfte = Promise.resolve().then(() => filerFor(bruker ?? null));
      /* En feilet oppstart skal ikke bli permanent: går det galt én
         gang, skal neste forsøk få spørre Rust på nytt. */
      løfte.catch(() => filerCache.delete(nøkkel));
      filerCache.set(nøkkel, løfte);
    }
    return filerCache.get(nøkkel);
  }
  const rot = () => filer(null);

  /* All skriving til registeret serialiseres, som i server/brukere.mjs.
     To knappetrykk i rask rekkefølge skal ikke kunne lese det samme
     registeret og skrive hver sin versjon oppå hverandre. */
  let kø = Promise.resolve();
  function iKø(fn){
    const oppgave = kø.then(fn);
    kø = oppgave.then(() => {}, () => {});      /* en feilet skriving låser ikke køen */
    return oppgave;
  }

  /* ---------- registeret ---------- */

  async function lesRegister(){
    const rå = await (await rot()).lesTekst(REGISTERFIL);
    if(rå == null) return tomtRegister();

    let dok;
    try{ dok = JSON.parse(rå); }
    catch{ return { ødelagt: true, grunn: "Brukerregisteret er ikke gyldig JSON." }; }

    const m = migrerRegister(dok);
    if(!m.ok) return { ødelagt: true, grunn: m.grunn };
    return m.register;
  }

  async function skrivRegister(reg){
    const dok = { versjon: reg.versjon, oppdatert: nå().toISOString(), brukere: reg.brukere };
    await (await rot()).skrivAtomisk(REGISTERFIL, JSON.stringify(dok, null, 2) + "\n",
                                     { kopiTil: REGISTER_FORRIGE });
  }

  /* ---------- passord ---------- */

  const hashNavn = a => (a === "sha512" ? "SHA-512" : "SHA-256");

  async function utled(passord, salt, iter, bytes, algoritme){
    const materiale = await krypto.subtle.importKey(
      "raw", tilBytes(passord), "PBKDF2", false, ["deriveBits"]);
    const bits = await krypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: iter, hash: hashNavn(algoritme) },
      materiale, bytes * 8);
    return new Uint8Array(bits);
  }

  async function hashPassord(passord){
    const salt = krypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const nøkkel = await utled(passord, salt, iterasjoner, NOKKEL_BYTES, ALGORITME);
    return formaterHash({ iterasjoner, salt, nøkkel, algoritme: ALGORITME });
  }

  /* Hashen bærer selv sine parametre, så en konto laget med et annet
     iterasjonstall verifiseres med sitt eget. Sammenlikningen er i
     konstant tid — den koster ingenting, og det finnes ingen god
     grunn til å sammenlikne hemmeligheter på noen annen måte. */
  async function sjekkPassord(passord, hash){
    const h = tolkHash(hash);
    if(!h.ok) return false;
    const utledet = await utled(passord, h.salt, h.iterasjoner, h.nøkkel.length, h.algoritme);
    return likeBytes(utledet, h.nøkkel);
  }

  /* ---------- økten ---------- */
  /*
     {id, utløper} i localStorage, uten signatur. Se hodet: en
     signatur her ville vært teater. Utløpet er en opprydding, ikke
     et forsvar — det er dagen appen slutter å huske deg.
  */
  const nåSekunder = () => Math.floor(nå().getTime() / 1000);

  function lesØkt(){
    let o;
    try{ o = JSON.parse(minne.getItem(ØKTNØKKEL)); }
    catch{ return null; }
    if(!o || typeof o !== "object") return null;
    if(!erGyldigBrukerId(o.id)) return null;
    if(!Number.isInteger(o.utløper) || o.utløper <= nåSekunder()) return null;
    return { id: o.id, utløper: o.utløper };
  }

  function settØkt(id){
    try{ minne.setItem(ØKTNØKKEL, JSON.stringify({ id, utløper: nåSekunder() + OKT_LEVETID })); }
    catch{ /* fullt eller sperret lager: da må man logge inn på nytt neste gang */ }
  }

  function glemØkt(){
    try{ minne.removeItem(ØKTNØKKEL); }catch{ /* samme sak */ }
  }

  /* ---------- nøkkelen ---------- */

  async function lesNokkel(id){
    const t = await (await filer(id)).lesTekst(NOKKELFIL);
    return (typeof t === "string" && t.trim()) || null;
  }

  /* ---------- migreringen ---------- */
  /*
     Rå tekst, kopiert, aldri parset og aldri flyttet — samme fire
     operasjoner og samme rekkefølge som server/brukere.mjs. Filen i
     rota blir liggende bit for bit uendret.
  */
  async function migrerTil(id){
    const fra = await rot();
    const til = await filer(id);
    const flyttet = [];
    for(const navn of MIGRERES){
      const rå = await fra.lesTekst(navn);
      if(rå == null) continue;
      await til.skrivAtomisk(navn, rå);
      flyttet.push(navn);
    }
    return flyttet;
  }

  /* ---------- de utadvendte ---------- */

  const frakoblet = e => ({
    innlogget: false, harBrukere: false, frakoblet: true,
    melding: "Fikk ikke lest profilene fra datakatalogen. " + tekstFra(e)
  });

  async function hentØkt(){
    let reg;
    try{ reg = await lesRegister(); }
    catch(e){ return frakoblet(e); }

    if(reg.ødelagt)
      return { innlogget: false, harBrukere: true, ødelagt: true,
               melding: reg.grunn + " Rett opp " + REGISTERFIL + " før du logger inn." };

    const harBrukere = reg.brukere.length > 0;
    const økt = lesØkt();
    if(!økt) return { innlogget: false, harBrukere };

    const bruker = reg.brukere.find(b => b.id === økt.id);
    /* Profilen er borte, eller økten er utløpt. Da er den ingen økt,
       og den skal ikke ligge igjen og bli forsøkt neste gang. */
    if(!bruker){ glemØkt(); return { innlogget: false, harBrukere }; }

    let harNokkel = false;
    try{ harNokkel = !!(await lesNokkel(bruker.id)); }
    catch{ /* nøkkelen er en opplysning, ikke en betingelse for å være innlogget */ }

    return { innlogget: true, bruker: offentligBruker(bruker),
             erFørste: reg.brukere[0].id === bruker.id, harNokkel };
  }

  /* Hele registreringen ligger i køen: tomhetssjekken, duplikatsjekken,
     hashingen og skrivingen — som på serveren, og av samme grunn. */
  function registrer(inn){
    return iKø(async () => {
      const v = validerRegistrering(inn);
      if(!v.ok) return { ok: false, feil: "ugyldig", detaljer: v.feil, melding: "Se over feltene." };

      let reg;
      try{ reg = await lesRegister(); }
      catch(e){ return feilsvar(e); }

      if(reg.ødelagt)
        return { ok: false, feil: "ødelagt-register", melding: "Brukerregisteret kan ikke leses." };
      if(reg.brukere.length >= MAKS_BRUKERE)
        return { ok: false, feil: "stengt", melding: "Det er ikke plass til flere profiler." };
      if(reg.brukere.some(b => b.epost === v.verdi.epost))
        return { ok: false, feil: "finnes", melding: "Det finnes allerede en profil med den adressen." };

      const først = reg.brukere.length === 0;
      const tid = nå().toISOString();

      let hash, id;
      try{
        hash = await hashPassord(v.verdi.passord);
        do{ id = lagBrukerId(krypto.getRandomValues(new Uint8Array(ID_BYTES))); }
        while(reg.brukere.some(b => b.id === id));
      }catch(e){ return feilsvar(e); }

      const bruker = { id, epost: v.verdi.epost, navn: v.verdi.navn, hash,
                       generasjon: 1, opprettet: tid, sistInnlogget: tid };

      /* Migreringen skjer før registeret skrives. Feiler den, står
         profilen der uten de gamle radene — og originalen er urørt, så
         den kan hentes for hånd. Motsatt rekkefølge kunne gitt en
         migrering uten en profil å migrere til. */
      let migrert = null, migreringsfeil = null;
      if(først){
        try{ migrert = await migrerTil(id); }
        catch(e){ migreringsfeil = tekstFra(e); }
      }

      try{ await skrivRegister({ versjon: reg.versjon, brukere: [...reg.brukere, bruker] }); }
      catch(e){ return feilsvar(e); }

      settØkt(id);
      return { ok: true, bruker: offentligBruker(bruker), erFørste: først,
               ...(migrert && migrert.length ? { migrert } : {}),
               ...(migreringsfeil ? { migreringsfeil } : {}) };
    });
  }

  async function loggInn(inn){
    const v = validerInnlogging(inn);

    let reg;
    try{ reg = await lesRegister(); }
    catch(e){ return feilsvar(e); }
    if(reg.ødelagt)
      return { ok: false, feil: "ødelagt-register", melding: "Brukerregisteret kan ikke leses." };

    const bruker = v.ok ? reg.brukere.find(b => b.epost === v.verdi.epost) : null;
    /* Samme svar for ukjent adresse og feil passord. Her er det ikke
       et forsvar — registeret ligger åpent — men flaten skal si det
       samme i begge modi, og «kontoen finnes ikke» er uansett en
       dårligere beskjed enn «e-post eller passord er feil». */
    if(!bruker || !(await sjekkPassord(v.verdi.passord, bruker.hash).catch(() => false)))
      return { ok: false, feil: "feil-innlogging", melding: "Feil e-postadresse eller passord." };

    settØkt(bruker.id);

    /* Innloggingen som nettopp lyktes er det ene tidspunktet passordet
       finnes i klartekst. Er hashen svakere enn dagens innstilling,
       skrives den om nå — ellers aldri. At det ikke lykkes, skal ikke
       stoppe en innlogging som er i orden. */
    iKø(async () => {
      const fersk = await lesRegister();
      if(fersk.ødelagt) return;
      const i = fersk.brukere.findIndex(b => b.id === bruker.id);
      if(i < 0) return;
      const rad = { ...fersk.brukere[i], sistInnlogget: nå().toISOString() };
      if(måHashesPåNytt(rad.hash)) rad.hash = await hashPassord(v.verdi.passord);
      fersk.brukere[i] = rad;
      await skrivRegister(fersk);
    }).catch(() => { /* sist innlogget er en bekvemmelighet, ikke et krav */ });

    return { ok: true, bruker: offentligBruker(bruker),
             erFørste: reg.brukere[0].id === bruker.id };
  }

  /* `allePlasser` gjør ingenting her, og det er ikke en forglemmelse:
     det finnes bare én plass. Økten ligger i dette webviewets
     localStorage, og den er borte i samme øyeblikk. Å heve
     generasjonen ville ikke felt noe, siden ingen økt bærer den. */
  async function loggUt(){
    glemØkt();
    return { ok: true };
  }

  function byttPassord({ gammelt, nytt } = {}){
    return iKø(async () => {
      const p = validerPassord(nytt);
      if(!p.ok) return { ok: false, feil: "ugyldig",
                         detaljer: [{ felt: "nytt", melding: p.melding }], melding: p.melding };

      const økt = lesØkt();
      if(!økt) return { ok: false, feil: "utlogget", melding: "Du er logget ut. Logg inn på nytt." };

      let reg;
      try{ reg = await lesRegister(); }
      catch(e){ return feilsvar(e); }
      if(reg.ødelagt)
        return { ok: false, feil: "ødelagt-register", melding: "Brukerregisteret kan ikke leses." };

      const i = reg.brukere.findIndex(b => b.id === økt.id);
      if(i < 0) return { ok: false, feil: "utlogget", melding: "Du er logget ut. Logg inn på nytt." };

      if(!(await sjekkPassord(typeof gammelt === "string" ? gammelt : "",
                              reg.brukere[i].hash).catch(() => false)))
        return { ok: false, feil: "feil-passord", melding: "Det gamle passordet stemmer ikke." };

      try{
        /* Generasjonen heves for at registerfilen skal bety det samme
           som i nettlesermodus. Ingenting her verifiserer den — det er
           serveren som kan felle andre økter med den. */
        reg.brukere[i] = { ...reg.brukere[i], hash: await hashPassord(p.verdi),
                           generasjon: reg.brukere[i].generasjon + 1 };
        await skrivRegister(reg);
      }catch(e){ return feilsvar(e); }

      settØkt(reg.brukere[i].id);
      return { ok: true };
    });
  }

  /* ---------- nøkkelen, utad ---------- */

  async function hentNokkel(){
    const økt = lesØkt();
    if(!økt) return utlogget();
    let n;
    try{ n = await lesNokkel(økt.id); }
    catch(e){ return feilsvar(e); }
    if(!n) return { ok: true, finnes: false, kilde: "ingen" };
    const h = hale(n);
    /* Aldri mer enn halen. At webviewet kunne lest hele filen selv er
       sant, og står i src/tauri-filer.mjs — kontrakten utad er
       likevel den samme som serverens. */
    return { ok: true, finnes: true, kilde: "egen", ...(h ? { hale: h } : {}) };
  }

  async function settNokkel(nokkel){
    const økt = lesØkt();
    if(!økt) return utlogget();
    const v = validerNokkel(nokkel);
    if(!v.ok) return { ok: false, feil: "ugyldig", melding: v.melding };
    try{ await (await filer(økt.id)).skrivAtomisk(NOKKELFIL, v.verdi + "\n"); }
    catch(e){ return feilsvar(e); }
    return { ok: true };
  }

  /* Rust har ingen slette-operasjon, og skal ikke få en for dette ene
     tilfellet. En tom fil er ingen nøkkel: les_nokkel i lib.rs nekter
     på nøyaktig samme måte som når filen mangler. Idempotent. */
  async function fjernNokkel(){
    const økt = lesØkt();
    if(!økt) return utlogget();
    try{ await (await filer(økt.id)).skrivAtomisk(NOKKELFIL, ""); }
    catch(e){ return feilsvar(e); }
    return { ok: true };
  }

  return { hentØkt, registrer, loggInn, loggUt, byttPassord,
           hentNokkel, settNokkel, fjernNokkel,
           /* Til lagring.js og import.js, som trenger katalogen til
              den som er innlogget. */
           innloggetId: () => (lesØkt()?.id ?? null) };
}

/* Rust sender feil som strenger over invoke. */
const tekstFra = e => (typeof e === "string" ? e : String(e?.message || e || "Ukjent feil."));

const utlogget = () => ({ ok: false, feil: "utlogget", melding: "Du er logget ut. Logg inn på nytt." });

/* En feil fra filsystemet er ikke en avvisning. Flaten skal si at
   noe er galt med maskinen, ikke med det brukeren skrev. */
const feilsvar = e => ({ ok: false, feil: "frakoblet",
                         melding: "Fikk ikke skrevet til datakatalogen. " + tekstFra(e) });

export default lagAppØkt;
