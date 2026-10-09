/* Annonsen følger importen inn i jobbdokumentet, i en ekte nettleser.
   Isolert datakatalog, syntetisk konto og falskt nett: ingen side og
   ingen modell utenfor maskinen blir spurt. Skjermbildene blir
   liggende i arbeidskatalogen. */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { lagServer } from "../server/server.mjs";

const stilling = (navn, beskrivelse) => `<html><head><script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org", "@type": "JobPosting", title: navn, description: beskrivelse,
  hiringOrganization: { "@type": "Organization", name: "Eksempelkraft" }, employmentType: "FULL_TIME",
  validThrough: "2026-12-01", jobLocation: { "@type": "Place", address: { addressLocality: "Bergen" } }
})}</script></head><body><main><h1>${navn}</h1></main></body></html>`;

const SIDER = {
  "https://jobb.example.invalid/analytiker": stilling("Analytiker",
    "<p>Eksempelkraft søker en analytiker som vil arbeide med prognoser for kraftmarkedet sammen med et lite team i Bergen.</p>"
    + "<ul><li>Python og SQL</li><li>Interesse for energi</li></ul>"),
  "https://jobb.example.invalid/kort": stilling("Ingeniør", "Kort."),
  "https://jobb.example.invalid/feiler": stilling("Rådgiver",
    "<p>Eksempelkraft søker en rådgiver som vil hjelpe kundene våre med alt som har med strøm og nettleie å gjøre.</p>")
};
const nett = {
  hentSide: async url => {
    if(!SIDER[url]) throw new Error("Siden svarte 404.");
    return { status: 200, sluttUrl: url, html: SIDER[url] };
  },
  spørModell: async () => ({ content: [{ type: "text", text: JSON.stringify({ sector: "energi" }) }] })
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "annonse-nettleser-"));
const server = lagServer({ katalog: path.join(dir, "data"), nett });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;

let browser, page;
try{
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE
    ? { executablePath: process.env.BROWSER_EXECUTABLE }
    : process.platform === "darwin" ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } : {}) });
  const context = await browser.newContext({ viewport: { width: 1180, height: 720 }, colorScheme: "light" });

  assert.ok((await context.request.post(url + "/api/registrer",
    { data: { epost: "test@eksempel.no", navn: "Astrid Eksempel", passord: "syntetisk-passord-123" } })).ok());
  const v = await (await context.request.get(url + "/api/jobber")).json();
  assert.ok((await context.request.put(url + "/api/jobber", { data: { versjon: v.versjon, jobber: [] } })).ok());

  const jobbFor = async lenke => (await (await context.request.get(url + "/api/jobber")).json()).jobber?.find(j => j.lenke === lenke);
  const dokument = async id => (await context.request.get(`${url}/api/jobber/${id}/dokument`)).json();
  async function vent(fn, hva){
    for(let i = 0; i < 60; i++){ const r = await fn(); if(r) return r; await page.waitForTimeout(100); }
    throw new Error(`Ventet forgjeves på ${hva}`);
  }

  page = await context.newPage();
  const feil = [];
  page.on("pageerror", e => feil.push(e.message));
  await page.goto(url);
  await page.locator("#apneNy").waitFor();

  async function importer(lenke){
    await page.locator("#apneNy").click();
    await page.locator("#skuff.er-apen").waitFor();
    await page.locator("#importLenke").fill(lenke);
    await page.locator("#hentLenke").click();
    await page.waitForFunction(() => document.querySelector("#fstilling")?.value);
    await page.locator("#lagreSkjema").click();
    await page.locator("#skuff:not(.er-apen)").waitFor();
    await page.waitForTimeout(350);   /* skuffen glir ut på 0,26 s */
    return vent(() => jobbFor(lenke), "søknaden på disk");
  }

  /* ---------- importen tar annonsen med seg ---------- */
  const a = await importer("https://jobb.example.invalid/analytiker");
  assert.equal(a.stilling, "Analytiker");
  const d = await vent(async () => { const x = await dokument(a.id); return x.annonse?.kilde ? x : null; }, "annonsen i jobb-<id>.json");
  assert.equal(d.annonse.kilde, "import");
  assert.equal(d.annonse.url, "https://jobb.example.invalid/analytiker");
  assert.match(d.annonse.tekst, /prognoser for kraftmarkedet/);
  assert.match(d.annonse.tekst, /Python og SQL/);
  assert.ok(!d.annonse.tekst.includes("<li>"));
  assert.ok(Date.parse(d.annonse.hentet));
  assert.equal(d.revisjon, 1);
  await page.screenshot({ path: path.join(dir, "importert.png") });

  /* ---------- for lite annonsetekst: søknaden lagres, uten annonse ---------- */
  const k = await importer("https://jobb.example.invalid/kort");
  await page.waitForTimeout(500);
  const dk = await dokument(k.id);
  assert.equal(dk.revisjon, 0);assert.equal(dk.annonse.tekst, "");

  /* ---------- skrivingen feiler: et varsel, og søknaden står ---------- */
  await page.route("**/api/jobber/*/annonse", r => r.fulfill({ status: 500, contentType: "application/json",
    body: JSON.stringify({ feil: "intern", melding: "Noe gikk galt på serveren." }) }));
  const f = await importer("https://jobb.example.invalid/feiler");
  await page.waitForFunction(() => /men ikke annonsen/.test(document.querySelector("#varsel.er-apen")?.textContent || ""));
  await page.screenshot({ path: path.join(dir, "annonse-ikke-lagret.png") });
  assert.equal(f.stilling, "Rådgiver");
  assert.equal((await dokument(f.id)).revisjon, 0);
  await page.unroute("**/api/jobber/*/annonse");
  assert.equal(await page.locator(`.rad[data-id="${f.id}"]`).count(), 1);

  assert.deepEqual(feil, []);
  console.log(`Nettlesertest av annonsen bestått. Skjermbilder: ${dir}`);
}catch(e){
  console.error(`Nettlesertesten av annonsen feilet. Arbeidskatalog: ${dir}`);
  if(page) await page.screenshot({ path: path.join(dir, "feil.png"), fullPage: true }).catch(() => {});
  throw e;
}
finally{ await browser?.close(); await new Promise(r => server.close(r)); }
