/* Reell nettleser, isolerte profildata og deterministisk modell. Ingen API-nøkler.
   Brevet åpnes i detaljpanelets Brev-fane. Brevet er ett modellkall som
   bare starter når brukeren trykker. Mangler annonsen og søknaden har en
   lenke, hentes den først (falskt nett, falsk annonsemodell). Å åpne et
   brev med en uferdig kjøring gir aldri et modellkall. */
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
let modellfeil=false,hentPort=null,ikkeAnnonse=false;
const kall=[];          // formålet til hvert modellkall, i rekkefølge
const deltaer=[];
const stilIKall=[];
const kildeblokker=[];  // kildene som ble sendt til brevkallet
const hentet=[];        // adressene det falske nettet fikk
const side=url=>`<main><p>Logg inn</p><p>${annonse}</p><p>Andre stillinger hos oss</p></main>`;
const server=lagServer({katalog:path.join(dir,"data"),nett:{hentSide:async url=>{
  hentet.push(url);
  if(hentPort)await hentPort.promise;
  if(url.includes("/dod"))throw new Error("Siden svarte 404.");
  return {status:200,html:side(url),sluttUrl:url};
}},brevModellFor:()=>async ({formal,kilder,innhold,signal,felt,påDelta})=>{
  // Matchvurderingen kan startes av panelet. Den hører ikke til brevet og telles ikke.
  if(formal!=="annonse"&&formal!=="brev")throw new BrevModellfeil("modell","Ikke i bruk i denne testen.");
  kall.push(formal);
  // Annonsemodellen velger linjene mellom menyen og bunnteksten.
  if(formal==="annonse"){
    if(ikkeAnnonse)return {data:{erAnnonse:false,behold:[]},bruk:{input_tokens:50,output_tokens:5},modell:"syntetisk-annonsemodell"};
    const linjer=JSON.parse(innhold).side.split("\n");
    const fra=linjer.findIndex(l=>l.includes("Eksempel AS søker"))+1,til=linjer.findIndex(l=>l.includes("Andre stillinger"));
    return {data:{erAnnonse:true,behold:[{fra,til}]},bruk:{input_tokens:50,output_tokens:12},modell:"syntetisk-annonsemodell"};
  }
  assert.ok(Array.isArray(kilder)&&kilder.length>=1&&kilder.length<=3,"kildene er en liste med opptil tre blokker");
  kildeblokker.push(kilder);
  const g=JSON.parse(kilder[1]).soknad,sprak=g.sprakvalg==="en"?"en":"nb";
  stilIKall.push(kilder.join("").includes("rydde i data"));
  // Den syntetiske modellen strømmer feltet i biter, slik den ekte gjør,
  // så forhåndsvisningen i flaten faktisk får noe å vise.
  const strømmes=sprak==="en"?engelsk:brev;
  for(let i=0;i<strømmes.length;i+=Math.ceil(strømmes.length/6)){
    await new Promise(r=>setTimeout(r,75));signal?.throwIfAborted();
    const bit=strømmes.slice(i,i+Math.ceil(strømmes.length/6));
    if(påDelta&&felt){påDelta(bit);deltaer.push({felt,bit});}
  }
  signal?.throwIfAborted();
  // Samme feil som den ekte leverandøren kaster når tjenesten er nede.
  if(modellfeil)throw new BrevModellfeil("modell","Modelltjenesten svarte 503. Prøv igjen senere.");
  return {data:{tekst:strømmes,sprak,merknader:[],pastander:[],maAvklares:false},bruk:{input_tokens:100,output_tokens:250},modell:"syntetisk-testmodell"};
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
  assert.ok((await context.request.put(url+"/api/jobber",{data:{versjon:data.versjon,jobber:[jobb("brevtest",{lenke:"https://example.com/jobb"}),jobb("utenlenke",{selskap:"Uten Lenke AS",frist:"2027-11-01"}),
    jobb("dod",{selskap:"Død Lenke AS",lenke:"https://example.com/dod"}),jobb("nedtatt",{selskap:"Nedtatt AS",lenke:"https://example.com/nedtatt"}),
    jobb("klarjobb",{selskap:"Klar AS"}),jobb("gammel",{selskap:"Gammel AS"})]}})).ok());
  assert.ok((await context.request.put(url+"/api/cv",{data:{revisjon:0,tekst:cv,navn:"Astrid Eksempel",format:"tekst"}})).ok());
  /* Annonsen limes inn i jobbdokumentet slik Annonse-fanen gjør. */
  const settAnnonse=async id=>{
    const d=await (await context.request.get(url+`/api/jobber/${id}/dokument`)).json();
    assert.ok((await context.request.put(url+`/api/jobber/${id}/dokument`,{data:{...d,annonse:{tekst:annonse,url:"",kilde:"limt",hentet:null}}})).ok());
  };
  // En kjøring som står i «klar»: grunnlaget er samlet, ingenting er betalt.
  await settAnnonse("klarjobb");
  assert.ok((await context.request.post(url+"/api/jobber/klarjobb/brev/kjoringer",{data:{}})).ok());
  // Et brev fra flyten i tre trinn: en versjon med analyse og en kjøring som ble stående i «venter».
  await settAnnonse("gammel");
  const gammelGrunnlag={cv,annonse,jobb:{selskap:"Gammel AS",stilling:"Kunderådgiver",sted:"Oslo",jobbtype:"Fast stilling",sektor:"Teknologi"},sprak:"auto",leverandor:"anthropic",historikk:[],stilreferanse:""};
  const gammelAnalyse={sprak:"nb",begrunnelse:"Norsk, som annonsen ber om.",kontaktperson:"",krav:[],bevis:[],virksomhet:[],uklarheter:[],merknader:[],maAvklares:false};
  const gammelBrev=await (await context.request.get(url+"/api/jobber/gammel/brev")).json();
  assert.ok((await context.request.put(url+"/api/jobber/gammel/brev",{data:{...gammelBrev,tekst:brev,aktivVersjon:"v-gammel",versjoner:[{id:"v-gammel",tekst:brev,sprak:"nb",opprettet:"2026-10-01T10:05:00.000Z",
    grunnlag:gammelGrunnlag,analyse:gammelAnalyse,instruks:"",historikk:[],leverandor:"anthropic",modell:"claude-opus-5",promptversjon:"brev-4",merknader:[],bruk:[{input_tokens:1},{input_tokens:2},{input_tokens:3}]}]}})).ok());
  const brukerId=(await fs.readdir(path.join(dir,"data","brukere"),{withFileTypes:true})).find(e=>e.isDirectory()).name;
  const gammelFil=path.join(dir,"data","brukere",brukerId,"brev-gammel.json");
  const gammelDok=JSON.parse(await fs.readFile(gammelFil,"utf8"));
  gammelDok.kjoring={id:"gammel-kjoring",status:"venter",opprettet:"2026-10-01T10:00:00.000Z",grunnlag:gammelGrunnlag,cvRevisjon:1,utgangspunkt:"",instruks:"",analyse:gammelAnalyse,utkast:null};
  await fs.writeFile(gammelFil,JSON.stringify(gammelDok,null,2));
  page=await context.newPage();const feil=[],trinnsvar=[],utgått=[];
  page.on("pageerror",e=>feil.push(e.message));
  page.on("request",r=>{if(r.url().includes("/api/annonsetekst"))utgått.push(r.url());});
  page.on("response",r=>{if(r.url().endsWith("/trinn"))trinnsvar.push({status:r.status(),type:r.headers()["content-type"]});});
  const klar=()=>page.waitForFunction(()=>document.querySelector(".brev")?.getAttribute("aria-busy")==="false");
  await page.goto(url);await page.locator('.rad[data-id="brevtest"] [data-gjor="brev"]').click();
  assert.equal(await page.evaluate(()=>location.hash),"#jobb/brevtest/brev");
  await klar();

  /* ---------- åpne et brev starter ingenting ---------- */
  await page.goto(url);
  // Kjøringen i «klar» tilbys som «Skriv på nytt», uten at noe skrives.
  await page.locator('.rad[data-id="klarjobb"] [data-gjor="brev"]').click();
  await klar();
  await page.locator('[data-brev="skrivIgjen"]').waitFor({state:"visible"});
  assert.equal(await page.locator("#brevFremdrift").getAttribute("data-fase"),"hvile");
  assert.equal(await page.locator("#brevStatus").textContent(),"Utkastet ble ikke ferdig.");
  assert.equal(await page.locator("#brevTekst").inputValue(),"");
  assert.equal(await page.locator('[data-brev="stopp"]').isHidden(),true);
  assert.deepEqual(kall,[],"å åpne brevet gir ingen modellkall");
  // En kjøring fra de tre trinnene er ikke en feil. Brevet og versjonen med analyse vises som før.
  await page.locator('#detalj [data-panel="lukk"]').click();
  await page.locator("#detalj").waitFor({state:"hidden"});
  await page.locator('.rad[data-id="gammel"] [data-gjor="brev"]').click();
  await klar();
  await page.locator('[data-brev="skrivIgjen"]').waitFor({state:"visible"});
  assert.equal(await page.locator("#brevTekst").inputValue(),brev);
  assert.equal(await page.locator("#brevFeil").isHidden(),true);
  assert.equal(await page.locator("#brevFremdrift").getAttribute("data-fase"),"hvile");
  assert.equal(await page.locator("#brevVersjon option").count(),1);
  assert.deepEqual(kall,[],"en gammel kjøring starter ikke av seg selv");
  await page.screenshot({path:path.join(dir,"00-gammel-kjoring.png")});
  // «Skriv på nytt» er det eneste som koster noe, og gir ett kall.
  await page.locator('[data-brev="skrivIgjen"]').click();
  await page.waitForFunction(()=>document.querySelector("#brevStatus").textContent.startsWith("Utkastet er klart")||document.querySelector("#brevStatus").textContent.startsWith("Endringene dine"));
  assert.deepEqual(kall,["brev"]);
  assert.equal(await page.locator('[data-brev="skrivIgjen"]').isHidden(),true);
  await page.locator('#detalj [data-panel="lukk"]').click();
  await page.locator("#detalj").waitFor({state:"hidden"});
  // Samme med kjøringen i «klar»: ett kall, og så en ferdig versjon.
  await page.locator('.rad[data-id="klarjobb"] [data-gjor="brev"]').click();
  await klar();
  await page.locator('[data-brev="skrivIgjen"]').click();
  await page.waitForFunction(()=>document.querySelector("#brevStatus").textContent.startsWith("Utkastet er klart"));
  assert.deepEqual(kall,["brev","brev"]);
  assert.equal((await page.locator("#brevTekst").inputValue()).startsWith("Til rekrutteringsteamet"),true);
  await page.locator('#detalj [data-panel="lukk"]').click();
  await page.locator("#detalj").waitFor({state:"hidden"});
  kall.length=0;deltaer.length=0;kildeblokker.length=0;stilIKall.length=0;

  /* ---------- annonsen mangler, men lenken finnes: den hentes først ---------- */
  await page.locator('.rad[data-id="brevtest"] [data-gjor="brev"]').click();
  assert.equal(await page.evaluate(()=>location.hash),"#jobb/brevtest/brev");
  await klar();
  await page.waitForFunction(()=>document.querySelector("#brevAnnonseVerdi").textContent==="Mangler");
  const skriv=page.getByRole("button",{name:"Skriv utkast",exact:true});
  assert.equal(await skriv.isDisabled(),false,"med lenke kan utkastet skrives, annonsen hentes først");
  assert.equal(await page.locator("#brevSkrivGrunn").textContent(),"Annonsen hentes fra example.com først");
  assert.equal(await skriv.getAttribute("aria-describedby"),"brevSkrivGrunn");
  // Det som var spørsmål, kontekst og raden med tre steg, er borte.
  for(const borte of ["#brevKontekst","#brevSporsmal","#brevAnnonseUrl","#brevAnnonseTekst",'[data-steg="avklaring"]',"#brevFlyt",".brev__steg"])assert.equal(await page.locator(borte).count(),0,borte);
  // Språkvelgeren leverer koden, ikke etiketten.
  assert.deepEqual(await page.$$eval("#brevSprak option",o=>o.map(x=>x.value)),["auto","nb","nn","en","sv","da","de","fr"]);
  assert.deepEqual(kall,[]);
  await page.screenshot({path:path.join(dir,"01-mangler-annonse.png")});

  /* ---------- Skriv utkast: henter annonsen, så ett Opus-kall ---------- */
  hentPort=Promise.withResolvers();
  await skriv.click();
  await page.waitForFunction(()=>document.querySelector("#brevFremdrift").dataset.fase==="henter");
  assert.match(await page.locator("#brevStatus").textContent(),/^Henter annonsen fra example\.com/);
  assert.equal(await page.locator("#brevTid").isVisible(),true);
  assert.deepEqual(kall,[],"ingen modell er spurt før siden er hentet");
  hentPort.resolve();
  // Teksten skal synes mens den blir skrevet, ikke først når den er ferdig.
  await page.waitForFunction(()=>{const s=document.querySelector("#brevStrom");return !s.hidden&&s.textContent.trim().length>0;});
  assert.equal(await page.locator("#brevFremdrift").getAttribute("data-fase"),"skriver");
  await page.screenshot({path:path.join(dir,"02-strommer.png")});
  await page.waitForFunction(()=>document.querySelector("#brevTekst").value.includes("Jeg søker")&&!document.querySelector('[data-brev="forbedre"]').disabled);
  assert.deepEqual(kall,["annonse","brev"],"Haiku henter annonsen, så ett Opus-kall");
  assert.deepEqual(hentet,["https://example.com/jobb"]);
  // Når brevet står i feltet, er laget over papiret borte og fremdriften i hvile.
  assert.equal(await page.locator("#brevStrom").isHidden(),true);
  assert.equal(await page.locator("#brevFremdrift").getAttribute("data-fase"),"hvile");
  assert.equal(await page.locator("#brevTid").isHidden(),true);
  assert.equal(await page.locator("#brevAnnonseVerdi").textContent().then(t=>t.startsWith("Lagret")),true);
  // Trinnet gikk som strøm, og modellen strømmet brevets tekstfelt.
  assert.ok(trinnsvar.length>=1&&trinnsvar.every(r=>r.status===200&&r.type?.startsWith("text/event-stream")),JSON.stringify(trinnsvar));
  assert.deepEqual([...new Set(deltaer.map(d=>d.felt))],["tekst"]);
  // Annonsen er lagret i jobbdokumentet, uten menyen og bunnteksten Haiku ikke valgte.
  const jobbdok=await (await context.request.get(url+"/api/jobber/brevtest/dokument")).json();
  assert.ok(jobbdok.annonse.tekst.includes("kunderådgiver")&&!jobbdok.annonse.tekst.includes("Logg inn")&&!jobbdok.annonse.tekst.includes("Andre stillinger"),jobbdok.annonse.tekst);
  assert.equal(jobbdok.annonse.kilde,"hentet");
  // Kildene til Opus er en liste med bufrede blokker, og annonsen er med.
  assert.equal(kildeblokker.length,1);
  assert.ok(kildeblokker[0].join("").includes("Eksempel AS søker kunderådgiver"));
  const lagretBrev=await (await context.request.get(url+"/api/jobber/brevtest/brev")).json();
  assert.equal(lagretBrev.kjoring.status,"ferdig");
  assert.equal(lagretBrev.versjoner.at(-1).bruk.length,1,"ett kall er ført i versjonen");
  assert.equal(lagretBrev.versjoner.at(-1).promptversjon,"brev-5");
  await page.screenshot({path:path.join(dir,"03-brev-lys.png")});

  /* ---------- en tekstendring under arbeidet vinner over modellsvaret ---------- */
  await page.locator("#brevInstruks").fill("Gjør åpningen kortere.");
  await page.getByRole("button",{name:"Lag ny versjon",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-brev="stopp"]').hidden===false);
  await page.locator("#brevTekst").fill(brev+"\n\nMin manuelle avslutning.");
  await page.waitForFunction(()=>!document.querySelector('[data-brev="forbedre"]').disabled);
  assert.ok((await page.locator("#brevTekst").inputValue()).endsWith("Min manuelle avslutning."));
  assert.deepEqual(kall,["annonse","brev","brev"],"en ny versjon er ett Opus-kall til, og annonsen hentes ikke på nytt");
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
  // Statuslinjen med fremdriften må få plass på den smaleste bredden.
  assert.equal(await page.evaluate(()=>{const f=document.querySelector("#brevFremdrift");return f.scrollWidth<=f.clientWidth&&f.getBoundingClientRect().right<=window.innerWidth;}),true);
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

  /* ---------- en lenke som ikke svarer: feilen med veien til Annonse-fanen, og ingen modell ---------- */
  await page.locator('#detalj [data-panel="lukk"]').click();
  await page.locator("#detalj").waitFor({state:"hidden"});
  kall.length=0;
  await page.locator('.rad[data-id="dod"] [data-gjor="brev"]').click();
  await klar();
  await page.getByRole("button",{name:"Skriv utkast",exact:true}).click();
  await page.locator("#brevFeil").waitFor({state:"visible"});
  assert.match(await page.locator("#brevFeil").textContent(),/Annonsen ligger ikke lenger på adressen/);
  assert.equal(await page.locator("#brevFremdrift").getAttribute("data-fase"),"stoppet");
  assert.equal(await page.locator("#brevStatus").textContent(),"Brevet er ikke skrevet, fordi annonsen ikke kunne hentes.");
  assert.deepEqual(kall,[],"ingen modell er spurt når siden ikke kan hentes");
  assert.equal(await page.locator("#brevTekst").inputValue(),"");
  await page.screenshot({path:path.join(dir,"08-lenke-dod.png")});
  await page.locator('#brevFeil [data-brev="limAnnonse"]').click();
  await page.waitForFunction(()=>location.hash==="#jobb/dod/annonse");
  await page.waitForFunction(()=>document.activeElement?.id==="annonseLim");
  await page.locator("#detaljFane-brev").click();
  await klar();
  // Siden finnes, men modellen sier at den ikke har noen annonse: samme vei, og ingen Opus-kall.
  await page.locator('#detalj [data-panel="lukk"]').click();
  await page.locator("#detalj").waitFor({state:"hidden"});
  ikkeAnnonse=true;
  await page.locator('.rad[data-id="nedtatt"] [data-gjor="brev"]').click();
  await klar();
  await page.getByRole("button",{name:"Skriv utkast",exact:true}).click();
  await page.locator('#brevFeil [data-brev="limAnnonse"]').waitFor();
  assert.deepEqual(kall,["annonse"],"bare uttrekket er forsøkt, brevet er ikke skrevet");
  ikkeAnnonse=false;

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
