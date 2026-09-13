import { lagBrevlager } from "./brevlager.mjs";
import { lagBrevtjeneste } from "../src/brevtjeneste.mjs";
import { trekkUtAnnonse } from "../src/annonsetekst.mjs";
import { Brevfeil } from "../src/brevdata.mjs";
import { FASE } from "../src/brevlogikk.mjs";
import { lagBrevModell, brevNokkelStatus, settBrevNokkel, fjernBrevNokkel } from "./brev-modell.mjs";

export const erBrevbane = p => /^\/api\/(cv(?:\/gjenopprett)?|annonsetekst|brevdata|nokler\/[^/]+|jobber\/[^/]+\/brev(?:\/.*)?)$/.test(p);
function send(res,status,data){
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
  res.end(JSON.stringify(data));
}
async function kropp(req){
  let størrelse=0;const b=[];
  for await(const bit of req){størrelse+=bit.length;if(størrelse>32*1024*1024)throw new Brevfeil("for-stort","Forespørselen er for stor.",413);b.push(bit);}
  try{return b.length?JSON.parse(Buffer.concat(b).toString("utf8")):{};}
  catch{throw new Brevfeil("ugyldig","Forespørselen er ikke gyldig JSON.");}
}
function metode(req,...lov){if(!lov.includes(req.method))throw new Brevfeil("metode","Metoden er ikke tillatt.",405);}

/* Trinn-endepunktet svarer alltid text/event-stream. Ingen JSON-variant og
   ingen Accept-forhandling: to transportveier betyr to feilsemantikker som må
   holdes korrekte for alltid, og den veien flaten ikke bruker ville råtnet i
   akkurat de kanttilfellene der det gjør mest skade. */
