/* ============================================================
   Import — å fylle skjemaet fra en utlysningslenke.

   Én kjede, to transporter. I nettlesermodus gjør serveren hele
   jobben bak /api/importer; i appmodus kjøres de samme reglene fra
   src/importlogikk.mjs her, over Rust. Reglene er de samme filene
   i begge tilfeller — det er bare hentingen som skifter.

   Ingenting herfra lagres. Svaret er et utkast skjemaet fylles med,
   og brukeren trykker selv.
   ============================================================ */

import * as Lagring from "./lagring.js";
import { SEKTOR_FOR } from "./felles.mjs";
import { tolkStrukturert, renskTekst, byggForespørsel,
         tolkModellsvar, slåSammen, sektorForSelskap, manglendeFelt, finnesFraFor } from "./importlogikk.mjs";

/* Feilene flaten skiller på. `navn` er til kode, `message` til folk. */
export class Importfeil extends Error {
  constructor(navn, melding, utkast = null){
    super(melding);
    this.navn = navn;
    this.utkast = utkast;
  }
}

/* Så flaten kan si «Henter utlysningen…» og «Leser annonsen…»
   uten å vite noe om hvordan kjeden er satt sammen. */
export const TRINN = { HENTER: "henter", LESER: "leser" };

export async function importerFraLenke(url, valg = {}){
  const si = valg.påTrinn || (() => {});
  return Lagring.I_APP ? iApp(url, valg, si) : overHttp(url, si);
}

/* ---------- nettlesermodus: serveren gjør jobben ---------- */

async function overHttp(url, si){
  si(TRINN.HENTER);
  let r;
  try{
    r = await fetch("/api/importer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
  }catch{
    throw new Importfeil("frakoblet", "Fikk ikke kontakt med serveren.");
  }

  let j = null;
  try{ j = await r.json(); }catch{ /* faller gjennom til feilen under */ }

  if(r.ok && j?.ok) return { utkast: j.utkast, kilder: j.kilder };
  throw new Importfeil(j?.feil || "ukjent",
                       j?.melding || `Importen feilet (${r.status}).`,
                       j?.utkast || null);
}

/* ---------- appmodus: samme kjede, over Rust ---------- */

async function iApp(url, valg, si){
  const { tauriNett } = await import("./tauri-nett.mjs");

  const fraFor = finnesFraFor(url, valg.jobber || []);
  if(fraFor) throw new Importfeil("finnes",
    `Du har allerede «${fraFor.stilling}» hos ${fraFor.selskap} i listen.`);

  si(TRINN.HENTER);
  let side;
  try{ side = await tauriNett.hentSide(url); }
  catch(e){ throw new Importfeil("henting", tekstFra(e, "Fikk ikke hentet siden.")); }

  const strukturert = tolkStrukturert(side.html);
  const tekst       = renskTekst(side.html);

  const jobber = valg.jobber || [];
  const kjent  = navn => sektorForSelskap(navn, SEKTOR_FOR, jobber);
  strukturert.sektor = kjent(strukturert.selskap);

  const manglende = manglendeFelt(strukturert);

  let modell = null;
  if(manglende.length && tekst.length > 40){
    si(TRINN.LESER);
    try{ modell = tolkModellsvar(await tauriNett.spørModell(byggForespørsel(tekst, manglende))); }
    catch(e){
      const m = tekstFra(e, "Fikk ikke kontakt med modellen.");
      throw new Importfeil(/nøkkel/i.test(m) ? "mangler-nokkel" : "modell", m);
    }
  }
  if(strukturert.sektor && modell) modell.sektor = null;

  const { utkast, kilder } = slåSammen(strukturert, modell, url);

  const fraSelskap = kjent(utkast.selskap);
  if(fraSelskap){ utkast.sektor = fraSelskap; kilder.sektor = "selskap"; }

  if(!utkast.selskap && !utkast.stilling)
    throw new Importfeil("tomt",
      "Fant ingenting å lese på den siden. Den er kanskje bygget med JavaScript.", utkast);

  return { utkast, kilder };
}

/* Rust sender feil som strenger over invoke. */
const tekstFra = (e, reserve) =>
  typeof e === "string" ? e : String(e?.message || e || reserve);
