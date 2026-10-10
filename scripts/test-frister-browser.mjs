/* Fristene i en ekte nettleser: båndene, det sammenfoldede båndet for
   frister som har gått ut, og «Flytt alle til arkivet» med én angre.
   Isolert datakatalog og syntetisk konto. Skjermbildene blir liggende
   i arbeidskatalogen. */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { lagServer } from "../server/server.mjs";
import { isoDato } from "../src/fristvarsel.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "frister-nettleser-"));
const server = lagServer({ katalog: path.join(dir, "data") });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;

const omDager = n => { const d = new Date(); d.setDate(d.getDate() + n); return isoDato(d); };
const jobb = (id, selskap, frist, o = {}) => ({ id, selskap, stilling: "ML Engineer", lenke: "", sted: "Oslo",
  frist, status: "todo", sektor: "energi", jobbtype: "fulltid", notat: "", sendtDato: null, ...o });

const UTGATTE = ["ut1", "ut2", "ut3", "ut4"];
const JOBBER = [
  jobb("idag", "Equinor", omDager(0)),
  jobb("uke", "Statkraft", omDager(7)),
  jobb("senere", "Aker BP", omDager(8)),
  jobb("lopende", "Cognite", null),
  /* Ut4 er i en annen sektor, så filteret kan skille den ut. */
  jobb("ut1", "Bekk", omDager(-1), { hendelser: [{ til: "todo", dato: omDager(-20), kilde: "bruker" }] }),
  jobb("ut2", "DNB", omDager(-9)),
  jobb("ut3", "Visma", omDager(-30)),
  jobb("ut4", "Bouvet", omDager(-3), { sektor: "konsulent" }),
  jobb("sendt", "NBIM", omDager(-5), { status: "sent", sendtDato: omDager(-6) })
];