const HJERTESLAG = 15_000;
function åpneStrøm(res){
  res.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-store",
    "Connection":"keep-alive","X-Accel-Buffering":"no"});
  // Et hjerteslag holder strømmen åpen gjennom mellomledd som ellers ville
  // stengt en stille forbindelse midt i et modellkall på titalls sekunder.
  const slag=setInterval(()=>{if(!res.writableEnded)res.write(":\n\n");},HJERTESLAG);
  slag.unref?.();
  let avsluttet=false;
  const skriv=(hendelse,data)=>{
    if(avsluttet||res.writableEnded||res.destroyed)return;
    res.write(`event: ${hendelse}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  return {
    fase:d=>skriv("fase",d),
    delta:d=>skriv("delta",d),
    // Nøyaktig én avsluttende hendelse. En strøm som slutter uten er et
    // transportbrudd, og klienten behandler den som frakoblet.
    slutt(hendelse,data){ skriv(hendelse,data); avsluttet=true; clearInterval(slag); if(!res.writableEnded)res.end(); }
  };
}
export function lagBrevRuter({nett,modellFor}){
  const tjenester=new Map();
  const grenser=new Map();
  function tjeneste(ktx){
    const {katalog,tillatMiljø,lager}=ktx;
    const nøkkel=katalog+":"+tillatMiljø;
    if(!tjenester.has(nøkkel))tjenester.set(nøkkel,lagBrevtjeneste({
      lager:lagBrevlager(katalog),
      kallModell:modellFor?modellFor(ktx):lagBrevModell({katalog,tillatMiljø}),
      hentJobb:async id=>(await lager.les()).jobber?.find(j=>j.id===id)
    }));
    return tjenester.get(nøkkel);
  }
  return async function ruter(req,res,bane,ktx){
    const controller=new AbortController();
    const stopp=()=>{if(!res.writableEnded)controller.abort();};
    res.on("close",stopp);
    try{
      const t=tjeneste(ktx);
      let r;
      if(bane==="/api/cv/gjenopprett"){
        metode(req,"POST");r=await t.gjenopprettCv();
      }else if(/\/brev\/gjenopprett$/.test(bane)){
        metode(req,"POST");r=await t.gjenopprettBrev(bane.split("/")[3]);
      }else if(bane==="/api/cv"){
        metode(req,"GET","PUT","DELETE");
        if(req.method==="GET")r=await t.hentCv();
        else if(req.method==="PUT")r=await t.lagreCv(await kropp(req));
        else {await t.slettCv((await kropp(req)).revisjon);r={ok:true};}
      }else if(bane==="/api/brevdata"){
        metode(req,"GET","POST");r=req.method==="GET"?await t.eksporter():await t.importer(await kropp(req));
      }else if(bane==="/api/annonsetekst"){
        metode(req,"POST");const {url}=await kropp(req);
        if(typeof url!=="string" || url.length>2000)throw new Brevfeil("ugyldig","Lim inn en gyldig annonselenke.");
        const side=await nett.hentSide(url);
        r={tekst:trekkUtAnnonse(side.html),url:side.sluttUrl||url,hentet:new Date().toISOString()};
      }else if(bane.startsWith("/api/nokler/")){
        metode(req,"GET","PUT","DELETE");const leverandor=bane.split("/").at(-1);
        if(!["anthropic","openai"].includes(leverandor))throw new Brevfeil("ugyldig","Ukjent leverandør.");
        if(req.method==="GET")r=await brevNokkelStatus(ktx,leverandor);
        if(req.method==="PUT"){
          r=await settBrevNokkel(ktx,leverandor,(await kropp(req)).nokkel);
          if(!r.ok)throw new Brevfeil("ugyldig",r.melding||"API-nøkkelen har ugyldig format.");
        }
        if(req.method==="DELETE"){await fjernBrevNokkel(ktx,leverandor);r={ok:true};}
      }else{
        const m=bane.match(/^\/api\/jobber\/([A-Za-z0-9_-]{1,64})\/brev(?:\/kjoringer(?:\/([A-Za-z0-9_-]{1,64})\/(trinn|avbryt))?)?$/);
        if(!m)throw new Brevfeil("finnes-ikke","Ukjent brevoperasjon.",404);
        const [,id,kid,handling]=m;
        if(!bane.includes("/kjoringer")){
          metode(req,"GET","PUT","DELETE");
          if(req.method==="GET")r=await t.hentBrev(id);
          if(req.method==="PUT")r=await t.lagreBrev(id,await kropp(req));
          if(req.method==="DELETE"){await t.slettBrev(id,(await kropp(req)).revisjon);r={ok:true};}
        }else{
          metode(req,"POST");const inn=await kropp(req);
          if(!kid){
            const nå=Date.now();const tidligere=(grenser.get(ktx.katalog)||[]).filter(v=>v>nå-3600000);
            if(tidligere.length>=20)throw new Brevfeil("for-mange","Du har startet 20 utkast den siste timen. Vent litt før du lager flere.",429);
            r={kjoring:await t.opprett(id,inn)};grenser.set(ktx.katalog,[...tidligere,nå]);
          }else if(handling==="avbryt")r={dokument:await t.avbryt(id,kid)};
          else return await kjørTrinn(t,res,id,kid,inn,controller);
        }
      }
      if(!res.destroyed)send(res,200,r);
    }catch(e){
      if(!res.destroyed)send(res,e.status||400,{feil:e.code||e.navn||"brevfeil",melding:e.melding||e.message||"Kunne ikke behandle brevet."});
    }finally{res.off("close",stopp);}
  };
}

/* Skilt ut fordi den har én ting å si: hodene skrives først rett før
   tjenesten kalles, slik at metodesjekk, kroppsparsing og ukjent trinn
   fortsatt svarer med vanlig HTTP-status og JSON. Etter det er alt en
   hendelse i strømmen, også feil. */
async function kjørTrinn(t,res,id,kid,inn,controller){
  if(!Object.hasOwn(FASE,inn.trinn)) throw new Brevfeil("ugyldig","Ukjent skrivetrinn.");
  const strøm=åpneStrøm(res);
  try{
    strøm.fase({trinn:inn.trinn,fase:FASE[inn.trinn],nullstill:true});
    const r=await t.trinn(id,kid,inn.trinn,inn.svar,{signal:controller.signal,
      påDelta:tekst=>strøm.delta({trinn:inn.trinn,tekst})});
    strøm.slutt("ferdig",r);
  }catch(e){
    strøm.slutt("feil",{feil:e.code||e.navn||"brevfeil",
      melding:e.melding||e.message||"Kunne ikke behandle brevet.",status:e.status||400});
  }
}
