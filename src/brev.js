/* Frontendens brevgrensesnitt. Samme dokumenter og kjede i begge modi. */
import * as Økt from "./okt.js";
import { Brevfeil, lesDokument, dokumentnavn } from "./brevdata.mjs";
import { lagBrevtjeneste } from "./brevtjeneste.mjs";
import { byggModellkropp, tolkModellsvar } from "./brev-provider.mjs";
import { trekkUtAnnonse } from "./annonsetekst.mjs";

const I_APP=typeof window!=="undefined" && !!window.__TAURI__;
const tjenestene=new Map();
function bruker(){const id=Økt.nåværendeBruker()?.id;if(!id)throw new Brevfeil("utlogget","Logg inn før du åpner brevet.",401);return id;}
async function invoke(navn,valg={}){
  try{return await window.__TAURI__.core.invoke(navn,valg);}
  catch(e){
    const m=typeof e==="string"?e:e?.message||"Appen kunne ikke fullføre handlingen.";
    const kode=m.split(":",1)[0];
    const kjente={konflikt:"Dokumentet er endret i et annet vindu. Teksten din er beholdt.",opptatt:"Dokumentet er opptatt. Prøv igjen når andre vinduer er lukket.",odelagt:"Dokumentet kan ikke leses. Gjenopprett forrige lagring.",gjenoppretting:"Hovedfilen mangler. Gjenopprett forrige lagring.",avbrutt:"Skrivingen ble avbrutt.",tidsavbrudd:"Modellen svarte ikke innen to minutter.","ingen-kopi":"Fant ingen tidligere lagring å gjenopprette."};
    throw new Brevfeil(kjente[kode]?kode:/^[a-z-]+:/.test(m)?kode:"appfeil",kjente[kode]||m,409);
  }
}
async function http(sti,{method="GET",body,signal}={}){
  const id=bruker();let r;
  try{r=await fetch(sti,{method,signal,credentials:"same-origin",headers:{"Content-Type":"application/json"},...(body!==undefined?{body:JSON.stringify(body)}:{})});}
  catch(e){if(signal?.aborted)throw new Brevfeil("avbrutt","Skrivingen ble avbrutt.");throw new Brevfeil("frakoblet","Fikk ikke kontakt med appen. Teksten din er beholdt.");}
  let j;try{j=await r.json();}catch{}
  if(r.status===401){Økt.meldUtlogget(j?.melding);throw new Brevfeil("utlogget","Logg inn igjen for å fortsette.",401);}
  if(id!==Økt.nåværendeBruker()?.id)throw new Brevfeil("utlogget","Profilen er byttet. Svaret ble forkastet.",401);
  if(!r.ok||!j)throw new Brevfeil(j?.feil||"brevfeil",j?.melding||"Handlingen kunne ikke fullføres.",r.status);
  return j;
}
function lokal(){
  const id=bruker();
  if(!tjenestene.has(id)){
    const sjekk=()=>{if(bruker()!==id)throw new Brevfeil("utlogget","Profilen er byttet.",401);};
    const lager={
      async les(navn){sjekk();const rå=await invoke("brev_les",{bruker:id,navn});sjekk();return lesDokument(navn,rå);},
      async skriv(navn,d,forventet){
        sjekk();dokumentnavn(navn);
        const tekst=JSON.stringify({...d,skjemaVersjon:1,revisjon:forventet+1,oppdatert:new Date().toISOString()});
        const rå=await invoke("brev_skriv",{bruker:id,navn,tekst,forventet});sjekk();return lesDokument(navn,rå);
      },
      async slett(navn,forventet){sjekk();await invoke("brev_slett",{bruker:id,navn,forventet});},
      async liste(){sjekk();return invoke("brev_liste",{bruker:id});},
      async gjenopprett(navn){sjekk();return lesDokument(navn,await invoke("brev_gjenopprett",{bruker:id,navn}));}
    };
    tjenestene.set(id,lagBrevtjeneste({lager,
      hentJobb:async jobbId=>{sjekk();const rå=await invoke("les_tekst",{bruker:id,navn:"jobber.json"});sjekk();return JSON.parse(rå||"{}").jobber?.find(j=>j.id===jobbId);},
      kallModell:async valg=>{
        sjekk();const kjoringId=crypto.randomUUID();
        const av=()=>{invoke("brev_avbryt_modell",{bruker:id,kjoringId}).catch(()=>{});};
        if(valg.signal?.aborted)throw new Brevfeil("avbrutt","Skrivingen ble avbrutt.");
        valg.signal?.addEventListener("abort",av,{once:true});
        try{
          const rå=await invoke("brev_modell",{bruker:id,leverandor:valg.leverandor,kropp:JSON.stringify(byggModellkropp(valg)),kjoringId});
          sjekk();if(valg.signal?.aborted)throw new Brevfeil("avbrutt","Skrivingen ble avbrutt.");
          return tolkModellsvar(valg.leverandor,JSON.parse(rå));
        }finally{valg.signal?.removeEventListener("abort",av);}
      }
    }));
  }
  return tjenestene.get(id);
}
const sti=id=>`/api/jobber/${encodeURIComponent(id)}/brev`;
export const hentCv=()=>I_APP?lokal().hentCv():http("/api/cv");
export const lagreCv=cv=>I_APP?lokal().lagreCv(cv):http("/api/cv",{method:"PUT",body:cv});
export const slettCv=revisjon=>I_APP?lokal().slettCv(revisjon):http("/api/cv",{method:"DELETE",body:{revisjon}});
export const hentBrev=id=>I_APP?lokal().hentBrev(id):http(sti(id));
export const lagreBrev=(id,d)=>I_APP?lokal().lagreBrev(id,d):http(sti(id),{method:"PUT",body:d});
export const slettBrev=(id,revisjon)=>I_APP?lokal().slettBrev(id,revisjon):http(sti(id),{method:"DELETE",body:{revisjon}});
export const eksporterData=()=>I_APP?lokal().eksporter():http("/api/brevdata");
export const importerData=d=>I_APP?lokal().importer(d):http("/api/brevdata",{method:"POST",body:d});
export const gjenopprettCv=()=>I_APP?lokal().gjenopprettCv():http("/api/cv/gjenopprett",{method:"POST"});
export const gjenopprettBrev=id=>I_APP?lokal().gjenopprettBrev(id):http(sti(id)+"/gjenopprett",{method:"POST"});
export async function hentAnnonse(url){
  if(!I_APP)return http("/api/annonsetekst",{method:"POST",body:{url}});
  const id=bruker();const side=await invoke("hent_side",{url});
  if(bruker()!==id)throw new Brevfeil("utlogget","Profilen er byttet.");
  return {tekst:trekkUtAnnonse(side.html),url:side.sluttUrl||url,hentet:new Date().toISOString()};
}
const opprett=async(id,inn,signal)=>I_APP?lokal().opprett(id,inn):(await http(sti(id)+"/kjoringer",{method:"POST",body:inn,signal})).kjoring;
const trinn=(id,kid,trinn,svar,signal)=>I_APP?lokal().trinn(id,kid,trinn,svar,{signal}):http(sti(id)+`/kjoringer/${kid}/trinn`,{method:"POST",body:{trinn,svar},signal});
export const avbryt=(id,kid)=>I_APP?lokal().avbryt(id,kid):http(sti(id)+`/kjoringer/${kid}/avbryt`,{method:"POST",body:{}});
export async function analyser(id,{signal}={}){
  let k;
  try{k=await opprett(id,{},signal);const r=await trinn(id,k.id,"analyse",{},signal);return {id:k.id,analyse:r.kjoring.analyse,dokument:r.dokument};}
  catch(e){if(signal?.aborted&&k)await avbryt(id,k.id).catch(()=>{});throw e;}
}
export async function skriv(id,kid,svar={}, {signal,påTrinn=()=>{}}={}){
  try{
    påTrinn("skriver");await trinn(id,kid,"skriv",svar,signal);
    if(signal?.aborted)throw new Brevfeil("avbrutt","Skrivingen ble avbrutt.");
    påTrinn("kontrollerer");const r=await trinn(id,kid,"kontroller",{},signal);return r.dokument;
  }catch(e){if(signal?.aborted)await avbryt(id,kid).catch(()=>{});throw e;}
}
export async function forbedre(id,instruks,{signal,påTrinn=()=>{}}={}){
  let k;
  try{
    k=await opprett(id,{instruks},signal);
    if(!k.analyse){påTrinn("analyserer");await trinn(id,k.id,"analyse",{},signal);}
    return await skriv(id,k.id,k.svar||{},{signal,påTrinn});
  }catch(e){if(signal?.aborted&&k)await avbryt(id,k.id).catch(()=>{});throw e;}
}
export const nokkelStatus=leverandor=>I_APP?invoke("brev_nokkel_status",{bruker:bruker(),leverandor}):http(`/api/nokler/${leverandor}`);
export const settNokkel=(leverandor,nokkel)=>I_APP?invoke("brev_nokkel_sett",{bruker:bruker(),leverandor,nokkel}):http(`/api/nokler/${leverandor}`,{method:"PUT",body:{nokkel}});
export const slettNokkel=leverandor=>I_APP?invoke("brev_nokkel_slett",{bruker:bruker(),leverandor}):http(`/api/nokler/${leverandor}`,{method:"DELETE"});
