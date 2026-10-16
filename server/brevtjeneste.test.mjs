import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lagBrevlager } from "./brevlager.mjs";
import { lagBrevtjeneste } from "../src/brevtjeneste.mjs";
import { lagJobbdokumenter } from "../src/jobbdokumenttjeneste.mjs";

/* Syntetiske personer, selskaper og sider. */
const BREV = "Til rekrutteringsteamet i Eksempel AS,\n\nJeg søker stillingen som kunderådgiver.\n\nMed vennlig hilsen\nKari Eksempel";
const b = (tekst=BREV) => ({sprak:"nb",tekst,pastander:[],merknader:[],maAvklares:false});
/* Siden annonsen hentes fra: meny og bunntekst rundt selve annonsen. */
const ANNONSELINJER = ["Eksempel AS søker en kunderådgiver til kontoret i Oslo.","Du vil svare kunder på telefon og chat, og følge opp saker til de er løst.",
  "Vi ser etter deg som har erfaring fra kundeservice og liker å forklare ting enkelt.","Søknadsfrist er 1. desember. Kontaktperson er Per Eksempel."];
const SIDE = `<html><body><nav>Meny</nav><main><p>Logg inn</p><p>Godta informasjonskapsler</p>${ANNONSELINJER.map(l=>`<p>${l}</p>`).join("")}<p>Andre stillinger: Lagermedarbeider</p></main></body></html>`;
const uttrekk = {erAnnonse:true,behold:[{fra:3,til:6}]};
const modell = async p => ({data:p.formal==="annonse"?uttrekk:b(),bruk:{input_tokens:10,output_tokens:20},modell:p.formal==="annonse"?"syntetisk-haiku":"syntetisk-modell"});
const vent = () => {let slipp;const promise=new Promise(r=>{slipp=r;});return {promise,slipp};};
const soknad = p => JSON.parse(p.kilder[1]).soknad;
const RAD = {id:"j1",stilling:"Kunderådgiver",selskap:"Eksempel AS",sted:"Oslo",jobbtype:"fulltid",sektor:"finans",notat:"Privat: ring Per.",lenke:""};
async function oppsett(t, callback=modell, {annonse="Eksempel AS søker kunderådgiver.",lenke="",hentSide}={}){
  const katalog=await fs.mkdtemp(path.join(os.tmpdir(),"brev-tjeneste-test-"));
  t.after(()=>fs.rm(katalog,{recursive:true,force:true}));
  const lager=lagBrevlager(katalog),kall=[],hentet=[];let id=0;
  const rad={...RAD,lenke};
  const hentJobb=async id=>id==="j1"?rad:null;
  const side=hentSide??(async url=>{hentet.push(url);return {status:200,sluttUrl:url,html:SIDE};});
  const lag=()=>lagBrevtjeneste({lager,hentJobb,lagId:()=>`id${++id}`,kallModell:async p=>{kall.push(p);return callback(p);},
    jobbdokumenter:lagJobbdokumenter({lager,hentJobb,hentSide:side})});
  const tjeneste=lag();
  await tjeneste.lagreCv({...await tjeneste.hentCv(),tekst:"Kari Eksempel. Erfaring fra kundeservice."});
  if(annonse) await tjeneste.lagreBrev("j1",{...await tjeneste.hentBrev("j1"),annonse:{tekst:annonse,url:"",hentet:null}});
  return {tjeneste,lager,kall,hentet,lag,katalog,rad};
}
async function generer(tjeneste,inn){
  const k=await tjeneste.opprett("j1",inn);
  return tjeneste.trinn("j1",k.id,"skriv");
}
test("ett modellkall per brev, og manuell redigering og ny versjon gir bevarte versjoner",async t=>{
  const {tjeneste,kall,hentet}=await oppsett(t);
  const k=await tjeneste.opprett("j1");
  assert.equal(k.status,"klar");assert.equal(kall.length,0,"å opprette koster ingenting");
  const ferdig=await tjeneste.trinn("j1",k.id,"skriv");
  assert.equal(ferdig.kjoring.status,"ferdig");assert.equal(ferdig.dokument.versjoner.length,1);
  assert.deepEqual(kall.map(p=>[p.trinn,p.formal]),[["skriv","brev"]]);
  assert.deepEqual(hentet,[],"annonsen fantes, så ingenting ble hentet");
  const v=ferdig.dokument.versjoner[0];
  assert.equal(v.promptversjon,"brev-5");assert.equal(v.modell,"syntetisk-modell");
  assert.deepEqual(v.bruk,[{input_tokens:10,output_tokens:20}]);
  for(const felt of ["analyse","svar","annonseuttrekk"]) assert.equal(Object.hasOwn(v,felt),false,felt);
  assert.ok(kall[0].system.includes("Promptversjon: brev-5"));
  assert.equal(ferdig.dokument.tekst,BREV);
  const manuell=await tjeneste.lagreBrev("j1",{...ferdig.dokument,tekst:"Min egen innledning og mitt eget språk."});
  const ny=await tjeneste.opprett("j1",{instruks:"Gjør brevet kortere."});
  assert.equal(ny.status,"klar");
  const etter=await tjeneste.trinn("j1",ny.id,"skriv");
  assert.equal(etter.dokument.versjoner.length,3);
  assert.ok(etter.dokument.versjoner.some(v=>v.manuell&&v.tekst===manuell.tekst));
  assert.equal(JSON.parse(kall[1].innhold).tidligereBrev,manuell.tekst);
  assert.equal(kall.length,2);
});
test("utdatert lagring gir konflikt uten å endre gjeldende tekst",async t=>{
  const {tjeneste}=await oppsett(t);const d=await tjeneste.hentBrev("j1");
  await tjeneste.lagreBrev("j1",{...d,tekst:"Den nye teksten."});
  await assert.rejects(tjeneste.lagreBrev("j1",{...d,tekst:"Gammel fane."}),{code:"konflikt"});
  assert.equal((await tjeneste.hentBrev("j1")).tekst,"Den nye teksten.");
});
test("manuelle endringer mens modellen skriver bevares, og resultatet blir et nytt forslag",async t=>{
  const startet=vent(),slipp=vent();
  const {tjeneste}=await oppsett(t,async p=>{startet.slipp();await slipp.promise;return modell(p);});
  const k=await tjeneste.opprett("j1");
  const arbeid=tjeneste.trinn("j1",k.id,"skriv");await startet.promise;
  assert.equal((await tjeneste.hentBrev("j1")).kjoring.status,"skriver");
  await tjeneste.lagreBrev("j1",{...await tjeneste.hentBrev("j1"),tekst:"Manuell tekst skrevet mens modellen arbeider."});
  slipp.slipp();const r=await arbeid;
  assert.equal(r.dokument.tekst,"Manuell tekst skrevet mens modellen arbeider.");
  assert.equal(r.kjoring.nyttForslag,true);assert.equal(r.dokument.versjoner.length,2);
});
test("avbryt stanser skrivingen, og et sent svar overskriver ikke brevet",async t=>{
  const startet=vent(),slipp=vent();
  const {tjeneste,kall}=await oppsett(t,async p=>{startet.slipp();await slipp.promise;return modell(p);});
  const k=await tjeneste.opprett("j1");const arbeid=tjeneste.trinn("j1",k.id,"skriv");
  const avvist=assert.rejects(arbeid);await startet.promise;
  await tjeneste.avbryt("j1",k.id);slipp.slipp();await avvist;
  const d=await tjeneste.hentBrev("j1");
  assert.equal(d.kjoring.status,"avbrutt");assert.equal(d.versjoner.length,0);assert.equal(d.tekst,"");
  await assert.rejects(tjeneste.trinn("j1",k.id,"skriv"),{code:"opptatt"});assert.equal(kall.length,1);
});
test("påDelta føres til modellkallet med feltet tekst, og aldri inn i dokumentet",async t=>{
  const {tjeneste,kall}=await oppsett(t,async p=>{p.påDelta?.("forhåndsvisning som aldri skal lagres");return modell(p);});
  const deltaer=[];
  const k=await tjeneste.opprett("j1");
  const r=await tjeneste.trinn("j1",k.id,"skriv",{påDelta:tekst=>deltaer.push(tekst)});
  assert.deepEqual(kall.map(p=>p.felt),["tekst"]);assert.equal(deltaer.length,1);
  assert.equal(r.dokument.tekst,BREV);
  assert.equal(JSON.stringify(r.dokument).includes("forhåndsvisning"),false);
});
test("en ferdig kjøring gis tilbake uten nytt modellkall, og uten påDelta sendes verken felt eller tilbakekalling",async t=>{
  const {tjeneste,kall}=await oppsett(t);
  const k=await tjeneste.opprett("j1");const første=await tjeneste.trinn("j1",k.id,"skriv");
  assert.equal(Object.hasOwn(kall[0],"felt"),false);assert.equal(Object.hasOwn(kall[0],"påDelta"),false);
  const igjen=await tjeneste.trinn("j1",k.id,"skriv",{påDelta:()=>assert.fail("ingen deltaer")});
  assert.equal(kall.length,1);assert.deepEqual(igjen.dokument.versjoner,første.dokument.versjoner);
});
test("ukjent trinn, manglende jobb og tomt grunnlag gir ingen modellkall",async t=>{
  const {tjeneste,kall}=await oppsett(t);
  await assert.rejects(tjeneste.opprett("ukjent"),{code:"finnes-ikke"});
  const k=await tjeneste.opprett("j1");
  for(const gammelt of ["analyse","kontroller","ukjent"]) await assert.rejects(tjeneste.trinn("j1",k.id,gammelt),{code:"ugyldig"},gammelt);
  await assert.rejects(tjeneste.trinn("j1","annen-kjoring","skriv"),{code:"konflikt"});
  await tjeneste.avbryt("j1",k.id);
  await tjeneste.lagreCv({...await tjeneste.hentCv(),tekst:""});
  await assert.rejects(tjeneste.opprett("j1"),{code:"ugyldig-grunnlag",message:/CV-en/});assert.equal(kall.length,0);
});
test("en kjøring som skriver, må avbrytes før en ny, og en i klar erstattes med kildene slik de er nå",async t=>{
  const startet=vent(),slipp=vent();
  const {tjeneste}=await oppsett(t,async p=>{startet.slipp();await slipp.promise;return modell(p);});
  const første=await tjeneste.opprett("j1");
  await tjeneste.lagreCv({...await tjeneste.hentCv(),tekst:"Kari Eksempel. Oppdatert CV med en ny erfaring."});
  const andre=await tjeneste.opprett("j1",{instruks:"Kortere."});
  assert.notEqual(andre.id,første.id);assert.match(andre.grunnlag.cv,/Oppdatert CV/);
  await assert.rejects(tjeneste.trinn("j1",første.id,"skriv"),{code:"konflikt"});
  const arbeid=tjeneste.trinn("j1",andre.id,"skriv");await startet.promise;
  await assert.rejects(tjeneste.opprett("j1"),{code:"opptatt"});
  slipp.slipp();await arbeid;
});
test("kodekontrollen avviser oppdiktede fakta: ingen versjon lagres, og kjøringen står som feilet",async t=>{
  const oppdiktet={...b(),pastander:[{tekst:"Ledet et team på tolv",kilder:[{kilde:"cv",sitat:"ledet et team på tolv"}]}]};
  const {tjeneste,kall}=await oppsett(t,async p=>({data:oppdiktet,bruk:null,modell:"syntetisk-modell"}));
  const k=await tjeneste.opprett("j1");
  await assert.rejects(tjeneste.trinn("j1",k.id,"skriv"),{code:"kildefeil"});
  const d=await tjeneste.hentBrev("j1");
  assert.equal(d.kjoring.status,"feilet");assert.equal(d.kjoring.feil.code,"kildefeil");
  assert.equal(d.versjoner.length,0);assert.equal(d.tekst,"");assert.equal(kall.length,1,"ingen nye forsøk i skjul");
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
  assert.equal((await annen.lager.les("radar.json")).innstillinger.pa,true);
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
test("faktakorrigeringer følger valgt versjon til neste versjon uten å bli dagens stilinstruks",async t=>{
  const {tjeneste,kall}=await oppsett(t);await generer(tjeneste);
  await generer(tjeneste,{instruks:"Maks 100 ord. Korrigering: Jeg vant en servicepris."});
  const andre=await tjeneste.opprett("j1",{instruks:"Utdyp eksemplene."});
  assert.ok(andre.grunnlag.historikk.some(h=>h.includes("servicepris")));
  assert.equal(andre.instruks,"Utdyp eksemplene.");
  await tjeneste.trinn("j1",andre.id,"skriv");
  const inn=JSON.parse(kall.at(-1).innhold);
  assert.ok(inn.historikk.some(h=>h.includes("servicepris")));
  assert.equal(inn.revisjonsinstruks,"Utdyp eksemplene.");
  assert.equal(kall.at(-1).kilder.join("").includes("Utdyp eksemplene"),false);
  const d=await tjeneste.hentBrev("j1");const opprinnelig=d.versjoner[0];
  await tjeneste.lagreBrev("j1",{...d,aktivVersjon:opprinnelig.id,tekst:opprinnelig.tekst});
  const gren=await tjeneste.opprett("j1",{instruks:"Kortere fra første versjon."});
  assert.equal(gren.grunnlag.historikk.some(h=>h.includes("servicepris")),false);
});

/* ---------- grunnlaget og annonsen ---------- */

test("grunnlaget har søknadsfeltene og stilreferansen, men ikke notat, kontekst eller svar",async t=>{
  const {tjeneste,kall}=await oppsett(t);
  const d=await tjeneste.hentBrev("j1");
  await tjeneste.lagreBrev("j1",{...d,kontekst:"Gammel kontekst som ikke skal sendes."});
  await tjeneste.lagreStil({revisjon:0,tekst:"Til rekrutteringsteamet i Testfirma,\n\nKort og konkret."});
  const k=await tjeneste.opprett("j1");
  assert.deepEqual(k.grunnlag.jobb,{selskap:"Eksempel AS",stilling:"Kunderådgiver",sted:"Oslo",jobbtype:"Fast stilling",sektor:"Finans"});
  assert.match(k.grunnlag.stilreferanse,/Testfirma/);
  for(const felt of ["kontekst","svar","notat","stilling","selskap"]) assert.equal(Object.hasOwn(k.grunnlag,felt),false,felt);
  await tjeneste.trinn("j1",k.id,"skriv");
  const sendt=kall[0].kilder.join("")+kall[0].innhold;
  assert.equal(sendt.includes("Gammel kontekst"),false);assert.equal(sendt.includes("ring Per"),false);
  assert.match(sendt,/Testfirma/);
});
test("annonsen kommer fra jobbdokumentet, og flyttes dit fra brevet én gang",async t=>{
  const {tjeneste,lager,kall}=await oppsett(t);
  let k=await tjeneste.opprett("j1");
  assert.equal(k.grunnlag.annonse,"Eksempel AS søker kunderådgiver.");
  const flyttet=await lager.les("jobb-j1.json");
  assert.equal(flyttet.annonse.kilde,"brev");assert.equal(flyttet.annonse.tekst,"Eksempel AS søker kunderådgiver.");
  await lager.skriv("jobb-j1.json",{...flyttet,annonse:{tekst:"Eksempel AS søker kunderådgiver med erfaring fra bank.",kilde:"import"}},flyttet.revisjon);
  // Brevets eget annonsefelt er ikke lenger kilden.
  await tjeneste.lagreBrev("j1",{...await tjeneste.hentBrev("j1"),annonse:{tekst:"Utdatert annonse i brevet.",url:"",hentet:null}});
  k=await tjeneste.opprett("j1");
  assert.equal(k.grunnlag.annonse,"Eksempel AS søker kunderådgiver med erfaring fra bank.");
  await tjeneste.trinn("j1",k.id,"skriv");
  assert.equal(soknad(kall[0]).annonse,"Eksempel AS søker kunderådgiver med erfaring fra bank.");
});
test("mangler annonsen, hentes den fra lenken, renses av annonsemodellen og lagres før brevet skrives",async t=>{
  const {tjeneste,lager,kall,hentet}=await oppsett(t,modell,{annonse:"",lenke:"https://jobb.example/kunderadgiver"});
  const k=await tjeneste.opprett("j1");
  assert.deepEqual(hentet,["https://jobb.example/kunderadgiver"]);
  assert.deepEqual(kall.map(p=>p.formal),["annonse"]);
  // Modellen får sidens linjer nummerert og søknadsfeltene, og svarer bare med linjenumre.
  const inn=JSON.parse(kall[0].innhold);
  assert.equal(inn.stilling,"Kunderådgiver");assert.match(inn.side,/^\[1\] Logg inn$/m);
  assert.equal(k.grunnlag.annonse,ANNONSELINJER.join("\n"));
  assert.deepEqual(k.annonseuttrekk,{modell:"syntetisk-haiku",bruk:{input_tokens:10,output_tokens:20}});
  const jd=await lager.les("jobb-j1.json");
  assert.equal(jd.annonse.tekst,ANNONSELINJER.join("\n"));assert.equal(jd.annonse.kilde,"hentet");
  assert.equal(jd.annonse.url,"https://jobb.example/kunderadgiver");
  const r=await tjeneste.trinn("j1",k.id,"skriv");
  assert.deepEqual(kall.map(p=>p.formal),["annonse","brev"]);
  assert.equal(soknad(kall[1]).annonse,ANNONSELINJER.join("\n"));
  assert.deepEqual(r.dokument.versjoner[0].annonseuttrekk,k.annonseuttrekk);
  // Neste brev bruker den lagrede annonsen uten å hente igjen.
  await generer(tjeneste);
  assert.equal(hentet.length,1);assert.deepEqual(kall.map(p=>p.formal),["annonse","brev","brev"]);
});
test("finnes annonsen, brukes den direkte uten henting og uten annonsemodellen, også når søknaden har lenke",async t=>{
  const {tjeneste,kall,hentet}=await oppsett(t,modell,{lenke:"https://jobb.example/kunderadgiver"});
  await generer(tjeneste);
  assert.deepEqual(hentet,[]);assert.deepEqual(kall.map(p=>p.formal),["brev"]);
});
test("sier annonsemodellen at siden ikke har annonsen, stopper det før noe er lagret eller betalt for brevet",async t=>{
  const {tjeneste,lager,kall}=await oppsett(t,async p=>({data:{erAnnonse:false,behold:[]},bruk:null,modell:"syntetisk-haiku"}),
    {annonse:"",lenke:"https://jobb.example/tatt-ned"});
  await assert.rejects(tjeneste.opprett("j1"),{code:"ikke-annonse",message:/Lim inn annonsen/});
  assert.deepEqual(kall.map(p=>p.formal),["annonse"]);
  assert.equal((await lager.les("jobb-j1.json")).annonse.tekst,"");
  assert.equal((await tjeneste.hentBrev("j1")).kjoring,null);
});
test("kan annonsemodellens svar ikke brukes, lagres teksten slik den ble lest ut av siden",async t=>{
  const {tjeneste}=await oppsett(t,async p=>({data:p.formal==="annonse"?{erAnnonse:true,behold:[{fra:900,til:999}]}:b(),bruk:null}),
    {annonse:"",lenke:"https://jobb.example/kunderadgiver"});
  const k=await tjeneste.opprett("j1");
  assert.match(k.grunnlag.annonse,/Logg inn/);assert.match(k.grunnlag.annonse,/Per Eksempel/);
});
test("uten annonse og uten lenke starter ingen kjøring, og feilen sier hva som mangler",async t=>{
  const {tjeneste,kall,hentet}=await oppsett(t,modell,{annonse:""});
  await assert.rejects(tjeneste.opprett("j1"),{code:"ugyldig-grunnlag",message:/mangler annonsen/});
  assert.equal((await tjeneste.hentBrev("j1")).kjoring,null);assert.equal(kall.length,0);assert.deepEqual(hentet,[]);
});
test("en død lenke gir feilen fra hentingen, og ingen modellkall",async t=>{
  const {tjeneste,kall}=await oppsett(t,modell,{annonse:"",lenke:"https://jobb.example/borte",
    hentSide:async()=>{throw new Error("Siden svarte 404.");}});
  await assert.rejects(tjeneste.opprett("j1"),{code:"dod-lenke"});assert.equal(kall.length,0);
});
test("en annonse som endres mens modellen skriver, gir et nytt forslag i stedet for å bytte teksten",async t=>{
  const startet=vent(),slipp=vent();
  const {tjeneste,lager}=await oppsett(t,async p=>{startet.slipp();await slipp.promise;return modell(p);});
  const k=await tjeneste.opprett("j1");
  const arbeid=tjeneste.trinn("j1",k.id,"skriv");await startet.promise;
  const jd=await lager.les("jobb-j1.json");
  await lager.skriv("jobb-j1.json",{...jd,annonse:{tekst:"En helt annen annonse.",kilde:"limt"}},jd.revisjon);
  slipp.slipp();const r=await arbeid;
  assert.equal(r.kjoring.nyttForslag,true);assert.equal(r.dokument.tekst,"");assert.equal(r.dokument.versjoner.length,1);
});

/* ---------- gammel form ---------- */

/* En kjøring fra brev-4 som sto i et av de gamle trinnene, og en versjon
   med analysen og tre bruksoppføringer. */
const gammelAnalyse={sprak:"nb",begrunnelse:"Bokmål.",kontaktperson:"",krav:[],bevis:[],virksomhet:[],uklarheter:[],merknader:[],maAvklares:false,bruk:{input_tokens:5,output_tokens:5},modell:"claude-opus-5"};
const gammelKjoring=(status,id="gammel")=>({id,status,opprettet:"2026-10-01T10:00:00.000Z",
  grunnlag:{cv:"Kari Eksempel. Erfaring fra kundeservice.",annonse:"Eksempel AS søker kunderådgiver.",jobb:{selskap:"Eksempel AS",stilling:"Kunderådgiver",sted:"Oslo",jobbtype:"Fast stilling",sektor:"Finans"},
    sprak:"auto",leverandor:"anthropic",historikk:[],stilreferanse:""},
  cvRevisjon:1,utgangspunkt:"",instruks:"",analyse:status==="klar"?null:gammelAnalyse,utkast:status==="skrevet"?{...b(),revisjonsinstruks:"",bruk:null,modell:"claude-opus-5"}:null});
const gammelVersjon={id:"v-gammel",tekst:BREV,sprak:"nb",opprettet:"2026-10-01T10:05:00.000Z",grunnlag:gammelKjoring("venter").grunnlag,
  analyse:gammelAnalyse,instruks:"",historikk:[],leverandor:"anthropic",modell:"claude-opus-5",promptversjon:"brev-4",merknader:[],
  bruk:[{input_tokens:1},{input_tokens:2},{input_tokens:3}]};
test("gamle versjoner med analyse og tre trinn leses, og en ny versjon kan bygge på dem",async t=>{
  const {tjeneste,lager,kall}=await oppsett(t);
  const d=await tjeneste.hentBrev("j1");
  await lager.skriv("brev-j1.json",{...d,tekst:BREV,aktivVersjon:"v-gammel",versjoner:[gammelVersjon],
    kjoring:{...gammelKjoring("ferdig"),resultatId:"v-gammel",nyttForslag:false,utkast:null}},d.revisjon);
  const lest=await tjeneste.hentBrev("j1");
  assert.deepEqual(lest.versjoner[0].analyse,gammelAnalyse);assert.equal(lest.versjoner[0].bruk.length,3);
  const k=await tjeneste.opprett("j1",{instruks:"Kortere."});
  const r=await tjeneste.trinn("j1",k.id,"skriv");
  assert.equal(r.kjoring.status,"ferdig");assert.equal(r.dokument.versjoner.length,2);
  assert.equal(r.dokument.versjoner[1].promptversjon,"brev-5");
  assert.equal(JSON.parse(kall[0].innhold).tidligereBrev,BREV);
  // Eksporten tar med den gamle versjonen som den er.
  assert.deepEqual((await tjeneste.eksporter()).dokumenter["brev-j1.json"].versjoner[0].analyse,gammelAnalyse);
});
for(const status of ["klar","analyserer","venter","skriver","skrevet","kontrollerer","feilet","avbrutt"]){
  test(`en kjøring fra de gamle trinnene i «${status}» kan startes på nytt`,async t=>{
    const {tjeneste,lager,kall}=await oppsett(t);
    const d=await tjeneste.hentBrev("j1");
    await lager.skriv("brev-j1.json",{...d,kjoring:gammelKjoring(status)},d.revisjon);
    assert.equal((await tjeneste.hentBrev("j1")).kjoring.status,status);
    // De gamle trinnene finnes ikke lenger, og «skriv» krever en ny kjøring.
    if(status!=="klar") await assert.rejects(tjeneste.trinn("j1","gammel","skriv"),{code:"opptatt"});
    // «skriver» kan stå igjen fra en avbrutt app, og avbrytes som før.
    if(status==="skriver"){
      await assert.rejects(tjeneste.opprett("j1"),{code:"opptatt"});
      await tjeneste.avbryt("j1","gammel");
    }
    const k=await tjeneste.opprett("j1");
    assert.notEqual(k.id,"gammel");assert.equal(k.status,"klar");
    for(const felt of ["analyse","utkast"]) assert.equal(Object.hasOwn(k,felt),false,felt);
    const r=await tjeneste.trinn("j1",k.id,"skriv");
    assert.equal(r.kjoring.status,"ferdig");assert.deepEqual(kall.map(p=>p.trinn),["skriv"]);
  });
}

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
