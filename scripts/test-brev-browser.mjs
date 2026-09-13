/* Reell nettleser, isolerte profildata og deterministisk modell. Ingen API-nøkler. */
import {chromium} from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {lagServer} from "../server/server.mjs";

const dir=await fs.mkdtemp(path.join(os.tmpdir(),"brev-nettleser-"));
const cv="Astrid Eksempel. To års erfaring med kundeoppfølging. På biblioteket hjalp jeg besøkende med selvbetjening. Jeg har laget automatiserte kontroller av data i Python.";
const annonse="Eksempel AS søker kunderådgiver i Oslo. Du skal følge opp bedriftskunder, veilede dem og samarbeide med kollegaer om datakvalitet. Vi ønsker relevant erfaring og tydelig skriftlig formidling. Skriv søknaden på norsk.";
const brev="Jeg søker stillingen som kunderådgiver hos Eksempel AS med to års erfaring fra kundeoppfølging. Oppgavene dere beskriver gir meg anledning til å bruke denne erfaringen i direkte kontakt med bedriftskundene deres.\n\nPå biblioteket hjalp jeg besøkende med selvbetjeningsløsninger. Arbeidet krevde at jeg tok utgangspunkt i hva den enkelte lurte på og forklarte fremgangsmåten slik at de kunne komme videre. Den erfaringen kan jeg bruke når kundene deres trenger veiledning.\n\nJeg har også laget automatiserte kontroller av data i Python. Dette er relevant for arbeidet med datakvalitet, og gir meg et nyttig grunnlag for å forstå problemene kundene møter og samarbeide med kollegaene som løser dem.\n\nJeg stiller gjerne til en samtale om hvordan bakgrunnen min passer til behovene deres.";
let modellfeil=false;
const kall=[];
const deltaer=[];
const server=lagServer({katalog:path.join(dir,"data"),nett:{hentSide:async url=>({html:`<main>${annonse}</main>`,sluttUrl:url})},brevModellFor:()=>async ({trinn,innhold,signal,felt,påDelta})=>{
  kall.push(trinn);
  // Den syntetiske modellen strømmer feltet i biter, slik den ekte gjør,
  // så forhåndsvisningen i flaten faktisk får noe å vise.
  const g=JSON.parse(innhold).grunnlag,sprak=g.sprak==="en"?"en":"nb";
  const strømmes=trinn==="analyse"?"Norsk, som annonsen ber om.":(sprak==="en"?"I am applying for the customer adviser position with two years of customer support experience.":brev);
  for(let i=0;i<strømmes.length;i+=Math.ceil(strømmes.length/6)){
    await new Promise(r=>setTimeout(r,75));signal?.throwIfAborted();
    const bit=strømmes.slice(i,i+Math.ceil(strømmes.length/6));
    if(påDelta&&felt){påDelta(bit);deltaer.push({trinn,felt,bit});}
  }
  signal?.throwIfAborted();
  if(modellfeil)throw new Error("Modelltjenesten er midlertidig utilgjengelig.");
  return {data:trinn==="analyse"?{sprak,begrunnelse:"Norsk, som annonsen ber om.",sporsmal:[{id:"q1",tekst:"Hva tiltrekker deg ved arbeidet med bedriftskunder?"}],krav:[],bevis:[],uklarheter:[],maAvklares:false}:{tekst:sprak==="en"?"I am applying for the customer adviser position with two years of customer support experience.":brev,sprak,merknader:[],pastander:[],maAvklares:false},bruk:{input_tokens:100,output_tokens:250},modell:"syntetisk-testmodell"};
}});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const url=`http://127.0.0.1:${server.address().port}`;
let browser,page;
try{
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:process.platform==="darwin"?{executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}:{})});
  const context=await browser.newContext({viewport:{width:1180,height:820},colorScheme:"light",permissions:["clipboard-read","clipboard-write"]});
  const reg=await context.request.post(url+"/api/registrer",{data:{epost:"test@eksempel.no",navn:"Astrid Eksempel",passord:"syntetisk-passord-123"}});assert.ok(reg.ok());
  const data=await (await context.request.get(url+"/api/jobber")).json();
  assert.ok((await context.request.put(url+"/api/jobber",{data:{versjon:data.versjon,jobber:[{id:"brevtest",selskap:"Eksempel AS",stilling:"Kunderådgiver",lenke:"https://example.com/jobb",sted:"Oslo",frist:"2027-10-15",status:"todo",sektor:"teknologi",jobbtype:"fulltid",notat:"",sendtDato:null}]}})).ok());
  assert.ok((await context.request.put(url+"/api/cv",{data:{revisjon:0,tekst:cv,navn:"Astrid Eksempel",format:"tekst"}})).ok());
  page=await context.newPage();const feil=[],trinnsvar=[];
  page.on("pageerror",e=>feil.push(e.message));
  page.on("response",r=>{if(r.url().endsWith("/trinn"))trinnsvar.push({status:r.status(),type:r.headers()["content-type"]});});
  await page.goto(url);await page.locator('[data-gjor="brev"]').first().click();
  await page.locator("#brevKontekst").waitFor({state:"visible"});
  await page.waitForFunction(()=>!document.querySelector("#brevGrunnlagsfelter").disabled);
  await page.screenshot({path:path.join(dir,"01-grunnlag.png"),fullPage:true});
  await page.getByRole("button",{name:"Hent",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector("#brevAnnonseTekst").value.length>80&&!document.querySelector("#brevGrunnlagsfelter").disabled);
  await page.locator("#brevKontekst").fill("Jeg ønsker en rolle med tett kundekontakt.");
  await page.getByRole("button",{name:"Skriv utkast",exact:true}).click();
  await page.locator("#brevSvar0").waitFor({state:"visible"});
  await page.screenshot({path:path.join(dir,"02-sporsmal.png"),fullPage:true});
  await page.locator("#brevSvar0").fill("Jeg vil bruke erfaringen min til å hjelpe kunder i hverdagen.");
  await page.getByRole("button",{name:"Skriv med svarene",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector("#brevTekst").value.includes("Jeg søker")&&!document.querySelector('[data-brev="forbedre"]').disabled);
  assert.deepEqual(kall,["analyse","skriv","kontroll"]);
  // Trinnene gikk som strøm, og modellen strømmet det feltet trinnet eier.
  assert.ok(trinnsvar.length>=3);
  assert.ok(trinnsvar.every(r=>r.status===200&&r.type?.startsWith("text/event-stream")),JSON.stringify(trinnsvar));
  assert.deepEqual([...new Set(deltaer.map(d=>`${d.trinn}:${d.felt}`))],["analyse:begrunnelse","skriv:tekst","kontroll:tekst"]);
  await page.screenshot({path:path.join(dir,"03-brev-lys.png"),fullPage:true});
  // En tekstendring under arbeidet får aldri erstattes av et sent modellsvar.
  await page.locator("#brevInstruks").fill("Gjør åpningen kortere.");
  await page.getByRole("button",{name:"Lag ny versjon",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-brev="stopp"]').hidden===false);
  await page.locator("#brevTekst").fill(brev+"\n\nMin manuelle avslutning.");
  await page.waitForFunction(()=>!document.querySelector('[data-brev="forbedre"]').disabled);
  assert.ok((await page.locator("#brevTekst").inputValue()).endsWith("Min manuelle avslutning."));
  assert.deepEqual(kall,["analyse","skriv","kontroll","skriv","kontroll"]);
  await page.waitForFunction(()=>document.querySelector("#brevLagret").textContent.startsWith("Lagret"));
  await page.locator("#lukkSkuff").click();
  await page.locator('[data-gjor="brev"]').first().click();
  await page.waitForFunction(()=>document.querySelector("#brevTekst")?.value.endsWith("Min manuelle avslutning."));
  await page.getByRole("button",{name:"Kopier brev",exact:true}).click();
  assert.ok((await page.evaluate(()=>navigator.clipboard.readText())).endsWith("Min manuelle avslutning."));
  for(const format of ["pdf","docx"]){
    await page.locator(".brev__nedlasting summary").click();
    const vent=page.waitForEvent("download");
    await page.locator(`[data-brev="${format}"]`).click();
    const fil=await vent;await fil.saveAs(path.join(dir,`soknadsbrev.${format}`));
  }
  // Filparserne prøves med reelle lokalt eksporterte dokumenter.
  await page.locator("#brevCvFil").setInputFiles(path.join(dir,"soknadsbrev.docx"));
  await page.waitForFunction(()=>document.querySelector("#brevCvTekst").value.includes("Min manuelle avslutning.")&&!document.querySelector("#brevGrunnlagsfelter").disabled);
  await page.locator("#brevCvFil").setInputFiles(path.join(dir,"soknadsbrev.pdf"));
  await page.waitForFunction(()=>document.querySelector("#brevCvNavn").textContent.includes(".pdf")&&!document.querySelector("#brevGrunnlagsfelter").disabled);
  assert.ok((await page.locator("#brevCvTekst").inputValue()).includes("Min manuelle avslutning."));
  await page.emulateMedia({colorScheme:"dark",reducedMotion:"reduce"});
  await page.screenshot({path:path.join(dir,"04-brev-mork.png"),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.getByRole("tab",{name:"Søknadsbrev",exact:true}).click();
  await page.screenshot({path:path.join(dir,"05-mobil-mork.png"),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.emulateMedia({colorScheme:"light"});
  await page.screenshot({path:path.join(dir,"06-mobil-lys.png"),fullPage:true});
  await page.getByRole("tab",{name:"Grunnlag",exact:true}).click();
  await page.locator("#brevInnstillinger summary").click();
  const backup=page.waitForEvent("download");await page.getByRole("button",{name:"Last ned sikkerhetskopi",exact:true}).click();
  await (await backup).saveAs(path.join(dir,"sikkerhetskopi.json"));
  const eksport=JSON.parse(await fs.readFile(path.join(dir,"sikkerhetskopi.json"),"utf8"));
  assert.equal(eksport.format,"jobbsoknader-brev");assert.ok(eksport.dokumenter["brev-brevtest.json"].versjoner.length>=2);
  // Feil må bevare et eksisterende brev.
  await page.setViewportSize({width:1180,height:820});modellfeil=true;
  await page.locator("#brevInstruks").fill("En gang til.");await page.getByRole("button",{name:"Lag ny versjon",exact:true}).click();
  await page.locator("#brevFeil").waitFor({state:"visible"});
  assert.ok((await page.locator("#brevTekst").inputValue()).includes("Min manuelle avslutning."));
  assert.deepEqual(feil,[]);
  console.log(`Nettlesertest bestått. Skjermbilder og eksportfiler: ${dir}`);
}catch(e){
  console.error(`Nettlesertesten feilet. Arbeidskatalog: ${dir}`);
  if(page){await page.screenshot({path:path.join(dir,"feil.png"),fullPage:true}).catch(()=>{});console.error(await page.locator("#brevFeil").textContent().catch(()=>""));}
  throw e;
}
finally{await browser?.close();await new Promise(r=>server.close(r));}
