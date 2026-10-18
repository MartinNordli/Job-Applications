/* Radars «Dagens utvalg» i en ekte nettleser: rangeringen (avdeling, så frist
   som haster, så prosent), 96 % står foran 80 % selv om den ble funnet sist,
   fanene kan brukes med piltastene, og tastene L, X, J og K styrer funnet i
   toppkortet (med angre), mens klikk på et kort i køen gjør det til fokus og
   tastene tier når fokus står i et tekstfelt.
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
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE
    ? { executablePath: process.env.BROWSER_EXECUTABLE }
    : process.platform === "darwin" ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", reducedMotion: "reduce" });
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
  const rekkefølge = async () => page.locator("#radarInnboks .radar__stilling").evaluateAll(
    rader => rader.map(r => r.textContent.trim()));
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
  const avdelinger = async () => page.locator("#radarInnboks .radar__stilling").evaluateAll(
    rader => rader.map(r => (r.closest("[data-avd]") ?? r.closest("article")?.querySelector("[data-avd]"))?.dataset.avd));
  const avd = await avdelinger();
  assert.equal(avd.length, 5);
  assert.equal(avd[3], avd[2], "80 % og 84 % står i samme avdeling");
  assert.notEqual(avd[4], avd[3], "70 % står i en lavere avdeling");
  assert.equal(await page.locator("#radarInnboks .sveip__kort.er-valgt[data-avd]").count(), 1, "ett valgt kort");

  /* ---------- 96 % funnet sist står øverst, som toppkort ---------- */
  medE = true;
  await søkNå();
  /* Nye funn starter utvalget øverst, så 96 % står i toppkortet uten at man blar. */
  assert.deepEqual(await rekkefølge(), ["Engineer E", "Engineer D", "Engineer C", "Engineer B", "Engineer A", "Engineer F"]);
  assert.equal(await page.locator(".sveip__kort.er-valgt").count(), 1);
  assert.match(await page.locator(".sveip__kort.er-valgt").textContent(), /Engineer E/);

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


  /* ---------- tastene og køen i Dagens utvalg ---------- */
  const topp = () => page.locator(".sveip__kort.er-valgt .radar__stilling").textContent();
  const plass = async () => {
    const t = (await page.locator("#radarTeller").textContent()).trim();
    const n = await page.locator("#radarRekke [role=option]").count();
    return t + " / " + n;
  };
  /* Rullingen stopper først etter en liten stund; vent på telleren, ikke på klokka. */
  const ventTeller = n => page.waitForFunction(v => document.querySelector("#radarTeller")?.textContent.trim() === v, String(n));
  const tilstand = async () => (await (await api.get(url + "/api/radar")).json()).tilstand;
  const statusFor = async tittel => (await tilstand()).innboks.find(r => r.stilling === tittel)?.status;
  assert.equal(await topp(), "Engineer E");
  assert.equal(await plass(), "1 / 6");

  await page.keyboard.press("j");
  await ventTeller(2);
  assert.equal(await topp(), "Engineer D");
  assert.equal(await plass(), "2 / 6");
  await page.keyboard.press("k");
  await ventTeller(1);
  assert.equal(await topp(), "Engineer E");
  await page.keyboard.press("k");
  assert.equal(await plass(), "1 / 6", "K på første plass gjør ingenting");

  /* Tastene tier når fokus står i et tekstfelt. */
  await page.evaluate(() => {
    const felt = document.createElement("input"); felt.id = "testfelt"; document.body.append(felt); felt.focus();
  });
  for(const tast of ["x", "l", "j"]) await page.keyboard.press(tast);
  assert.equal(await page.locator("#testfelt").inputValue(), "xlj", "bokstavene havnet i feltet");
  assert.equal(await topp(), "Engineer E", "ingenting skjedde med funnet");
  assert.equal(await page.locator("#angreKnapp").count(), 0);
  assert.equal(await statusFor("Engineer E"), "ny");
  await page.evaluate(() => document.querySelector("#testfelt").remove());

  /* Klikk på et kort i køen gjør det til fokus. */
  await page.locator("#radarRekke [role=option]", { hasText: "Engineer C" }).click();
  await ventTeller(3);
  assert.equal(await topp(), "Engineer C");
  assert.equal(await plass(), "3 / 6");
  await page.keyboard.press("k"); await ventTeller(2);
  await page.keyboard.press("k"); await ventTeller(1);
  assert.equal(await topp(), "Engineer E");

  /* L legger toppfunnet til, og neste rykker opp. */
  await page.keyboard.press("l");
  await page.locator(".sveip__kort.er-valgt .radar__stilling", { hasText: "Engineer D" }).waitFor();
  assert.equal(await plass(), "1 / 5");
  assert.equal(await statusFor("Engineer E"), "lagtTil", "Engineer E er lagt til på serveren");
  assert.ok((await tilstand()).innboks.every(r => r.stilling !== "Engineer E" || r.status !== "ny"));

  /* X avviser; Angre bringer funnet tilbake i toppkortet. */
  await page.keyboard.press("x");
  await page.locator("#angreKnapp").waitFor();
  assert.equal(await topp(), "Engineer C", "neste har rykket opp");
  assert.equal(await plass(), "1 / 4");
  await page.locator("#angreKnapp").click();
  await page.locator(".sveip__kort.er-valgt .radar__stilling", { hasText: "Engineer D" }).waitFor();
  assert.equal(await plass(), "1 / 5");
  assert.equal(await statusFor("Engineer D"), "ny", "angret avvisning rører ikke serveren");

  assert.deepEqual(feil, [], "ingen feil i konsollen");
  console.log("Nettlesertest av Radars bånd og faner bestått. Datakatalog: " + dir);
}finally{
  await browser?.close();
  await new Promise(r => server.close(r));
}
