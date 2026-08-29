/* ============================================================
   Lager — lesing og skriving av data/jobber.json.

   Filen er den eneste kopien av dataene. Derfor tre regler:
   aldri overskrive noe vi ikke forstår, alltid bytte filen
   atomisk, og la all skriving gå gjennom én kø slik at to
   samtidige lagringer ikke fletter seg inn i hverandre.
   ============================================================ */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validerSamling } from "../src/felles.mjs";

const FILNAVN      = "jobber.json";
const FORRIGE      = "jobber.forrige.json";
const MIDLERTIDIG  = ".jobber.json.tmp";

const lagId = () => randomUUID();

/* Feltene som avgjør om en rad faktisk er endret. Tidsstemplene
   teller ikke med — ellers ville hver lagring sett ut som en endring. */
const INNHOLD = ["id", "selskap", "stilling", "lenke", "sted",
                 "frist", "status", "sektor", "notat", "sendtDato"];

const likeRader = (a, b) => !!a && !!b && INNHOLD.every(f => a[f] === b[f]);

export function lagLager(valg = {}){
  const katalog    = valg.katalog ?? path.join(process.cwd(), "data");
  const sti        = path.join(katalog, FILNAVN);
  const forrigeSti = path.join(katalog, FORRIGE);
  const tmpSti     = path.join(katalog, MIDLERTIDIG);

  let kø = Promise.resolve();      /* all skriving serialiseres her */

  /* En uforståelig fil blir liggende. Å flytte den bort under lesing
     ville etterlatt katalogen tom, og da ville neste lagring blitt
     godtatt og skrevet over sikkerhetskopien. Filen ryddes først når
     brukeren har valgt hva som skal skje — se gjenopprett(). */
  async function meldOdelagt(grunn){
    return { ødelagt: true, sti, grunn, ...(await sikkerhetskopi()) };
  }

  async function settIKarantene(){
    const merke = new Date().toISOString().replaceAll(":", "-");
    const mål   = path.join(katalog, `jobber.ødelagt-${merke}.json`);
    await fs.rename(sti, mål);
    return mål;
  }

  /* Er hovedfilen borte, men sikkerhetskopien der, skal den tilbys før
     noe annet. Ellers ser en karantene ut som en tom app, og det neste
     lagringen gjør er å bekrefte tomheten. */
  async function sikkerhetskopi(){
    try{
      const rå  = await fs.readFile(forrigeSti, "utf8");
      const dok = JSON.parse(rå);
      const liste = Array.isArray(dok) ? dok
                  : (dok && Array.isArray(dok.jobber) ? dok.jobber : null);
      if(!liste) return {};
      const { gyldige } = validerSamling(liste, { lagId });
      if(!gyldige.length) return {};
      return { sikkerhetskopi: { jobber: gyldige, oppdatert: (dok && dok.oppdatert) || null } };
    }catch{ return {}; }
  }

  async function les(){
    let rå;
    try{ rå = await fs.readFile(sti, "utf8"); }
    catch(e){
      if(e.code === "ENOENT") return { tom: true, versjon: 0, jobber: null, ...(await sikkerhetskopi()) };
      throw e;
    }

    let dok;
    try{ dok = JSON.parse(rå); }
    catch{ return meldOdelagt("Filen er ikke gyldig JSON."); }

    let versjon = 0, liste;
    if(Array.isArray(dok)){
      liste = dok;                                   /* eldre format: bar liste */
    }else if(dok && typeof dok === "object" && Array.isArray(dok.jobber)){
      liste   = dok.jobber;
      versjon = Number.isInteger(dok.versjon) && dok.versjon >= 0 ? dok.versjon : 0;
    }else{
      return meldOdelagt("Filen har ikke forventet form.");
    }

    const { gyldige, forkastet } = validerSamling(liste, { lagId });
    const svar = { versjon, jobber: gyldige };
    if(forkastet.length){
      svar.forkastet = forkastet;
      /* Rådataene tas vare på og skrives tilbake urørt, ellers ville
         første lagring slettet en rad brukeren selv har skrevet inn. */
      svar.ugyldige = forkastet.map(f => liste[f.indeks]).filter(r => r !== undefined);
      svar.advarsel  = forkastet.length === 1
        ? "Én rad i datafilen var ugyldig og ble hoppet over."
        : `${forkastet.length} rader i datafilen var ugyldige og ble hoppet over.`;
    }
    return svar;
  }

  async function lagreAtomisk(dok){
    await fs.mkdir(katalog, { recursive: true });

    /* Kopi av forrige gode fil før vi bytter den ut. */
    try{ await fs.copyFile(sti, forrigeSti); }
    catch(e){ if(e.code !== "ENOENT") throw e; }

    const tekst = JSON.stringify(dok, null, 2) + "\n";
    let fh = null;
    try{
      fh = await fs.open(tmpSti, "w");
      await fh.writeFile(tekst, "utf8");
      await fh.sync();          /* uten fsync kan et strømbrudd gi en tom fil */
      await fh.close();
      fh = null;
      await fs.rename(tmpSti, sti);
      /* Innholdet er synket, men selve navnebyttet ligger i katalogen. */
      const kh = await fs.open(katalog, "r");
      await kh.sync().catch(() => {});     /* ikke støttet overalt */
      await kh.close();
    }catch(e){
      if(fh) await fh.close().catch(() => {});
      await fs.rm(tmpSti, { force: true });
      throw e;
    }
  }

  async function utfør(jobber, forventetVersjon, valg2 = {}){
    let nå = await les();

    if(nå.ødelagt){
      /* Bare et bevisst valg fra brukeren får rydde bort en fil vi ikke
         forstår — og da flyttes den til side, aldri over. */
      if(!valg2.overstyrOdelagt) return { ok: false, feil: "ødelagt", sti: nå.sti };
      const karantene = await settIKarantene();
      nå = { versjon: 0, jobber: [], karantene };
      forventetVersjon = undefined;
    }

    const versjon = nå.versjon;
    if(typeof forventetVersjon === "number" && forventetVersjon !== versjon)
      return { ok: false, feil: "konflikt", versjon, jobber: nå.jobber ?? [] };

    const { gyldige, forkastet } = validerSamling(jobber, { lagId });
    if(forkastet.length) return { ok: false, feil: "ugyldig", detaljer: forkastet };

    /* Tidsstempler settes av serveren; klientens verdier er ikke til å stole på. */
    const før = new Map((nå.jobber ?? []).map(r => [r.id, r]));
    const tid = new Date().toISOString();
    const rader = gyldige.map(rad => {
      const gammel = før.get(rad.id);
      if(!gammel)               return { ...rad, opprettet: tid, oppdatert: tid };
      if(likeRader(gammel, rad)) return { ...rad, opprettet: gammel.opprettet ?? tid,
                                                  oppdatert: gammel.oppdatert ?? tid };
      return { ...rad, opprettet: gammel.opprettet ?? tid, oppdatert: tid };
    });

    const dok = { versjon: versjon + 1, oppdatert: tid, jobber: rader };
    /* Rader vi ikke forsto ved lesing skrives tilbake urørt. De vises
       ikke i appen, men de skal heller ikke forsvinne fordi noen
       lagret noe annet. */
    if(nå.ugyldige && nå.ugyldige.length) dok.ugyldige = nå.ugyldige;

    await lagreAtomisk(dok);
    return { ok: true, versjon: dok.versjon, jobber: rader,
             ...(nå.karantene ? { karantene: nå.karantene } : {}) };
  }

  function skriv(jobber, forventetVersjon, valg2){
    const oppgave = kø.then(() => utfør(jobber, forventetVersjon, valg2));
    kø = oppgave.then(() => {}, () => {});   /* en feilet skriving skal ikke låse køen */
    return oppgave;
  }

  return { les, skriv, katalog, sti, forrigeSti, tmpSti };
}

export default lagLager;
