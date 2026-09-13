import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {lagBrevlager} from "./brevlager.mjs";
import {tomCv,tomtBrev} from "../src/brevdata.mjs";
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
