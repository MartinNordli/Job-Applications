import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Brevfeil, dokumentnavn, lesDokument, revisjon, MAKS_DOKUMENT } from "../src/brevdata.mjs";

/* Samme eksklusive låsekatalog som Rust. Ingen lås over nettverkskall. */
export function lagBrevlager(katalog){
  async function medLås(navn, fn){
    dokumentnavn(navn);
    await fs.mkdir(katalog, { recursive: true });
    const lås = path.join(katalog, `.${navn}.las`);
    let låst = false;
    for(let i = 0; i < 10; i++){
      try{ await fs.mkdir(lås); låst = true; break; }
      catch(e){ if(e.code !== "EEXIST") throw e; await new Promise(r => setTimeout(r,50)); }
    }
    if(!låst) throw new Brevfeil("opptatt", "Dokumentet er opptatt. Lukk andre åpne appvinduer og prøv igjen. Ved en avbrutt skriving kan en låsekatalog måtte fjernes mens appen er avslått.", 409);
    try{ return await fn(); }
    finally{ await fs.rmdir(lås); }
  }
  async function rå(navn){
    dokumentnavn(navn);
    try{
      const fil = path.join(katalog, navn);
      if((await fs.stat(fil)).size > MAKS_DOKUMENT) throw new Brevfeil("for-stort", "Dokumentet er for stort.", 413);
      return await fs.readFile(fil, "utf8");
    }catch(e){
      if(e.code === "ENOENT"){
        try{await fs.access(path.join(katalog,navn.replace(/\.json$/,".forrige.json")));}
        catch(f){
          if(f.code==="ENOENT"){
            const n=await markør(navn);
            return n?JSON.stringify({...lesDokument(navn,null),revisjon:n}):null;
          }
          throw f;
        }
        throw new Brevfeil("gjenoppretting","Hovedfilen mangler, men en tidligere lagring finnes. Gjenopprett forrige lagring.",503);
      }
      throw e;
    }
  }
  async function les(navn){ return lesDokument(navn, await rå(navn)); }
  async function markør(navn){
    try{
      const rå=await fs.readFile(path.join(katalog,`.${navn}.revisjon`),"utf8");
      if(!/^\d+$/.test(rå))throw new Brevfeil("odelagt","Dokumentets revisjonsmarkør er skadet. Originaldataene er beholdt.",503);
      const n=Number(rå);
      return revisjon(n);
    }catch(e){if(e.code==="ENOENT")return 0;throw e;}
  }
  async function settMarkør(navn,n){
    const mål=path.join(katalog,`.${navn}.revisjon`),tmp=mål+`.${randomUUID()}.tmp`;
    try{
      const f=await fs.open(tmp,"wx",0o600);
      try{await f.writeFile(String(n));await f.sync();}finally{await f.close();}
      await fs.rename(tmp,mål);
    }finally{await fs.rm(tmp,{force:true});}
  }
  async function skriv(navn, verdi, forventet){
    revisjon(forventet);
    return medLås(navn, async () => {
      const før = await les(navn);
      if(før.revisjon !== forventet) throw new Brevfeil("konflikt", "Dokumentet er endret i et annet vindu. Teksten din er beholdt; hent den lagrede versjonen før du prøver igjen.", 409);
      // En ukjent eller skadet kopi skal heller ikke forsvinne ved vanlig lagring.
      try{lesDokument(navn,await fs.readFile(path.join(katalog,navn.replace(/\.json$/,".forrige.json")),"utf8"));}
      catch(e){if(e.code!=="ENOENT")throw e;}
      const neste = lesDokument(navn,JSON.stringify({ ...verdi, skjemaVersjon:1, revisjon:forventet+1, oppdatert:new Date().toISOString() }));
      const mål = path.join(katalog,navn);
      const tmp = path.join(katalog,`.${navn}.${randomUUID()}.tmp`);
      try{
        const f = await fs.open(tmp,"wx",0o600);
        try{ await f.writeFile(JSON.stringify(neste,null,2)); await f.sync(); }finally{ await f.close(); }
        if(før.revisjon){
          try{await fs.copyFile(mål, mål.replace(/\.json$/,".forrige.json"));await fs.chmod(mål.replace(/\.json$/,".forrige.json"),0o600);}
          catch(e){if(e.code!=="ENOENT")throw e;}
        }
        await fs.rename(tmp,mål);
        const dir = await fs.open(katalog,"r"); try{ await dir.sync(); }finally{ await dir.close(); }
      }finally{ await fs.rm(tmp,{force:true}); }
      return neste;
    });
  }
  async function slett(navn, forventet){
    return medLås(navn,async () => {
      const før = await les(navn);
      if(før.revisjon !== revisjon(forventet)) throw new Brevfeil("konflikt","Dokumentet er endret. Hent på nytt før sletting.",409);
      await settMarkør(navn,før.revisjon+1);
      await fs.rm(path.join(katalog,navn.replace(/\.json$/,".forrige.json")),{force:true});
      await fs.rm(path.join(katalog,navn),{force:true});
      const prefiks=navn.replace(/\.json$/,".odelagt-");
      for(const n of await fs.readdir(katalog))if(n.startsWith(prefiks)&&n.endsWith(".json"))await fs.rm(path.join(katalog,n),{force:true});
    });
  }
  async function liste(){
    try{ return (await fs.readdir(katalog)).filter(n => n === "cv.json" || /^brev-[A-Za-z0-9_-]{1,64}\.json$/.test(n)).filter(n => !n.endsWith(".forrige.json")); }
    catch(e){ if(e.code === "ENOENT") return []; throw e; }
  }
  async function gjenopprett(navn){
    return medLås(navn,async()=>{
      const mål=path.join(katalog,navn);
      let rå;
      try{rå=await fs.readFile(mål.replace(/\.json$/,".forrige.json"),"utf8");}
      catch{throw new Brevfeil("ingen-kopi","Fant ingen tidligere lagring å gjenopprette.",404);}
      const kopi=lesDokument(navn,rå);
      let gjeldende=0;
      try{const n=JSON.parse(await fs.readFile(mål,"utf8")).revisjon;if(Number.isSafeInteger(n)&&n>=0)gjeldende=n;}catch{}
      const neste=Math.max(await markør(navn),gjeldende,kopi.revisjon+1)+1;
      const d={...kopi,revisjon:neste,oppdatert:new Date().toISOString()};
      const tmp=path.join(katalog,`.${navn}.${randomUUID()}.tmp`);
      try{
        const f=await fs.open(tmp,"wx",0o600);
        try{await f.writeFile(JSON.stringify(d,null,2));await f.sync();}finally{await f.close();}
        await settMarkør(navn,neste);
        try{await fs.rename(mål,mål.replace(/\.json$/,`.odelagt-${Date.now()}.json`));}
        catch(e){if(e.code!=="ENOENT")throw e;}
        await fs.rename(tmp,mål);
      }finally{await fs.rm(tmp,{force:true});}
      return d;
    });
  }
  return {les,skriv,slett,liste,gjenopprett};
}
