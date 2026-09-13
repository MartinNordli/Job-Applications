import { Brevfeil, brevfil, validerCv, validerBrev } from "./brevdata.mjs";
import { analyserGrunnlag, skrivUtkast, kontrollerUtkast, validerGrunnlag, PROMPTVERSJON } from "./brevlogikk.mjs";

const aktive = new Set(["analyserer","skriver","kontrollerer"]);
const klon = v => structuredClone(v);
const tidspunkt = () => new Date().toISOString();
const kildefelt = d => ({ annonse:d.annonse.tekst,kontekst:d.kontekst,sprak:d.sprak,leverandor:d.leverandor });
const sammeKilder = (a,b) => ["cv","annonse","kontekst","sprak","leverandor"].every(k => String(a?.[k]??"").trim() === String(b?.[k]??"").trim());

/* Kjøringene lagres sammen med brevet. HTTP og Tauri bruker denne kjeden. */
export function lagBrevtjeneste({lager,kallModell,hentJobb,lagId = () => crypto.randomUUID()}){
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
  async function hentBrev(id){ await sjekkJobb(id); return les(id); }
  async function lagreBrev(id,inn){
    await sjekkJobb(id);
    const før = await les(id);
    const d = validerBrev(id,inn);
    // Kjøringsstatus skrives kun gjennom kjøringsoperasjonene.
    d.kjoring = før.kjoring;
    return lager.skriv(brevfil(id),d,inn.revisjon);
  }
  async function opprett(id,{instruks=""}={}){
    const jobb = await sjekkJobb(id);
    if(typeof instruks!=="string" || instruks.length>4000) throw new Brevfeil("ugyldig","Forbedringsinstruksjonen kan ha høyst 4 000 tegn.");
    const cv = await hentCv();
    let kjørt;
    await endre(id,d => {
      if(aktive.has(d.kjoring?.status) || ["klar","venter","skrevet"].includes(d.kjoring?.status)) throw new Brevfeil("opptatt","Et utkast er allerede under arbeid. Avbryt det før du starter på nytt.",409);
      const aktivVersjon=d.versjoner.find(v=>v.id===d.aktivVersjon);
      const historikk=instruks?(aktivVersjon?.historikk||[]):[];
      const grunnlag = validerGrunnlag({cv:cv.tekst,...kildefelt(d),stilling:jobb.stilling,selskap:jobb.selskap,historikk});
      const avstamning=aktivVersjon?.analyse?aktivVersjon:(d.kjoring?.resultatId===d.aktivVersjon?d.kjoring:null);
      const gjenbruk = !!instruks && avstamning?.analyse && sammeKilder(avstamning.grunnlag,grunnlag);
      const forrigeSvar = instruks ? (avstamning?.svar || {}) : {};
      kjørt = {id:lagId(),status:gjenbruk?"venter":"klar",opprettet:tidspunkt(),grunnlag,cvRevisjon:cv.revisjon,utgangspunkt:d.tekst,instruks,analyse:gjenbruk?avstamning.analyse:null,svar:forrigeSvar,utkast:null};
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
  async function trinn(id,kid,trinnnavn,svar={}, {signal,påDelta}={}){
    await sjekkJobb(id);
    const ventet = {analyse:"klar",skriv:"venter",kontroller:"skrevet"};
    const status = {analyse:"analyserer",skriv:"skriver",kontroller:"kontrollerer"};
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
      if(trinnnavn==="skriv"){
        if(!svar || typeof svar!=="object" || Array.isArray(svar) || JSON.stringify(svar).length>6000) throw new Brevfeil("ugyldig","Svarene kan til sammen ha høyst 6 000 tegn.");
        for(const v of Object.values(svar)) if(typeof v!=="string" || v.length>6000) throw new Brevfeil("ugyldig","Hvert svar kan ha høyst 6 000 tegn.");
        d.kjoring.svar={...d.kjoring.svar,...svar};
      }
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
      if(trinnnavn==="skriv") resultat=await skrivUtkast(k.grunnlag,k.analyse,k.svar,{...valg,tekst:k.utgangspunkt,instruks:k.instruks});
      if(trinnnavn==="kontroller") resultat=await kontrollerUtkast(k.grunnlag,k.analyse,k.svar,k.utkast,valg);
      if(controller.signal.aborted) throw new Brevfeil("avbrutt","Skrivingen ble avbrutt.",409);
      const cv = await hentCv();
      const dokument = await endre(id,d => {
        if(d.kjoring?.id!==kid || d.kjoring.status!==status[trinnnavn]) throw new Brevfeil("avbrutt","Kjøringen er avbrutt. Eksisterende brev er beholdt.",409);
        if(trinnnavn==="analyse"){ d.kjoring.analyse=resultat; d.kjoring.status="venter"; }
        if(trinnnavn==="skriv"){ d.kjoring.utkast=resultat; d.kjoring.status="skrevet"; }
        if(trinnnavn==="kontroller"){
          if(d.versjoner.length>=99) throw new Brevfeil("for-mange","Eksporter og rydd historikken før du lager flere versjoner.");
          // Bevar den manuelle teksten også når ingen generert versjon inneholder den.
          if(d.tekst && !d.versjoner.some(v=>v.tekst===d.tekst)) d.versjoner.push({...d.versjoner.find(v=>v.id===d.aktivVersjon),id:lagId(),tekst:d.tekst,opprettet:tidspunkt(),sprak:d.kjoring.analyse.sprak,manuell:true});
          const v={id:lagId(),tekst:resultat.tekst,sprak:resultat.sprak,opprettet:tidspunkt(),grunnlag:k.grunnlag,analyse:k.analyse,svar:k.svar,instruks:k.instruks,historikk:[...(k.grunnlag.historikk||[]),...(k.instruks?[k.instruks]:[])],leverandor:k.grunnlag.leverandor,modell:resultat.modell || k.analyse.modell,promptversjon:PROMPTVERSJON,merknader:resultat.merknader || [],bruk:[k.analyse.bruk,k.utkast.bruk,resultat.bruk].filter(Boolean)};
          d.versjoner.push(v);
          const uendret=d.tekst===k.utgangspunkt && sammeKilder({...kildefelt(d),cv:cv.tekst},k.grunnlag);
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
  async function eksporter(){
    const dokumenter={};
    for(const n of await lager.liste()){
      const d=await lager.les(n);
      if(n!=="cv.json")d.kjoring=null;
      dokumenter[n]=d;
    }
    return {format:"jobbsoknader-brev",skjemaVersjon:1,eksportert:tidspunkt(),dokumenter};
  }
  async function importer(data){
    if(data?.format!=="jobbsoknader-brev" || data.skjemaVersjon!==1 || !data.dokumenter || Array.isArray(data.dokumenter)) throw new Brevfeil("ugyldig","Filen er ikke en sikkerhetskopi av brevdata.");
    const inn=[];
    // Valider alt før første skriving. Eksisterende dokumenter erstattes aldri ved import.
    for(const [navn,d] of Object.entries(data.dokumenter)){
      if(navn!=="cv.json" && !/^brev-[A-Za-z0-9_-]{1,64}\.json$/.test(navn)) throw new Brevfeil("ugyldig","Sikkerhetskopien inneholder et ukjent dokument.");
      const verdi=navn==="cv.json"?validerCv(d):validerBrev(navn.slice(5,-5),d);
      if(navn!=="cv.json")verdi.kjoring=null;
      const før=await lager.les(navn);
      const innhold=navn==="cv.json"?(før.tekst||før.navn):(før.tekst||før.annonse?.tekst||før.kontekst||før.versjoner?.length||før.kjoring);
      if(innhold) throw new Brevfeil("konflikt","Sikkerhetskopien inneholder dokumenter som allerede finnes. Eksporter nåværende data og fjern de aktuelle brevdataene før gjenoppretting.",409);
      inn.push([navn,verdi,før.revisjon]);
    }
    const lagret=[];
    try{for(const [navn,d,forventet] of inn){await lager.skriv(navn,d,forventet);lagret.push([navn,forventet+1]);}}
    catch(e){for(const [n,r] of lagret) await lager.slett(n,r).catch(()=>{});throw e;}
    return {antall:lagret.length};
  }
  return {hentCv,lagreCv,slettCv:r=>lager.slett("cv.json",r),hentBrev,lagreBrev,opprett,trinn,avbryt,eksporter,importer,slettBrev:(id,r)=>lager.slett(brevfil(id),r),gjenopprettCv:()=>lager.gjenopprett("cv.json"),gjenopprettBrev:id=>lager.gjenopprett(brevfil(id))};
}
