/* Frontendens brevgrensesnitt. Samme dokumenter og kjede i begge modi. */
import * as Økt from "./okt.js";
import { Brevfeil, lesDokument, dokumentnavn } from "./brevdata.mjs";
import { lagBrevtjeneste } from "./brevtjeneste.mjs";
import { byggModellkropp, tolkModellsvar } from "./brev-provider.mjs";
import { delSse, lagSvarsamler, lagFeltstrøm } from "./brev-strom.mjs";
import { FASE } from "./brevlogikk.mjs";
import { trekkUtAnnonse } from "./annonsetekst.mjs";

const I_APP=typeof window!=="undefined" && !!window.__TAURI__;
const MAKS_STRØM=32*1024*1024;
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
   her og ikke bare i flaten, så alle kallsteder og begge modi arver den.
   påTrinn er bakoverkompatibel og kalles med fasenavnet på nøyaktig samme
   steder som før; den finnes bare inntil flaten bygger mot påFase. */
function vakt(signal,{påFase,påDelta,påTrinn}={}){
  let stengt=false;
  const åpen=()=>!stengt&&!signal?.aborted;
  return {
    steng(){stengt=true;},
    // En feil i mottakerens tegning skal ikke rive brevet den tegner.
    fase(d){if(åpen())try{påFase?.(d);påTrinn?.(d.fase);}catch{}},
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
          const rå=await invoke("brev_modell",{bruker:id,leverandor:valg.leverandor,
            kropp:JSON.stringify(byggModellkropp(valg)),kjoringId,...forhåndsvisning(valg)});
          sjekk();if(valg.signal?.aborted)throw new Brevfeil("avbrutt","Skrivingen ble avbrutt.");
          return tolkModellsvar(valg.leverandor,settSammen(valg.leverandor,rå));
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
/* Fasehendelsen eies av transporten på begge sider. Over HTTP sender serveren
   den; i appen er det ingen strøm foran oss, så den lages her. Begge veier
   gjelder det samme: fase alltid først, også når trinnet gjenopptas. */
function trinn(id,kid,trinnnavn,svar,{signal,vakt}){
  if(!I_APP) return strøm(sti(id)+`/kjoringer/${kid}/trinn`,{body:{trinn:trinnnavn,svar},signal,
    påFase:d=>vakt.fase(d),påDelta:(tekst,om)=>vakt.delta(tekst,om)});
  vakt.fase({trinn:trinnnavn,fase:FASE[trinnnavn],nullstill:true});
  return lokal().trinn(id,kid,trinnnavn,svar,{signal,påDelta:tekst=>vakt.delta(tekst,{trinn:trinnnavn})});
}
export const avbryt=(id,kid)=>I_APP?lokal().avbryt(id,kid):http(sti(id)+`/kjoringer/${kid}/avbryt`,{method:"POST",body:{}});
export async function analyser(id,{signal,...meldinger}={}){
  const v=vakt(signal,meldinger);
  let k;
  try{k=await opprett(id,{},signal);const r=await trinn(id,k.id,"analyse",{},{signal,vakt:v});return {id:k.id,analyse:r.kjoring.analyse,dokument:r.dokument};}
  catch(e){if(signal?.aborted&&k)await avbryt(id,k.id).catch(()=>{});throw e;}
  finally{v.steng();}
}
export async function skriv(id,kid,svar={}, {signal,...meldinger}={}){
  const v=vakt(signal,meldinger);
  try{
    await trinn(id,kid,"skriv",svar,{signal,vakt:v});
    if(signal?.aborted)throw new Brevfeil("avbrutt","Skrivingen ble avbrutt.");
    const r=await trinn(id,kid,"kontroller",{},{signal,vakt:v});return r.dokument;
  }catch(e){if(signal?.aborted)await avbryt(id,kid).catch(()=>{});throw e;}
  finally{v.steng();}
}
export async function forbedre(id,instruks,{signal,...meldinger}={}){
  const v=vakt(signal,meldinger);
  let k;
  try{
    k=await opprett(id,{instruks},signal);
    if(!k.analyse)await trinn(id,k.id,"analyse",{},{signal,vakt:v});
    return await skriv(id,k.id,k.svar||{},{signal,...meldinger});
  }catch(e){if(signal?.aborted&&k)await avbryt(id,k.id).catch(()=>{});throw e;}
  finally{v.steng();}
}
export const nokkelStatus=leverandor=>I_APP?invoke("brev_nokkel_status",{bruker:bruker(),leverandor}):http(`/api/nokler/${leverandor}`);
export const settNokkel=(leverandor,nokkel)=>I_APP?invoke("brev_nokkel_sett",{bruker:bruker(),leverandor,nokkel}):http(`/api/nokler/${leverandor}`,{method:"PUT",body:{nokkel}});
export const slettNokkel=leverandor=>I_APP?invoke("brev_nokkel_slett",{bruker:bruker(),leverandor}):http(`/api/nokler/${leverandor}`,{method:"DELETE"});
