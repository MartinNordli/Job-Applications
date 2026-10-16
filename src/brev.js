/* Frontendens brevgrensesnitt. Samme dokumenter og kjede i begge modi. */
import * as Økt from "./okt.js";
import { Brevfeil } from "./brevdata.mjs";
import { I_APP, bruker, invoke, http, lokaltLager } from "./dokumentklient.js";
import { lagBrevtjeneste } from "./brevtjeneste.mjs";
import { lagJobbdokumenter } from "./jobbdokumenttjeneste.mjs";
import { byggModellkropp, tolkModellsvar } from "./brev-provider.mjs";
import { delSse, lagSvarsamler, lagFeltstrøm } from "./brev-strom.mjs";
import { FASE } from "./brevlogikk.mjs";

const MAKS_STRØM=32*1024*1024;
const tjenestene=new Map();
/* Trinn-endepunktet svarer alltid text/event-stream. Kontrakten er: én
   fase-hendelse først, så null eller flere deltaer, så nøyaktig én avsluttende
   hendelse. En strøm som slutter uten avslutning er et transportbrudd. */
async function strøm(sti,{body,signal,påFase,påDelta}){
  const id=bruker();let r;
  try{r=await fetch(sti,{method:"POST",signal,credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});}
  catch{if(signal?.aborted)throw new Brevfeil("avbrutt","Skrivingen ble avbrutt.");throw new Brevfeil("frakoblet","Fikk ikke kontakt med appen. Teksten din er beholdt.");}
  if(r.status===401){let j;try{j=await r.json();}catch{}Økt.meldUtlogget(j?.melding);throw new Brevfeil("utlogget","Logg inn igjen for å fortsette.",401);}
  if(!r.headers.get("content-type")?.startsWith("text/event-stream")||!r.body){
    let j;try{j=await r.json();}catch{}
    throw new Brevfeil(j?.feil||"brevfeil",j?.melding||"Handlingen kunne ikke fullføres.",r.status);
  }
  const del=delSse(),leser=r.body.getReader(),koder=new TextDecoder();
  let slutt=null,lest=0;
  try{
    for(;;){
      const bit=await leser.read();if(bit.done)break;
      lest+=bit.value.byteLength;
      if(lest>MAKS_STRØM)throw new Brevfeil("brevfeil","Svaret ble uventet stort. Teksten din er beholdt.");
      for(const ramme of del(koder.decode(bit.value,{stream:true}))){
        let d;try{d=JSON.parse(ramme.data);}catch{continue;}
        if(ramme.hendelse==="fase")påFase?.(d);
        else if(ramme.hendelse==="delta"){if(typeof d.tekst==="string")påDelta?.(d.tekst,{trinn:d.trinn});}
        else if(ramme.hendelse==="ferdig"||ramme.hendelse==="feil"){slutt={hendelse:ramme.hendelse,data:d};break;}
      }
      if(slutt)break;
    }
  }catch(e){
    if(e instanceof Brevfeil)throw e;
    if(signal?.aborted)throw new Brevfeil("avbrutt","Skrivingen ble avbrutt.");
    throw new Brevfeil("frakoblet","Fikk ikke kontakt med appen. Teksten din er beholdt.");
  }finally{leser.cancel().catch(()=>{});}
  if(id!==Økt.nåværendeBruker()?.id)throw new Brevfeil("utlogget","Profilen er byttet. Svaret ble forkastet.",401);
  if(!slutt)throw new Brevfeil("frakoblet","Fikk ikke kontakt med appen. Teksten din er beholdt.");
  if(slutt.hendelse==="feil")throw new Brevfeil(slutt.data?.feil||"brevfeil",slutt.data?.melding||"Handlingen kunne ikke fullføres.",slutt.data?.status||400);
  return slutt.data;
}

/* Ingen tilbakekalling skal fyre etter avbrudd eller etter at promisen har
   satt seg: flaten ville da tegnet tekst som ikke lenger er sann. Vakten står
   her og ikke bare i flaten, så alle kallsteder og begge modi arver den. */
function vakt(signal,{påFase,påDelta}={}){
  let stengt=false;
  const åpen=()=>!stengt&&!signal?.aborted;
  return {
    steng(){stengt=true;},
    // En feil i mottakerens tegning skal ikke rive brevet den tegner.
    fase(d){if(åpen())try{påFase?.(d);}catch{}},
    delta(tekst,om){if(åpen())try{påDelta?.(tekst,om);}catch{}}
  };
}

/* Rust videresender hele SSE-linjer og kjenner ingen leverandørformater.
   Kanalen mater bare forhåndsvisningen. Svaret settes sammen fra kroppen
   kommandoen returnerer, så en tapt eller sen kanalmelding kan aldri endre
   brevet: det er den samme regelen som gjelder over HTTP. */
function settSammen(leverandor,sse){
  const del=delSse(),samler=lagSvarsamler(leverandor);
  for(const ramme of del(String(sse??""))) samler.ta(ramme);
  const svar=samler.svar();
  if(!svar)throw new Brevfeil("modellformat","Modellen svarte i feil format.",502);
  return svar;
}
function forhåndsvisning(valg){
  const Kanal=window.__TAURI__?.core?.Channel;
  if(typeof valg.påDelta!=="function"||!valg.felt||!Kanal)return {};
  const del=delSse(),samler=lagSvarsamler(valg.leverandor),feltstrøm=lagFeltstrøm(valg.felt);
  const kanal=new Kanal(melding=>{
    if(valg.signal?.aborted)return;
    try{
      for(const linje of melding?.linjer||[]){
        // Rust sender linjer uten linjeskift. Rammedeleren trenger dem tilbake.
        for(const ramme of del(linje+"\n")){
          const tillegg=samler.ta(ramme);
          if(!tillegg)continue;
          const dekodet=feltstrøm.ta(tillegg);
          if(dekodet&&!valg.signal?.aborted)valg.påDelta(dekodet);
        }
      }
    }catch{} // En halv forhåndsvisning skal aldri rive kallet den viser.
  });
  return {kanal};
}

