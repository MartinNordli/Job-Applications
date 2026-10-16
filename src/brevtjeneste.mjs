/* ============================================================
   Brevtjenesten: CV, stilreferanse, brev og kjøringene som skriver
   dem. HTTP-rutene og appen bruker den samme kjeden.

   En kjøring er klar → skriver → ferdig, og skrivingen er ett
   modellkall (skrivBrev i src/brevlogikk.mjs). Den kan også ende som
   avbrutt eller feilet. «klar» betyr at grunnlaget er samlet og at
   ingenting er betalt ennå.

   Kjøringer fra brev-4 og eldre gikk gjennom analyse, skriving og
   kontroll, med tilstandene analyserer, venter, skrevet og
   kontrollerer. Ingen av dem kan fortsettes nå. En slik kjøring står
   ikke i veien: neste «Skriv utkast» erstatter den med en ny. Gamle
   versjoner med analyse og tre bruksoppføringer leses og vises som før.

   Annonsen hentes fra jobb-<id>.json gjennom annonseFor, ett sted for
   søknaden. Har jobbdokumentet aldri hatt en annonse, flytter
   annonseFor annonsen fra brevdokumentet over én gang (se
   src/jobbdokumenttjeneste.mjs), så brev fra før jobbdokumentet
   fantes, virker uten at noe gjøres. Mangler annonsen, men søknaden
   har en lenke, hentes den før kjøringen opprettes: siden hentes,
   modellen for formålet «annonse» velger linjene som hører til
   annonsen (src/annonseuttrekk.mjs), og annonsen lagres i
   jobbdokumentet før brevet bruker den. Det skjer bare når brukeren
   har bedt om et brev.
   ============================================================ */
import { Brevfeil, brevfil, validerCv, validerStil, validerBrev, validerDokument, harInnhold } from "./brevdata.mjs";
import { dokumenttype } from "./dokumentnavn.mjs";
import { skrivBrev, validerGrunnlag, PROMPTVERSJON, FASE } from "./brevlogikk.mjs";
import { velgAnnonse } from "./annonseuttrekk.mjs";
import { SEKTORER, JOBBTYPER } from "./felles.mjs";
import { lagJobbdokumenter } from "./jobbdokumenttjeneste.mjs";

const SKRIVER = FASE.skriv;
const klon = v => structuredClone(v);
const tidspunkt = () => new Date().toISOString();
/* Det modellen får vite om søknaden fra listen. Kodene blir til ord. */
const jobbfelt = j => ({ selskap:j?.selskap??"",stilling:j?.stilling??"",sted:j?.sted??"",
  jobbtype:Object.hasOwn(JOBBTYPER,j?.jobbtype??"")?JOBBTYPER[j.jobbtype]:"",
  sektor:Object.hasOwn(SEKTORER,j?.sektor??"")?SEKTORER[j.sektor]:"" });
const likt = (a,b) => JSON.stringify(a??null) === JSON.stringify(b??null);
const sammeKilder = (a,b) => ["cv","annonse","sprak","leverandor"].every(k => String(a?.[k]??"").trim() === String(b?.[k]??"").trim())
  && likt(a?.jobb,b?.jobb);
const erNettlenke = v => typeof v === "string" && /^https?:\/\//i.test(v.trim());
const MANGLER_ANNONSE = "Søknaden mangler annonsen. Hent den eller lim den inn før du skriver brevet.";

const SIKKERHETSKOPI = 3;
const TYPER_I_KOPI = { 1:["cv","brev"], 2:["cv","brev","jobb","radar"], 3:["cv","stil","brev","jobb","radar"] };

/* jobbdokumenter er tjenesten fra src/jobbdokumenttjeneste.mjs, med
   hentSide og taket for henting satt opp av den som kaller. Uten den
   lages en som bare kan lese annonsen, ikke hente den. */
