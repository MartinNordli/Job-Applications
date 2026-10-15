/* Intervju-fanen i en ekte nettleser: et nytt intervju flytter en sendt
   søknad til intervju og kan angres uten å ta intervjuet bort, fanemerket
   viser datoen for det neste, forberedelsen lages av en falsk modell og
   vises fra lageret uten nytt kall, mangler annonsen sender knappen til
   Annonse-fanen, og et intervju med forberedelse slettes først etter
   bekreftelse. Isolert datakatalog, syntetisk konto, falskt nett og
   falsk modell: ingenting utenfor maskinen blir spurt. */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { lagServer } from "../server/server.mjs";
import { isoDato } from "../src/fristvarsel.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "intervju-nettleser-"));
const nett = {
  hentSide: async () => { throw new Error("Ingen nett i denne testen."); },
  spørModell: async () => { throw new Error("Ingen modell i denne testen."); }
};
const CV = "Astrid Eksempel. To år med dataflyt i Python og SQL hos et kraftselskap.";
const ANNONSE = "Fjordnett søker dataingeniør. Du kan Python og SQL, og liker å gjøre rotete data til noe folk kan stole på.";
let modellkall = 0;
const brevModellFor = () => async () => {
  modellkall++;
  return { modell: "claude-opus-5", bruk: { input_tokens: 10, output_tokens: 10 }, data: {
    sammendrag: "Rollen handler om pålitelige datastrømmer.",
    sporsmal: [{ sporsmal: "Fortell om et datasett du måtte rydde.", hvorfor: "De tester metode.", svarskisse: "Situasjon, grep, resultat.", kilder: [] }],
    eksempler: [{ krav: "Python og SQL", situasjon: "To år med dataflyt.", kilder: [{ kilde: "cv", sitat: "dataflyt i Python og SQL" }] }],
    sporsmalTilDem: ["Hvordan måler dere datakvalitet?"],
    sjekkliste: ["Les annonsen en gang til."] } };
};
const server = lagServer({ katalog: path.join(dir, "data"), nett, brevModellFor });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;

const omDager = n => { const d = new Date(); d.setDate(d.getDate() + n); return isoDato(d); };
const jobb = (id, selskap, o = {}) => ({ id, selskap, stilling: "Dataingeniør", lenke: "", sted: "Bergen",
  frist: omDager(-10), status: "sent", sektor: "energi", jobbtype: "fulltid", notat: "", sendtDato: omDager(-8),
  hendelser: [{ til: "todo", dato: omDager(-12) }, { til: "sent", dato: omDager(-8) }], ...o });
const IV = { id: "iv00000000000001", dato: omDager(3), tid: "09:00", varighet: 60, sted: "Teams", type: "video", lenke: "", runde: "", notat: "" };
const JOBBER = [
  jobb("sendt", "Fjordnett"),
  jobb("utenannonse", "Havbruk Vest", { status: "interview", intervjuer: [IV] })
];

