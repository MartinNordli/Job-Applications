/* Sveipekortet i Radar i WebKit (motoren i Mac-appen): siden skal bli stående
   der den er. Før hoppet siden til toppen for hvert klikk på pilene.
   Testen ruller vinduet ned og krever at rulleposisjonen er uendret etter
   klikk i kortrekken, J, K, sidelengs hjul på hovedkortet og i rekken, og
   L og X med angre. Rekken skal rulle sidelengs, og telleren følge kortet.
   Isolert datakatalog, falskt nett og falsk modell. */
import { webkit } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { lagServer } from "../server/server.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "radar-sveip-"));
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
let medE = true;
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
  /* «Legg til» starter vanlig match på den nye søknaden i bakgrunnen. */
  if(valg.formal === "vurdering")
    return { data: { prosent: 78, oppsummering: "Kravene er oppfylt.", styrker: [], mangler: [], sprak: "nb" }, bruk: { input_tokens: 900, output_tokens: 60 } };
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
  browser = await webkit.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 700 }, colorScheme: "light" });
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
  await page.goto(url + "/");
  await page.locator('[data-visning="radar"]').click();
  await page.locator("#radarSokNa").waitFor();
  nåMs += 7 * 3600_000;
  await page.locator("#radarSokNa").click();
  await page.locator("#radarStatus", { hasText: /^\d\d:\d\d: / }).waitFor();
  await page.locator("#radarFane-innboks").click();
  await page.locator("#radarRekke [role=option]").nth(5).waitFor();

  /* Siden er rullbar: finn flaten som ruller (vinduet eller hovedkolonnen). */
  const flate = await page.evaluate(() => {
    const h = document.querySelector(".hoved");
    const rull = h && h.scrollHeight > h.clientHeight + 100 && getComputedStyle(h).overflowY !== "visible" ? h : document.scrollingElement;
    window.__rull = rull;
    return { hoved: rull === h, rom: rull.scrollHeight - rull.clientHeight };
  });
  assert.ok(flate.rom >= 200, "siden er høy nok til å rulle: " + flate.rom);
  const y = () => page.evaluate(() => Math.round(window.__rull.scrollTop));
  const rullNed = async () => { await page.evaluate(() => { window.__rull.scrollTop = 200; }); assert.equal(await y(), 200); };
  const teller = async () => Number((await page.locator("#radarTeller").textContent()).trim());
  const ventTeller = n => page.waitForFunction(v => Number(document.querySelector("#radarTeller")?.textContent.trim()) === v, n);
  const rekkeX = () => page.evaluate(() => Math.round(document.querySelector("#radarRekke").scrollLeft));
  const kortX = () => page.evaluate(() => Math.round(document.querySelector("#radarScene").scrollLeft));
  /* Gi nettleseren tid til et eventuelt hopp: to bilder, så en kort pause som ikke er synkronisering mot noe annet. */
  const rolig = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 400)))));
  const stårStille = async navn => { await rolig(); assert.equal(await y(), 200, navn + ": siden skal stå stille"); };

  assert.equal(await teller(), 1);
  await rullNed();

  /* Klikk i kortrekken ruller hovedkortet dit, uten at siden flytter seg. */
  await rullNed();
  await page.locator("#radarRekke [role=option]").nth(2).click();
  await ventTeller(3);
  await stårStille("klikk i rekken");
  await page.locator("#radarRekke [role=option]").nth(5).click();
  await ventTeller(6);
  await stårStille("klikk på siste i rekken");
  assert.ok(await rekkeX() > 0, "rekken har rullet sidelengs for å vise det siste kortet");

  /* J og K. */
  await page.keyboard.press("k"); await ventTeller(5);
  await stårStille("K");
  await page.keyboard.press("j"); await ventTeller(6);
  await stårStille("J");

  /* Sidelengs hjul på hovedkortet, så i rekken. */
  const bx = await page.locator("#radarScene").boundingBox();
  await page.mouse.move(bx.x + bx.width / 2, bx.y + 80);
  const førKort = await kortX();
  await page.mouse.wheel(-900, 0);
  await page.waitForFunction(v => document.querySelector("#radarScene").scrollLeft < v, førKort);
  await page.waitForFunction(v => Number(document.querySelector("#radarTeller").textContent.trim()) < v, 6);
  await stårStille("hjul på hovedkortet");
  assert.equal(await teller(), await page.locator("#radarScene .er-valgt").evaluate(e => Number(e.dataset.indeks) + 1), "telleren følger det valgte kortet");

  const rbx = await page.locator("#radarRekke").boundingBox();
  await page.mouse.move(rbx.x + rbx.width / 2, rbx.y + rbx.height / 2);
  await page.evaluate(() => { document.querySelector("#radarRekke").scrollLeft = 0; });
  await page.mouse.wheel(400, 0);
  await page.waitForFunction(() => document.querySelector("#radarRekke").scrollLeft > 0);
  await stårStille("hjul i rekken");

  /* L og X med angre. Tilbake til første kort først. */
  await page.locator("#radarRekke [role=option]").first().click();
  await ventTeller(1);
  await rullNed();
  const antall = () => page.locator("#radarRekke [role=option]").count();
  assert.equal(await antall(), 6);
  await page.keyboard.press("l");
  await page.waitForFunction(() => document.querySelectorAll("#radarRekke [role=option]").length === 5);
  await stårStille("L");
  assert.equal(await teller(), 1);
  await page.keyboard.press("x");
  await page.locator("#angreKnapp").waitFor();
  assert.equal(await antall(), 4);
  await stårStille("X");
  await page.locator("#angreKnapp").click();
  await page.waitForFunction(() => document.querySelectorAll("#radarRekke [role=option]").length === 5);
  await stårStille("angre");
  assert.equal(await teller(), 1);

  assert.deepEqual(feil, [], "ingen feil i konsollen");
  console.log("WebKit-test av sveipekortet bestått (siden holdt seg stille). Datakatalog: " + dir);
}finally{
  await browser?.close();
  await new Promise(r => server.close(r));
}
