/* ============================================================
   Utdrag: noen få små verdier fra mange dokumenter på én gang.

   Listen vil vise et match-merke og om annonsen er lagret på hver
   rad. Å hente 150 hele dokumenter over HTTP eller IPC for det,
   med annonser på opptil 100 000 tegn hver, er å flytte megabyte
   for å vise et tall. Utdraget leser filene der de ligger og sender
   bare stiene som ble bedt om.

   Reglene er de samme i Node (her) og i Rust (dokument_utdrag i
   src-tauri/src/brev.rs), og testdata/dokumenter.json holder dem
   like:

     - En sti er 1 til 4 ledd skilt med punktum, hvert ledd
       [A-Za-z0-9_]{1,40}. Høyst 20 stier. Ledd som kan peke inn i en
       prototype avvises.
     - Bare egne nøkler følges, aldri arv.
     - Bare enkle verdier sendes: tekst, tall, sannhetsverdi og null.
       Et objekt eller en liste på stien gir ingen nøkkel i svaret.
     - Tekst kortes til 300 kodepunkter. Et utdrag er ikke stedet å
       lese annonsen.
     - Et dokument som ikke kan leses, er for stort eller har et
       skjema vi ikke kjenner, hoppes over. Det er listen som ber, og
       én skadet fil skal ikke ta merkene fra alle de andre. Feilen
       viser seg når dokumentet åpnes.
   ============================================================ */

import { Brevfeil } from "./dokumentfeil.mjs";

export const MAKS_STIER = 20;
/* Taket på listen før duplikatene er fjernet. */
const MAKS_RÅ_STIER = 100;
export const MAKS_UTDRAGSTEKST = 300;
const LEDD = /^[A-Za-z0-9_]{1,40}$/;
const FARLIGE = new Set(["__proto__", "constructor", "prototype"]);

export function gyldigSti(sti){
  if(typeof sti !== "string") return false;
  const ledd = sti.split(".");
  return ledd.length >= 1 && ledd.length <= 4 && ledd.every(l => LEDD.test(l) && !FARLIGE.has(l));
}

/* Tar en kommaliste eller en liste. Kaster ved første ugyldige sti:
   å svare med færre stier enn det ble bedt om, ville sett ut som at
   verdiene manglet i dokumentene. */
export function tolkStier(inn){
  const liste = Array.isArray(inn) ? inn : typeof inn === "string" ? inn.split(",") : null;
  if(!liste || liste.length > MAKS_RÅ_STIER) throw new Brevfeil("ugyldig", "Oppgi hvilke felt utdraget skal ha.");
  const stier = [...new Set(liste.map(s => typeof s === "string" ? s.trim() : s))];
  if(!stier.length || stier.length > MAKS_STIER || !stier.every(gyldigSti))
    throw new Brevfeil("ugyldig", `Utdraget kan ha 1 til ${MAKS_STIER} felt, skrevet som for eksempel match.prosent.`);
  return stier;
}

function enkel(v){
  if(v === null || typeof v === "boolean") return { ok: true, v };
  if(typeof v === "number") return { ok: Number.isFinite(v), v };
  if(typeof v === "string"){
    const tegn = Array.from(v);
    return { ok: true, v: tegn.length > MAKS_UTDRAGSTEKST ? tegn.slice(0, MAKS_UTDRAGSTEKST).join("") : v };
  }
  return { ok: false };
}

/* Utdraget av ett dokument. Stiene må allerede være tolket. */
export function utdragAv(dok, stier){
  const ut = {};
  for(const sti of stier){
    let v = dok, funnet = true;
    for(const ledd of sti.split(".")){
      if(!v || typeof v !== "object" || Array.isArray(v) || !Object.hasOwn(v, ledd)){ funnet = false; break; }
      v = v[ledd];
    }
    if(!funnet) continue;
    const e = enkel(v);
    if(e.ok) ut[sti] = e.v;
  }
  return ut;
}
