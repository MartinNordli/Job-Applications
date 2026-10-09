import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lagBrevlager } from "./brevlager.mjs";
import { lagBrevtjeneste } from "../src/brevtjeneste.mjs";

/* Syntetiske personer og selskaper. */
const a = () => ({ sprak:"nb",begrunnelse:"Annonsens språk.",kontaktperson:"",krav:[],bevis:[],virksomhet:[],uklarheter:[],merknader:[],maAvklares:false });
const BREV = "Til rekrutteringsteamet i Eksempel AS,\n\nJeg søker stillingen som kunderådgiver.\n\nMed vennlig hilsen\nKari Eksempel";
const b = (tekst=BREV) => ({tekst,sprak:"nb",merknader:[],pastander:[],maAvklares:false});
const modell = async p => ({data:p.trinn==="analyse"?a():b(),bruk:{input_tokens:10,output_tokens:20},modell:"syntetisk-modell"});
const vent = () => {let slipp;const promise=new Promise(r=>{slipp=r;});return {promise,slipp};};
const kilder = p => JSON.parse(p.kilder).kilder;
const RAD = {id:"j1",stilling:"Kunderådgiver",selskap:"Eksempel AS",sted:"Oslo",jobbtype:"fulltid",sektor:"finans",notat:"Privat: ring Per."};
async function oppsett(t, callback=modell, ekstra={}){
  const katalog=await fs.mkdtemp(path.join(os.tmpdir(),"brev-tjeneste-test-"));
  t.after(()=>fs.rm(katalog,{recursive:true,force:true}));
  const lager=lagBrevlager(katalog),kall=[];let id=0;
  const rad={...RAD};
  const lag=()=>lagBrevtjeneste({lager,hentJobb:async id=>id==="j1"?rad:null,
    lagId:()=>`id${++id}`,kallModell:async p=>{kall.push(p);return callback(p);},...ekstra});
  const tjeneste=lag();
  await tjeneste.lagreCv({...await tjeneste.hentCv(),tekst:"Kari Eksempel. Erfaring fra kundeservice."});
  await tjeneste.lagreBrev("j1",{...await tjeneste.hentBrev("j1"),annonse:{tekst:"Eksempel AS søker kunderådgiver.",url:"",hentet:null}});
  return {tjeneste,lager,kall,lag,katalog,rad};
}
async function generer(tjeneste){
  const k=await tjeneste.opprett("j1");
  await tjeneste.trinn("j1",k.id,"analyse");
  await tjeneste.trinn("j1",k.id,"skriv");
  return tjeneste.trinn("j1",k.id,"kontroller");
}
test("hele kjeden, manuell redigering og revisjon gir bevarte versjoner",async t=>{
  const {tjeneste,kall}=await oppsett(t);
  const ferdig=await generer(tjeneste);
  assert.equal(ferdig.kjoring.status,"ferdig");assert.equal(ferdig.dokument.versjoner.length,1);
  assert.deepEqual(kall.map(p=>p.trinn),["analyse","skriv","kontroll"]);
  const promptversjon = ferdig.dokument.versjoner[0].promptversjon;
  assert.equal(promptversjon,"brev-4");
  assert.ok(kall.every(p=>p.system.includes(`Promptversjon: ${promptversjon}`)));
  assert.equal(Object.hasOwn(ferdig.dokument.versjoner[0],"svar"),false);
  const manuell=await tjeneste.lagreBrev("j1",{...ferdig.dokument,tekst:"Min egen innledning og mitt eget språk."});
  const ny=await tjeneste.opprett("j1",{instruks:"Gjør brevet kortere."});
  assert.equal(ny.status,"venter");assert.equal(Object.hasOwn(ny,"svar"),false);
  await tjeneste.trinn("j1",ny.id,"skriv");
  const etter=await tjeneste.trinn("j1",ny.id,"kontroller");
  assert.equal(etter.dokument.versjoner.length,3);
  assert.ok(etter.dokument.versjoner.some(v=>v.manuell&&v.tekst===manuell.tekst));
  assert.equal(JSON.parse(kall[3].innhold).tidligereBrev,manuell.tekst);
  assert.deepEqual(kall.map(p=>p.trinn),["analyse","skriv","kontroll","skriv","kontroll"]);
});
test("utdatert lagring gir konflikt uten å endre gjeldende tekst",async t=>{
  const {tjeneste}=await oppsett(t);const d=await tjeneste.hentBrev("j1");
  await tjeneste.lagreBrev("j1",{...d,tekst:"Den nye teksten."});
  await assert.rejects(tjeneste.lagreBrev("j1",{...d,tekst:"Gammel fane."}),{code:"konflikt"});
  assert.equal((await tjeneste.hentBrev("j1")).tekst,"Den nye teksten.");
});
test("manuelle endringer under QA bevares og resultatet blir et nytt forslag",async t=>{
  const startet=vent(),slipp=vent();
  const {tjeneste}=await oppsett(t,async p=>{if(p.trinn==="kontroll"){startet.slipp();await slipp.promise;}return modell(p);});
  const k=await tjeneste.opprett("j1");await tjeneste.trinn("j1",k.id,"analyse");await tjeneste.trinn("j1",k.id,"skriv");
  const arbeid=tjeneste.trinn("j1",k.id,"kontroller");await startet.promise;
  await tjeneste.lagreBrev("j1",{...await tjeneste.hentBrev("j1"),tekst:"Manuell tekst skrevet mens modellen arbeider."});
  slipp.slipp();const r=await arbeid;
  assert.equal(r.dokument.tekst,"Manuell tekst skrevet mens modellen arbeider.");
  assert.equal(r.kjoring.nyttForslag,true);assert.equal(r.dokument.versjoner.length,2);
});
test("avbryt stanser videre trinn og et sent svar overskriver ikke brevet",async t=>{
  const startet=vent(),slipp=vent();
  const {tjeneste,kall}=await oppsett(t,async p=>{startet.slipp();await slipp.promise;return modell(p);});
  const k=await tjeneste.opprett("j1");const arbeid=tjeneste.trinn("j1",k.id,"analyse");
  const avvist=assert.rejects(arbeid);await startet.promise;
  await tjeneste.avbryt("j1",k.id);slipp.slipp();await avvist;
  assert.equal((await tjeneste.hentBrev("j1")).kjoring.status,"avbrutt");
  await assert.rejects(tjeneste.trinn("j1",k.id,"skriv"),{code:"opptatt"});assert.equal(kall.length,1);
});
test("påDelta føres til modellkallet med riktig felt, og aldri inn i dokumentet",async t=>{
  const {tjeneste,kall}=await oppsett(t,async p=>{
    p.påDelta?.("forhåndsvisning som aldri skal lagres");
    return modell(p);
  });
  const deltaer=[];
  const k=await tjeneste.opprett("j1");
  const påDelta=(tekst)=>deltaer.push(tekst);
  await tjeneste.trinn("j1",k.id,"analyse",{},{påDelta});
  await tjeneste.trinn("j1",k.id,"skriv",{},{påDelta});
  const r=await tjeneste.trinn("j1",k.id,"kontroller",{},{påDelta});
  assert.deepEqual(kall.map(p=>p.felt),["begrunnelse","tekst","tekst"]);
  assert.equal(deltaer.length,3);
  // Bare den oppfylte returverdien blir brevtekst. Deltaene finnes ikke i dokumentet.
  assert.equal(r.dokument.tekst,BREV);
  assert.equal(JSON.stringify(r.dokument).includes("forhåndsvisning"),false);
});
test("et gjenopptatt trinn kaller verken modellen eller påDelta",async t=>{
  const {tjeneste,kall}=await oppsett(t,async p=>{p.påDelta?.("tekstbit");return modell(p);});
  const deltaer=[];const påDelta=t=>deltaer.push(t);
  const k=await tjeneste.opprett("j1");
  await tjeneste.trinn("j1",k.id,"analyse",{},{påDelta});
  assert.equal(kall.length,1);assert.equal(deltaer.length,1);
  await tjeneste.trinn("j1",k.id,"analyse",{},{påDelta});
  assert.equal(kall.length,1);assert.equal(deltaer.length,1);
});
test("uten påDelta sendes verken felt eller tilbakekalling til modellen",async t=>{
  const {tjeneste,kall}=await oppsett(t);
  const k=await tjeneste.opprett("j1");await tjeneste.trinn("j1",k.id,"analyse");
  assert.equal(Object.hasOwn(kall[0],"felt"),false);
  assert.equal(Object.hasOwn(kall[0],"påDelta"),false);
});
test("lagret analyse kan fortsettes etter ny tjenesteinstans uten å betale analyse igjen",async t=>{
  const {tjeneste,kall,lag}=await oppsett(t);
  const k=await tjeneste.opprett("j1");await tjeneste.trinn("j1",k.id,"analyse");
  const ny=lag();assert.equal((await ny.hentBrev("j1")).kjoring.status,"venter");
  await ny.trinn("j1",k.id,"analyse");assert.equal(kall.length,1);
  await ny.trinn("j1",k.id,"skriv");await ny.trinn("j1",k.id,"skriv");assert.equal(kall.length,2);
  await ny.trinn("j1",k.id,"kontroller");await ny.trinn("j1",k.id,"kontroller");assert.equal(kall.length,3);
});
test("feil rekkefølge, manglende jobb og tomt grunnlag gir ingen modellkall",async t=>{
  const {tjeneste,kall}=await oppsett(t);
  await assert.rejects(tjeneste.opprett("ukjent"),{code:"finnes-ikke"});
  const k=await tjeneste.opprett("j1");
  await assert.rejects(tjeneste.trinn("j1",k.id,"skriv"),{code:"opptatt"});
  await assert.rejects(tjeneste.trinn("j1",k.id,"ukjent"),{code:"ugyldig"});
  await tjeneste.avbryt("j1",k.id);
  await tjeneste.lagreCv({...await tjeneste.hentCv(),tekst:""});
  await assert.rejects(tjeneste.opprett("j1"),{code:"ugyldig-grunnlag"});assert.equal(kall.length,0);
});
test("en kildeendring krever ny analyse",async t=>{
  const {tjeneste,kall}=await oppsett(t);
  const r=await generer(tjeneste);assert.equal(Object.hasOwn(r.kjoring,"svar"),false);
  await tjeneste.lagreCv({...await tjeneste.hentCv(),tekst:"Oppdatert CV med en ny erfaring."});
  const k=await tjeneste.opprett("j1",{instruks:"Prøv igjen med den nye CV-en."});
  assert.equal(k.status,"klar");await tjeneste.trinn("j1",k.id,"analyse");assert.equal(kall.length,4);
});
test("eksport og import inkluderer egne kilder og versjoner, men ingen aktiv kjøring",async t=>{
  const {tjeneste}=await oppsett(t);await generer(tjeneste);
  const eksport=await tjeneste.eksporter();assert.equal(eksport.dokumenter["brev-j1.json"].kjoring,null);
  assert.match(eksport.dokumenter["cv.json"].tekst,/Kari/);
  const annen=await oppsett(t);
  await annen.tjeneste.slettBrev("j1",(await annen.tjeneste.hentBrev("j1")).revisjon);
  await annen.tjeneste.slettCv((await annen.tjeneste.hentCv()).revisjon);
  // CV, brev og jobbdokumentet annonsen ble flyttet til da brevet ble skrevet.
  assert.equal((await annen.tjeneste.importer(eksport)).antall,3);
  assert.equal((await annen.tjeneste.hentBrev("j1")).versjoner.length,1);
  await assert.rejects(annen.tjeneste.importer(eksport),{code:"konflikt"});
});
test("sikkerhetskopien er versjon 3 og har med stilreferansen, jobbdokumentene og radar.json",async t=>{
  const {tjeneste,lager}=await oppsett(t);await generer(tjeneste);
  const jd=await lager.les("jobb-j1.json");
  await lager.skriv("jobb-j1.json",{...jd,annonse:{tekst:"Eksempel AS søker kunderådgiver.",kilde:"limt"},match:{prosent:77}},jd.revisjon);
  await lager.skriv("radar.json",{revisjon:0,innstillinger:{pa:true}},0);
  await tjeneste.lagreStil({revisjon:0,tekst:"Mitt eget brev."});
  const eksport=await tjeneste.eksporter();
  assert.equal(eksport.skjemaVersjon,3);
  assert.deepEqual(Object.keys(eksport.dokumenter),["brev-j1.json","cv.json","jobb-j1.json","radar.json","stil.json"]);
  const annen=await oppsett(t);
  await annen.tjeneste.slettBrev("j1",(await annen.tjeneste.hentBrev("j1")).revisjon);
  await annen.tjeneste.slettCv((await annen.tjeneste.hentCv()).revisjon);
  assert.equal((await annen.tjeneste.importer(eksport)).antall,5);
  assert.equal((await annen.tjeneste.hentStil()).tekst,"Mitt eget brev.");
  const jobb=await annen.lager.les("jobb-j1.json");
  assert.equal(jobb.match.prosent,77);assert.equal(jobb.annonse.kilde,"limt");
  assert.deepEqual((await annen.lager.les("radar.json")).innstillinger,{pa:true});
  // Ingenting som allerede finnes erstattes, heller ikke et jobbdokument alene.
  const tredje=await oppsett(t);
  await tredje.lager.skriv("jobb-j1.json",{revisjon:0,annonse:{tekst:"Min egen annonse."}},0);
  await assert.rejects(tredje.tjeneste.importer({...eksport,dokumenter:{"jobb-j1.json":eksport.dokumenter["jobb-j1.json"]}}),{code:"konflikt"});
  assert.equal((await tredje.lager.les("jobb-j1.json")).annonse.tekst,"Min egen annonse.");
  // radar.json finnes ikke der ennå og legges inn. Andre gang finnes den.
  const bareRadar={...eksport,dokumenter:{"radar.json":eksport.dokumenter["radar.json"]}};
  assert.equal((await tredje.tjeneste.importer(bareRadar)).antall,1);
  await assert.rejects(tredje.tjeneste.importer(bareRadar),{code:"konflikt"});
});
test("versjon 1 og 2 kan fortsatt gjenopprettes, men bare med dokumentene de kjente",async t=>{
  const {tjeneste}=await oppsett(t);await generer(tjeneste);
  const v3=await tjeneste.eksporter();
  const v1={format:"jobbsoknader-brev",skjemaVersjon:1,eksportert:v3.eksportert,dokumenter:{"cv.json":v3.dokumenter["cv.json"],"brev-j1.json":v3.dokumenter["brev-j1.json"]}};
  const annen=await oppsett(t);
  await annen.tjeneste.slettBrev("j1",(await annen.tjeneste.hentBrev("j1")).revisjon);
  await annen.tjeneste.slettCv((await annen.tjeneste.hentCv()).revisjon);
  for(const [navn,d] of [["jobb-j1.json",{skjemaVersjon:1,revisjon:1}],["radar.json",{skjemaVersjon:1,revisjon:1}],["stil.json",{skjemaVersjon:1,revisjon:1,tekst:"x"}]])
    await assert.rejects(annen.tjeneste.importer({...v1,dokumenter:{...v1.dokumenter,[navn]:d}}),{code:"ugyldig"});
  // Avvist før første skriving: ingenting er lagt inn.
  assert.equal((await annen.tjeneste.hentCv()).tekst,"");
  assert.equal((await annen.tjeneste.importer(v1)).antall,2);
  assert.match((await annen.tjeneste.hentCv()).tekst,/Kari/);
  // Versjon 2 kjente ikke stilreferansen.
  const v2={format:"jobbsoknader-brev",skjemaVersjon:2,eksportert:v3.eksportert,dokumenter:{"stil.json":{skjemaVersjon:1,revisjon:1,tekst:"x"}}};
  await assert.rejects(annen.tjeneste.importer(v2),{code:"ugyldig"});
});
test("ukjente versjoner, navn og former i sikkerhetskopien avvises",async t=>{
  const {tjeneste}=await oppsett(t);
  const grunn={format:"jobbsoknader-brev",skjemaVersjon:3,dokumenter:{}};
  for(const data of [null,[],{...grunn,format:"annet"},{...grunn,skjemaVersjon:4},{...grunn,skjemaVersjon:"2"},{...grunn,skjemaVersjon:"constructor"},
    {...grunn,skjemaVersjon:"__proto__"},{...grunn,dokumenter:[]},{...grunn,dokumenter:null}])
    await assert.rejects(tjeneste.importer(data),{code:"ugyldig"},JSON.stringify(data));
  for(const navn of ["nokkel.txt","jobber.json","../cv.json","jobb-x.forrige.json","jobb-../x.json"])
    await assert.rejects(tjeneste.importer({...grunn,dokumenter:{[navn]:{skjemaVersjon:1,revisjon:1}}}),{code:"ugyldig"},navn);
  await assert.rejects(tjeneste.importer({...grunn,dokumenter:JSON.parse('{"__proto__":{"skjemaVersjon":1,"revisjon":1}}')}),{code:"ugyldig"});
  await assert.rejects(tjeneste.importer({...grunn,dokumenter:{"jobb-x.json":{skjemaVersjon:1,revisjon:1,annonse:{tekst:"x",url:"javascript:1"}}}}),{code:"ugyldig"});
});
test("faktakorrigeringer følger valgt versjon til neste revisjon uten å bli dagens stilinstruks",async t=>{
  const {tjeneste,kall}=await oppsett(t);await generer(tjeneste);
  const første=await tjeneste.opprett("j1",{instruks:"Maks 100 ord. Korrigering: Jeg vant en servicepris."});
  await tjeneste.trinn("j1",første.id,"skriv");await tjeneste.trinn("j1",første.id,"kontroller");
  const andre=await tjeneste.opprett("j1",{instruks:"Utdyp eksemplene."});
  assert.ok(andre.grunnlag.historikk.some(h=>h.includes("servicepris")));
  assert.equal(andre.instruks,"Utdyp eksemplene.");
  if(andre.status==="klar")await tjeneste.trinn("j1",andre.id,"analyse");
  await tjeneste.trinn("j1",andre.id,"skriv");
  const inn=JSON.parse(kall.at(-1).innhold);
  assert.ok(kilder(kall.at(-1)).historikk.some(h=>h.includes("servicepris")));
  assert.equal(inn.revisjonsinstruks,"Utdyp eksemplene.");
  assert.equal(kall.at(-1).kilder.includes("Utdyp eksemplene"),false);
  await tjeneste.trinn("j1",andre.id,"kontroller");
  const d=await tjeneste.hentBrev("j1");const opprinnelig=d.versjoner[0];
  await tjeneste.lagreBrev("j1",{...d,aktivVersjon:opprinnelig.id,tekst:opprinnelig.tekst});
  const gren=await tjeneste.opprett("j1",{instruks:"Kortere fra første versjon."});
  assert.equal(gren.grunnlag.historikk.some(h=>h.includes("servicepris")),false);
});

