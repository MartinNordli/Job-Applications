import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lagServer } from "./server.mjs";
import { lagBrukere } from "./brukere.mjs";
import { delSse } from "../src/brev-strom.mjs";
import { lagBrevlager } from "./brevlager.mjs";
import { sjekksum } from "../src/jobbdokument.mjs";

const BREV = "Til rekrutteringsteamet i Eksempelbedrift,\n\nJeg søker stillingen som rådgiver.\n\nMed vennlig hilsen\nAlfa Eksempel";
const brev = () => ({tekst:BREV,sprak:"nb",merknader:[],pastander:[],maAvklares:false});
const rad = {id:"j1",selskap:"Eksempelbedrift",stilling:"Rådgiver",lenke:"https://example.invalid/jobb",sted:"Oslo",frist:null,status:"todo",sektor:"annet",notat:"",sendtDato:null};
const sti="/api/jobber/j1/brev";
/* Annonsemodellen beholder linje 2 til 3 av siden. */
const svarFor = p => ({data:p.formal==="annonse"?{erAnnonse:true,behold:[{fra:2,til:3}]}:brev(),bruk:{input_tokens:10,output_tokens:20},modell:"testmodell"});
const SIDE = "<main><p>Logg inn</p><p>Eksempelbedrift søker en rådgiver som vil arbeide med kunder i hele landet, fra kontoret i Oslo.</p>"
  + "<p>Du har erfaring fra kundeservice, skriver klart og enkelt, og liker å følge opp en sak helt til den er løst for kunden.</p><p>Andre stillinger</p></main>";
