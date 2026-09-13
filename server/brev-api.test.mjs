import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lagServer } from "./server.mjs";
import { lagBrukere } from "./brukere.mjs";

const analyse = () => ({sprak:"nb",begrunnelse:"Bokmål i annonsen.",sporsmal:[{id:"q1",tekst:"Hva ved stillingen motiverer deg?"}],krav:[],bevis:[],uklarheter:[],maAvklares:false});
const brev = () => ({tekst:"Jeg søker stillingen som rådgiver.",sprak:"nb",merknader:[],pastander:[],maAvklares:false});
const rad = {id:"j1",selskap:"Eksempelbedrift",stilling:"Rådgiver",lenke:"https://example.invalid/jobb",sted:"Oslo",frist:null,status:"todo",sektor:"annet",notat:"",sendtDato:null};
const sti="/api/jobber/j1/brev";
async function start(t,callback){
  const katalog=await fs.mkdtemp(path.join(os.tmpdir(),"brev-http-test-"));const kall=[];
  const brukere=lagBrukere({katalog,iterasjoner:1});
  const server=lagServer({katalog,brukere,brevModellFor:ktx=>async p=>{
    kall.push({katalog:ktx.katalog,...p});
    return callback?callback(p):{data:p.trinn==="analyse"?analyse():brev(),bruk:{input_tokens:10,output_tokens:20},modell:"testmodell"};
  }});
  await new Promise((ok,feil)=>{server.once("error",feil);server.listen(0,"127.0.0.1",ok);});
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(r=>server.close(r));await fs.rm(katalog,{recursive:true,force:true});});
  const apiFor=cookie=>async(p,method="GET",body)=>{
    const r=await fetch(base+p,{method,headers:{...(cookie?{cookie}:{}),"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:r.status,data:await r.json(),headers:r.headers};
  };
  async function registrer(epost){
    const r=await apiFor()("/api/registrer","POST",{epost,passord:"syntetisk-godt-passord"});
    assert.equal(r.status,201);
    return apiFor(r.headers.getSetCookie()[0].split(";")[0]);
  }
  const api=await registrer("alfa@example.no");
  return {api,registrer,kall,utenOkt:apiFor(),katalog};
}
async function grunnlag(api,navn="Alfa"){
  let r=await api("/api/jobber","PUT",{versjon:0,jobber:[rad]});assert.equal(r.status,200);
  r=await api("/api/cv");r=await api("/api/cv","PUT",{...r.data,tekst:`${navn} Eksempel. Erfaring fra kundeservice.`});assert.equal(r.status,200);
  r=await api(sti);r=await api(sti,"PUT",{...r.data,kontekst:`Kontekst for ${navn}.`,annonse:{tekst:"Eksempelbedrift søker rådgiver.",url:"",hentet:null}});assert.equal(r.status,200);
  return r.data;
}
async function steg(api,kid,trinn,svar){return api(`${sti}/kjoringer/${kid}/trinn`,"POST",{trinn,...(svar?{svar}:{})});}

test("brev, CV, modellnøkler og eksport krever autentisert økt",async t=>{
  const {utenOkt,kall}=await start(t);
  for(const p of ["/api/cv",sti,"/api/nokler/anthropic","/api/nokler/openai","/api/brevdata"])
    assert.equal((await utenOkt(p)).status,401,p);
  assert.equal((await utenOkt(`${sti}/kjoringer`,"POST",{})).status,401);assert.equal(kall.length,0);
});
test("to profiler har separate CV-er, brev, kjøringer, eksport og nøkkelstatus",async t=>{
  const {api,registrer,kall}=await start(t);const beta=await registrer("beta@example.no");
  await grunnlag(api,"Alfa");await grunnlag(beta,"Beta");
  const nokkel="sk-syntetisk-testnokkel-abcdefghijklmnopqrstuvwxyz";
  assert.equal((await api("/api/nokler/openai","PUT",{nokkel})).status,200);
  const status=await api("/api/nokler/openai");assert.equal(status.data.finnes,true);assert.equal(JSON.stringify(status.data).includes(nokkel),false);
  assert.equal((await beta("/api/nokler/openai")).data.finnes,false);
  assert.match((await api("/api/cv")).data.tekst,/Alfa/);assert.match((await beta("/api/cv")).data.tekst,/Beta/);
  const k=(await api(`${sti}/kjoringer`,"POST",{})).data.kjoring;
  const fremmed=await steg(beta,k.id,"analyse");assert.equal(fremmed.status,409);assert.equal(kall.length,0);
  assert.equal((await steg(api,k.id,"analyse")).status,200);assert.equal(kall.length,1);
  assert.match(JSON.parse(kall[0].innhold).grunnlag.cv,/Alfa/);
  const eksport=await beta("/api/brevdata");const serialisert=JSON.stringify(eksport.data);
  assert.match(serialisert,/Beta/);assert.doesNotMatch(serialisert,/Alfa/);assert.equal(serialisert.includes(nokkel),false);
  assert.equal((await api("/api/nokler/openai","DELETE",{})).status,200);
  assert.equal((await api("/api/nokler/openai")).data.finnes,false);
});
test("HTTP-kjeden tåler gjenhenting, valgfrie svar, redigering og revisjon",async t=>{
  const {api,kall}=await start(t);await grunnlag(api);
  const k=(await api(`${sti}/kjoringer`,"POST",{})).data.kjoring;
  assert.equal((await steg(api,k.id,"skriv")).status,409);
  assert.equal((await steg(api,k.id,"analyse")).status,200);
  assert.equal((await api(sti)).data.kjoring.status,"venter");
  assert.equal((await steg(api,k.id,"analyse")).status,200);assert.equal(kall.length,1);
  assert.equal((await steg(api,k.id,"skriv",{})).status,200);
  let r=await steg(api,k.id,"kontroller");assert.equal(r.status,200);assert.equal(r.data.dokument.versjoner.length,1);
  const d=r.data.dokument;r=await api(sti,"PUT",{...d,tekst:"Jeg ønsker å bruke min egen innledning."});assert.equal(r.status,200);
  const k2=(await api(`${sti}/kjoringer`,"POST",{instruks:"Kortere."})).data.kjoring;assert.equal(k2.status,"venter");
  assert.equal((await steg(api,k2.id,"skriv")).status,200);r=await steg(api,k2.id,"kontroller");assert.equal(r.status,200);
  assert.equal(r.data.dokument.versjoner.length,3);assert.equal(kall.length,5);
  assert.equal(JSON.parse(kall[3].innhold).tidligereBrev,"Jeg ønsker å bruke min egen innledning.");
});
test("utdaterte revisjoner og ugyldig grunnlag avvises før modellbruk",async t=>{
  const {api,kall}=await start(t);const d=await grunnlag(api);
  assert.equal((await api(sti,"PUT",{...d,tekst:"Første endring."})).status,200);
  assert.equal((await api(sti,"PUT",{...d,tekst:"Utdatert endring."})).status,409);
  assert.equal((await api(sti)).data.tekst,"Første endring.");
  const cv=(await api("/api/cv")).data;assert.equal((await api("/api/cv","PUT",{...cv,tekst:""})).status,200);
  const r=await api(`${sti}/kjoringer`,"POST",{});assert.equal(r.status,400);assert.equal(r.data.feil,"ugyldig-grunnlag");assert.equal(kall.length,0);
});
test("avbryt via HTTP bevarer teksten og hindrer senere skriving",async t=>{
  const {api,kall}=await start(t);await grunnlag(api);
  const k=(await api(`${sti}/kjoringer`,"POST",{})).data.kjoring;
  assert.equal((await steg(api,k.id,"analyse")).status,200);
  const av=await api(`${sti}/kjoringer/${k.id}/avbryt`,"POST",{});assert.equal(av.status,200);assert.equal(av.data.dokument.kjoring.status,"avbrutt");
  assert.equal((await steg(api,k.id,"skriv")).status,409);assert.equal(kall.length,1);
});
