import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lagBrevlager } from "./brevlager.mjs";
import { lagBrevtjeneste } from "../src/brevtjeneste.mjs";

const a = () => ({ sprak:"nb",begrunnelse:"Annonsens språk.",sporsmal:[{id:"q1",tekst:"Hva ved oppgavene interesserer deg?"}],krav:[],bevis:[],uklarheter:[],maAvklares:false });
const b = (tekst="Jeg søker stillingen som kunderådgiver.") => ({tekst,sprak:"nb",merknader:[],pastander:[],maAvklares:false});
const modell = async p => ({data:p.trinn==="analyse"?a():b(),bruk:{input_tokens:10,output_tokens:20},modell:"syntetisk-modell"});
const vent = () => {let slipp;const promise=new Promise(r=>{slipp=r;});return {promise,slipp};};
async function oppsett(t, callback=modell){
  const katalog=await fs.mkdtemp(path.join(os.tmpdir(),"brev-tjeneste-test-"));
  t.after(()=>fs.rm(katalog,{recursive:true,force:true}));
  const lager=lagBrevlager(katalog),kall=[];let id=0;
  const lag=()=>lagBrevtjeneste({lager,hentJobb:async id=>id==="j1"?{id,stilling:"Kunderådgiver",selskap:"Eksempel AS"}:null,
    lagId:()=>`id${++id}`,kallModell:async p=>{kall.push(p);return callback(p);}});
  const tjeneste=lag();
  await tjeneste.lagreCv({...await tjeneste.hentCv(),tekst:"Kari Eksempel. Erfaring fra kundeservice."});
  await tjeneste.lagreBrev("j1",{...await tjeneste.hentBrev("j1"),annonse:{tekst:"Eksempel AS søker kunderådgiver.",url:"",hentet:null}});
  return {tjeneste,lager,kall,lag,katalog};
}
async function generer(tjeneste,svar={}){
  const k=await tjeneste.opprett("j1");
  await tjeneste.trinn("j1",k.id,"analyse");
  await tjeneste.trinn("j1",k.id,"skriv",svar);
  return tjeneste.trinn("j1",k.id,"kontroller");
}
test("hele kjeden, manuell redigering og revisjon gir bevarte versjoner",async t=>{
  const {tjeneste,kall}=await oppsett(t);
  const ferdig=await generer(tjeneste,{q1:"Jeg ønsker mer arbeid med kunder."});
  assert.equal(ferdig.kjoring.status,"ferdig");assert.equal(ferdig.dokument.versjoner.length,1);
  assert.deepEqual(kall.map(p=>p.trinn),["analyse","skriv","kontroll"]);
  const promptversjon = ferdig.dokument.versjoner[0].promptversjon;
  assert.equal(promptversjon,"brev-2");
  assert.ok(kall.every(p=>p.system.includes(`Promptversjon: ${promptversjon}`)));
  assert.equal(ferdig.dokument.versjoner[0].svar.q1,"Jeg ønsker mer arbeid med kunder.");
  const manuell=await tjeneste.lagreBrev("j1",{...ferdig.dokument,tekst:"Min egen innledning og mitt eget språk."});
  const ny=await tjeneste.opprett("j1",{instruks:"Gjør brevet kortere."});
  assert.equal(ny.status,"venter");assert.deepEqual(ny.svar,ferdig.kjoring.svar);
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
  assert.equal(r.dokument.tekst,"Jeg søker stillingen som kunderådgiver.");
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
test("oppfølgingsspørsmål er valgfrie og en kildeendring krever ny analyse",async t=>{
  const {tjeneste,kall}=await oppsett(t);
  const r=await generer(tjeneste);assert.deepEqual(r.kjoring.svar,{});
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
  assert.equal((await annen.tjeneste.importer(eksport)).antall,2);
  assert.equal((await annen.tjeneste.hentBrev("j1")).versjoner.length,1);
  await assert.rejects(annen.tjeneste.importer(eksport),{code:"konflikt"});
});
test("faktakorrigeringer følger valgt versjon til neste revisjon uten å bli dagens stilinstruks",async t=>{
  const {tjeneste,kall}=await oppsett(t);await generer(tjeneste);
  const første=await tjeneste.opprett("j1",{instruks:"Maks 100 ord. Korrigering: Jeg vant en servicepris."});
  await tjeneste.trinn("j1",første.id,"skriv",{q1:"Ny opplysning som bare tilhører denne grenen."});await tjeneste.trinn("j1",første.id,"kontroller");
  const andre=await tjeneste.opprett("j1",{instruks:"Utdyp eksemplene."});
  assert.ok(andre.grunnlag.historikk.some(h=>h.includes("servicepris")));
  assert.equal(andre.instruks,"Utdyp eksemplene.");
  if(andre.status==="klar")await tjeneste.trinn("j1",andre.id,"analyse");
  await tjeneste.trinn("j1",andre.id,"skriv");
  const inn=JSON.parse(kall.at(-1).innhold);
  assert.ok(inn.grunnlag.historikk.some(h=>h.includes("servicepris")));
  assert.equal(inn.revisjonsinstruks,"Utdyp eksemplene.");
  assert.equal(inn.grunnlag.kontekst.includes("Maks 100 ord"),false);
  await tjeneste.trinn("j1",andre.id,"kontroller");
  const d=await tjeneste.hentBrev("j1");const opprinnelig=d.versjoner[0];
  await tjeneste.lagreBrev("j1",{...d,aktivVersjon:opprinnelig.id,tekst:opprinnelig.tekst});
  const gren=await tjeneste.opprett("j1",{instruks:"Kortere fra første versjon."});
  assert.equal(gren.grunnlag.historikk.some(h=>h.includes("servicepris")),false);
  assert.equal(Object.values(gren.svar).includes("Ny opplysning som bare tilhører denne grenen."),false);
});

for(const type of ["cv","brev"]){
  const operasjoner = tjeneste => type==="cv" ? {
    hent:()=>tjeneste.hentCv(),lagre:d=>tjeneste.lagreCv(d),slett:r=>tjeneste.slettCv(r),
    gjenopprett:()=>tjeneste.gjenopprettCv(),fil:"cv.json"
  } : {
    hent:()=>tjeneste.hentBrev("j1"),lagre:d=>tjeneste.lagreBrev("j1",d),slett:r=>tjeneste.slettBrev("j1",r),
    gjenopprett:()=>tjeneste.gjenopprettBrev("j1"),fil:"brev-j1.json"
  };
  test(`${type}: slett og opprett på nytt avviser en gammel fanes revisjon`,async t=>{
    const {tjeneste}=await oppsett(t),op=operasjoner(tjeneste);
    const gammel=await op.hent();await op.slett(gammel.revisjon);
    const tom=await op.hent();assert.equal(tom.tekst,"");assert.ok(tom.revisjon>gammel.revisjon);
    const ny=await op.lagre({...tom,tekst:"Nytt innhold etter sletting."});
    assert.ok(ny.revisjon>tom.revisjon);
    await assert.rejects(op.lagre({...gammel,tekst:"Skriving fra en gammel fane."}),{code:"konflikt"});
    await assert.rejects(op.slett(gammel.revisjon),{code:"konflikt"});
    assert.equal((await op.hent()).tekst,"Nytt innhold etter sletting.");
  });
  test(`${type}: gjenoppretting etter skadet hovedfil tildeler ny revisjon og avviser gammel fane`,async t=>{
    const {tjeneste,katalog}=await oppsett(t),op=operasjoner(tjeneste);
    const før=await op.hent();const siste=await op.lagre({...før,tekst:"Tekst som lå i den skadde hovedfilen."});
    await fs.writeFile(path.join(katalog,op.fil),"{ødelagt JSON");
    await assert.rejects(op.hent(),{code:"odelagt"});
    const gjenopprettet=await op.gjenopprett();
    assert.equal(gjenopprettet.tekst,før.tekst);assert.ok(gjenopprettet.revisjon>siste.revisjon);
    await assert.rejects(op.lagre({...siste,tekst:"Stale fane etter recovery."}),{code:"konflikt"});
    assert.equal((await op.hent()).tekst,før.tekst);
  });
  test(`${type}: import til slettet dokument beholder monoton revisjon`,async t=>{
    const {tjeneste}=await oppsett(t),op=operasjoner(tjeneste);
    const gammel=await op.hent();const eksport=await tjeneste.eksporter();
    eksport.dokumenter={[op.fil]:eksport.dokumenter[op.fil]};
    await op.slett(gammel.revisjon);const tom=await op.hent();
    assert.equal((await tjeneste.importer(eksport)).antall,1);
    const tilbake=await op.hent();assert.equal(tilbake.tekst,gammel.tekst);assert.ok(tilbake.revisjon>tom.revisjon);
    await assert.rejects(op.lagre({...gammel,tekst:"En gammel fane overskriver sikkerhetskopien."}),{code:"konflikt"});
  });
  test(`${type}: korrupt sikkerhetskopi bevares og stanser lagring uten å endre hovedfilen`,async t=>{
    const {tjeneste,katalog}=await oppsett(t),op=operasjoner(tjeneste);
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