export function lagBrevtjeneste({lager,kallModell,hentJobb,jobbdokumenter,lagId = () => crypto.randomUUID()}){
  const jd = jobbdokumenter ?? lagJobbdokumenter({lager,hentJobb});
  const annonsen = async id => (await jd.annonseFor(id))?.tekst ?? "";
  /* Kildene slik de er nå, i samme form som et grunnlag. */
  const gjeldende = (d,{cv,jobb,fraJobb}) => ({ cv:cv.tekst,annonse:fraJobb,jobb:jobbfelt(jobb),sprak:d.sprak,leverandor:d.leverandor });
  const avbrudd = new Map();
  const les = id => lager.les(brevfil(id));
  async function endre(id, fn){
    for(let i=0;i<4;i++){
      const d = await les(id);
      const neste = await fn(klon(d));
      try{ return await lager.skriv(brevfil(id),neste,d.revisjon); }
      catch(e){ if(e.code !== "konflikt" || i===3) throw e; }
    }
  }
  async function sjekkJobb(id){
    const j = await hentJobb(id);
    if(!j) throw new Brevfeil("finnes-ikke","Jobben finnes ikke. Legg den til før du skriver brevet.",404);
    return j;
  }
  async function hentCv(){ return lager.les("cv.json"); }
  async function lagreCv(d){ return lager.skriv("cv.json",validerCv(d),d.revisjon); }
  async function hentStil(){ return lager.les("stil.json"); }
  async function lagreStil(d){ return lager.skriv("stil.json",validerStil(d),d?.revisjon); }
  async function hentBrev(id){ await sjekkJobb(id); return les(id); }
  async function lagreBrev(id,inn){
    await sjekkJobb(id);
    const før = await les(id);
    const d = validerBrev(id,inn);
    // Kjøringsstatus skrives kun gjennom kjøringsoperasjonene.
    d.kjoring = før.kjoring;
    return lager.skriv(brevfil(id),d,inn.revisjon);
  }
  /* Henter annonsen fra søknadens lenke og lagrer den i jobbdokumentet.
     Gir teksten og det uttrekket kostet. */
  async function hentManglendeAnnonse(id,jobb,{leverandor,signal}){
    if(!erNettlenke(jobb.lenke) || typeof jd.hentAnnonse!=="function") throw new Brevfeil("ugyldig-grunnlag",MANGLER_ANNONSE);
    let uttrekk=null;
    const dok=await jd.hentAnnonse(id,{velg:async(tekst,j)=>{
      const v=await velgAnnonse(tekst,{kallModell,leverandor,jobb:jobbfelt(j),signal});
      if(v.bruk||v.modell)uttrekk={modell:v.modell,bruk:v.bruk};
      return v.tekst;
    }});
    signal?.throwIfAborted();
    return {tekst:dok?.annonse?.tekst??"",uttrekk};
  }
  /* Uten instruks er dette «Skriv utkast», med instruks «Lag ny versjon».
     Grunnlaget samles på nytt hver gang, så brevet skrives fra kildene
     slik de er nå. En kjøring som skriver, må avbrytes først. Alt annet
     erstattes: en kjøring i «klar» har ikke kostet noe, og kjøringer fra
     de gamle trinnene kan ikke fortsettes. */
  async function opprett(id,{instruks=""}={},{signal}={}){
    const jobb = await sjekkJobb(id);
    if(typeof instruks!=="string" || instruks.length>4000) throw new Brevfeil("ugyldig","Forbedringsinstruksjonen kan ha høyst 4 000 tegn.");
    const før = await les(id);
    const opptatt = k => k?.status===SKRIVER;
    // Sjekkes før annonsen hentes, så ingen betaler for et uttrekk som ikke brukes.
    if(opptatt(før.kjoring)) throw new Brevfeil("opptatt","Et utkast er allerede under arbeid. Avbryt det før du starter på nytt.",409);
    const [cv,stil] = await Promise.all([hentCv(),hentStil()]);
    if(!cv.tekst.trim()) throw new Brevfeil("ugyldig-grunnlag","Legg til CV-en din før du skriver brevet.");
    let fraJobb = await annonsen(id), uttrekk = null;
    if(!fraJobb.trim()) ({tekst:fraJobb,uttrekk} = await hentManglendeAnnonse(id,jobb,{leverandor:før.leverandor,signal}));
    if(!fraJobb.trim()) throw new Brevfeil("ugyldig-grunnlag",MANGLER_ANNONSE);
    let kjørt;
    await endre(id,d => {
      if(opptatt(d.kjoring)) throw new Brevfeil("opptatt","Et utkast er allerede under arbeid. Avbryt det før du starter på nytt.",409);
      const aktivVersjon=d.versjoner.find(v=>v.id===d.aktivVersjon);
      const historikk=instruks?(aktivVersjon?.historikk||[]):[];
      const grunnlag = validerGrunnlag({...gjeldende(d,{cv,jobb,fraJobb}),historikk,stilreferanse:stil.tekst});
      kjørt = {id:lagId(),status:"klar",opprettet:tidspunkt(),grunnlag,cvRevisjon:cv.revisjon,utgangspunkt:d.tekst,instruks,
        ...(uttrekk?{annonseuttrekk:uttrekk}:{})};
      d.kjoring = kjørt;
      return d;
    });
    return klon(kjørt);
  }
  async function avbryt(id,kid){
    avbrudd.get(kid)?.abort();
    return endre(id,d => {
      if(d.kjoring?.id===kid && d.kjoring.status!=="ferdig") d.kjoring.status="avbrutt";
      return d;
    });
  }
  /* Skriver brevet for en kjøring i «klar». Det eneste trinnet heter
     «skriv». Er kjøringen allerede ferdig, gis resultatet tilbake uten
     et nytt modellkall, så et tapt HTTP-svar kan hentes igjen. */
  async function trinn(id,kid,trinnnavn,{signal,påDelta}={}){
    await sjekkJobb(id);
    if(!Object.hasOwn(FASE,trinnnavn)) throw new Brevfeil("ugyldig","Ukjent skrivetrinn.");
    let k;
    const nå = await les(id);
    if(nå.kjoring?.id!==kid) throw new Brevfeil("konflikt","Kjøringen finnes ikke lenger.",409);
    if(nå.kjoring.status==="ferdig")return {kjoring:nå.kjoring,dokument:nå};
    await endre(id,d => {
      if(d.kjoring?.id!==kid || d.kjoring.status!=="klar") throw new Brevfeil("opptatt","Dette utkastet er allerede startet eller avbrutt.",409);
      d.kjoring.status=SKRIVER;
      k=klon(d.kjoring); return d;
    });
    const controller = new AbortController();
    avbrudd.set(kid,controller);
    const av = () => controller.abort();
    if(signal?.aborted) controller.abort();
    signal?.addEventListener("abort",av,{once:true});
    try{
      // Deltaene går bare til den som kaller. Ingen av dem rører dokumentet:
      // kodekontrollen kan forkaste en tekst som allerede er strømmet ferdig.
      const resultat=await skrivBrev(k.grunnlag,{kallModell,signal:controller.signal,tekst:k.utgangspunkt,instruks:k.instruks,
        ...(typeof påDelta==="function"?{påDelta}:{})});
      if(controller.signal.aborted) throw new Brevfeil("avbrutt","Skrivingen ble avbrutt.",409);
      // Kildene slik de er nå, for å se om brukeren har endret noe mens modellen skrev.
      const kilder = {cv:await hentCv(),jobb:await hentJobb(id),fraJobb:await annonsen(id)};
      const dokument = await endre(id,d => {
        if(d.kjoring?.id!==kid || d.kjoring.status!==SKRIVER) throw new Brevfeil("avbrutt","Kjøringen er avbrutt. Eksisterende brev er beholdt.",409);
        if(d.versjoner.length>=99) throw new Brevfeil("for-mange","Eksporter og rydd historikken før du lager flere versjoner.");
        // Bevar den manuelle teksten også når ingen generert versjon inneholder den.
        if(d.tekst && !d.versjoner.some(v=>v.tekst===d.tekst)){
          const aktiv=d.versjoner.find(v=>v.id===d.aktivVersjon);
          d.versjoner.push({...aktiv,id:lagId(),tekst:d.tekst,opprettet:tidspunkt(),sprak:aktiv?.sprak??resultat.sprak,manuell:true});
        }
        const v={id:lagId(),tekst:resultat.tekst,sprak:resultat.sprak,opprettet:tidspunkt(),grunnlag:k.grunnlag,instruks:k.instruks,
          historikk:[...(k.grunnlag.historikk||[]),...(k.instruks?[k.instruks]:[])],leverandor:k.grunnlag.leverandor,modell:resultat.modell,
          promptversjon:PROMPTVERSJON,merknader:resultat.merknader||[],bruk:[resultat.bruk].filter(Boolean),
          ...(k.annonseuttrekk?{annonseuttrekk:k.annonseuttrekk}:{})};
        d.versjoner.push(v);
        const uendret=d.tekst===k.utgangspunkt && sammeKilder(gjeldende(d,kilder),k.grunnlag);
        if(uendret){d.tekst=v.tekst;d.aktivVersjon=v.id;}
        d.kjoring.status="ferdig";d.kjoring.resultatId=v.id;d.kjoring.nyttForslag=!uendret;
        return d;
      });
      return {kjoring:dokument.kjoring,dokument};
    }catch(e){
      await endre(id,d => {
        if(d.kjoring?.id===kid && d.kjoring.status===SKRIVER){
          d.kjoring.status=controller.signal.aborted?"avbrutt":"feilet";
          d.kjoring.feil={code:e.code||"modellfeil",melding:e.message||"Modellen svarte ikke."};
        }
        return d;
      }).catch(()=>{});
      throw e;
    }finally{avbrudd.delete(kid);signal?.removeEventListener("abort",av);}
  }
  /* Sikkerhetskopien. Versjon 3 har med stilreferansen, versjon 2
     jobbdokumentene og radar.json, og versjon 1 bare CV og brev. Alle
     kan gjenopprettes, men en fil som sier en versjon og har dokumenter
     den versjonen ikke kjenner, er ikke det den sier den er, og avvises. */
  async function eksporter(){
    const dokumenter={};
    for(const n of await lager.liste()){
      const d=await lager.les(n);
      if(dokumenttype(n)==="brev")d.kjoring=null;
      dokumenter[n]=d;
    }
    return {format:"jobbsoknader-brev",skjemaVersjon:SIKKERHETSKOPI,eksportert:tidspunkt(),dokumenter};
  }
  async function importer(data){
    const v=data?.skjemaVersjon,typer=Number.isInteger(v)&&Object.hasOwn(TYPER_I_KOPI,v)?TYPER_I_KOPI[v]:null;
    if(data?.format!=="jobbsoknader-brev" || !typer || !data.dokumenter || typeof data.dokumenter!=="object" || Array.isArray(data.dokumenter)) throw new Brevfeil("ugyldig","Filen er ikke en sikkerhetskopi av brevdata.");
    const inn=[];
    // Valider alt før første skriving. Eksisterende dokumenter erstattes aldri ved import.
    for(const [navn,d] of Object.entries(data.dokumenter)){
      if(!typer.includes(dokumenttype(navn))) throw new Brevfeil("ugyldig","Sikkerhetskopien inneholder et ukjent dokument.");
      const verdi=validerDokument(navn,d);
      if(dokumenttype(navn)==="brev")verdi.kjoring=null;
      const før=await lager.les(navn);
      if(harInnhold(navn,før)) throw new Brevfeil("konflikt","Sikkerhetskopien inneholder dokumenter som allerede finnes. Eksporter nåværende data og fjern de aktuelle brevdataene før gjenoppretting.",409);
      inn.push([navn,verdi,før.revisjon]);
    }
    const lagret=[];
    try{for(const [navn,d,forventet] of inn){await lager.skriv(navn,d,forventet);lagret.push([navn,forventet+1]);}}
    catch(e){for(const [n,r] of lagret) await lager.slett(n,r).catch(()=>{});throw e;}
    return {antall:lagret.length};
  }
  return {hentCv,lagreCv,slettCv:r=>lager.slett("cv.json",r),gjenopprettCv:()=>lager.gjenopprett("cv.json"),
    hentStil,lagreStil,slettStil:r=>lager.slett("stil.json",r),gjenopprettStil:()=>lager.gjenopprett("stil.json"),hentBrev,lagreBrev,opprett,trinn,avbryt,eksporter,importer,slettBrev:(id,r)=>lager.slett(brevfil(id),r),gjenopprettBrev:id=>lager.gjenopprett(brevfil(id))};
}