let browser, page;
try{
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE
    ? { executablePath: process.env.BROWSER_EXECUTABLE }
    : process.platform === "darwin" ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  const reg = await context.request.post(url + "/api/registrer",
    { data: { epost: "test@eksempel.no", navn: "Astrid Eksempel", passord: "syntetisk-passord-123" } });
  assert.ok(reg.ok());
  const v = await (await context.request.get(url + "/api/jobber")).json();
  assert.ok((await context.request.put(url + "/api/jobber", { data: { versjon: v.versjon, jobber: JOBBER } })).ok());
  assert.ok((await context.request.put(url + "/api/jobber/sendt/dokument", { data: { revisjon: 0,
    annonse: { tekst: ANNONSE, url: "", kilde: "limt", hentet: new Date().toISOString() } } })).ok());
  assert.ok((await context.request.put(url + "/api/cv", { data: { revisjon: 0, tekst: CV, navn: "", format: "tekst" } })).ok());
  assert.ok((await context.request.put(url + "/api/nokler/anthropic", { data: { nokkel: "sk-syntetisk-testnokkel-abcdefghijklmnopqrstuvwxyz" } })).ok());

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

  /* ---------- nytt intervju: status, angre og fanemerke ---------- */
  await page.goto(url + "/#jobb/sendt/intervju");
  await page.locator("#detalj").waitFor();
  assert.equal(await page.locator('[data-fanemerke="intervju"]').isHidden(), true, "intet merke uten intervju");
  await page.locator('[data-iv="ny"]').click();
  await page.locator("#ivSkjema").waitFor();
  await page.locator("#ivtid").fill("10:30");
  await page.locator('[data-iv="lagre"]').click();
  assert.match(await page.locator(".ivskjema__feil").textContent(), /dato/i, "dato er påkrevd");
  assert.ok(await page.locator("#ivSkjema").isVisible(), "skjemaet står med feilen");
  await page.locator("#ivdato").fill(omDager(10));
  await page.locator("#ivtype").selectOption("video");
  await page.locator("#ivsted").fill("Teams");
  await page.locator('[data-iv="lagre"]').click();
  await page.locator(".iv").waitFor();
  await vent(async () => (await påDisk("sendt")).status === "interview", "status interview");
  assert.equal((await påDisk("sendt")).intervjuer.length, 1);
  const d = new Date(omDager(10) + "T12:00:00");
  const forventetDato = d.getDate() + ". " + ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"][d.getMonth()];
  assert.match(await page.locator('[data-fanemerke="intervju"]').textContent(), new RegExp(forventetDato.replace(".", "\\.")), "fanemerket viser datoen");
  await page.locator("#angreKnapp").click();
  await vent(async () => (await påDisk("sendt")).status === "sent", "angret til sendt");
  assert.equal((await påDisk("sendt")).intervjuer.length, 1, "angre tar ikke intervjuet bort");
  await page.locator(".iv").waitFor();

  /* ---------- forberedelse: ett kall, så fra lageret ---------- */
  await page.locator('[data-iv="forbered"]').click();
  const forb = page.locator("[data-forb] .forb__sammendrag");
  await forb.waitFor();
  assert.match(await forb.textContent(), /pålitelige datastrømmer/);
  assert.equal(modellkall, 1);
  assert.equal(await page.locator(".forb__feil").count(), 0);
  await page.reload();
  await page.locator("[data-forb] .forb__sammendrag").waitFor();
  assert.equal(modellkall, 1, "en lagret forberedelse gir ikke nytt kall");
  assert.equal(await page.locator('[data-iv="forbered"]').count(), 0);

  /* ---------- sletting med forberedelse krever bekreftelse ---------- */
  await page.locator('[data-iv="slett"]').click();
  await page.locator('[data-iv="bekreft-slett"]').waitFor();
  assert.equal((await påDisk("sendt")).intervjuer.length, 1, "ingenting er slettet før bekreftelsen");
  await page.locator('[data-iv="avbryt-slett"]').click();
  assert.equal(await page.locator('[data-iv="bekreft-slett"]').count(), 0);
  assert.equal((await påDisk("sendt")).intervjuer.length, 1);
  await page.locator('[data-iv="slett"]').click();
  await page.locator('[data-iv="bekreft-slett"]').click();
  await vent(async () => (await påDisk("sendt")).intervjuer.length === 0, "intervjuet slettet");
  await vent(async () => Object.keys((await dokument("sendt")).forberedelser ?? {}).length === 0, "forberedelsen slettet");

  /* ---------- feilvei: uten annonse sendes brukeren til Annonse-fanen ---------- */
  const førKall = modellkall;
  await page.goto(url + "/#jobb/utenannonse/intervju");
  await page.locator(".forb__mangler[data-mangler='annonse']").waitFor();
  assert.equal(await page.locator('[data-iv="forbered"]').count(), 0, "ingen kallknapp uten annonse");
  await page.locator('[data-iv="til-annonse"]').click();
  await page.waitForFunction(() => location.hash === "#jobb/utenannonse/annonse");
  assert.equal(await page.locator("#detaljFane-annonse").getAttribute("aria-selected"), "true");
  assert.equal(modellkall, førKall, "ingen modellkall uten annonse");

  assert.deepEqual(feil, [], "ingen feil i konsollen");
  console.log("Nettlesertest av intervjuene bestått. Datakatalog: " + dir);
}finally{
  await browser?.close();
  await new Promise(r => server.close(r));
}
