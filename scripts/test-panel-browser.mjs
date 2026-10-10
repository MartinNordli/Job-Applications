/* Detaljpanelet og «⋯»-menyen i en ekte nettleser: åpning med klikk og
   Enter, direktelenker og tilbakeknappen, stegraden med angre, notatet,
   annonsen (visning, tom, innliming og hentefeil), brevet, menyen med
   tastaturet, radknappenes kolonne og arket på telefonbredde.
   Isolert datakatalog, syntetisk konto og falskt nett: ingen side
   utenfor maskinen blir spurt. Skjermbildene, også av alle fem temaene
   i fem bredder, blir liggende i arbeidskatalogen. */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { lagServer } from "../server/server.mjs";
import { isoDato } from "../src/fristvarsel.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "panel-nettleser-"));
const nett = {
  hentSide: async url => { throw new Error(url.includes("borte") ? "Siden svarte 404." : "Adressen peker ikke til en nettside."); },
  spørModell: async () => { throw new Error("Ingen modell i denne testen."); }
};
const server = lagServer({ katalog: path.join(dir, "data"), nett });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;

const omDager = n => { const d = new Date(); d.setDate(d.getDate() + n); return isoDato(d); };
const jobb = (id, selskap, o = {}) => ({ id, selskap, stilling: "Dataingeniør", lenke: "", sted: "Bergen",
  frist: omDager(5), status: "todo", sektor: "energi", jobbtype: "fulltid", notat: "", sendtDato: null, ...o });

const JOBBER = [
  jobb("snart", "Eksempelkraft", { lenke: "https://jobb.example.invalid/borte",
    hendelser: [{ til: "todo", dato: omDager(-10), kilde: "bruker" }] }),
  jobb("annonse", "Fjordnett", { frist: omDager(12), lenke: "https://jobb.example.invalid/fjordnett" }),
  jobb("utenlenke", "Havbruk Vest", { frist: null }),
  jobb("utgatt", "Kystdata", { frist: omDager(-4) }),
  jobb("sendt", "Nordlys Analyse", { status: "sent", sendtDato: omDager(-20), frist: omDager(-21),
    hendelser: [{ til: "todo", dato: omDager(-30) }, { til: "sent", dato: omDager(-20) }] }),
  jobb("intervju", "Vestvind", { status: "interview", lenke: "https://jobb.example.invalid/vestvind.pdf", sendtDato: omDager(-40), frist: omDager(-41), intervju: true,
    stilling: "Graduate: Life Cycle Data Services med et svært langt stillingsnavn som må brytes pent" }),
  jobb("avslag", "Bølge AS", { status: "rejected", sendtDato: omDager(-60), frist: omDager(-61), intervju: true })
];

const ANNONSE = "Fjordnett søker dataingeniør\n"
  + "Vi bygger dataplattformen for strømnettet på Vestlandet, og vil ha med deg som liker å gjøre rotete data til noe folk kan stole på.\n\n"
  + "Arbeidsoppgaver:\nBygge og drifte datastrømmer\nSamarbeide med analytikere\nSkrive tester og dokumentasjon\n\n"
  + "Vi ser etter deg som\n- har master i informatikk eller tilsvarende\n- kan Python og SQL\n\n"
  + "Søk innen fristen. Vi intervjuer fortløpende.";