async function start(t,callback,{hentSide}={}){
  const katalog=await fs.mkdtemp(path.join(os.tmpdir(),"brev-http-test-"));const kall=[],hentet=[];
  const brukere=lagBrukere({katalog,iterasjoner:1});
  const nett={hentSide:hentSide??(async url=>{hentet.push(url);return {status:200,sluttUrl:url,html:SIDE};}),
    hentJson:async()=>{throw new Error("ikke i bruk");},spørModell:async()=>{throw new Error("ikke i bruk");}};
  const server=lagServer({katalog,brukere,nett,brevModellFor:ktx=>async p=>{
    kall.push({katalog:ktx.katalog,...p});
    return callback?callback(p):svarFor(p);
  }});
  await new Promise((ok,feil)=>{server.once("error",feil);server.listen(0,"127.0.0.1",ok);});
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(r=>server.close(r));await fs.rm(katalog,{recursive:true,force:true});});
  const apiFor=cookie=>{
    const api=async(p,method="GET",body)=>{
      const r=await fetch(base+p,{method,headers:{...(cookie?{cookie}:{}),"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:r.status,data:await r.json(),headers:r.headers};
    };
    /* Kroppen sendes som den er, for å prøve det som ikke er JSON. */
    api.rå=async(p,method,tekst)=>{
      const r=await fetch(base+p,{method,headers:{...(cookie?{cookie}:{}),"Content-Type":"application/json"},body:tekst});
      return {status:r.status,data:await r.json()};
    };
    /* Trinn-endepunktet er en SSE-strøm. Leseren gir tilbake det samme
       {status,data} som før, pluss fasene og deltaene underveis, slik at
       eksisterende påstander om 200 og 409 fortsatt leser naturlig. */
    api.strøm=async(p,body)=>{
      const r=await fetch(base+p,{method:"POST",headers:{...(cookie?{cookie}:{}),"Content-Type":"application/json"},body:JSON.stringify(body)});
      if(!r.headers.get("content-type")?.startsWith("text/event-stream"))
        return {status:r.status,data:await r.json(),faser:[],deltaer:[],type:r.headers.get("content-type")};
      const del=delSse();const faser=[],deltaer=[];let slutt=null;
      const leser=r.body.getReader(),koder=new TextDecoder();
      for(;;){
        const bit=await leser.read();if(bit.done)break;
        for(const ramme of del(koder.decode(bit.value,{stream:true}))){
          const d=JSON.parse(ramme.data);
          if(ramme.hendelse==="fase")faser.push(d);
          else if(ramme.hendelse==="delta")deltaer.push(d);
          else slutt={hendelse:ramme.hendelse,data:d};
        }
      }
      assert.ok(slutt,"strømmen sluttet uten avsluttende hendelse");
      return {status:slutt.hendelse==="ferdig"?200:slutt.data.status,data:slutt.data,faser,deltaer,type:"text/event-stream"};
    };
    return api;
  };
  async function registrer(epost){
    const r=await apiFor()("/api/registrer","POST",{epost,passord:"syntetisk-godt-passord"});
    assert.equal(r.status,201);
    return apiFor(r.headers.getSetCookie()[0].split(";")[0]);
  }
  const api=await registrer("alfa@example.no");
  return {api,registrer,kall,hentet,utenOkt:apiFor(),katalog};
}
async function grunnlag(api,navn="Alfa",{annonse=true}={}){
  let r=await api("/api/jobber","PUT",{versjon:0,jobber:[rad]});assert.equal(r.status,200);
  r=await api("/api/cv");r=await api("/api/cv","PUT",{...r.data,tekst:`${navn} Eksempel. Erfaring fra kundeservice.`});assert.equal(r.status,200);
  r=await api(sti);
  if(annonse){r=await api(sti,"PUT",{...r.data,annonse:{tekst:"Eksempelbedrift søker rådgiver.",url:"",hentet:null}});assert.equal(r.status,200);}
  return r.data;
}
async function steg(api,kid,trinn="skriv"){return api.strøm(`${sti}/kjoringer/${kid}/trinn`,{trinn});}
const profil = p => JSON.parse(p.kilder[0]).profil;

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
  const fremmed=await steg(beta,k.id);assert.equal(fremmed.status,409);assert.equal(kall.length,0);
  assert.equal(fremmed.data.feil,"konflikt");
  assert.equal((await steg(api,k.id)).status,200);assert.equal(kall.length,1);
  assert.match(profil(kall[0]).cv,/Alfa/);
  const eksport=await beta("/api/brevdata");const serialisert=JSON.stringify(eksport.data);
  assert.match(serialisert,/Beta/);assert.doesNotMatch(serialisert,/Alfa/);assert.equal(serialisert.includes(nokkel),false);
  assert.equal((await api("/api/nokler/openai","DELETE",{})).status,200);
  assert.equal((await api("/api/nokler/openai")).data.finnes,false);
});
test("HTTP-kjeden er ett kall per brev, og tåler gjenhenting, redigering og revisjon",async t=>{
  const {api,kall,hentet}=await start(t);await grunnlag(api);
  const k=(await api(`${sti}/kjoringer`,"POST",{})).data.kjoring;
  assert.equal(k.status,"klar");assert.equal(kall.length,0);
  let r=await steg(api,k.id);assert.equal(r.status,200);assert.equal(r.data.dokument.versjoner.length,1);
  assert.equal(r.data.kjoring.status,"ferdig");assert.equal(kall.length,1);
  // Et tapt svar kan hentes igjen uten å betale for brevet to ganger.
  assert.equal((await steg(api,k.id)).status,200);assert.equal(kall.length,1);
  const d=r.data.dokument;r=await api(sti,"PUT",{...d,tekst:"Jeg ønsker å bruke min egen innledning."});assert.equal(r.status,200);
  const k2=(await api(`${sti}/kjoringer`,"POST",{instruks:"Kortere."})).data.kjoring;assert.equal(k2.status,"klar");
  r=await steg(api,k2.id);assert.equal(r.status,200);
  assert.equal(r.data.dokument.versjoner.length,3);assert.equal(kall.length,2);
  assert.equal(JSON.parse(kall[1].innhold).tidligereBrev,"Jeg ønsker å bruke min egen innledning.");
  assert.deepEqual(kall.map(p=>p.formal),["brev","brev"]);assert.deepEqual(hentet,[],"annonsen fantes");
});
test("mangler annonsen, henter serveren den fra lenken med annonsemodellen før kjøringen opprettes",async t=>{
  const {api,kall,hentet}=await start(t);await grunnlag(api,"Alfa",{annonse:false});
  const r=await api(`${sti}/kjoringer`,"POST",{});
  assert.equal(r.status,200);assert.deepEqual(hentet,[rad.lenke]);
  assert.deepEqual(kall.map(p=>p.formal),["annonse"]);
  assert.match(r.data.kjoring.grunnlag.annonse,/^Eksempelbedrift søker en rådgiver/);
  assert.doesNotMatch(r.data.kjoring.grunnlag.annonse,/Logg inn|Andre stillinger/);
  const dok=(await api("/api/jobber/j1/dokument")).data;
  assert.equal(dok.annonse.kilde,"hentet");assert.equal(dok.annonse.tekst,r.data.kjoring.grunnlag.annonse);
  assert.equal((await steg(api,r.data.kjoring.id)).status,200);
  assert.deepEqual(kall.map(p=>p.formal),["annonse","brev"]);
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
  const av=await api(`${sti}/kjoringer/${k.id}/avbryt`,"POST",{});assert.equal(av.status,200);assert.equal(av.data.dokument.kjoring.status,"avbrutt");
  assert.equal((await steg(api,k.id)).status,409);assert.equal(kall.length,0);
});
test("trinn-endepunktet er en strøm: fase først, så deltaer, så én avslutning",async t=>{
  const {api,kall}=await start(t,async p=>{
    for(const bit of ["Jeg har de ","siste tre ","årene"]) p.påDelta?.(bit);
    return svarFor(p);
  });
  await grunnlag(api);
  const k=(await api(`${sti}/kjoringer`,"POST",{})).data.kjoring;
  const s=await steg(api,k.id);
  assert.equal(s.type,"text/event-stream");
  assert.deepEqual(s.faser,[{trinn:"skriv",fase:"skriver",nullstill:true}]);
  assert.deepEqual(s.deltaer,[{trinn:"skriv",tekst:"Jeg har de "},{trinn:"skriv",tekst:"siste tre "},{trinn:"skriv",tekst:"årene"}]);
  assert.equal(s.status,200);assert.equal(s.data.kjoring.status,"ferdig");
  assert.equal(s.data.dokument.versjoner.length,1);
  // Deltaene blir aldri brevtekst. Bare det ferdige dokumentet er teksten.
  assert.equal(s.data.dokument.tekst,BREV);
  assert.equal(kall.length,1);
});
test("en ferdig kjøring gir fase uten deltaer og koster ikke et nytt kall",async t=>{
  const {api,kall}=await start(t,async p=>{p.påDelta?.("noe som strømmes");return svarFor(p);});
  await grunnlag(api);
  const k=(await api(`${sti}/kjoringer`,"POST",{})).data.kjoring;
  const første=await steg(api,k.id);
  assert.equal(første.deltaer.length,1);assert.equal(kall.length,1);
  const igjen=await steg(api,k.id);
  assert.equal(igjen.status,200);
  assert.deepEqual(igjen.faser,[{trinn:"skriv",fase:"skriver",nullstill:true}]);
  assert.deepEqual(igjen.deltaer,[]);
  assert.equal(kall.length,1);
});
test("en modellfeil midt i strømmen lar brevet stå urørt",async t=>{
  let feile=false;
  const {api}=await start(t,async p=>{
    p.påDelta?.("halvferdig tekst som blir forkastet");
    if(feile){const e=new Error("Modelltjenesten svarte ikke.");e.navn="modell";e.status=502;throw e;}
    return svarFor(p);
  });
  await grunnlag(api);
  let k=(await api(`${sti}/kjoringer`,"POST",{})).data.kjoring;
  await steg(api,k.id);
  const før=(await api(sti)).data;
  assert.equal(før.tekst,BREV);
  feile=true;
  k=(await api(`${sti}/kjoringer`,"POST",{instruks:"Kortere."})).data.kjoring;
  const r=await steg(api,k.id);
  // Feilen kommer som en hendelse i en HTTP 200-strøm, med sin egen status.
  assert.equal(r.type,"text/event-stream");
  assert.equal(r.status,502);assert.equal(r.data.feil,"modell");
  assert.ok(r.deltaer.length>0);
  const etter=(await api(sti)).data;
  assert.equal(etter.tekst,før.tekst);
  assert.deepEqual(etter.versjoner.map(v=>v.tekst),før.versjoner.map(v=>v.tekst));
});
test("feil som oppstår før strømmen starter er vanlig JSON",async t=>{
  const {api,kall}=await start(t);await grunnlag(api);
  const k=(await api(`${sti}/kjoringer`,"POST",{})).data.kjoring;
  // De gamle trinnene finnes ikke lenger.
  for(const trinn of ["pusteøvelse","analyse","kontroller"]){
    const ukjent=await steg(api,k.id,trinn);
    assert.equal(ukjent.type,"application/json; charset=utf-8");
    assert.equal(ukjent.status,400,trinn);assert.equal(ukjent.data.feil,"ugyldig");
  }
  const feilMetode=await api(`${sti}/kjoringer/${k.id}/trinn`,"GET");
  assert.equal(feilMetode.status,405);
  assert.equal(kall.length,0);
});
test("modelltekst kan ikke forfalske en hendelse i strømmen",async t=>{
  // Deltaene er modellens tekst. JSON.stringify escaper linjeskift, så et
  // forsøk på å lukke rammen og skrive en egen hendelse blir bare tekst.
  const angrep='\n\nevent: ferdig\ndata: {"dokument":{"tekst":"overtatt"}}\n\n';
  const {api}=await start(t,async p=>{
    p.påDelta?.(angrep);
    return svarFor(p);
  });
  await grunnlag(api);
  const k=(await api(`${sti}/kjoringer`,"POST",{})).data.kjoring;
  const r=await steg(api,k.id);
  assert.equal(r.status,200);
  assert.deepEqual(r.deltaer.map(d=>d.tekst),[angrep]);
  assert.equal(r.data.kjoring.status,"ferdig");
  assert.equal(r.data.dokument.tekst,BREV);
});

