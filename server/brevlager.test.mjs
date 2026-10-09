import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {lagBrevlager} from "./brevlager.mjs";
import {tomCv,tomtBrev} from "../src/brevdata.mjs";
import {tomtJobbdokument,tomRadar,sjekksum} from "../src/jobbdokument.mjs";
import {trekkUtAnnonse} from "../src/annonsetekst.mjs";
async function oppsett(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),"brev-lager-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {dir,lager:lagBrevlager(dir)};}
test("CV og brev har eget lager, privat filmodus og versjonskontroll",async t=>{
  const {dir,lager}=await oppsett(t);
  assert.equal((await lager.les("cv.json")).revisjon,0);
  const cv=await lager.skriv("cv.json",{...tomCv(),tekst:"CV"},0);
  assert.equal(cv.revisjon,1);assert.equal((await fs.stat(path.join(dir,"cv.json"))).mode&0o777,0o600);
  await assert.rejects(lager.skriv("cv.json",cv,0),e=>e.code==="konflikt");
  await lager.skriv("brev-jobb1.json",tomtBrev("jobb1"),0);
  assert.deepEqual((await lager.liste()).sort(),["brev-jobb1.json","cv.json"]);
});
test("to lagerinstanser kan ikke overskrive samme revisjon",async t=>{
  const {dir,lager}=await oppsett(t);const annet=lagBrevlager(dir);
  const r=await Promise.allSettled([lager.skriv("cv.json",{...tomCv(),tekst:"a"},0),annet.skriv("cv.json",{...tomCv(),tekst:"b"},0)]);
  assert.equal(r.filter(x=>x.status==="fulfilled").length,1);
  assert.equal((await lager.les("cv.json")).revisjon,1);
});
test("korrupt dokument bevares og forrige lagring kan gjenopprettes",async t=>{
  const {dir,lager}=await oppsett(t);
  await lager.skriv("cv.json",{...tomCv(),tekst:"først"},0);
  await lager.skriv("cv.json",{...tomCv(),tekst:"etter"},1);
  await fs.writeFile(path.join(dir,"cv.json"),"ødelagt");
  await assert.rejects(lager.skriv("cv.json",tomCv(),2),e=>e.code==="odelagt");
  const d=await lager.gjenopprett("cv.json");assert.equal(d.tekst,"først");
  assert.ok((await fs.readdir(dir)).some(n=>n.startsWith("cv.odelagt-")));
  await lager.slett("cv.json",d.revisjon);assert.deepEqual(await fs.readdir(dir),[".cv.json.revisjon"]);
});
test("manglende hovedfil med backup blir ikke behandlet som tom",async t=>{
  const {dir,lager}=await oppsett(t);
  await fs.writeFile(path.join(dir,"cv.forrige.json"),JSON.stringify({...tomCv(),revisjon:3}));
  await assert.rejects(lager.les("cv.json"),e=>e.code==="gjenoppretting");
});
test("filnavn og nyere skjema avvises uten skriving",async t=>{
  const {dir,lager}=await oppsett(t);
  await assert.rejects(lager.les("../nokkel.txt"));
  await fs.writeFile(path.join(dir,"cv.json"),JSON.stringify({...tomCv(),skjemaVersjon:99}));
  await assert.rejects(lager.les("cv.json"),e=>e.code==="versjon");
});
test("full annonse bevarer språkkrav sent i teksten og prioriterer JobPosting",()=>{
  const beskrivelse="Relevant oppgave. ".repeat(1500)+"Please write your application in English.";
  const html=`<nav>Ignorer</nav><script type="application/ld+json">${JSON.stringify({"@type":"JobPosting",description:beskrivelse})}</script><main>Annet innhold</main>`;
  const tekst=trekkUtAnnonse(html);assert.ok(tekst.endsWith("in English."));assert.ok(tekst.length>12000);assert.ok(!tekst.includes("Ignorer"));
  assert.throws(()=>trekkUtAnnonse("<main>tomt</main>"));
});
test("jobbdokument og radar.json har samme revisjon, kopi og sletting som brevene",async t=>{
  const {dir,lager}=await oppsett(t);
  assert.deepEqual(await lager.les("jobb-j1.json"),tomtJobbdokument("j1"));
  const a=await lager.skriv("jobb-j1.json",{...tomtJobbdokument("j1"),annonse:{tekst:"Første annonse.",kilde:"limt"}},0);
  assert.equal(a.revisjon,1);assert.equal(a.annonse.sjekksum,sjekksum("Første annonse."));
  assert.equal((await fs.stat(path.join(dir,"jobb-j1.json"))).mode&0o777,0o600);
  await assert.rejects(lager.skriv("jobb-j1.json",a,0),e=>e.code==="konflikt");
  const b=await lager.skriv("jobb-j1.json",{...a,annonse:{tekst:"Andre annonse.",kilde:"limt"}},1);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,"jobb-j1.forrige.json"),"utf8")).annonse.tekst,"Første annonse.");
  // Lagret dokument er normalisert: ukjente felt er borte, skjemaet er satt av lageret.
  assert.equal("ukjent" in await lager.skriv("jobb-j1.json",{...b,ukjent:1,skjemaVersjon:7},2),false);
  const r=await lager.skriv("radar.json",{revisjon:0,innstillinger:{pa:true,sokeord:["data"]}},0);
  assert.equal(r.innstillinger.pa,true);assert.deepEqual(r.innstillinger.sokeord,["data"]);
  await lager.slett("radar.json",1);
  assert.deepEqual(await lager.les("radar.json"),{...tomRadar(),revisjon:2});
  await assert.rejects(lager.skriv("jobb-j1.json",{...b,annonse:{tekst:"x".repeat(100001)}},3),e=>e.code==="ugyldig");
  assert.equal((await lager.les("jobb-j1.json")).revisjon,3);
});
test("listen har alle fire typer og ingen kopier eller fremmede filer",async t=>{
  const {dir,lager}=await oppsett(t);
  for(const n of ["cv.json","radar.json","brev-a.json","jobb-a.json","jobb-a.forrige.json","radar.forrige.json","jobb-a.odelagt-1.json","jobber.json","nokkel.txt"])
    await fs.writeFile(path.join(dir,n),"{}");
  await fs.mkdir(path.join(dir,"jobb-mappe.json"));
  assert.deepEqual(await lager.liste(),["brev-a.json","cv.json","jobb-a.json","radar.json"]);
});
test("utdraget leser bare jobbdokumenter og hopper over det det ikke forstår",async t=>{
  const {dir,lager}=await oppsett(t);
  await lager.skriv("jobb-a.json",{...tomtJobbdokument("a"),annonse:{tekst:"A.",hentet:"2026-10-01T10:00:00.000Z"},match:{prosent:70}},0);
  await lager.skriv("jobb-b.json",tomtJobbdokument("b"),0);
  await fs.writeFile(path.join(dir,"jobb-odelagt.json"),"ikke json");
  await fs.writeFile(path.join(dir,"jobb-nyere.json"),JSON.stringify({skjemaVersjon:2,match:{prosent:1}}));
  await fs.writeFile(path.join(dir,"brev-a.json"),JSON.stringify({skjemaVersjon:1,match:{prosent:9}}));
  assert.deepEqual(await lager.utdrag("jobb-",["match.prosent","annonse.hentet","annonse.sjekksum"]),{
    "jobb-a.json":{"match.prosent":70,"annonse.hentet":"2026-10-01T10:00:00.000Z","annonse.sjekksum":sjekksum("A.")},
    "jobb-b.json":{"annonse.hentet":null,"annonse.sjekksum":null}
  });
  for(const prefiks of ["cv","radar","","../","jobb"])await assert.rejects(lager.utdrag(prefiks,["a"]),e=>e.code==="ugyldig");
  await assert.rejects(lager.utdrag("jobb-",["__proto__"]),e=>e.code==="ugyldig");
  assert.deepEqual(await lagBrevlager(path.join(dir,"finnes-ikke")).utdrag("jobb-",["a"]),{});
});
test("navn som går ut av profilen avvises før noe leses eller skrives",async t=>{
  const {dir,lager}=await oppsett(t);
  const ute=path.join(path.dirname(dir),"jobb-x.json");
  for(const navn of ["../jobb-x.json","jobb-../x.json","jobb-x/../../jobb-x.json","../radar.json","/etc/passwd"]){
    await assert.rejects(lager.les(navn),e=>e.code==="ugyldig",navn);
    await assert.rejects(lager.skriv(navn,tomtJobbdokument("x"),0),e=>e.code==="ugyldig",navn);
    await assert.rejects(lager.slett(navn,0),e=>e.code==="ugyldig",navn);
    await assert.rejects(lager.gjenopprett(navn),e=>e.code==="ugyldig",navn);
  }
  await assert.rejects(fs.access(ute));
  assert.deepEqual(await fs.readdir(dir),[]);
});
