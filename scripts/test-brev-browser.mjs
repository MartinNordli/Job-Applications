/* Reell nettleser, isolerte profildata og deterministisk modell. Ingen API-nøkler.
   Brevet åpnes i detaljpanelets Brev-fane. Annonsen ligger i jobbdokumentet
   og hentes fra grunnlagslinjen, utkastet går gjennom de tre fasene uten
   spørsmål, og stilreferansen lagres fra innstillingene. */
import {chromium} from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {lagServer} from "../server/server.mjs";
import {BrevModellfeil} from "../server/brev-modell.mjs";

const dir=await fs.mkdtemp(path.join(os.tmpdir(),"brev-nettleser-"));
const cv="Astrid Eksempel. To års erfaring med kundeoppfølging. På biblioteket hjalp jeg besøkende med selvbetjening. Jeg har laget automatiserte kontroller av data i Python.";
const annonse="Eksempel AS søker kunderådgiver i Oslo. Du skal følge opp bedriftskunder, veilede dem og samarbeide med kollegaer om datakvalitet. Vi ønsker relevant erfaring og tydelig skriftlig formidling. Skriv søknaden på norsk.";
const brev="Til rekrutteringsteamet i Eksempel AS,\n\nJeg søker stillingen som kunderådgiver hos Eksempel AS med to års erfaring fra kundeoppfølging. Oppgavene dere beskriver gir meg anledning til å bruke denne erfaringen i direkte kontakt med bedriftskundene deres.\n\nPå biblioteket hjalp jeg besøkende med selvbetjeningsløsninger. Arbeidet krevde at jeg tok utgangspunkt i hva den enkelte lurte på og forklarte fremgangsmåten slik at de kunne komme videre. Den erfaringen kan jeg bruke når kundene deres trenger veiledning.\n\nJeg har også laget automatiserte kontroller av data i Python. Dette er relevant for arbeidet med datakvalitet, og gir meg et nyttig grunnlag for å forstå problemene kundene møter og samarbeide med kollegaene som løser dem.\n\nJeg stiller gjerne til en samtale om hvordan bakgrunnen min passer til behovene deres.\n\nMed vennlig hilsen\nAstrid Eksempel";
const engelsk="Dear Hiring Manager,\n\nI am applying for the customer adviser position with two years of customer support experience.\n\nSincerely,\nAstrid Eksempel";
const stilreferanse="Hei,\n\nJeg skriver fordi jobben passer det jeg liker best: å rydde i data sammen med folk som bruker dem.\n\nHilsen Astrid";
let modellfeil=false;
const kall=[];
const deltaer=[];
const stilIKall=[];
const server=lagServer({katalog:path.join(dir,"data"),nett:{hentSide:async url=>({html:`<main>${annonse}</main>`,sluttUrl:url})},brevModellFor:()=>async ({trinn,kilder,signal,felt,påDelta})=>{
  kall.push(trinn);
  // Den syntetiske modellen strømmer feltet i biter, slik den ekte gjør,
  // så forhåndsvisningen i flaten faktisk får noe å vise.
  const g=JSON.parse(kilder).kilder,sprak=g.sprakvalg==="en"?"en":"nb";
  if(trinn==="skriv")stilIKall.push(kilder.includes("rydde i data"));
  const strømmes=trinn==="analyse"?"Norsk, som annonsen ber om.":(sprak==="en"?engelsk:brev);
  for(let i=0;i<strømmes.length;i+=Math.ceil(strømmes.length/6)){
    await new Promise(r=>setTimeout(r,75));signal?.throwIfAborted();
    const bit=strømmes.slice(i,i+Math.ceil(strømmes.length/6));
    if(påDelta&&felt){påDelta(bit);deltaer.push({trinn,felt,bit});}
  }
  signal?.throwIfAborted();
  // Samme feil som den ekte leverandøren kaster når tjenesten er nede.
  if(modellfeil)throw new BrevModellfeil("modell","Modelltjenesten svarte 503. Prøv igjen senere.");
  return {data:trinn==="analyse"?{sprak,begrunnelse:"Norsk, som annonsen ber om.",kontaktperson:"",krav:[],bevis:[],virksomhet:[],uklarheter:[],merknader:[],maAvklares:false}:{tekst:sprak==="en"?engelsk:brev,sprak,merknader:[],pastander:[],maAvklares:false},bruk:{input_tokens:100,output_tokens:250},modell:"syntetisk-testmodell"};
}});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const url=`http://127.0.0.1:${server.address().port}`;
let browser,page;
try{
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:process.platform==="darwin"?{executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}:{})});
  const context=await browser.newContext({viewport:{width:1280,height:820},colorScheme:"light",permissions:["clipboard-read","clipboard-write"]});
  const reg=await context.request.post(url+"/api/registrer",{data:{epost:"test@eksempel.no",navn:"Astrid Eksempel",passord:"syntetisk-passord-123"}});assert.ok(reg.ok());
  const data=await (await context.request.get(url+"/api/jobber")).json();
  const jobb=(id,mer)=>({id,selskap:"Eksempel AS",stilling:"Kunderådgiver",lenke:"",sted:"Oslo",frist:"2027-10-15",status:"todo",sektor:"teknologi",jobbtype:"fulltid",notat:"",sendtDato:null,...mer});
  assert.ok((await context.request.put(url+"/api/jobber",{data:{versjon:data.versjon,jobber:[jobb("brevtest",{lenke:"https://example.com/jobb"}),jobb("utenlenke",{selskap:"Uten Lenke AS",frist:"2027-11-01"})]}})).ok());
  assert.ok((await context.request.put(url+"/api/cv",{data:{revisjon:0,tekst:cv,navn:"Astrid Eksempel",format:"tekst"}})).ok());
  page=await context.newPage();const feil=[],trinnsvar=[],utgått=[];
  page.on("pageerror",e=>feil.push(e.message));
  page.on("request",r=>{if(r.url().includes("/api/annonsetekst"))utgått.push(r.url());});
  page.on("response",r=>{if(r.url().endsWith("/trinn"))trinnsvar.push({status:r.status(),type:r.headers()["content-type"]});});
  const klar=()=>page.waitForFunction(()=>document.querySelector(".brev")?.getAttribute("aria-busy")==="false");
  await page.goto(url);await page.locator('.rad[data-id="brevtest"] [data-gjor="brev"]').click();
  assert.equal(await page.evaluate(()=>location.hash),"#jobb/brevtest/brev");
  await klar();

  /* ---------- annonsen mangler ---------- */
  await page.waitForFunction(()=>document.querySelector("#brevAnnonseVerdi").textContent==="Mangler");
  const skriv=page.getByRole("button",{name:"Skriv utkast",exact:true});
  assert.equal(await skriv.isDisabled(),true,"uten annonse kan utkastet ikke skrives");
  assert.equal(await page.locator("#brevSkrivGrunn").textContent(),"Legg til annonsen først");
  assert.equal(await skriv.getAttribute("aria-describedby"),"brevSkrivGrunn");
  // Det som var spørsmål og kontekst, er borte.
  for(const borte of ["#brevKontekst","#brevSporsmal","#brevAnnonseUrl","#brevAnnonseTekst",'[data-steg="avklaring"]'])assert.equal(await page.locator(borte).count(),0,borte);
  // Raden står fremme før man trykker, med de tre fasene.
  assert.deepEqual(await page.$$eval(".brev__steg",e=>e.map(s=>s.dataset.steg)),["analyse","skriv","kontroll"]);
  assert.deepEqual(await page.$$eval(".brev__steg",e=>e.map(s=>s.dataset.tilstand)),["kommende","kommende","kommende"]);
  assert.deepEqual(await page.$$eval(".brev__steg__navn",e=>e.map(s=>s.textContent)),["Leser annonsen og CV-en","Skriver","Leser gjennom"]);
  // Språkvelgeren leverer koden, ikke etiketten.
  assert.deepEqual(await page.$$eval("#brevSprak option",o=>o.map(x=>x.value)),["auto","nb","nn","en","sv","da","de","fr"]);
  await page.screenshot({path:path.join(dir,"01-mangler-annonse.png")});

  /* ---------- hent annonsen fra grunnlagslinjen ---------- */
  await page.locator("#brevAnnonseHandlinger").getByRole("button",{name:"Hent",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector("#brevAnnonseVerdi").textContent.startsWith("Lagret"));
  // Fokus blir i raden når «Hent» blir til «Se annonsen».
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent),"Se annonsen");
  assert.equal(await skriv.isDisabled(),false);
  assert.equal(await page.locator("#brevSkrivGrunn").textContent(),"");
  const jobbdok=await (await context.request.get(url+"/api/jobber/brevtest/dokument")).json();
  assert.ok(jobbdok.annonse.tekst.includes("kunderådgiver"),"annonsen er lagret i jobbdokumentet");

  /* ---------- utkastet: analyse, skriv, kontroll ---------- */
  await skriv.click();
  // Teksten skal synes mens den blir skrevet, ikke først når den er ferdig.
  await page.waitForFunction(()=>{const s=document.querySelector("#brevStrom");return !s.hidden&&s.textContent.trim().length>0;});
  await page.screenshot({path:path.join(dir,"02-strommer.png")});
  // Kontrollen skriver brevet på nytt, den skjøter ikke på utkastet.
  await page.waitForFunction(()=>document.querySelector('[data-steg="kontroll"]').dataset.tilstand==="aktiv");
  await page.waitForFunction(()=>document.querySelector("#brevStatus").textContent.includes("Leser gjennom"));
  await page.waitForFunction(()=>document.querySelector("#brevTekst").value.includes("Jeg søker")&&!document.querySelector('[data-brev="forbedre"]').disabled);
  assert.deepEqual(kall,["analyse","skriv","kontroll"]);
  // Når brevet står i feltet, er laget over papiret borte og raden ferdig.
  assert.equal(await page.locator("#brevStrom").isHidden(),true);
  assert.deepEqual(await page.$$eval(".brev__steg",e=>e.map(s=>s.dataset.tilstand)),["ferdig","ferdig","ferdig"]);
  // Trinnene gikk som strøm, og modellen strømmet det feltet trinnet eier.
  assert.ok(trinnsvar.length>=3);
  assert.ok(trinnsvar.every(r=>r.status===200&&r.type?.startsWith("text/event-stream")),JSON.stringify(trinnsvar));
  assert.deepEqual([...new Set(deltaer.map(d=>`${d.trinn}:${d.felt}`))],["analyse:begrunnelse","skriv:tekst","kontroll:tekst"]);
  await page.screenshot({path:path.join(dir,"03-brev-lys.png")});

  /* ---------- en tekstendring under arbeidet vinner over modellsvaret ---------- */
  await page.locator("#brevInstruks").fill("Gjør åpningen kortere.");
  await page.getByRole("button",{name:"Lag ny versjon",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-brev="stopp"]').hidden===false);
  // Analysen gjenbrukes når grunnlaget er det samme, og raden sier det.
  await page.waitForFunction(()=>document.querySelector('[data-steg="analyse"] .brev__steg__mikro').textContent==="gjenbrukt");
  await page.locator("#brevTekst").fill(brev+"\n\nMin manuelle avslutning.");
  await page.waitForFunction(()=>!document.querySelector('[data-brev="forbedre"]').disabled);
  assert.ok((await page.locator("#brevTekst").inputValue()).endsWith("Min manuelle avslutning."));
  assert.deepEqual(kall,["analyse","skriv","kontroll","skriv","kontroll"]);
  await page.waitForFunction(()=>document.querySelector("#brevLagret").textContent.startsWith("Lagret"));

  /* ---------- lukking venter på lagringen ---------- */
  await page.locator('#detalj [data-panel="lukk"]').click();
  await page.locator("#detalj").waitFor({state:"hidden"});
  assert.equal(await page.evaluate(()=>location.hash),"");
  await page.locator('.rad[data-id="brevtest"] [data-gjor="brev"]').click();
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
  await page.waitForFunction(()=>document.querySelector("#brevCvTekst").value.includes("Min manuelle avslutning.")&&document.querySelector(".brev").getAttribute("aria-busy")==="false");
  await page.locator("#brevCvFil").setInputFiles(path.join(dir,"soknadsbrev.pdf"));
  await page.waitForFunction(()=>document.querySelector("#brevCvNavn").textContent.includes(".pdf")&&document.querySelector(".brev").getAttribute("aria-busy")==="false");
  assert.ok((await page.locator("#brevCvTekst").inputValue()).includes("Min manuelle avslutning."));
  // CV-teksten foldes ut fra linjen og tilbake.
  await page.getByRole("button",{name:"Se teksten",exact:true}).click();
  assert.equal(await page.locator("#brevCvTekst").isVisible(),true);
  assert.equal(await page.evaluate(()=>document.activeElement?.id),"brevCvTekst");
  await page.getByRole("button",{name:"Skjul teksten",exact:true}).click();
  assert.equal(await page.locator("#brevCvPanel").isHidden(),true);

  /* ---------- «Se annonsen» bytter fane ---------- */
  await page.getByRole("button",{name:"Se annonsen",exact:true}).click();
  await page.waitForFunction(()=>location.hash==="#jobb/brevtest/annonse");
  await page.locator(".annonse__tekst").waitFor();
  await page.locator("#detaljFane-brev").click();
  await klar();

  /* ---------- innstillingene og stilreferansen ---------- */
  await page.locator("#detalj").getByRole("button",{name:"Innstillinger",exact:true}).click();
  // Panelet bytter ut grunnlaget og papiret, det legger seg ikke oppå dem.
  assert.equal(await page.locator("#brevGrunnlag").isHidden(),true);
  assert.equal(await page.locator("#brevSkriveflate").isHidden(),true);
  await page.waitForFunction(()=>!document.querySelector("#brevStil").disabled);
  assert.equal(await page.locator("#brevStilTeller").textContent(),"0 av 16 000 tegn");
  await page.locator("#brevStil").fill(stilreferanse);
  assert.equal(await page.locator("#brevStilStatus").textContent(),"Ikke lagret");
  await page.getByRole("button",{name:"Lagre stilreferansen",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector("#brevStilStatus").textContent==="Lagret");
  let lagretStil=await (await context.request.get(url+"/api/stil")).json();
  assert.equal(lagretStil.tekst,stilreferanse);
  await page.screenshot({path:path.join(dir,"04-innstillinger.png")});
  // Et annet vindu lagrer i mellomtiden: teksten her blir stående, og
  // et nytt trykk erstatter den andre.
  assert.ok((await context.request.put(url+"/api/stil",{data:{revisjon:lagretStil.revisjon,tekst:"Fra et annet vindu."}})).ok());
  await page.locator("#brevStil").fill(stilreferanse+"\n");
  await page.getByRole("button",{name:"Lagre stilreferansen",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector("#brevFeil").textContent.includes("endret i et annet vindu"));
  assert.equal(await page.locator("#brevStil").inputValue(),stilreferanse+"\n");
  await page.getByRole("button",{name:"Lagre stilreferansen",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector("#brevStilStatus").textContent==="Lagret");
  lagretStil=await (await context.request.get(url+"/api/stil")).json();
  assert.equal(lagretStil.tekst,stilreferanse+"\n");
  // Sikkerhetskopien har med stilreferansen og jobbdokumentet.
  const backup=page.waitForEvent("download");await page.getByRole("button",{name:"Last ned sikkerhetskopi",exact:true}).click();
  await (await backup).saveAs(path.join(dir,"sikkerhetskopi.json"));
  const eksport=JSON.parse(await fs.readFile(path.join(dir,"sikkerhetskopi.json"),"utf8"));
  assert.equal(eksport.format,"jobbsoknader-brev");
  assert.ok(eksport.dokumenter["brev-brevtest.json"].versjoner.length>=2);
  assert.equal(eksport.dokumenter["stil.json"].tekst,stilreferanse+"\n");
  assert.ok(eksport.dokumenter["jobb-brevtest.json"].annonse.tekst.includes("kunderådgiver"));
  // Esc lukker innstillingene, ikke panelet, og fokus går tilbake.
  await page.locator("#brevStil").focus();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#brevInnstillinger").isHidden(),true);
  assert.equal(await page.locator("#detalj").isVisible(),true);
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset.brev),"innstillinger");
  // Neste versjon får stilreferansen med.
  await page.locator("#brevInstruks").fill("Kortere.");
  await page.getByRole("button",{name:"Lag ny versjon",exact:true}).click();
  await page.waitForFunction(()=>/^(En ny versjon er klar|Endringene dine)/.test(document.querySelector("#brevStatus").textContent));
  assert.equal(stilIKall.at(-1),true,"stilreferansen ble sendt med");

  /* ---------- mørkt og smalt ---------- */
  await page.emulateMedia({colorScheme:"dark",reducedMotion:"reduce"});
  await page.screenshot({path:path.join(dir,"05-brev-mork.png")});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(dir,"06-mobil-mork.png")});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  // Navnene i fremdriftsraden må få plass på én linje hver, ellers faller
  // mikrolinjene fra hverandre i høyden. Dette er den smaleste bredden.
  assert.equal(new Set(await page.$$eval(".brev__steg__mikro",e=>e.map(m=>m.getBoundingClientRect().top))).size,1);
  assert.equal(await page.evaluate(()=>{const f=document.querySelector(".brev__flyt");return f.scrollWidth<=f.clientWidth;}),true);
  await page.emulateMedia({colorScheme:"light"});
  await page.screenshot({path:path.join(dir,"07-mobil-lys.png")});
  await page.setViewportSize({width:1280,height:820});
  await page.emulateMedia({colorScheme:"light",reducedMotion:"no-preference"});

  /* ---------- feil bevarer et eksisterende brev ---------- */
  modellfeil=true;
  await page.locator("#brevInstruks").fill("En gang til.");await page.getByRole("button",{name:"Lag ny versjon",exact:true}).click();
  await page.locator("#brevFeil").waitFor({state:"visible"});
  assert.match(await page.locator("#brevFeil").textContent(),/Modelltjenesten svarte 503/);
  assert.ok((await page.locator("#brevTekst").inputValue()).includes("Jeg søker"));
  modellfeil=false;

  /* ---------- en kjøring som venter, fortsetter når brevet åpnes ---------- */
  await page.locator("#detaljFane-oversikt").click();
  await page.locator(".oversikt").waitFor();
  const før=kall.length;
  const ny=await context.request.post(url+"/api/jobber/brevtest/brev/kjoringer",{data:{}});
  assert.ok(ny.ok(),await ny.text());
  await page.locator("#detaljFane-brev").click();
  await page.waitForFunction(()=>/^(Utkastet er klart|Endringene dine)/.test(document.querySelector("#brevStatus").textContent));
  assert.ok(kall.slice(før).includes("kontroll"),JSON.stringify(kall.slice(før)));

  /* ---------- uten lenke: «Lim inn» går rett til innlimingen ---------- */
  await page.locator('.rad[data-id="utenlenke"]').click({position:{x:30,y:20}});
  await page.waitForFunction(()=>location.hash==="#jobb/utenlenke/brev");
  await klar();
  await page.waitForFunction(()=>document.querySelector("#brevAnnonseVerdi").textContent==="Mangler");
  assert.equal(await page.locator("#brevAnnonseHandlinger").getByRole("button",{name:"Hent",exact:true}).count(),0,"uten lenke er det ingenting å hente");
  await page.locator("#brevAnnonseHandlinger").getByRole("button",{name:"Lim inn",exact:true}).click();
  await page.waitForFunction(()=>location.hash==="#jobb/utenlenke/annonse");
  await page.waitForFunction(()=>document.activeElement?.id==="annonseLim");
  await page.locator("#annonseLim").fill(annonse);
  await page.getByRole("button",{name:"Lagre annonsen",exact:true}).click();
  await page.locator(".annonse__tekst").waitFor();
  await page.locator("#detaljFane-brev").click();
  await klar();
  await page.waitForFunction(()=>document.querySelector("#brevAnnonseVerdi").textContent.startsWith("Lagret"));
  assert.equal(await page.getByRole("button",{name:"Skriv utkast",exact:true}).isDisabled(),false);

  assert.deepEqual(utgått,[],"den utgåtte annonseruten brukes ikke");
  assert.deepEqual(feil,[]);
  console.log(`Nettlesertest bestått. Skjermbilder og eksportfiler: ${dir}`);
}catch(e){
  console.error(`Nettlesertesten feilet. Arbeidskatalog: ${dir}`);
  if(page){await page.screenshot({path:path.join(dir,"feil.png"),fullPage:true}).catch(()=>{});console.error(await page.locator("#brevFeil").textContent().catch(()=>""));}
  throw e;
}
finally{await browser?.close();await new Promise(r=>server.close(r));}
