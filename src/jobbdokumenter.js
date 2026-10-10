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

   Annonsen. Alle skriver bare annonsen, gjennom tjenestens endre(), og
   gir tilbake hele dokumentet med ny revisjon:

   annonseFor(id)              annonsen { tekst, url, kilde, hentet,
                               sjekksum }. Ligger den bare i brevet,
                               flyttes den over én gang med kilde "brev".
   hentAnnonse(id)             henter fra søknadens lenke, kilde "hentet".
                               Feilkoder: mangler-lenke, dod-lenke,
                               ikke-nettside, tom-annonse, for-lang,
                               henting, for-mange (bare i nettleseren)
   limInnAnnonse(id, tekst)    kilde "limt"
   lagreAnnonse(id, annonse)   { tekst, url?, kilde: "import"|"limt",
                               hentet? }, det importen bruker
   vurderMatch(id, {tving?})   vurderer hvor godt stillingen passer CV-en
                               og gir dokumentet med dok.match. Feilkoder:
                               mangler-cv, mangler-annonse, mangler-nokkel,
                               for-mange (bare i nettleseren)
   hentManglendeAnnonser({ider?})
                               henter alt som mangler, én om gangen, og
                               gir { hentet, fraBrev, hadde, utenLenke,
                               feilet, gjenstar, stoppet }
   ============================================================ */
import { I_APP, bruker, http, lokaltLager } from "./dokumentklient.js";
import { lagJobbdokumenter } from "./jobbdokumenttjeneste.mjs";
import { tolkStier } from "./dokumentutdrag.mjs";
import { lagMatchtjeneste } from "./matchtjeneste.mjs";
import { lokalKallModell } from "./brev.js";

const tjenestene=new Map();
function lokal(){
  const id=bruker();
  if(!tjenestene.has(id)){
    const {lager,hentJobb,hentJobber,hentSide}=lokaltLager(id);
    tjenestene.set(id,lagJobbdokumenter({lager,hentJobb,hentJobber,hentSide}));
  }
  return tjenestene.get(id);
}
/* Vurderingen går over modellkallet i Rust i appen, og over serveren i
   nettleseren, der taket på 60 i timen gjelder. */
const matchtjenestene=new Map();
function lokalMatch(){
  const id=bruker();
  if(!matchtjenestene.has(id)){
    const {lager,hentJobb,sjekk}=lokaltLager(id);
    matchtjenestene.set(id,lagMatchtjeneste({lager,jobbdokumenter:lokal(),hentJobb,kallModell:lokalKallModell(id,sjekk)}));
  }
  return matchtjenestene.get(id);
}
/* Leverandøren brukeren sist valgte i brevskriveren, ellers Anthropic. */
function valgtLeverandør(){
  try{return window.localStorage.getItem(`jobbsoknader-brev-leverandor-${bruker()}`)==="openai"?"openai":"anthropic";}
  catch{return "anthropic";}
}
const sti=id=>`/api/jobber/${encodeURIComponent(id)}/dokument`;
const asti=id=>`/api/jobber/${encodeURIComponent(id)}/annonse`;

export const hent=id=>I_APP?lokal().hent(id):http(sti(id));
export const lagre=(id,dok)=>I_APP?lokal().lagre(id,dok):http(sti(id),{method:"PUT",body:dok});
export const gjenopprett=id=>I_APP?lokal().gjenopprett(id):http(sti(id)+"/gjenopprett",{method:"POST"});
/* Stiene sjekkes her også, så en feil i kallet viser seg likt i begge
   modi i stedet for som en 400 i den ene og en Rust-feil i den andre. */
export function utdrag(stier){
  const felt=tolkStier(stier);
  return I_APP?lokal().utdrag(felt):http(`/api/jobbdokumenter/utdrag?stier=${encodeURIComponent(felt.join(","))}`);
}

export const annonseFor=id=>I_APP?lokal().annonseFor(id):http(asti(id));
export const hentAnnonse=id=>I_APP?lokal().hentAnnonse(id):http(asti(id)+"/hent",{method:"POST"});
export const lagreAnnonse=(id,annonse)=>I_APP?lokal().settAnnonse(id,annonse):http(asti(id),{method:"PUT",body:annonse});
export const limInnAnnonse=(id,tekst)=>lagreAnnonse(id,{tekst,kilde:"limt"});
/* Taket på 30 i timen gjelder bare i nettleseren, der serveren kan ha
   flere profiler. I appen er det ingen andre å dele nettet med. */
export const hentManglendeAnnonser=({ider}={})=>I_APP?lokal().hentManglende({ider})
  :http("/api/jobbdokumenter/hent-manglende",{method:"POST",body:ider?{ider}:{}});

/* Gir hele jobbdokumentet med den nye vurderingen. Uendret grunnlag
   gir den lagrede vurderingen uten nytt kall, med mindre tving er satt. */
export const vurderMatch=(id,{tving=false}={})=>{
  const leverandor=valgtLeverandør();
  return I_APP?lokalMatch().vurder(id,{tving,leverandor})
    :http(`/api/jobber/${encodeURIComponent(id)}/match`,{method:"POST",body:{tving,leverandor}});
};
