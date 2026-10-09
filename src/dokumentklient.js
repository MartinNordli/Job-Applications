/* ============================================================
   Transporten under brev.js og jobbdokumenter.js.

   I appen går profildokumentene til Rust (brev_les, brev_skriv, ...),
   i nettleseren til serveren over HTTP. Begge klientene velger vei på
   samme måte og tolker feil på samme måte, så det står her én gang.
   Lageret over Rust har samme form som server/brevlager.mjs, slik at
   tjenestene i src/ kan bruke det ene eller det andre uten å vite
   hvilket.
   ============================================================ */
import * as Økt from "./okt.js";
import { Brevfeil, lesDokument, dokumentnavn, skjemaFor } from "./brevdata.mjs";

export const I_APP=typeof window!=="undefined" && !!window.__TAURI__;

export function bruker(){const id=Økt.nåværendeBruker()?.id;if(!id)throw new Brevfeil("utlogget","Logg inn før du åpner brevet.",401);return id;}

export async function invoke(navn,valg={}){
  try{return await window.__TAURI__.core.invoke(navn,valg);}
  catch(e){
    const m=typeof e==="string"?e:e?.message||"Appen kunne ikke fullføre handlingen.";
    const kode=m.split(":",1)[0];
    const kjente={konflikt:"Dokumentet er endret i et annet vindu. Teksten din er beholdt.",opptatt:"Dokumentet er opptatt. Prøv igjen når andre vinduer er lukket.",odelagt:"Dokumentet kan ikke leses. Gjenopprett forrige lagring.",gjenoppretting:"Hovedfilen mangler. Gjenopprett forrige lagring.",avbrutt:"Skrivingen ble avbrutt.",tidsavbrudd:"Modellen svarte ikke innen to minutter.","ingen-kopi":"Fant ingen tidligere lagring å gjenopprette."};
    throw new Brevfeil(kjente[kode]?kode:/^[a-z-]+:/.test(m)?kode:"appfeil",kjente[kode]||m,409);
  }
}

export async function http(sti,{method="GET",body,signal}={}){
  const id=bruker();let r;
  try{r=await fetch(sti,{method,signal,credentials:"same-origin",headers:{"Content-Type":"application/json"},...(body!==undefined?{body:JSON.stringify(body)}:{})});}
  catch(e){if(signal?.aborted)throw new Brevfeil("avbrutt","Skrivingen ble avbrutt.");throw new Brevfeil("frakoblet","Fikk ikke kontakt med appen. Teksten din er beholdt.");}
  let j;try{j=await r.json();}catch{}
  if(r.status===401){Økt.meldUtlogget(j?.melding);throw new Brevfeil("utlogget","Logg inn igjen for å fortsette.",401);}
  if(id!==Økt.nåværendeBruker()?.id)throw new Brevfeil("utlogget","Profilen er byttet. Svaret ble forkastet.",401);
  if(!r.ok||!j)throw new Brevfeil(j?.feil||"brevfeil",j?.melding||"Handlingen kunne ikke fullføres.",r.status);
  return j;
}

/* Lageret og søknadsoppslaget for én profil i appen. sjekk() kaster
   når profilen er byttet underveis, så et svar til den forrige aldri
   havner hos den neste. */
export function lokaltLager(id){
  const sjekk=()=>{if(bruker()!==id)throw new Brevfeil("utlogget","Profilen er byttet.",401);};
  const lager={
    async les(navn){sjekk();const rå=await invoke("brev_les",{bruker:id,navn});sjekk();return lesDokument(navn,rå);},
    async skriv(navn,d,forventet){
      sjekk();dokumentnavn(navn);
      const tekst=JSON.stringify({...d,skjemaVersjon:skjemaFor(navn),revisjon:forventet+1,oppdatert:new Date().toISOString()});
      const rå=await invoke("brev_skriv",{bruker:id,navn,tekst,forventet});sjekk();return lesDokument(navn,rå);
    },
    async slett(navn,forventet){sjekk();await invoke("brev_slett",{bruker:id,navn,forventet});},
    async liste(){sjekk();return invoke("brev_liste",{bruker:id});},
    async gjenopprett(navn){sjekk();return lesDokument(navn,await invoke("brev_gjenopprett",{bruker:id,navn}));},
    async utdrag(prefiks,stier){sjekk();const r=await invoke("dokument_utdrag",{bruker:id,prefiks,stier});sjekk();return r;}
  };
  const hentJobb=async jobbId=>{sjekk();const rå=await invoke("les_tekst",{bruker:id,navn:"jobber.json"});sjekk();return JSON.parse(rå||"{}").jobber?.find(j=>j.id===jobbId);};
  return {lager,hentJobb,sjekk};
}
