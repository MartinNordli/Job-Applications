/* Radar i en ekte nettleser: av til på med CV-en fra Innstillinger,
   «Foreslå fra CV» som fyller ordlistene uten å lagre, «Søk nå» som gir
   innboks og tall i sidepanelet, «Legg til» som lager én søknad med annonse
   i jobbdokumentet, «Ikke interessert» med angre, og «Søk nå» to ganger på
   under et minutt. Isolert datakatalog, syntetisk konto, falskt nett (de
   lagrede Greenhouse-svarene i testdata/) og falsk modell: ingenting utenfor
   maskinen blir spurt. */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { lagServer } from "../server/server.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "radar-nettleser-"));
const full = JSON.parse(await fs.readFile(new URL("../testdata/radar/greenhouse/cognite-jobs-content.json", import.meta.url), "utf8"));
const SIDE = "https://job-boards.greenhouse.io/cognite";
const CV = "Astrid Eksempel. To år med dataflyt i Python og SQL hos et kraftselskap.";
const nett = {
  hentJson: async url => ({ status: 200, json: url.endsWith("/jobs") ? full : full.jobs.find(j => url.endsWith(`/${j.id}`)) }),
  hentSide: async () => { throw new Error("Ingen nett i denne testen."); }
};
const kall = { forslag: 0, vurdering: 0, annet: 0 };
const brevModellFor = () => async valg => {
  if(valg.trinn === "radarforslag"){
    kall.forslag++;
    return { data: { sokeord: ["Engineer", "Account Executive"], steder: [], ekskluder: ["lærling"] }, bruk: { input_tokens: 700, output_tokens: 30 } };
  }
  let annonser;
  try{ annonser = JSON.parse(valg.innhold).annonser; }catch{ /* ikke en radarvurdering */ }
  if(!annonser){ kall.annet++; throw new Error("Uventet modellkall: " + valg.trinn); }
  kall.vurdering++;
  return { data: { vurderinger: annonser.map(a => ({ id: a.id, prosent: 80, grunner: ["Passer CV-en."] })) }, bruk: { input_tokens: 100, output_tokens: 20 } };
};
/* Serverens klokke er låst og flyttes for hånd, så minuttgrensen ikke krever venting. */
let nåMs = Date.now();
const server = lagServer({ katalog: path.join(dir, "data"), nett, brevModellFor, nå: () => new Date(nåMs) });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;