let browser, page;
try{
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE
    ? { executablePath: process.env.BROWSER_EXECUTABLE }
    : process.platform === "darwin" ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });

  assert.ok((await context.request.post(url + "/api/registrer",
    { data: { epost: "test@eksempel.no", navn: "Astrid Eksempel", passord: "syntetisk-passord-123" } })).ok());
  const v = await (await context.request.get(url + "/api/jobber")).json();
  assert.ok((await context.request.put(url + "/api/jobber", { data: { versjon: v.versjon, jobber: JOBBER } })).ok());
  const påDisk = async () => (await (await context.request.get(url + "/api/jobber")).json()).jobber;
  const ventPåDisk = async (sjekk, hva) => {
    for(let i = 0; i < 60; i++){ const j = await påDisk(); if(sjekk(j)) return j; await page.waitForTimeout(100); }
    throw new Error("Lagringen kom aldri: " + hva);
  };
  const førDisk = await påDisk();

  page = await context.newPage();
  const feil = [];
  page.on("pageerror", e => feil.push(e.message));
  await page.goto(url);
  await page.locator(".rad").first().waitFor();

  /* ---------- båndene og rekkefølgen ---------- */
  const bånd = () => page.$$eval("#innhold .baandblokk", b => b.map(x => x.id));
  const måned = iso => { const [a, m] = iso.split("-").map(Number); return "baand-m" + (a * 12 + m - 1); };
  const forventet = ["baand-naa", "baand-lopende", måned(omDager(8)), "baand-utgatt"];
  assert.deepEqual(await bånd(), forventet, "utgått ligger nederst, ikke i «Denne uka»");
  const iBånd = id => page.$$eval(`#${id} .rad`, r => r.map(x => x.dataset.id));
  assert.deepEqual(await iBånd("baand-naa"), ["idag", "uke"], "Denne uka er 0 til 7 dager");
  assert.deepEqual(await iBånd("baand-utgatt"), ["ut1", "ut4", "ut2", "ut3"], "sist utgått står først");

  /* Lukket som standard, med antallet i overskriften. */
  const utgatt = page.locator("#utgatt");
  assert.equal(await utgatt.evaluate(d => d.open), false);
  assert.equal(await page.locator("#utgatt > summary .baand__tall").textContent(), "4");
  assert.equal(await page.locator("#utgatt > summary .baand__navn").textContent(), "Fristen har gått ut");
  assert.equal(await page.locator('[data-gjor="arkiverUtgatte"]').isVisible(), false);
  assert.match(await page.locator("#sideUnder").textContent(), /8 å søke på · 3 med frist · 1 løpende · 4 gikk ut/);
  assert.match(await page.locator("#neste").textContent(), /Equinor/, "neste frist er dagens, ikke en utgått");
  await page.screenshot({ path: path.join(dir, "lukket.png"), fullPage: true });

  /* ---------- tastaturet folder ut, og båndet blir stående åpent ---------- */
  await page.locator("#utgatt > summary").focus();
  await page.keyboard.press("Enter");
  assert.equal(await utgatt.evaluate(d => d.open), true);
  /* En endring på en rad tegner listen på nytt; båndet skal ikke lukke seg. */
  await page.locator("#sok").fill("a");
  await page.locator("#sok").fill("");
  assert.equal(await page.locator("#utgatt").evaluate(d => d.open), true, "åpent bånd overlever omtegning");
  await page.screenshot({ path: path.join(dir, "apen.png"), fullPage: true });

  /* ---------- filtrene gjelder ---------- */
  await page.locator("#filtSektor").selectOption("energi");
  assert.equal(await page.locator("#utgatt > summary .baand__tall").textContent(), "3");
  assert.match(await page.locator(".utgatt__tekst").textContent(), /Bare de 3 som passer filtrene, flyttes\./);

  /* ---------- flytt alle: én lagring, fokus et fornuftig sted ---------- */
  await page.locator('[data-gjor="arkiverUtgatte"]').focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#baand-utgatt").count(), 0, "båndet er borte når alle er flyttet");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "sidetittel");
  assert.equal(await page.locator("#varsel span").textContent(), "Flyttet 3 søknader til arkivet");
  const etter = await ventPåDisk(j => ["ut1", "ut2", "ut3"].every(id => j.find(x => x.id === id).status === "expired"),
    "tre utløpte");
  assert.equal(etter.find(x => x.id === "ut4").status, "todo", "den som ikke passet filteret, står urørt");
  const dag = isoDato(new Date());
  for(const id of ["ut1", "ut2", "ut3"]){
    const h = etter.find(x => x.id === id).hendelser;
    assert.deepEqual([h.at(-1).til, h.at(-1).dato], ["expired", dag], id + " har en utløpt-hendelse datert i dag");
  }
  await page.screenshot({ path: path.join(dir, "flyttet.png") });

  /* ---------- én angre gir alt tilbake, hendelsene også ---------- */
  await page.locator("#angreKnapp").click();
  await ventPåDisk(j => UTGATTE.every(id => j.find(x => x.id === id).status === "todo"), "angret");
  const angret = await påDisk();
  for(const id of UTGATTE){
    const a = førDisk.find(x => x.id === id), b = angret.find(x => x.id === id);
    assert.deepEqual([b.status, b.sendtDato, b.intervju, b.hendelser], [a.status, a.sendtDato, a.intervju, a.hendelser],
      id + " er som før");
  }
  assert.equal(await page.locator("#utgatt > summary .baand__tall").textContent(), "3");
  assert.equal(await page.evaluate(() => document.activeElement?.closest("summary")?.parentElement?.id), "utgatt",
    "fokus står på båndet som kom tilbake");

  /* ---------- én rad om gangen virker fortsatt ---------- */
  await page.locator("#filtSektor").selectOption("");
  await page.locator('.rad[data-id="ut3"] [data-meny]').click();
  await page.locator('#radmeny [data-gjor="expired"]').click();
  assert.deepEqual(await iBånd("baand-utgatt"), ["ut1", "ut4", "ut2"]);

  /* ---------- telefonbredde ---------- */
  await page.setViewportSize({ width: 390, height: 844 });
  const knapp = await page.locator('[data-gjor="arkiverUtgatte"]').boundingBox();
  assert.ok(knapp.x >= 0 && knapp.x + knapp.width <= 390, "knappen står innenfor skjermen");
  await page.screenshot({ path: path.join(dir, "telefon.png"), fullPage: true });

  /* ---------- er alt gått ut, sier listen det ---------- */
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#filtSektor").selectOption("konsulent");
  assert.equal(await page.locator(".tomt__tittel").textContent(), "Ingen åpne frister");
  assert.equal(await page.locator("#baand-utgatt").count(), 1);

  assert.deepEqual(feil, []);
  console.log(`Nettlesertest av fristene bestått. Skjermbilder: ${dir}`);
}catch(e){
  console.error(`Nettlesertesten av fristene feilet. Arbeidskatalog: ${dir}`);
  if(page) await page.screenshot({ path: path.join(dir, "feil.png"), fullPage: true }).catch(() => {});
  throw e;
}
finally{ await browser?.close(); await new Promise(r => server.close(r)); }