let browser, page;
try{
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE
    ? { executablePath: process.env.BROWSER_EXECUTABLE }
    : process.platform === "darwin" ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });

  const reg = await context.request.post(url + "/api/registrer",
    { data: { epost: "test@eksempel.no", navn: "Astrid Eksempel", passord: "syntetisk-passord-123" } });
  assert.ok(reg.ok());
  const brukerId = (await reg.json()).bruker.id;
  const v = await (await context.request.get(url + "/api/jobber")).json();
  assert.ok((await context.request.put(url + "/api/jobber", { data: { versjon: v.versjon, jobber: JOBBER } })).ok());
  assert.ok((await context.request.put(url + "/api/jobber/annonse/dokument", { data: { revisjon: 0,
    annonse: { tekst: ANNONSE, url: "https://jobb.example.invalid/fjordnett", kilde: "limt", hentet: new Date().toISOString() } } })).ok());
  /* Vurderingen skrives bare av tjenesten som lager den, så den legges
     rett i filen her, slik en ferdig vurdering ville ligget. */
  const fil = path.join(dir, "data", "brukere", brukerId, "jobb-annonse.json");
  const lagret = JSON.parse(await fs.readFile(fil, "utf8"));
  lagret.match = { prosent: 78, oppsummering: "Godt treff på data og Python, svakere på domenet.",
    styrker: [{ krav: "Python og SQL", bevis: "To år med dataflyt i Python.", kilder: [] }],
    mangler: [{ krav: "Erfaring fra kraftbransjen", alvor: "middels" }] };
  await fs.writeFile(fil, JSON.stringify(lagret, null, 2));

  const påDisk = async id => (await (await context.request.get(url + "/api/jobber")).json()).jobber.find(j => j.id === id);
  const dokument = async id => (await context.request.get(`${url}/api/jobber/${id}/dokument`)).json();
  async function vent(fn, hva){
    for(let i = 0; i < 80; i++){ const r = await fn(); if(r) return r; await page.waitForTimeout(100); }
    throw new Error("Ventet forgjeves på " + hva);
  }

  page = await context.newPage();
  const feil = [];
  page.on("pageerror", e => feil.push(e.message));
  page.on("console", m => { if(m.type() === "error" && !/404|Failed to load resource/.test(m.text())) feil.push(m.text()); });
  await page.goto(url);
  await page.locator(".rad").first().waitFor();
  const panel = page.locator("#detalj");
  const hash = () => page.evaluate(() => location.hash);
  const aktiv = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.className || "");

  /* ---------- raden: alle knappene i én kolonne, i alle bånd ---------- */
  await page.locator("#utgatt > summary").click();
  const kolonner = await page.$$eval("#innhold .rad", rader => {
    const x = s => rader.map(r => Math.round(r.querySelector(s).getBoundingClientRect().right));
    return { brev: x('[data-gjor="brev"]'), hoved: x(".handling--hoved"), meny: x("[data-meny]"),
             om: rader.map(r => Math.round(r.querySelector(".rad__om").getBoundingClientRect().right)) };
  });
  for(const [hva, xs] of Object.entries(kolonner)) assert.equal(new Set(xs).size, 1, hva + " står i samme kolonne: " + xs);
  assert.equal(await page.locator(".rad__mer").count(), 0, "ingen skjulte sidehandlinger");
  /* Ingenting dukker opp når musa går over raden. */
  const førHover = await page.locator('.rad[data-id="utgatt"] button').count();
  await page.locator('.rad[data-id="utgatt"]').hover();
  assert.equal(await page.locator('.rad[data-id="utgatt"] button:visible').count(), førHover);
  await page.screenshot({ animations: "disabled", path: path.join(dir, "01-liste.png"), fullPage: true });

  /* Sendt-visningen blander «Fikk intervju» og «Fikk tilbud» og merkelapper. */
  await page.locator('[data-visning="sendt"]').click();
  const sendtKol = await page.$$eval("#innhold .rad", rader => rader.map(r => Math.round(r.querySelector(".handling--hoved").getBoundingClientRect().left)));
  assert.equal(new Set(sendtKol).size, 1, "hovedknappen har samme bredde uansett tekst");
  await page.locator('[data-visning="frister"]').click();

  /* ---------- «⋯»-menyen med tastaturet ---------- */
  const knapp = page.locator('.rad[data-id="utgatt"] [data-meny]');
  await knapp.focus();
  await page.keyboard.press("ArrowDown");
  await page.locator("#radmeny").waitFor();
  assert.equal(await knapp.getAttribute("aria-expanded"), "true");
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Rediger");
  assert.deepEqual(await page.$$eval("#radmeny [role=menuitem]", v => v.map(x => x.textContent)), ["Rediger", "Marker som utløpt", "Slett"]);
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Marker som utløpt");
  await page.keyboard.press("End");
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Slett");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Rediger", "pilene går rundt");
  await page.screenshot({ animations: "disabled", path: path.join(dir, "02-meny.png") });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#radmeny").isHidden(), true);
  assert.equal(await knapp.getAttribute("aria-expanded"), "false");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.meny), "utgatt", "fokus tilbake på knappen");
  assert.equal(await panel.isHidden(), true, "Esc i menyen lukker bare menyen");
  /* Enter åpner, en bokstav hopper, og valget utføres. */
  await page.keyboard.press("Enter");
  await page.keyboard.press("m");
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Marker som utløpt");
  await page.keyboard.press("Enter");
  await vent(async () => (await påDisk("utgatt")).status === "expired", "utløpt fra menyen");
  await page.locator("#angreKnapp").click();
  await vent(async () => (await påDisk("utgatt")).status === "todo", "angret");
  /* Klikk utenfor lukker. */
  await page.locator('.rad[data-id="snart"] [data-meny]').click();
  await page.locator("#radmeny").waitFor();
  await page.locator("#sidetittel").click();
  assert.equal(await page.locator("#radmeny").isHidden(), true);

  /* ---------- åpne med klikk, lukke med Esc ---------- */
  await page.locator('.rad[data-id="snart"] .dato').click();
  await panel.waitFor();
  assert.equal(await hash(), "#jobb/snart/oversikt");
  assert.equal(await page.locator('.rad[data-id="snart"]').getAttribute("aria-current"), "true");
  await page.waitForFunction(() => document.activeElement?.id === "detaljTittel");
  assert.equal(await panel.getAttribute("role"), "complementary", "på bred skjerm er panelet ikke modalt");
  assert.equal(await page.locator(".skall > .hoved").getAttribute("inert"), null);
  /* Knapper og lenker i raden gjør sitt eget, ikke panelets. */
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden" });
  assert.equal(await hash(), "");
  assert.equal(await page.evaluate(() => document.activeElement?.closest(".rad")?.dataset.id), "snart", "fokus tilbake på raden");
  assert.equal(await page.locator(".rad.er-valgt").count(), 0);
  await page.locator('.rad[data-id="snart"] [data-meny]').click();
  assert.equal(await panel.isHidden(), true, "menyknappen åpner ikke panelet");
  await page.keyboard.press("Escape");

  /* ---------- Enter på raden, og tilbakeknappen ---------- */
  await page.locator('.rad[data-id="sendt"]').count();
  await page.locator('[data-visning="sendt"]').click();
  await page.locator('.rad[data-id="sendt"] .rad__selskap').focus();
  await page.keyboard.press("Enter");
  await panel.waitFor();
  assert.equal(await hash(), "#jobb/sendt/oversikt");
  assert.match(await page.locator(".detalj__fakta").textContent(), /Sendt .*venter 20 dager/);
  await page.goBack();
  await panel.waitFor({ state: "hidden" });
  assert.equal(await hash(), "");
  await page.goForward();
  await panel.waitFor();
  assert.equal(await page.locator("#detaljTittel").textContent(), "Nordlys Analyse");
  await page.locator('#detalj [data-panel="lukk"]').click();
  await panel.waitFor({ state: "hidden" });
  await page.locator('[data-visning="frister"]').click();

  /* ---------- direktelenke rett på annonsen ---------- */
  await page.goto(url + "/#jobb/annonse/annonse");
  await panel.waitFor();
  await page.locator(".annonse__tekst").waitFor();
  assert.equal(await page.locator("#detaljFane-annonse").getAttribute("aria-selected"), "true");
  assert.equal(await page.locator(".annonse__tekst h4").first().textContent(), "Fjordnett søker dataingeniør");
  assert.deepEqual(await page.$$eval(".annonse__tekst ul", u => u.map(x => x.children.length)), [3, 2], "listene er lister");
  assert.match(await page.locator(".annonse__kilde").textContent(), /Limt inn .*jobb\.example\.invalid/);
  assert.equal(await page.locator(".annonse__original").getAttribute("href"), "https://jobb.example.invalid/fjordnett");
  assert.match(await page.locator(".detalj__match").textContent(), /78 % match/);
  assert.equal(await page.locator('.rad[data-id="annonse"]').getAttribute("aria-current"), "true");
  await page.screenshot({ animations: "disabled", path: path.join(dir, "03-annonse.png") });

  /* Fanene med piltastene. */
  await page.locator("#detaljFane-annonse").focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => location.hash === "#jobb/annonse/oversikt");
  assert.equal(await page.evaluate(() => document.activeElement.id), "detaljFane-oversikt");
  await page.locator(".match").waitFor();
  assert.match(await page.locator(".match").textContent(), /78 %.*Python og SQL.*kraftbransjen/s);
  await page.screenshot({ animations: "disabled", path: path.join(dir, "04-oversikt-match.png") });

  /* ---------- stegraden, med samme angre som raden ---------- */
  await page.locator('#detalj [data-status="sent"]').click();
  await vent(async () => (await påDisk("annonse")).status === "sent", "sendt fra stegraden");
  assert.equal(await page.locator('#detalj .steg__post[data-tilstand="naa"] .steg__navn').textContent(), "Sendt");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.status), "sent", "fokus blir i stegraden");
  assert.match(await page.locator(".tidslinje").textContent(), /Sendt/);
  assert.match(await page.locator("#varsel").textContent(), /Fjordnett · sendt/);
  await page.locator("#angreKnapp").click();
  await vent(async () => (await påDisk("annonse")).status === "todo", "angret statusen");
  assert.equal(await page.locator('#detalj .steg__post[data-tilstand="naa"] .steg__navn').textContent(), "Å søke på");
  assert.equal(await page.locator("#detaljFane-oversikt").getAttribute("aria-selected"), "true", "fanen står");

  /* ---------- notatet ---------- */
  await page.locator("#detaljNotat").fill("Ring Kari om rotasjonsordningen.\nSpør om oppstart.");
  await page.keyboard.press("Tab");
  await vent(async () => (await påDisk("annonse")).notat === "Ring Kari om rotasjonsordningen.\nSpør om oppstart.", "notatet på disk");
  await page.waitForFunction(() => document.querySelector('[data-del="notatstatus"]')?.textContent === "Lagret");
  assert.match(await page.locator('.rad[data-id="annonse"] .rad__notat').textContent(), /Ring Kari/);

  /* ---------- endringer i skuffen vises i panelet ---------- */
  await page.locator('#detalj [data-panel="rediger"]').click();
  await page.locator("#skuff.er-apen").waitFor();
  assert.equal(await page.locator("#fnotat").inputValue(), "Ring Kari om rotasjonsordningen.\nSpør om oppstart.", "linjeskiftet står");
  await page.locator("#fstilling").fill("Senior dataingeniør");
  await page.locator("#lagreSkjema").click();
  await page.locator("#skuff:not(.er-apen)").waitFor();
  assert.match(await page.locator(".detalj__stilling").textContent(), /Senior dataingeniør/);
  assert.equal(await panel.isVisible(), true);

  /* ---------- tom annonse, hentefeil og innliming ---------- */
  await page.locator('.rad[data-id="snart"] .rad__selskap').click();
  await page.waitForFunction(() => location.hash === "#jobb/snart/oversikt");
  await page.locator("#detaljFane-annonse").click();
  await page.locator(".annonse--tom").waitFor();
  assert.equal(await page.locator(".detalj__tomtittel").textContent(), "Ingen annonse lagret");
  await page.screenshot({ animations: "disabled", path: path.join(dir, "05-annonse-tom.png") });
  await page.getByRole("button", { name: "Hent annonsen", exact: true }).click();
  await page.locator(".detalj__feil").waitFor();
  assert.equal(await page.locator(".detalj__feiltittel").textContent(), "Annonsen ligger ikke lenger på adressen.");
  await page.waitForFunction(() => /ligger ikke lenger/.test(document.querySelector("#detaljMelding")?.textContent || ""));
  await page.screenshot({ animations: "disabled", path: path.join(dir, "06-hentefeil.png") });
  assert.equal(await page.locator(".detalj__feil button").count(), 0, "meldingen gjentar ikke «Lim inn»");
  await page.getByRole("button", { name: "Lim inn", exact: true }).click();
  await page.locator("#annonseLim").waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), "annonseLim");
  await page.getByRole("button", { name: "Lagre annonsen" }).click();
  assert.equal(await page.locator(".detalj__feiltittel").textContent(), "Lim inn teksten fra annonsen først.");
  await page.locator("#annonseLim").fill("Eksempelkraft søker dataingeniør.\n\nDu bygger prognoser for kraftmarkedet sammen med et lite team i Bergen.");
  await page.getByRole("button", { name: "Lagre annonsen" }).click();
  await page.locator(".annonse__tekst").waitFor();
  const dSnart = await vent(async () => { const d = await dokument("snart"); return d.annonse?.kilde ? d : null; }, "annonsen på disk");
  assert.equal(dSnart.annonse.kilde, "limt");
  assert.match(dSnart.annonse.tekst, /prognoser for kraftmarkedet/);

  /* Esc i innlimingen avbryter den, ikke panelet. */
  await page.getByRole("button", { name: "Lim inn", exact: true }).click();
  await page.locator("#annonseLim").waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".annonse__tekst").waitFor();
  assert.equal(await panel.isVisible(), true);

  /* Uten lenke: bare innliming, og veien til skjemaet. */
  await page.locator('.rad[data-id="utenlenke"] .rad__selskap').click();
  await page.waitForFunction(() => location.hash === "#jobb/utenlenke/annonse");
  await page.locator(".annonse--tom").waitFor();
  assert.equal(await page.getByRole("button", { name: "Hent annonsen" }).count(), 0);
  assert.match(await page.locator(".detalj__tomtekst").textContent(), /ingen lenke/);

  /* ---------- brevet monteres, og rydder etter seg ---------- */
  await page.locator("#detaljFane-brev").click();
  await page.locator("#brevKontekst").waitFor({ state: "attached" });
  await page.waitForFunction(() => !document.querySelector("#brevGrunnlagsfelter")?.disabled);
  assert.equal(await page.locator("#detaljBunn").isVisible(), true);
  assert.equal(await page.locator(".detalj__fane[aria-selected=true]").textContent(), "Brev");
  await page.screenshot({ animations: "disabled", path: path.join(dir, "07-brev.png") });
  await page.locator("#detaljFane-oversikt").click();
  await page.locator(".oversikt").waitFor();
  assert.equal(await page.locator("#brevKontekst").count(), 0, "brevflaten er borte");
  assert.equal(await page.locator("#detaljBunn").isHidden(), true);
  /* Med panelet ved siden av en smal liste er radknappene tatt ut:
     panelet har dem alle. */
  assert.equal(await page.locator('.rad[data-id="snart"] [data-gjor="brev"]').isHidden(), true);
  await page.locator('#detalj [data-panel="lukk"]').click();
  await panel.waitFor({ state: "hidden" });
  /* «Søknadsbrev» på raden åpner panelet rett på brevet, og lukking
     venter på at brevet er lagret. */
  await page.locator('.rad[data-id="snart"] [data-gjor="brev"]').click();
  await page.waitForFunction(() => location.hash === "#jobb/snart/brev");
  await page.waitForFunction(() => !document.querySelector("#brevGrunnlagsfelter")?.disabled);
  await page.locator("#brevKontekst").fill("Jeg vil jobbe med kraftmarkedet.");
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden" });
  const brev = await (await context.request.get(url + "/api/jobber/snart/brev")).json();
  assert.equal(brev.kontekst, "Jeg vil jobbe med kraftmarkedet.", "brevet ble lagret før panelet lukket seg");

  /* ---------- en slettet søknad lukker panelet ---------- */
  await page.locator('.rad[data-id="utgatt"]').click({ position: { x: 30, y: 20 } });
  await page.waitForFunction(() => location.hash === "#jobb/utgatt/oversikt");
  assert.match(await page.locator(".steg__utganger").textContent(), /Marker som utløpt/);
  await page.locator('#detalj [data-panel="slett"]').click();
  await panel.waitFor({ state: "hidden" });
  assert.equal(await hash(), "");
  assert.match(await page.locator("#varsel").textContent(), /Slettet Kystdata/);
  await page.locator("#angreKnapp").click();
  await page.locator('.rad[data-id="utgatt"]').waitFor();

  /* ---------- en direktelenke viser raden, også i en annen visning ---------- */
  await page.goto(url + "/#jobb/avslag/oversikt");
  await panel.waitFor();
  assert.equal(await page.locator('[data-visning="arkiv"]').getAttribute("aria-selected"), "true");
  assert.equal(await page.locator('.rad[data-id="avslag"]').getAttribute("aria-current"), "true");
  assert.equal(await page.locator(".steg__utfall .merkelapp").textContent(), "Avslag");
  assert.equal(await page.locator('.steg__post[data-tilstand="ferdig"]').count(), 3, "avslaget kom etter intervjuet");
  await page.screenshot({ animations: "disabled", path: path.join(dir, "10-avslag.png") });

  /* ---------- en lenke til noe som ikke finnes ---------- */
  await page.goto(url + "/#jobb/finnesikke/oversikt");
  await page.locator(".rad").first().waitFor();
  await page.waitForFunction(() => /Fant ikke søknaden/.test(document.querySelector("#varsel")?.textContent || ""));
  assert.equal(await panel.isHidden(), true);
  assert.equal(await hash(), "");

  /* ---------- hent manglende annonser, fra «Dataene dine» ---------- */
  await page.locator("#apneEksport").click();
  await page.waitForFunction(() => document.querySelector("#manglendeTall")?.textContent === "(5)");
  await page.locator("#hentManglende").click();
  await page.locator("#manglendeSvar").waitFor();
  const svar = await page.locator("#manglendeSvar").textContent();
  assert.match(svar, /4 søknader har ingen lenke/);
  assert.match(svar, /Vestvind Lenken peker ikke til en nettside/);
  assert.match(await page.locator("#varsel").textContent(), /Annonser: 1 feilet/);
  await page.screenshot({ animations: "disabled", path: path.join(dir, "11-manglende.png") });
  await page.keyboard.press("Escape");

  /* ---------- telefonbredde: et ark, modalt ---------- */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url);
  await page.locator(".rad").first().waitFor();
  await page.screenshot({ animations: "disabled", path: path.join(dir, "08-liste-390.png"), fullPage: true });
  const utenfor = await page.$$eval(".rad", rader => rader.flatMap(r => {
    const kant = r.closest(".stabel").getBoundingClientRect().right;
    return [...r.querySelectorAll("button")].filter(k => k.getBoundingClientRect().right > kant + 0.5).map(k => r.dataset.id);
  }));
  assert.deepEqual(utenfor, [], "alle radknappene står innenfor kortet");
  await page.locator('.rad[data-id="snart"] .rad__selskap').click();
  await panel.waitFor();
  await page.waitForTimeout(250);
  const boks = await panel.boundingBox();
  assert.deepEqual([boks.x, boks.width], [0, 390], "arket fyller bredden");
  assert.equal(await panel.getAttribute("role"), "dialog");
  assert.equal(await panel.getAttribute("aria-modal"), "true");
  assert.equal(await page.locator(".skall > .hoved").getAttribute("inert"), "", "listen bak arket sover");
  for(let i = 0; i < 25; i++) await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => !!document.activeElement.closest("#detalj")), true, "fokus blir i arket");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ animations: "disabled", path: path.join(dir, "09-ark-390.png") });
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".skall > .hoved").getAttribute("inert"), null);

  /* ---------- skjermbilder: fem temaer, fem bredder ---------- */
  for(const tema of ["lys", "mork", "ink", "blush", "midnatt"]){
    for(const [b, h] of [[1440, 900], [1280, 800], [1100, 760], [900, 760], [390, 844]]){
      await page.setViewportSize({ width: b, height: h });
      await page.evaluate(t => localStorage.setItem("jobbsoknader-tema", t), tema);
      await page.goto(url + "/#jobb/intervju/oversikt");
      await page.reload();
      await page.locator("#detaljTittel").waitFor();
      await page.waitForTimeout(250);
      await page.screenshot({ animations: "disabled", path: path.join(dir, `tema-${tema}-${b}.png`) });
    }
  }

  assert.deepEqual(feil, []);
  console.log(`Nettlesertest av detaljpanelet bestått. Skjermbilder: ${dir}`);
}catch(e){
  console.error(`Nettlesertesten av detaljpanelet feilet. Arbeidskatalog: ${dir}`);
  if(page) await page.screenshot({ animations: "disabled", path: path.join(dir, "feil.png"), fullPage: true }).catch(() => {});
  throw e;
}
finally{ await browser?.close(); await new Promise(r => server.close(r)); }
