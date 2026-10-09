/* ============================================================
   Brevtjenesten: CV, stilreferanse, brev og kjøringene som skriver
   dem. HTTP-rutene og appen bruker den samme kjeden.

   En kjøring går gjennom tre trinn: analyse (klar → analyserer →
   venter), skriving (venter → skriver → skrevet) og kontroll
   (skrevet → kontrollerer → ferdig). Tilstandsnavnene er de samme som
   da brevskriveren stilte spørsmål, så gamle dokumenter leses som før.
   «venter» betyr nå bare at analysen er ferdig og skrivingen er neste.

   Annonsen hentes fra jobb-<id>.json gjennom annonseFor, ett sted for
   søknaden. Har jobbdokumentet aldri hatt en annonse, flytter
   annonseFor annonsen fra brevdokumentet over én gang (se
   src/jobbdokumenttjeneste.mjs), så brev fra før jobbdokumentet
   fantes, virker uten at noe gjøres.
   ============================================================ */
import { Brevfeil, brevfil, validerCv, validerStil, validerBrev, validerDokument, harInnhold } from "./brevdata.mjs";
import { dokumenttype } from "./dokumentnavn.mjs";
import { analyserGrunnlag, skrivUtkast, kontrollerUtkast, validerGrunnlag, PROMPTVERSJON, FASE } from "./brevlogikk.mjs";
import { SEKTORER, JOBBTYPER } from "./felles.mjs";
import { lagJobbdokumenter } from "./jobbdokumenttjeneste.mjs";

const aktive = new Set(Object.values(FASE));
/* Ikke i gang, men heller ikke ferdig. En slik kjøring kan fortsettes. */
const VENTENDE = new Set(["klar","venter","skrevet"]);
const klon = v => structuredClone(v);
const tidspunkt = () => new Date().toISOString();
/* Det modellen får vite om søknaden fra listen. Kodene blir til ord. */
const jobbfelt = j => ({ selskap:j?.selskap??"",stilling:j?.stilling??"",sted:j?.sted??"",
  jobbtype:Object.hasOwn(JOBBTYPER,j?.jobbtype??"")?JOBBTYPER[j.jobbtype]:"",
  sektor:Object.hasOwn(SEKTORER,j?.sektor??"")?SEKTORER[j.sektor]:"" });
const likt = (a,b) => JSON.stringify(a??null) === JSON.stringify(b??null);
const sammeKilder = (a,b) => ["cv","annonse","sprak","leverandor"].every(k => String(a?.[k]??"").trim() === String(b?.[k]??"").trim())
  && likt(a?.jobb,b?.jobb);

const SIKKERHETSKOPI = 3;
const TYPER_I_KOPI = { 1:["cv","brev"], 2:["cv","brev","jobb","radar"], 3:["cv","stil","brev","jobb","radar"] };

/* annonseFor(jobbId) gir annonseteksten for søknaden, eller tom tekst.
   Den er injisert så annonsen kan komme fra et annet sted uten at
   tjenesten endres. Et objekt med tekst godtas også. */
