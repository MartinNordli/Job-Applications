/* ============================================================
   Frontendens vei til jobb-<id>.json. Samme dokumenter og regler i
   begge modi: i appen kjører tjenesten her, over Rust-lageret; i
   nettleseren kjører den samme tjenesten på serveren.

   hent(id)          dokumentet, eller et tomt dokument med revisjon 0
   lagre(id, dok)    skriver annonsen; dok.revisjon må være den som ble
                     hentet, ellers Brevfeil med code "konflikt" (409)
                     og ingenting skrevet. match og forberedelser
                     beholdes fra det lagrede dokumentet.
   gjenopprett(id)   legger forrige lagring tilbake og flytter den
                     gjeldende filen til side
   utdrag(stier)     { "jobb-<id>.json": { "match.prosent": 82, ... } }
                     for alle søknadene, se src/dokumentutdrag.mjs
   ============================================================ */
import { I_APP, bruker, http, lokaltLager } from "./dokumentklient.js";
import { lagJobbdokumenter } from "./jobbdokumenttjeneste.mjs";
import { tolkStier } from "./dokumentutdrag.mjs";

const tjenestene=new Map();
function lokal(){
  const id=bruker();
  if(!tjenestene.has(id)){
    const {lager,hentJobb}=lokaltLager(id);
    tjenestene.set(id,lagJobbdokumenter({lager,hentJobb}));
  }
  return tjenestene.get(id);
}
const sti=id=>`/api/jobber/${encodeURIComponent(id)}/dokument`;

export const hent=id=>I_APP?lokal().hent(id):http(sti(id));
export const lagre=(id,dok)=>I_APP?lokal().lagre(id,dok):http(sti(id),{method:"PUT",body:dok});
export const gjenopprett=id=>I_APP?lokal().gjenopprett(id):http(sti(id)+"/gjenopprett",{method:"POST"});
/* Stiene sjekkes her også, så en feil i kallet viser seg likt i begge
   modi i stedet for som en 400 i den ene og en Rust-feil i den andre. */
export function utdrag(stier){
  const felt=tolkStier(stier);
  return I_APP?lokal().utdrag(felt):http(`/api/jobbdokumenter/utdrag?stier=${encodeURIComponent(felt.join(","))}`);
}
