/* ============================================================
   Fristvarsel over HTTP: innstillingen og runden for nettleseren.

   GET  /api/varsel        → { på, dagerFør }
   PUT  /api/varsel        ← { på, dagerFør }  → 200 med det lagrede
   POST /api/varsel/sjekk  → { varsler: [{ id, dager, tittel, tekst }] }

   Sjekken fører det den returnerer i varslet.json, den samme loggen
   Mac-appens bakgrunnsjobb bruker, så en frist varsles én gang selv
   om både nettleseren og jobben ser den. Reglene står i
   src/fristvarsel.mjs.
   ============================================================ */

import { INNSTILLINGSFIL, LOGGFIL, validerInnstilling, lesInnstilling,
         lesLogg, runde, isoDato } from "../src/fristvarsel.mjs";

export const erVarselbane = bane => bane === "/api/varsel" || bane === "/api/varsel/sjekk";

/* Sjekken leser loggen, regner og skriver den tilbake. To sjekker for
   samme profil samtidig ville begge sett en logg uten varselet og
   begge sendt det, så de går etter hverandre. */
const køer = new Map();
function iKø(nøkkel, fn){
  const oppgave = (køer.get(nøkkel) ?? Promise.resolve()).then(fn);
  const hale = oppgave.then(() => {}, () => {});
  køer.set(nøkkel, hale);
  hale.then(() => { if(køer.get(nøkkel) === hale) køer.delete(nøkkel); });
  return oppgave;
}

async function lesFil(filer, navn){
  try{ return await filer.lesTekst(navn); }catch{ return null; }
}

const utenVersjon = ({ på, dagerFør }) => ({ på, dagerFør });

export function lagVarselRuter({ svar, lesJson, ikkeTillatt, nå = () => new Date() }){
  async function innstilling(req, res, { filer }){
    if(req.method === "GET")
      return svar(res, 200, utenVersjon(lesInnstilling(await lesFil(filer, INNSTILLINGSFIL))));

    if(req.method === "PUT"){
      const inn = await lesJson(req, res);
      if(inn === null) return;
      const v = validerInnstilling(inn);
      if(!v.ok) return svar(res, 400, { feil: "ugyldig", detaljer: v.feil });
      await filer.skrivAtomisk(INNSTILLINGSFIL, JSON.stringify(v.verdi, null, 2) + "\n");
      return svar(res, 200, utenVersjon(v.verdi));
    }

    return ikkeTillatt(res, "GET, PUT");
  }

  async function sjekk(req, res, { lager, filer, katalog }){
    if(req.method !== "POST") return ikkeTillatt(res, "POST");
    const varsler = await iKø(katalog, async () => {
      const data = await lager.les();
      if(!Array.isArray(data.jobber)) return [];
      const tid = nå();
      const logg = lesLogg(await lesFil(filer, LOGGFIL));
      const r = runde({ jobber: data.jobber, iDag: isoDato(tid), logg, nå: tid.toISOString(),
                        innstilling: lesInnstilling(await lesFil(filer, INNSTILLINGSFIL)) });
      /* Ingenting å varsle og ingenting å rydde: filen står urørt. */
      if(r.varsler.length || Object.keys(logg).length !== Object.keys(r.logg).length)
        await filer.skrivAtomisk(LOGGFIL, JSON.stringify(r.logg, null, 2) + "\n");
      return r.varsler;
    });
    return svar(res, 200, { varsler });
  }

  return (req, res, bane, ktx) =>
    bane === "/api/varsel/sjekk" ? sjekk(req, res, ktx) : innstilling(req, res, ktx);
}
