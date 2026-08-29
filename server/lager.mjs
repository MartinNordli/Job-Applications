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

  /* Uforståelig fil flyttes til side i stedet for å bli lest som tom.
     Å starte tomt og så lagre den tomheten ville slettet alt. */
  async function settIKarantene(grunn){
    const merke = new Date().toISOString().replaceAll(":", "-");
    const mål   = path.join(katalog, `jobber.ødelagt-${merke}.json`);
    await fs.rename(sti, mål);
    return { ødelagt: true, sti: mål, grunn, ...(await sikkerhetskopi()) };
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
    catch{ return settIKarantene("Filen er ikke gyldig JSON."); }

    let versjon = 0, liste;
    if(Array.isArray(dok)){
      liste = dok;                                   /* eldre format: bar liste */
    }else if(dok && typeof dok === "object" && Array.isArray(dok.jobber)){
      liste   = dok.jobber;
      versjon = Number.isInteger(dok.versjon) && dok.versjon >= 0 ? dok.versjon : 0;
    }else{
      return settIKarantene("Filen har ikke forventet form.");
    }

    const { gyldige, forkastet } = validerSamling(liste, { lagId });
    const svar = { versjon, jobber: gyldige };
    if(forkastet.length){
      svar.forkastet = forkastet;
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
    }catch(e){
      if(fh) await fh.close().catch(() => {});
      await fs.rm(tmpSti, { force: true });
      throw e;
    }
  }

  async function utfør(jobber, forventetVersjon){
    const nå = await les();
    if(nå.ødelagt) return { ok: false, feil: "ødelagt", sti: nå.sti };

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
    await lagreAtomisk(dok);
    return { ok: true, versjon: dok.versjon, jobber: rader };
  }

  function skriv(jobber, forventetVersjon){
    const oppgave = kø.then(() => utfør(jobber, forventetVersjon));
    kø = oppgave.then(() => {}, () => {});   /* en feilet skriving skal ikke låse køen */
    return oppgave;
  }

  return { les, skriv, katalog, sti, forrigeSti, tmpSti };
}

export default lagLager;