/* Modellkallet over Rust for én profil. Brevtjenesten og vurderingen av
   hvor godt stillingen passer bruker det samme, så nøkkelen, avbrytingen
   og profilvernet står bare her. */
export function lokalKallModell(id,sjekk){
  return async valg=>{
    sjekk();const kjoringId=crypto.randomUUID();
    const av=()=>{invoke("brev_avbryt_modell",{bruker:id,kjoringId}).catch(()=>{});};
    if(valg.signal?.aborted)throw new Brevfeil("avbrutt","Skrivingen ble avbrutt.");
    valg.signal?.addEventListener("abort",av,{once:true});
    try{
      const rå=await invoke("brev_modell",{bruker:id,leverandor:valg.leverandor,
        kropp:JSON.stringify(byggModellkropp(valg)),kjoringId,...forhåndsvisning(valg)});
      sjekk();if(valg.signal?.aborted)throw new Brevfeil("avbrutt","Skrivingen ble avbrutt.");
      return tolkModellsvar(valg.leverandor,settSammen(valg.leverandor,rå));
    }finally{valg.signal?.removeEventListener("abort",av);}
  };
}
function lokal(){
  const id=bruker();
  if(!tjenestene.has(id)){
    const {lager,hentJobb,hentJobber,hentSide,sjekk}=lokaltLager(id);
    // Med hentSide kan brevet hente en annonse som mangler, fra søknadens lenke.
    tjenestene.set(id,lagBrevtjeneste({lager,hentJobb,kallModell:lokalKallModell(id,sjekk),
      jobbdokumenter:lagJobbdokumenter({lager,hentJobb,hentJobber,hentSide})}));
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
/* Stilreferansen: et brev brukeren selv har skrevet, som nye brev skal
   ligne i tone og form. Ett per profil, i stil.json. */
export const hentStil=()=>I_APP?lokal().hentStil():http("/api/stil");
export const lagreStil=d=>I_APP?lokal().lagreStil(d):http("/api/stil",{method:"PUT",body:d});
export const slettStil=revisjon=>I_APP?lokal().slettStil(revisjon):http("/api/stil",{method:"DELETE",body:{revisjon}});
export const gjenopprettStil=()=>I_APP?lokal().gjenopprettStil():http("/api/stil/gjenopprett",{method:"POST"});
/* Oppretter kjøringen. Mangler annonsen, henter tjenesten den først fra
   søknadens lenke, så dette kan ta noen sekunder. */
const opprett=async(id,inn,signal)=>I_APP?lokal().opprett(id,inn,{signal}):(await http(sti(id)+"/kjoringer",{method:"POST",body:inn,signal})).kjoring;
/* Det ene trinnet, «skriv». Fasehendelsen eies av transporten på begge
   sider. Over HTTP sender serveren den; i appen er det ingen strøm foran
   oss, så den lages her. Begge veier gjelder det samme: fase alltid
   først, også når kjøringen allerede er ferdig. */
function skriv(id,kid,{signal,melder}){
  if(!I_APP) return strøm(sti(id)+`/kjoringer/${kid}/trinn`,{body:{trinn:"skriv"},signal,
    påFase:d=>melder.fase(d),påDelta:(tekst,om)=>melder.delta(tekst,om)});
  melder.fase({trinn:"skriv",fase:FASE.skriv,nullstill:true});
  return lokal().trinn(id,kid,"skriv",{signal,påDelta:tekst=>melder.delta(tekst,{trinn:"skriv"})});
}
export const avbryt=(id,kid)=>I_APP?lokal().avbryt(id,kid):http(sti(id)+`/kjoringer/${kid}/avbryt`,{method:"POST",body:{}});
/* Skriv utkast: ett modellkall, med kodekontroll etterpå. Fasen kommer i
   påFase ({trinn, fase, nullstill}) og teksten underveis i påDelta
   (tekst, {trinn}). Svaret er det ferdige brevdokumentet. */
async function kjør(id,inn,{signal,...meldinger}){
  const v=vakt(signal,meldinger);
  let k;
  try{
    k=await opprett(id,inn,signal);
    if(signal?.aborted)throw new Brevfeil("avbrutt","Skrivingen ble avbrutt.");
    return (await skriv(id,k.id,{signal,melder:v})).dokument;
  }catch(e){if(signal?.aborted&&k)await avbryt(id,k.id).catch(()=>{});throw e;}
  finally{v.steng();}
}
export const lagUtkast=(id,valg={})=>kjør(id,{},valg);
/* Lag ny versjon ut fra teksten som står nå og brukerens instruks. */
export const forbedre=(id,instruks,valg={})=>kjør(id,{instruks},valg);
export const nokkelStatus=leverandor=>I_APP?invoke("brev_nokkel_status",{bruker:bruker(),leverandor}):http(`/api/nokler/${leverandor}`);
export const settNokkel=(leverandor,nokkel)=>I_APP?invoke("brev_nokkel_sett",{bruker:bruker(),leverandor,nokkel}):http(`/api/nokler/${leverandor}`,{method:"PUT",body:{nokkel}});
export const slettNokkel=leverandor=>I_APP?invoke("brev_nokkel_slett",{bruker:bruker(),leverandor}):http(`/api/nokler/${leverandor}`,{method:"DELETE"});