export function lagBrevtjeneste({lager,kallModell,hentJobb,annonseFor,lagId = () => crypto.randomUUID()}){
  const finnAnnonse = annonseFor ?? lagJobbdokumenter({lager,hentJobb}).annonseFor;
  async function annonsen(id){
    const a = await finnAnnonse(id);
    return typeof a === "string" ? a : (typeof a?.tekst === "string" ? a.tekst : "");
  }
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
  /* Uten instruks er dette «Skriv utkast», med instruks «Lag ny versjon».
     Står det en ventende kjøring for den samme forespørselen, fortsetter
     den i stedet for å starte på nytt: en kjøring som ble stående i
     «venter» går da rett til skriving, og ingen betaler for analysen
     to ganger. En kjøring som er i gang, eller som ble startet for en
     annen forespørsel, må avbrytes først. */
  async function opprett(id,{instruks=""}={}){
    const jobb = await sjekkJobb(id);
    if(typeof instruks!=="string" || instruks.length>4000) throw new Brevfeil("ugyldig","Forbedringsinstruksjonen kan ha høyst 4 000 tegn.");
    // Å fortsette endrer ingenting, så det skrives heller ingenting.
    const før = (await les(id)).kjoring;
    if(VENTENDE.has(før?.status) && (før.instruks||"")===instruks) return klon(før);
    const [cv,stil,fraJobb] = await Promise.all([hentCv(),hentStil(),annonsen(id)]);
    let kjørt;
    await endre(id,d => {
      const k = d.kjoring;
      if(aktive.has(k?.status) || VENTENDE.has(k?.status)) throw new Brevfeil("opptatt","Et utkast er allerede under arbeid. Avbryt det før du starter på nytt.",409);
      const kilder = gjeldende(d,{cv,jobb,fraJobb});
      if(!kilder.cv.trim()) throw new Brevfeil("ugyldig-grunnlag","Legg til CV-en din før du skriver brevet.");
      if(!kilder.annonse.trim()) throw new Brevfeil("ugyldig-grunnlag","Søknaden mangler annonsen. Hent den eller lim den inn før du skriver brevet.");
      const aktivVersjon=d.versjoner.find(v=>v.id===d.aktivVersjon);
      const historikk=instruks?(aktivVersjon?.historikk||[]):[];
      const grunnlag = validerGrunnlag({...kilder,historikk,stilreferanse:stil.tekst});
      const avstamning=aktivVersjon?.analyse?aktivVersjon:(k?.resultatId===d.aktivVersjon?k:null);
      const gjenbruk = !!instruks && avstamning?.analyse && sammeKilder(avstamning.grunnlag,grunnlag);
      kjørt = {id:lagId(),status:gjenbruk?"venter":"klar",opprettet:tidspunkt(),grunnlag,cvRevisjon:cv.revisjon,utgangspunkt:d.tekst,instruks,analyse:gjenbruk?avstamning.analyse:null,utkast:null};
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
  /* Det fjerde argumentet var svarene på avklaringsspørsmålene. Det
     tas fortsatt imot, så en eldre klient ikke feiler, men brukes ikke. */
  async function trinn(id,kid,trinnnavn,_svar, {signal,påDelta}={}){
    await sjekkJobb(id);
    const ventet = {analyse:"klar",skriv:"venter",kontroller:"skrevet"};
    const status = FASE;
    if(!ventet[trinnnavn]) throw new Brevfeil("ugyldig","Ukjent skrivetrinn.");
    let k;
    const nå = await les(id);
    if(nå.kjoring?.id!==kid) throw new Brevfeil("konflikt","Kjøringen finnes ikke lenger.",409);
    if(nå.kjoring.status==="ferdig")return {kjoring:nå.kjoring,dokument:nå};
    // Et tapt HTTP-svar kan hentes igjen uten å gjenta modellkallet.
    if(trinnnavn==="analyse" && nå.kjoring.analyse) return {kjoring: nå.kjoring,dokument:nå};
    if(trinnnavn==="skriv" && nå.kjoring.utkast) return {kjoring:nå.kjoring,dokument:nå};
    if(trinnnavn==="kontroller" && nå.kjoring.status==="ferdig") return {kjoring:nå.kjoring,dokument:nå};
    await endre(id,d => {
      if(d.kjoring?.id!==kid || d.kjoring.status!==ventet[trinnnavn]) throw new Brevfeil("opptatt","Dette skrivetrinnet er allerede startet eller avbrutt.",409);
      d.kjoring.status=status[trinnnavn];
      k=klon(d.kjoring); return d;
    });
    const controller = new AbortController();
    avbrudd.set(kid,controller);
    const av = () => controller.abort();
    if(signal?.aborted) controller.abort();
    signal?.addEventListener("abort",av,{once:true});
    try{
      let resultat;
      // Deltaene går bare til den som kaller. Ingen av dem rører dokumentet:
      // kontrollen kan forkaste en tekst som allerede er strømmet ferdig.
      const valg = {kallModell,signal:controller.signal,...(typeof påDelta==="function"?{påDelta}:{})};
      if(trinnnavn==="analyse") resultat=await analyserGrunnlag(k.grunnlag,valg);
      if(trinnnavn==="skriv") resultat=await skrivUtkast(k.grunnlag,k.analyse,{...valg,tekst:k.utgangspunkt,instruks:k.instruks});
      if(trinnnavn==="kontroller") resultat=await kontrollerUtkast(k.grunnlag,k.analyse,k.utkast,valg);
      if(controller.signal.aborted) throw new Brevfeil("avbrutt","Skrivingen ble avbrutt.",409);
      // Kildene slik de er nå, for å se om brukeren har endret noe mens modellen skrev.
      const nå = trinnnavn==="kontroller" ? {cv:await hentCv(),jobb:await hentJobb(id),fraJobb:await annonsen(id)} : null;
      const dokument = await endre(id,d => {
        if(d.kjoring?.id!==kid || d.kjoring.status!==status[trinnnavn]) throw new Brevfeil("avbrutt","Kjøringen er avbrutt. Eksisterende brev er beholdt.",409);
        if(trinnnavn==="analyse"){ d.kjoring.analyse=resultat; d.kjoring.status="venter"; }
        if(trinnnavn==="skriv"){ d.kjoring.utkast=resultat; d.kjoring.status="skrevet"; }
        if(trinnnavn==="kontroller"){
          if(d.versjoner.length>=99) throw new Brevfeil("for-mange","Eksporter og rydd historikken før du lager flere versjoner.");
          // Bevar den manuelle teksten også når ingen generert versjon inneholder den.
          if(d.tekst && !d.versjoner.some(v=>v.tekst===d.tekst)) d.versjoner.push({...d.versjoner.find(v=>v.id===d.aktivVersjon),id:lagId(),tekst:d.tekst,opprettet:tidspunkt(),sprak:d.kjoring.analyse.sprak,manuell:true});
          const v={id:lagId(),tekst:resultat.tekst,sprak:resultat.sprak,opprettet:tidspunkt(),grunnlag:k.grunnlag,analyse:k.analyse,instruks:k.instruks,historikk:[...(k.grunnlag.historikk||[]),...(k.instruks?[k.instruks]:[])],leverandor:k.grunnlag.leverandor,modell:resultat.modell || k.analyse.modell,promptversjon:PROMPTVERSJON,merknader:resultat.merknader || [],bruk:[k.analyse.bruk,k.utkast.bruk,resultat.bruk].filter(Boolean)};
          d.versjoner.push(v);
          const uendret=d.tekst===k.utgangspunkt && sammeKilder(gjeldende(d,nå),k.grunnlag);
          if(uendret){d.tekst=v.tekst;d.aktivVersjon=v.id;}
          d.kjoring.status="ferdig";d.kjoring.resultatId=v.id;d.kjoring.nyttForslag=!uendret;
          d.kjoring.utkast=null;
        }
        return d;
      });
      return {kjoring:dokument.kjoring,dokument};
    }catch(e){
      await endre(id,d => {
        if(d.kjoring?.id===kid && d.kjoring.status===status[trinnnavn]){
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