let browser, page;
try{
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE
    ? { executablePath: process.env.BROWSER_EXECUTABLE }
    : process.platform === "darwin" ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  const api = context.request;
  assert.ok((await api.post(url + "/api/registrer",
    { data: { epost: "test@eksempel.no", navn: "Astrid Eksempel", passord: "syntetisk-passord-123" } })).ok());
  assert.ok((await api.put(url + "/api/nokler/anthropic", { data: { nokkel: "sk-syntetisk-testnokkel-abcdefghijklmnopqrstuvwxyz" } })).ok());
  /* Radar er av, med bare én karriereside som kilde. */
  assert.ok((await api.put(url + "/api/radar/innstillinger", { data: { pa: false, kilder: { nav: { pa: false }, jobbnorge: { pa: false } } } })).ok());
  assert.ok((await api.post(url + "/api/radar/karrieresider", { data: { url: SIDE, navn: "Cognite" } })).ok());

  const radar = async () => (await (await api.get(url + "/api/radar")).json()).tilstand;
  const jobber = async () => (await (await api.get(url + "/api/jobber")).json()).jobber;
  async function vent(fn, hva){
    for(let i = 0; i < 80; i++){ const r = await fn(); if(r) return r; await page.waitForTimeout(100); }
    throw new Error("Ventet forgjeves på " + hva);
  }

  page = await context.newPage();
  const feil = [];
  page.on("pageerror", e => feil.push(e.message));
  page.on("console", m => { if(m.type() === "error" && !/404|Failed to load resource/.test(m.text())) feil.push(m.text()); });

  /* ---------- av: CV-en legges inn under Innstillinger ---------- */
  await page.goto(url + "/");
  await page.locator('[data-visning="radar"]').click();
  await page.locator('[data-radar="pa"]').click();
  await page.locator('[data-merknad="cv"]').waitFor();
  assert.equal((await radar()).innstillinger.pa, true, "Radar er slått på");
  await page.locator('[data-radar="tilCv"]').click();
  await page.locator("#cvInnst").waitFor();
  await page.locator("#cvInnstTekst").waitFor();   /* mangler CV-en, står tekstfeltet åpent */
  await page.locator("#cvInnstTekst").fill(CV);
  await page.locator("#cvInnstStatus", { hasText: /^Lagret/ }).waitFor();
  assert.equal((await (await api.get(url + "/api/cv")).json()).tekst, CV, "CV-en er lagret");
  await page.keyboard.press("Escape");
  await page.locator('[data-merknad="cv"]').waitFor({ state: "detached" });

  /* ---------- Foreslå fra CV fyller ordlistene, men lagrer ikke ---------- */
  await page.locator('[data-visning="radar"]').click();
  await page.locator("#radarInnst > summary").click();
  await page.locator('[data-radar="foresla"]').first().click();
  await page.locator("#radarOrd-sokeord").locator("xpath=ancestor::*[contains(@class,'ordliste')][1]")
    .getByText("Engineer", { exact: true }).waitFor();
  assert.equal(kall.forslag, 1);
  assert.deepEqual((await radar()).innstillinger.sokeord, [], "forslaget er ikke lagret");
  await page.locator('[data-radar="lagre"]').click();
  await vent(async () => (await radar()).innstillinger.sokeord.includes("Engineer"), "lagrede søkeord");
  assert.deepEqual((await radar()).innstillinger.ekskluder, ["lærling"]);
  await page.locator("#radarLagret", { hasText: /^Lagret/ }).waitFor();

  /* ---------- Søk nå: innboks og tall i sidepanelet ---------- */
  /* Slå-på-kjøringen uten CV har allerede brukt minuttet, så klokken flyttes. */
  nåMs += 120_000;
  await page.locator("#radarSokNa").click();
  await page.locator("#radarStatus", { hasText: /^Søkte/ }).waitFor();
  const antallNye = full.jobs.length;
  await page.locator("[data-radar-id]").first().waitFor();
  assert.equal(await page.locator("[data-radar-id]").count(), antallNye);
  assert.equal((await page.locator("#tallRadar").textContent()).trim(), String(antallNye));
  assert.match(await page.locator("#radarStatus").textContent(), /ny/);
  assert.equal(kall.vurdering, 1);

  /* ---------- Legg til: én søknad med annonse, raden merkes ---------- */
  const radId = await page.locator("[data-radar-id]").first().getAttribute("data-radar-id");
  const rad = page.locator(`[data-radar-id="${radId}"]`);
  const førJobber = (await jobber()).length;
  await rad.locator('[data-radar="leggTil"]').click();
  await rad.locator('[data-radar="apneSoknad"]').waitFor();
  const etter = await jobber();
  assert.equal(etter.length, førJobber + 1, "én søknad");
  const ny = etter.at(-1);
  const dok = await (await api.get(`${url}/api/jobber/${ny.id}/dokument`)).json();
  assert.equal(dok.annonse.kilde, "radar");
  assert.ok(dok.annonse.tekst.length > 50, "annonsen ligger i jobbdokumentet");
  assert.equal((await radar()).innboks.find(r => r.id === radId).status, "lagtTil");
  assert.equal((await page.locator("#tallRadar").textContent()).trim(), String(antallNye - 1));

  /* ---------- Ikke interessert, med angre ---------- */
  const neste = page.locator('[data-radar-id]:has([data-radar="ikke"])').first();
  const nesteId = await neste.getAttribute("data-radar-id");
  await neste.locator('[data-radar="ikke"]').click();
  await page.locator("#angreKnapp").waitFor();
  assert.equal(await page.locator(`[data-radar-id="${nesteId}"]`).count(), 0, "raden er ute av innboksen");
  assert.equal((await radar()).innboks.find(r => r.id === nesteId).status, "ny", "serveren venter med fjerningen til angrefristen er ute");
  await page.locator("#angreKnapp").click();
  await page.locator(`[data-radar-id="${nesteId}"]`).waitFor();
  assert.equal((await radar()).innboks.find(r => r.id === nesteId).status, "ny", "angre setter raden tilbake");

  /* ---------- feilvei: Søk nå to ganger på under et minutt ---------- */
  const modellFør = kall.vurdering;
  await page.locator("#radarSokNa").click();
  await page.locator("#radarStatus", { hasText: /sekunder/ }).waitFor();
  assert.equal(kall.vurdering, modellFør, "ingen nytt modellkall");
  assert.equal(kall.annet, 0, "ingen uventede modellkall");
  assert.equal(await page.locator("[data-radar-id]").count(), antallNye, "innboksen står som den var");

  assert.deepEqual(feil, [], "ingen feil i konsollen");
  console.log("Nettlesertest av Radar bestått. Datakatalog: " + dir);
}finally{
  await browser?.close();
  await new Promise(r => server.close(r));
}