/* ---------- brev-4: grunnlaget, annonsen og kjøringer som fortsetter ---------- */

test("grunnlaget har søknadsfeltene og stilreferansen, men ikke notat, kontekst eller svar",async t=>{
  const {tjeneste,kall}=await oppsett(t);
  const d=await tjeneste.hentBrev("j1");
  await tjeneste.lagreBrev("j1",{...d,kontekst:"Gammel kontekst som ikke skal sendes."});
  await tjeneste.lagreStil({revisjon:0,tekst:"Til rekrutteringsteamet i Testfirma,\n\nKort og konkret."});
  const k=await tjeneste.opprett("j1");
  assert.deepEqual(k.grunnlag.jobb,{selskap:"Eksempel AS",stilling:"Kunderådgiver",sted:"Oslo",jobbtype:"Fast stilling",sektor:"Finans"});
  assert.match(k.grunnlag.stilreferanse,/Testfirma/);
  for(const felt of ["kontekst","svar","notat","stilling","selskap"]) assert.equal(Object.hasOwn(k.grunnlag,felt),false,felt);
  await tjeneste.trinn("j1",k.id,"analyse");
  const sendt=kall[0].kilder;
  assert.equal(sendt.includes("Gammel kontekst"),false);assert.equal(sendt.includes("ring Per"),false);
  assert.match(sendt,/Testfirma/);
});
test("annonsen kommer fra jobbdokumentet, og flyttes dit fra brevet én gang",async t=>{
  const {tjeneste,lager,kall}=await oppsett(t);
  let k=await tjeneste.opprett("j1");
  assert.equal(k.grunnlag.annonse,"Eksempel AS søker kunderådgiver.");
  const flyttet=await lager.les("jobb-j1.json");
  assert.equal(flyttet.annonse.kilde,"brev");assert.equal(flyttet.annonse.tekst,"Eksempel AS søker kunderådgiver.");
  await tjeneste.avbryt("j1",k.id);
  await lager.skriv("jobb-j1.json",{...flyttet,annonse:{tekst:"Eksempel AS søker kunderådgiver med erfaring fra bank.",kilde:"import"}},flyttet.revisjon);
  // Brevets eget annonsefelt er ikke lenger kilden.
  await tjeneste.lagreBrev("j1",{...await tjeneste.hentBrev("j1"),annonse:{tekst:"Utdatert annonse i brevet.",url:"",hentet:null}});
  k=await tjeneste.opprett("j1");
  assert.equal(k.grunnlag.annonse,"Eksempel AS søker kunderådgiver med erfaring fra bank.");
  await tjeneste.trinn("j1",k.id,"analyse");
  assert.equal(kilder(kall[0]).annonse,"Eksempel AS søker kunderådgiver med erfaring fra bank.");
});
test("annonseFor kan injiseres, som tekst eller som objekt med tekst",async t=>{
  for(const svar of ["Injisert annonse for kunderådgiver.",{tekst:"Injisert annonse for kunderådgiver.",url:""}]){
    const spurt=[];
    const {tjeneste}=await oppsett(t,modell,{annonseFor:async id=>{spurt.push(id);return svar;}});
    const k=await tjeneste.opprett("j1");
    assert.equal(k.grunnlag.annonse,"Injisert annonse for kunderådgiver.");assert.deepEqual(spurt,["j1"]);
  }
});
test("uten annonse eller CV starter ingen kjøring, og feilen sier hva som mangler",async t=>{
  let annonse="";
  const {tjeneste,kall}=await oppsett(t,modell,{annonseFor:async()=>annonse});
  await assert.rejects(tjeneste.opprett("j1"),{code:"ugyldig-grunnlag",message:/mangler annonsen/});
  annonse="Eksempel AS søker kunderådgiver.";
  await tjeneste.lagreCv({...await tjeneste.hentCv(),tekst:""});
  await assert.rejects(tjeneste.opprett("j1"),{code:"ugyldig-grunnlag",message:/CV-en/});
  assert.equal((await tjeneste.hentBrev("j1")).kjoring,null);assert.equal(kall.length,0);
});
test("en kjøring som står i venter fortsetter rett til skriving uten ny analyse",async t=>{
  const {tjeneste,kall,lag}=await oppsett(t);
  const k=await tjeneste.opprett("j1");await tjeneste.trinn("j1",k.id,"analyse");
  const revisjon=(await tjeneste.hentBrev("j1")).revisjon;
  // Fanen ble lukket her. Neste «Skriv utkast» skal fortsette, ikke starte på nytt.
  const ny=lag();
  const igjen=await ny.opprett("j1");
  assert.equal(igjen.id,k.id);assert.equal(igjen.status,"venter");
  assert.equal((await ny.hentBrev("j1")).revisjon,revisjon,"å fortsette skriver ingenting");
  await ny.trinn("j1",igjen.id,"analyse");await ny.trinn("j1",igjen.id,"skriv");
  const r=await ny.trinn("j1",igjen.id,"kontroller");
  assert.equal(r.kjoring.status,"ferdig");
  assert.deepEqual(kall.map(p=>p.trinn),["analyse","skriv","kontroll"]);
  // En annen forespørsel må vente til den ventende er avbrutt.
  const tredje=await ny.opprett("j1");await ny.trinn("j1",tredje.id,"analyse");
  await assert.rejects(ny.opprett("j1",{instruks:"Kortere."}),{code:"opptatt"});
});
test("svar sendt til skrivetrinnet av en eldre klient lagres ikke og brukes ikke",async t=>{
  const {tjeneste,kall}=await oppsett(t);
  const k=await tjeneste.opprett("j1");await tjeneste.trinn("j1",k.id,"analyse");
  await tjeneste.trinn("j1",k.id,"skriv",{q1:"Et svar fra den gamle flaten."});
  const d=await tjeneste.hentBrev("j1");
  assert.equal(JSON.stringify(d).includes("gamle flaten"),false);
  assert.equal(kall.some(p=>p.innhold.includes("gamle flaten")||p.kilder.includes("gamle flaten")),false);
});
test("en kjøring fra brev-3 med kontekst og svar kan skrives ferdig",async t=>{
  const {tjeneste,lager,kall}=await oppsett(t);
  const d=await tjeneste.hentBrev("j1");
  const gammelAnalyse={sprak:"nb",begrunnelse:"Bokmål.",sporsmal:[{id:"q1",tekst:"Hva liker du?"}],krav:[],bevis:[],uklarheter:[],maAvklares:false,bruk:null,modell:"gammel"};
  await lager.skriv("brev-j1.json",{...d,kontekst:"Gammel kontekst.",kjoring:{id:"gammel",status:"venter",opprettet:"2026-09-01T10:00:00.000Z",
    grunnlag:{cv:"Kari Eksempel. Erfaring fra kundeservice.",annonse:"Eksempel AS søker kunderådgiver.",kontekst:"Gammel kontekst.",sprak:"auto",
      stilling:"Kunderådgiver",selskap:"Eksempel AS",leverandor:"anthropic",historikk:[]},
    cvRevisjon:1,utgangspunkt:"",instruks:"",analyse:gammelAnalyse,svar:{q1:"Gammelt svar."},utkast:null}},d.revisjon);
  const k=await tjeneste.opprett("j1");assert.equal(k.id,"gammel");
  await tjeneste.trinn("j1",k.id,"analyse");await tjeneste.trinn("j1",k.id,"skriv");
  const r=await tjeneste.trinn("j1",k.id,"kontroller");
  assert.equal(r.kjoring.status,"ferdig");
  // Det gamle grunnlaget kjente ikke stedet fra søknaden, så det regnes som
  // endret: brevet havner i versjonslisten i stedet for å bytte teksten.
  assert.equal(r.kjoring.nyttForslag,true);assert.equal(r.dokument.versjoner[0].tekst,BREV);
  assert.deepEqual(kall.map(p=>p.trinn),["skriv","kontroll"]);
  assert.equal(kilder(kall[0]).jobb.selskap,"Eksempel AS");
  assert.equal(kall.some(p=>p.kilder.includes("Gammel kontekst")||p.innhold.includes("Gammelt svar")),false);
  // Gamle versjoner med kontekst og svar lastes fortsatt.
  await lager.skriv("brev-j1.json",{...r.dokument,versjoner:[...r.dokument.versjoner,{...r.dokument.versjoner[0],id:"v-gammel",svar:{q1:"x"},grunnlag:{...r.dokument.versjoner[0].grunnlag,kontekst:"x"}}]},r.dokument.revisjon);
  assert.equal((await tjeneste.hentBrev("j1")).versjoner.length,2);
});
test("en endret stilling krever ny analyse, en endret stilreferanse gjør det ikke",async t=>{
  const {tjeneste,kall,rad}=await oppsett(t);
  await generer(tjeneste);
  await tjeneste.lagreStil({revisjon:0,tekst:"Et nytt eget brev."});
  let k=await tjeneste.opprett("j1",{instruks:"Kortere."});
  assert.equal(k.status,"venter");assert.match(k.grunnlag.stilreferanse,/nytt eget brev/);
  await tjeneste.trinn("j1",k.id,"skriv");await tjeneste.trinn("j1",k.id,"kontroller");
  rad.stilling="Seniorrådgiver";
  k=await tjeneste.opprett("j1",{instruks:"Enda kortere."});
  assert.equal(k.status,"klar");
  assert.equal(kall.filter(p=>p.trinn==="analyse").length,1);
});
test("en annonse som endres mens modellen skriver, gir et nytt forslag i stedet for å bytte teksten",async t=>{
  const startet=vent(),slipp=vent();
  const {tjeneste,lager}=await oppsett(t,async p=>{if(p.trinn==="kontroll"){startet.slipp();await slipp.promise;}return modell(p);});
  const k=await tjeneste.opprett("j1");await tjeneste.trinn("j1",k.id,"analyse");await tjeneste.trinn("j1",k.id,"skriv");
  const arbeid=tjeneste.trinn("j1",k.id,"kontroller");await startet.promise;
  const jd=await lager.les("jobb-j1.json");
  await lager.skriv("jobb-j1.json",{...jd,annonse:{tekst:"En helt annen annonse.",kilde:"limt"}},jd.revisjon);
  slipp.slipp();const r=await arbeid;
  assert.equal(r.kjoring.nyttForslag,true);assert.equal(r.dokument.tekst,"");assert.equal(r.dokument.versjoner.length,1);
});

