import { I_APP, bruker, http, lokaltLager } from "../dokumenter/dokumentklient.js";
import { lagJobbdokumenter } from "./jobbdokumenttjeneste.mjs";
import { tolkStier } from "../dokumenter/dokumentutdrag.mjs";
import { lagMatchtjeneste } from "./matchtjeneste.mjs";
import { lagForberedelsetjeneste } from "../intervju/forberedelsetjeneste.mjs";
import { lokalKallModell, hentCv } from "../brev/brev.js";
import { MATCH_PROMPTVERSJON } from "./matchlogikk.mjs";
import { matchUtdatert } from "./jobbdokument.mjs";

const tjenestene=new Map();
function lokal(){
  const id=bruker();
  if(!tjenestene.has(id)){
    const {lager,hentJobb,hentJobber,hentSide}=lokaltLager(id);
    tjenestene.set(id,lagJobbdokumenter({lager,hentJobb,hentJobber,hentSide}));
  }
  return tjenestene.get(id);
}
const matchtjenestene=new Map();
function lokalMatch(){
  const id=bruker();
  if(!matchtjenestene.has(id)){
    const {lager,hentJobb,sjekk}=lokaltLager(id);
    matchtjenestene.set(id,lagMatchtjeneste({lager,jobbdokumenter:lokal(),hentJobb,kallModell:lokalKallModell(id,sjekk)}));
  }
  return matchtjenestene.get(id);
}
const forberedelsetjenestene=new Map();
function lokalForberedelse(){
  const id=bruker();
  if(!forberedelsetjenestene.has(id)){
    const {lager,hentJobb,sjekk}=lokaltLager(id);
    forberedelsetjenestene.set(id,lagForberedelsetjeneste({lager,jobbdokumenter:lokal(),hentJobb,kallModell:lokalKallModell(id,sjekk)}));
  }
  return forberedelsetjenestene.get(id);
}
export function valgtLeverandør(){
  try{return window.localStorage.getItem(`jobbsoknader-brev-leverandor-${bruker()}`)==="openai"?"openai":"anthropic";}
  catch{return "anthropic";}
}
const sti=id=>`/api/jobber/${encodeURIComponent(id)}/dokument`;
const asti=id=>`/api/jobber/${encodeURIComponent(id)}/annonse`;

export const hent=id=>I_APP?lokal().hent(id):http(sti(id));
export const lagre=(id,dok)=>I_APP?lokal().lagre(id,dok):http(sti(id),{method:"PUT",body:dok});
export const gjenopprett=id=>I_APP?lokal().gjenopprett(id):http(sti(id)+"/gjenopprett",{method:"POST"});
export function utdrag(stier){
  const felt=tolkStier(stier);
  return I_APP?lokal().utdrag(felt):http(`/api/jobbdokumenter/utdrag?stier=${encodeURIComponent(felt.join(","))}`);
}

export const annonseFor=id=>I_APP?lokal().annonseFor(id):http(asti(id));
export const hentAnnonse=async id=>{const d=await(I_APP?lokal().hentAnnonse(id):http(asti(id)+"/hent",{method:"POST"}));meld(id);return d;};
export const lagreAnnonse=async(id,annonse)=>{const d=await(I_APP?lokal().settAnnonse(id,annonse):http(asti(id),{method:"PUT",body:annonse}));meld(id);return d;};
export const limInnAnnonse=(id,tekst)=>lagreAnnonse(id,{tekst,kilde:"limt"});
export const hentManglendeAnnonser=({ider}={})=>I_APP?lokal().hentManglende({ider})
  :http("/api/jobbdokumenter/hent-manglende",{method:"POST",body:ider?{ider}:{}});

const lyttere=new Set();
export function påMatchEndring(fn){lyttere.add(fn);return ()=>lyttere.delete(fn);}
const meld=id=>{for(const fn of lyttere){try{fn(id);}catch{}}};

export const vurderMatch=async(id,{tving=false}={})=>{
  const leverandor=valgtLeverandør();
  const dok=await(I_APP?lokalMatch().vurder(id,{tving,leverandor})
    :http(`/api/jobber/${encodeURIComponent(id)}/match`,{method:"POST",body:{tving,leverandor}}));
  meld(id);
  return dok;
};
const fsti=(id,iid)=>`/api/jobber/${encodeURIComponent(id)}/intervjuer/${encodeURIComponent(iid)}/forberedelse`;
export const lagForberedelse=(id,iid,{tving=false}={})=>{
  const leverandor=valgtLeverandør();
  return I_APP?lokalForberedelse().lag(id,iid,{tving,leverandor}):http(fsti(id,iid),{method:"POST",body:{tving,leverandor}});
};
export const slettForberedelse=(id,iid)=>I_APP?lokalForberedelse().slett(id,iid):http(fsti(id,iid),{method:"DELETE"});

export const vurderIBakgrunnen=id=>vurderMatch(id).catch(()=>null);

export async function matchGrunnlag(){
  const cv=await hentCv();
  return {cvRevisjon:cv.revisjon,promptversjon:MATCH_PROMPTVERSJON};
}
export async function matchMerker(){
  const [u,g]=await Promise.all([
    utdrag(["match.prosent","match.cvRevisjon","match.annonseSjekksum","match.promptversjon","annonse.sjekksum"]),
    matchGrunnlag()]);
  const ut={};
  for(const [fil,v] of Object.entries(u)){
    if(typeof v["match.prosent"]!=="number")continue;
    const dok={match:{cvRevisjon:v["match.cvRevisjon"]??null,annonseSjekksum:v["match.annonseSjekksum"]??null,promptversjon:v["match.promptversjon"]??null},
      annonse:{sjekksum:v["annonse.sjekksum"]??null}};
    ut[fil.slice(5,-5)]={prosent:v["match.prosent"],utdatert:matchUtdatert(dok,g)};
  }
  return ut;
}
