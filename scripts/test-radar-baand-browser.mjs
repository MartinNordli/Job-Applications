/* Radars innboks som rangering, i en ekte nettleser: stillingene står i bånd
   etter treffskalaen (95+ som toppkort, så 80, så 65), en frist som haster
   står først i sitt bånd selv om prosenten er lavere, 96 % står foran 80 %
   selv om den ble funnet sist, og fanene kan brukes med piltastene.
   Isolert datakatalog, syntetisk konto, låst klokke, falskt nett og falsk
   modell: ingenting utenfor maskinen blir spurt. */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { lagServer } from "../server/server.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "radar-baand-"));
const SIDE = "https://job-boards.greenhouse.io/testfirma";
const NÅ = new Date("2026-10-17T10:00:00+02:00");
const omDager = n => new Date(NÅ.getTime() + n * 86400000).toISOString().slice(0, 10);
/* Prosent og frist per stilling. Rekkefølgen i listen er ikke rekkefølgen på skjermen. */
const STILLINGER = {
  "Engineer A": { id: 101, prosent: 80, frist: null },
  "Engineer B": { id: 102, prosent: 84, frist: omDager(60) },   /* frist, men ikke en som haster */
  "Engineer C": { id: 103, prosent: 81, frist: omDager(10) },
  "Engineer D": { id: 104, prosent: 82, frist: omDager(3) },
  "Engineer F": { id: 105, prosent: 70, frist: null },
  "Engineer E": { id: 106, prosent: 96, frist: null }          /* kommer først i andre kjøring */
};
let medE = false;
const jobb = ([tittel, s]) => ({ id: s.id, title: tittel, absolute_url: `${SIDE}/jobs/${s.id}`, location: { name: "Oslo" },
  company_name: "Testfirma", first_published: NÅ.toISOString(), updated_at: NÅ.toISOString(), application_deadline: s.frist, content: "" });
const nett = {
  hentJson: async url => {
    const liste = Object.entries(STILLINGER).filter(([t]) => medE || t !== "Engineer E").map(jobb);
    if(url.endsWith("/jobs")) return { status: 200, json: { jobs: liste } };
    const j = liste.find(x => url.endsWith(`/${x.id}`));
    return { status: 200, json: { ...j, content: "Stillingen krever Python og SQL, og erfaring med dataflyt i praksis." } };
  },
  hentSide: async () => { throw new Error("Ingen nett i denne testen."); }
};
const brevModellFor = () => async valg => {
  const annonser = JSON.parse(valg.innhold).annonser;
  return { data: { vurderinger: annonser.map(a => ({ id: a.id, prosent: STILLINGER[a.stilling].prosent, grunner: ["Passer CV-en."] })) },
    bruk: { input_tokens: 100, output_tokens: 20 } };
};
let nåMs = NÅ.getTime();
const server = lagServer({ katalog: path.join(dir, "data"), nett, brevModellFor, nå: () => new Date(nåMs) });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;

let browser;
try{
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE
    ? { executablePath: process.env.BROWSER_EXECUTABLE }
    : process.platform === "darwin" ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  await context.clock.setFixedTime(NÅ);
  const api = context.request;
  assert.ok((await api.post(url + "/api/registrer", { data: { epost: "test@eksempel.no", navn: "Astrid Eksempel", passord: "syntetisk-passord-123" } })).ok());
  assert.ok((await api.put(url + "/api/nokler/anthropic", { data: { nokkel: "sk-syntetisk-testnokkel-abcdefghijklmnopqrstuvwxyz" } })).ok());
  const cv = await (await api.get(url + "/api/cv")).json();
  assert.ok((await api.put(url + "/api/cv", { data: { ...cv, tekst: "Astrid Eksempel. To år med dataflyt i Python og SQL." } })).ok());
  assert.ok((await api.put(url + "/api/radar/innstillinger", { data: { pa: true, sokeord: ["Engineer"], kilder: { nav: { pa: false }, jobbnorge: { pa: false } } } })).ok());
  assert.ok((await api.post(url + "/api/radar/karrieresider", { data: { url: SIDE, navn: "Testfirma" } })).ok());

  const page = await context.newPage();
  const feil = [];
  page.on("pageerror", e => feil.push(e.message));
  page.on("console", m => { if(m.type() === "error" && !/404|Failed to load resource/.test(m.text())) feil.push(m.text()); });
  const rekkefølge = async () => page.locator("#radarInnboks [data-radar-id]").evaluateAll(
    rader => rader.map(r => (r.querySelector("h3, h4")?.textContent ?? "").trim()));
  const søkNå = async () => {
    nåMs += 7 * 3600_000;   /* forbi intervallet for karrieresiden */
    const før = await page.locator("#radarStatus").textContent();
    await page.locator("#radarSokNa").click();
    await page.locator("#radarStatus", { hasText: /^\d\d:\d\d: / }).waitFor();
    assert.notEqual(await page.locator("#radarStatus").textContent(), før);
  };

  await page.goto(url + "/");
  await page.locator('[data-visning="radar"]').click();
  await page.locator("#radarSokNa").waitFor();
  await søkNå();
  await page.locator("#radarFane-innboks").click();

  /* ---------- bånd: frist som haster først, så høyest prosent ---------- */
  assert.deepEqual(await rekkefølge(), ["Engineer D", "Engineer C", "Engineer B", "Engineer A", "Engineer F"],
    "82 % med frist om 3 dager, 81 % med frist om 10, så 84 %, så 80 %; 70 % i neste bånd");
  assert.deepEqual(await page.locator(".radarbaand").evaluateAll(b => b.map(x => x.dataset.trinn)), ["3", "2"]);

  /* ---------- 96 % funnet sist står øverst, som toppkort ---------- */
  medE = true;
  await søkNå();
  assert.deepEqual(await rekkefølge(), ["Engineer E", "Engineer D", "Engineer C", "Engineer B", "Engineer A", "Engineer F"]);
  assert.equal(await page.locator(".toppfunn").count(), 1);
  assert.match(await page.locator(".toppfunn").textContent(), /Engineer E/);

  /* ---------- fanene med piltastene ---------- */
  const faner = ["innboks", "under", "lagt", "kjoringer", "innstillinger"];
  const valgt = () => page.locator("#radarFaner [role=tab][aria-selected=true]").evaluate(e => e.id);
  await page.locator("#radarFane-innboks").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await valgt(), "radarFane-under");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "radarFane-under", "fokus følger fanen");
  assert.equal(await page.locator("#radarUnder").count(), 1, "bare den valgte fanen tegnes");
  assert.equal(await page.locator("#radarInnboks").count(), 0);
  await page.keyboard.press("End");
  assert.equal(await valgt(), "radarFane-" + faner.at(-1));
  await page.keyboard.press("ArrowRight");
  assert.equal(await valgt(), "radarFane-innboks", "pila går rundt");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await valgt(), "radarFane-innstillinger");
  await page.keyboard.press("Home");
  assert.equal(await valgt(), "radarFane-innboks");
  assert.equal(await page.locator("#radarFane-under").getAttribute("tabindex"), "-1", "bare den valgte fanen står i tabrekkefølgen");

  assert.deepEqual(feil, [], "ingen feil i konsollen");
  console.log("Nettlesertest av Radars bånd og faner bestått. Datakatalog: " + dir);
}finally{
  await browser?.close();
  await new Promise(r => server.close(r));
}