for(const type of ["cv","stil","brev"]){
  const operasjoner = tjeneste => type==="cv" ? {
    hent:()=>tjeneste.hentCv(),lagre:d=>tjeneste.lagreCv(d),slett:r=>tjeneste.slettCv(r),
    gjenopprett:()=>tjeneste.gjenopprettCv(),fil:"cv.json"
  } : type==="stil" ? {
    hent:()=>tjeneste.hentStil(),lagre:d=>tjeneste.lagreStil(d),slett:r=>tjeneste.slettStil(r),
    gjenopprett:()=>tjeneste.gjenopprettStil(),fil:"stil.json"
  } : {
    hent:()=>tjeneste.hentBrev("j1"),lagre:d=>tjeneste.lagreBrev("j1",d),slett:r=>tjeneste.slettBrev("j1",r),
    gjenopprett:()=>tjeneste.gjenopprettBrev("j1"),fil:"brev-j1.json"
  };
  /* CV og brev finnes etter oppsettet. Stilreferansen må legges inn. */
  const klar = async t => {
    const o=await oppsett(t);
    if(type==="stil") await o.tjeneste.lagreStil({revisjon:0,tekst:"Et eget brev som stilreferanse."});
    return o;
  };
  test(`${type}: slett og opprett på nytt avviser en gammel fanes revisjon`,async t=>{
    const {tjeneste}=await klar(t),op=operasjoner(tjeneste);
    const gammel=await op.hent();await op.slett(gammel.revisjon);
    const tom=await op.hent();assert.equal(tom.tekst,"");assert.ok(tom.revisjon>gammel.revisjon);
    const ny=await op.lagre({...tom,tekst:"Nytt innhold etter sletting."});
    assert.ok(ny.revisjon>tom.revisjon);
    await assert.rejects(op.lagre({...gammel,tekst:"Skriving fra en gammel fane."}),{code:"konflikt"});
    await assert.rejects(op.slett(gammel.revisjon),{code:"konflikt"});
    assert.equal((await op.hent()).tekst,"Nytt innhold etter sletting.");
  });
  test(`${type}: gjenoppretting etter skadet hovedfil tildeler ny revisjon og avviser gammel fane`,async t=>{
    const {tjeneste,katalog}=await klar(t),op=operasjoner(tjeneste);
    const før=await op.hent();const siste=await op.lagre({...før,tekst:"Tekst som lå i den skadde hovedfilen."});
    await fs.writeFile(path.join(katalog,op.fil),"{ødelagt JSON");
    await assert.rejects(op.hent(),{code:"odelagt"});
    const gjenopprettet=await op.gjenopprett();
    assert.equal(gjenopprettet.tekst,før.tekst);assert.ok(gjenopprettet.revisjon>siste.revisjon);
    await assert.rejects(op.lagre({...siste,tekst:"Stale fane etter recovery."}),{code:"konflikt"});
    assert.equal((await op.hent()).tekst,før.tekst);
  });
  test(`${type}: import til slettet dokument beholder monoton revisjon`,async t=>{
    const {tjeneste}=await klar(t),op=operasjoner(tjeneste);
    const gammel=await op.hent();const eksport=await tjeneste.eksporter();
    eksport.dokumenter={[op.fil]:eksport.dokumenter[op.fil]};
    await op.slett(gammel.revisjon);const tom=await op.hent();
    assert.equal((await tjeneste.importer(eksport)).antall,1);
    const tilbake=await op.hent();assert.equal(tilbake.tekst,gammel.tekst);assert.ok(tilbake.revisjon>tom.revisjon);
    await assert.rejects(op.lagre({...gammel,tekst:"En gammel fane overskriver sikkerhetskopien."}),{code:"konflikt"});
  });
  test(`${type}: korrupt sikkerhetskopi bevares og stanser lagring uten å endre hovedfilen`,async t=>{
    const {tjeneste,katalog}=await klar(t),op=operasjoner(tjeneste);
    const siste=await op.lagre({...await op.hent(),tekst:"Gyldig hovedfil som skal bevares."});
    const hovedfil=path.join(katalog,op.fil),kopifil=path.join(katalog,op.fil.replace(/\.json$/,".forrige.json"));
    const original=await fs.readFile(hovedfil);
    const ødelagt=Buffer.from("{ufullstendig sikkerhetskopi");await fs.writeFile(kopifil,ødelagt);
    await assert.rejects(op.lagre({...siste,tekst:"Dette skal ikke bli skrevet."}),{code:"odelagt"});
    assert.deepEqual(await fs.readFile(hovedfil),original);
    assert.deepEqual(await fs.readFile(kopifil),ødelagt);
    assert.equal((await op.hent()).tekst,"Gyldig hovedfil som skal bevares.");
  });
}