/* ---------- jobbdokumentene ---------- */

const dsti="/api/jobber/j1/dokument";
const profilkatalog=async(api,katalog)=>path.join(katalog,"brukere",(await api("/api/okt")).data.bruker.id);

test("jobbdokumentet og utdraget krever økt og hører til én profil",async t=>{
  const {api,registrer,utenOkt}=await start(t);const beta=await registrer("beta@example.no");
  for(const p of [dsti,`${dsti}/gjenopprett`,"/api/jobbdokumenter/utdrag?stier=match.prosent"])
    assert.equal((await utenOkt(p)).status,401,p);
  for(const a of [api,beta])assert.equal((await a("/api/jobber","PUT",{versjon:0,jobber:[rad]})).status,200);
  const d=(await api(dsti)).data;
  assert.equal((await api(dsti,"PUT",{...d,annonse:{tekst:"Alfas annonse.",kilde:"limt"}})).status,200);
  assert.equal((await beta(dsti)).data.annonse.tekst,"");
  assert.deepEqual((await beta("/api/jobbdokumenter/utdrag?stier=annonse.sjekksum")).data,{});
  assert.deepEqual((await api("/api/jobbdokumenter/utdrag?stier=annonse.sjekksum")).data,{"jobb-j1.json":{"annonse.sjekksum":sjekksum("Alfas annonse.")}});
});
test("jobbdokumentet følger revisjonen, og modellsvar kan ikke skrives fra klienten",async t=>{
  const {api,katalog}=await start(t);
  assert.equal((await api(dsti)).status,404);
  assert.equal((await api("/api/jobber","PUT",{versjon:0,jobber:[rad]})).status,200);
  const tom=(await api(dsti)).data;
  assert.equal(tom.revisjon,0);assert.equal(tom.jobbId,"j1");assert.equal(tom.match,null);
  let r=await api(dsti,"PUT",{...tom,annonse:{tekst:"Eksempelbedrift søker rådgiver.",kilde:"import",url:"https://example.invalid/jobb"},
    match:{prosent:99},forberedelser:{i1:{sammendrag:"Laget i klienten."}}});
  assert.equal(r.status,200);assert.equal(r.data.revisjon,1);
  assert.equal(r.data.annonse.sjekksum,sjekksum("Eksempelbedrift søker rådgiver."));
  assert.equal(r.data.match,null);assert.deepEqual(r.data.forberedelser,{});
  // En vurdering lagt inn av tjenesten overlever en vanlig lagring av annonsen.
  const lager=lagBrevlager(await profilkatalog(api,katalog));
  await lager.skriv("jobb-j1.json",{...r.data,match:{prosent:71}},1);
  r=await api(dsti,"PUT",{...r.data,revisjon:2,annonse:{...r.data.annonse,tekst:"Ny tekst."},match:null});
  assert.equal(r.status,200);assert.equal(r.data.match.prosent,71);assert.equal(r.data.revisjon,3);
  const utdatert=await api(dsti,"PUT",{...r.data,revisjon:2,annonse:{tekst:"Fra en gammel fane."}});
  assert.equal(utdatert.status,409);assert.equal(utdatert.data.feil,"konflikt");
  assert.equal((await api(dsti)).data.annonse.tekst,"Ny tekst.");
  assert.equal((await api(dsti,"PUT",{...r.data,annonse:{tekst:"x".repeat(100001)}})).status,400);
  assert.equal((await api(dsti,"PUT",{...r.data,annonse:{tekst:"x",url:"javascript:alert(1)"}})).status,400);
  assert.equal((await api(dsti,"PUT",{...r.data,revisjon:"3"})).status,400);
  assert.equal((await api(dsti,"DELETE",{revisjon:3})).status,405);
  assert.equal((await api(`${dsti}/gjenopprett`,"GET")).status,405);
  for(const p of ["/api/jobber/a.b/dokument","/api/jobber/..%2F..%2Fcv/dokument",`/api/jobber/${"x".repeat(65)}/dokument`]){
    const svar=await api(p);assert.ok([400,404].includes(svar.status),`${p}: ${svar.status}`);
  }
  assert.equal((await api(dsti)).data.revisjon,3);
});
test("ugyldig JSON til jobbdokumentet gir 400 og ingen skriving",async t=>{
  const {api}=await start(t);
  assert.equal((await api("/api/jobber","PUT",{versjon:0,jobber:[rad]})).status,200);
  const r=await api.rå(dsti,"PUT","{ikke json");
  assert.equal(r.status,400);assert.equal((await api(dsti)).data.revisjon,0);
});
test("et skadet jobbdokument kan gjenopprettes fra forrige lagring over HTTP",async t=>{
  const {api,katalog}=await start(t);
  assert.equal((await api("/api/jobber","PUT",{versjon:0,jobber:[rad]})).status,200);
  let d=(await api(dsti,"PUT",{...(await api(dsti)).data,annonse:{tekst:"Første."}})).data;
  d=(await api(dsti,"PUT",{...d,annonse:{tekst:"Andre."}})).data;
  const fil=path.join(await profilkatalog(api,katalog),"jobb-j1.json");
  await fs.writeFile(fil,"ødelagt");
  const feil=await api(dsti);assert.equal(feil.status,503);assert.equal(feil.data.feil,"odelagt");
  const r=await api(`${dsti}/gjenopprett`,"POST");
  assert.equal(r.status,200);assert.equal(r.data.annonse.tekst,"Første.");assert.ok(r.data.revisjon>d.revisjon);
  assert.equal((await api(dsti)).data.annonse.tekst,"Første.");
  assert.ok((await fs.readdir(path.dirname(fil))).some(n=>n.startsWith("jobb-j1.odelagt-")));
});
test("utdraget svarer med de stiene det ble bedt om, for alle jobbdokumentene",async t=>{
  const {api,katalog}=await start(t);
  const rader=[rad,{...rad,id:"j2",lenke:"https://example.invalid/jobb2"}];
  assert.equal((await api("/api/jobber","PUT",{versjon:0,jobber:rader})).status,200);
  await api(dsti,"PUT",{...(await api(dsti)).data,annonse:{tekst:"A.",hentet:"2026-10-01T10:00:00.000Z"}});
  const lager=lagBrevlager(await profilkatalog(api,katalog));
  await lager.skriv("jobb-j2.json",{revisjon:0,match:{prosent:64,oppsummering:"ø".repeat(1000)}},0);
  await lager.skriv("brev-j1.json",{...(await lager.les("brev-j1.json")),tekst:"Brev."},0);
  const r=await api("/api/jobbdokumenter/utdrag?stier=match.prosent,annonse.hentet,match.oppsummering");
  assert.equal(r.status,200);
  assert.deepEqual(r.data,{
    "jobb-j1.json":{"annonse.hentet":"2026-10-01T10:00:00.000Z"},
    "jobb-j2.json":{"match.prosent":64,"annonse.hentet":null,"match.oppsummering":"ø".repeat(300)}
  });
  assert.equal(r.headers.get("cache-control"),"no-store");
  for(const p of ["/api/jobbdokumenter/utdrag","/api/jobbdokumenter/utdrag?stier=","/api/jobbdokumenter/utdrag?stier=__proto__",
    "/api/jobbdokumenter/utdrag?stier=a..b","/api/jobbdokumenter/utdrag?stier="+Array.from({length:21},(_,i)=>`s${i}`).join(",")]){
    const svar=await api(p);assert.equal(svar.status,400,p);assert.equal(svar.data.feil,"ugyldig");
  }
  assert.equal((await api("/api/jobbdokumenter/utdrag?stier=match.prosent","POST",{})).status,405);
  assert.equal((await api("/api/jobbdokumenter")).status,404);
  assert.equal((await api("/api/jobbdokumenter/annet")).status,404);
});
test("sikkerhetskopien over HTTP er versjon 3 og har med jobbdokumentet og stilreferansen",async t=>{
  const {api}=await start(t);await grunnlag(api);
  await api(dsti,"PUT",{...(await api(dsti)).data,annonse:{tekst:"Annonse til kopien."}});
  assert.equal((await api("/api/stil","PUT",{revisjon:0,tekst:"Et eget brev."})).status,200);
  const r=await api("/api/brevdata");
  assert.equal(r.data.skjemaVersjon,3);
  assert.equal(r.data.dokumenter["stil.json"].tekst,"Et eget brev.");
  assert.equal(r.data.dokumenter["jobb-j1.json"].annonse.tekst,"Annonse til kopien.");
  const konflikt=await api("/api/brevdata","POST",r.data);
  assert.equal(konflikt.status,409);
});

/* ---------- feilmeldinger ---------- */

test("en uventet filsystemfeil gir en generell melding uten sti, og en referanse i loggen",async t=>{
  const {api,katalog}=await start(t);
  assert.equal((await api("/api/jobber","PUT",{versjon:0,jobber:[rad]})).status,200);
  const dir=await profilkatalog(api,katalog);
  await api(dsti,"PUT",{...(await api(dsti)).data,annonse:{tekst:"Annonse."}});
  const fil=path.join(dir,"jobb-j1.json");
  await fs.chmod(fil,0o000);
  t.after(()=>fs.chmod(fil,0o600).catch(()=>{}));
  const logg=[];const før=console.error;console.error=(...a)=>logg.push(a.map(String).join(" "));
  let r;try{r=await api(dsti);}finally{console.error=før;}
  assert.equal(r.status,500);assert.equal(r.data.feil,"intern");
  assert.ok(!r.data.melding.includes(katalog),r.data.melding);
  assert.ok(!/EACCES|\//.test(r.data.melding),r.data.melding);
  const ref=r.data.melding.match(/se etter ([0-9a-f]{8})/)?.[1];
  assert.ok(ref,r.data.melding);
  assert.ok(logg.some(l=>l.includes(ref)&&l.includes("EACCES")),"detaljen skal stå i serverloggen");
  // De bevisste meldingene går fortsatt ut som før.
  await fs.chmod(fil,0o600);
  const konflikt=await api(dsti,"PUT",{revisjon:0,annonse:{tekst:"Gammel."}});
  assert.equal(konflikt.status,409);assert.equal(konflikt.data.feil,"konflikt");
  assert.match(konflikt.data.melding,/endret i et annet vindu/);
});
/* ---------- stilreferansen ---------- */

test("stilreferansen krever økt, hører til én profil og følger revisjonen",async t=>{
  const {api,registrer,utenOkt,kall}=await start(t);const beta=await registrer("beta@example.no");
  for(const p of ["/api/stil","/api/stil/gjenopprett"]) assert.equal((await utenOkt(p)).status,401,p);
  const tom=(await api("/api/stil")).data;
  assert.deepEqual({tekst:tom.tekst,revisjon:tom.revisjon},{tekst:"",revisjon:0});
  let r=await api("/api/stil","PUT",{...tom,tekst:"Til rekrutteringsteamet i Testfirma,\n\nKort og konkret.",ukjent:"faller bort"});
  assert.equal(r.status,200);assert.equal(r.data.revisjon,1);assert.equal(Object.hasOwn(r.data,"ukjent"),false);
  assert.equal((await beta("/api/stil")).data.tekst,"");
  const gammel=await api("/api/stil","PUT",{...tom,tekst:"Fra en gammel fane."});
  assert.equal(gammel.status,409);assert.equal(gammel.data.feil,"konflikt");
  assert.equal((await api("/api/stil","PUT",{...r.data,tekst:"x".repeat(16001)})).status,400);
  assert.equal((await api("/api/stil","PUT",{...r.data,tekst:42})).status,400);
  assert.equal((await api.rå("/api/stil","PUT","{ikke json")).status,400);
  assert.equal((await api("/api/stil","POST",{})).status,405);
  assert.equal((await api("/api/stil/gjenopprett","GET")).status,405);
  // Stilreferansen går med i kildeblokken, aldri som noe modellen kan sitere.
  await grunnlag(api);
  const k=(await api(`${sti}/kjoringer`,"POST",{})).data.kjoring;
  assert.equal((await steg(api,k.id)).status,200);
  assert.match(profil(kall.at(-1)).stilreferanse,/Testfirma/);
  assert.equal((await api("/api/stil","DELETE",{revisjon:1})).status,200);
  const etter=(await api("/api/stil")).data;assert.equal(etter.tekst,"");assert.ok(etter.revisjon>1);
});
test("en kjøring som ble stående i et av de gamle trinnene, erstattes når et nytt utkast startes",async t=>{
  const {api,kall,katalog}=await start(t);await grunnlag(api);
  const lager=lagBrevlager(await profilkatalog(api,katalog));
  const d=await lager.les("brev-j1.json");
  await lager.skriv("brev-j1.json",{...d,kjoring:{id:"gammel",status:"venter",opprettet:"2026-10-01T10:00:00.000Z",
    grunnlag:{cv:"Alfa Eksempel.",annonse:"Eksempelbedrift søker rådgiver.",sprak:"auto",leverandor:"anthropic",historikk:[]},
    instruks:"",utgangspunkt:"",analyse:{sprak:"nb",begrunnelse:"Bokmål."},utkast:null}},d.revisjon);
  assert.equal((await api(sti)).data.kjoring.status,"venter");
  assert.equal((await steg(api,"gammel")).status,409);
  const ny=await api(`${sti}/kjoringer`,"POST",{});
  assert.equal(ny.status,200);assert.notEqual(ny.data.kjoring.id,"gammel");assert.equal(ny.data.kjoring.status,"klar");
  assert.equal((await steg(api,ny.data.kjoring.id)).status,200);
  assert.deepEqual(kall.map(p=>p.trinn),["skriv"]);
});
