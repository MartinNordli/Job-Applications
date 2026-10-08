/* «Legg til søknad», «Dataene dine» og intervjutallene i en ekte nettleser.
   Isolert datakatalog og syntetisk konto. Skjermbildene blir liggende i
   arbeidskatalogen. */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { lagServer } from "../server/server.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skuff-nettleser-"));
const server = lagServer({ katalog: path.join(dir, "data") });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;

const jobb = (id, selskap, status, o = {}) => ({ id, selskap, stilling: "ML Engineer", lenke: "", sted: "Oslo",
  frist: null, status, sektor: "energi", jobbtype: "fulltid", notat: "",
  sendtDato: status === "todo" ? null : "2026-09-01", ...o });

let browser, page;
try{
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE
    ? { executablePath: process.env.BROWSER_EXECUTABLE }
    : process.platform === "darwin" ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } : {}) });
  const context = await browser.newContext({ viewport: { width: 1180, height: 640 }, colorScheme: "light" });

  assert.ok((await context.request.post(url + "/api/registrer",
    { data: { epost: "test@eksempel.no", navn: "Astrid Eksempel", passord: "syntetisk-passord-123" } })).ok());
  const v = await (await context.request.get(url + "/api/jobber")).json();
  assert.ok((await context.request.put(url + "/api/jobber", { data: { versjon: v.versjon, jobber: [
    jobb("todo1", "Aker BP", "todo"), jobb("sendt1", "Equinor", "sent"), jobb("sendt2", "Bekk", "sent"),
    jobb("intervju1", "Statkraft", "interview"), jobb("avslag1", "Cognite", "rejected")] } })).ok());
  const påDisk = async id => (await (await context.request.get(url + "/api/jobber")).json()).jobber.find(j => j.id === id);

  page = await context.newPage();
  const feil = [];
  page.on("pageerror", e => feil.push(e.message));
  await page.goto(url);
  await page.locator(".rad").first().waitFor();

  /* ---------- to veier inn, lenken først ---------- */
  await page.locator("#apneNy").click();
  await page.locator("#skuff.er-apen").waitFor();
  const faner = () => page.$$eval("#skuff [data-modus]", k => k.map(x => [x.dataset.modus, x.getAttribute("aria-selected")]));
  assert.deepEqual(await faner(), [["lenke", "true"], ["skjema", "false"]]);
  assert.equal(await page.locator("#importLenke").count(), 1);
  assert.equal(await page.getByText("Fra notat").count(), 0);

  /* ---------- bryteren står fast når skjemaet rulles ---------- */
  await page.locator('[data-modus="skjema"]').click();
  const kropp = page.locator("#skuffKropp");
  const før = await page.locator(".modus").boundingBox();
  const rullet = await kropp.evaluate(el => { el.scrollTop = el.scrollHeight; return el.scrollTop; });
  assert.ok(rullet > 0, "skjemaet må være høyere enn skuffen for at testen skal si noe");
  const etter = await page.locator(".modus").boundingBox();
  assert.equal(Math.round(etter.y), Math.round(før.y), "bryteren skal ikke rulle bort");
  /* Feltene glir under bryteren, ikke over den. */
  const øverst = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".modus") !== null,
    { x: etter.x + etter.width / 2, y: etter.y + etter.height / 2 });
  assert.ok(øverst, "bryteren skal ligge øverst når skjemaet er rullet");
  await page.screenshot({ path: path.join(dir, "skjema-rullet.png") });

  /* Valget huskes til neste gang skuffen åpnes. */
  await page.keyboard.press("Escape");
  await page.locator("#apneNy").click();
  await page.locator("#skuff.er-apen").waitFor();
  assert.deepEqual(await faner(), [["lenke", "false"], ["skjema", "true"]]);
  await page.keyboard.press("Escape");

  /* ---------- dataene dine: bare tallet og startlisten ---------- */
  await page.locator("#apneEksport").click();
  await page.locator("#skuff.er-apen").waitFor();
  assert.match(await page.locator("#skuffKropp").textContent(), /5 søknader ligger i jobber\.json/);
  assert.deepEqual(await page.$$eval("#skuffKropp button", k => k.map(x => x.dataset.gjor)), ["tilbakestill"]);
  assert.equal(await page.locator("#apiNokkel").count(), 0);
  await page.screenshot({ path: path.join(dir, "dataene-dine.png") });
  await page.keyboard.press("Escape");

  /* ---------- API-nøkkelen ligger under innstillingene ---------- */
  await page.locator("#apneInnstillinger").click();
  await page.locator("#skuff.er-apen").waitFor();
  await page.waitForFunction(() => document.querySelector("#nokkelTilstand")?.textContent);
  assert.equal(await page.locator("#nokkelTilstand").textContent(), "Ingen nøkkel, importen er slått av");
  await page.locator("#apiNokkelInn").fill("sk-ant-syntetisk-testnokkel-1234");
  await page.locator("#lagreNokkel").click();
  await page.waitForFunction(() => /^Nøkkel satt/.test(document.querySelector("#nokkelTilstand")?.textContent || ""));
  assert.match(await page.locator("#nokkelTilstand").textContent(), /····1234/);
  assert.equal(await page.locator("#fjernNokkel").isVisible(), true);
  await page.screenshot({ path: path.join(dir, "innstillinger-nokkel.png") });
  await page.keyboard.press("Escape");

  /* ---------- intervjuet overlever et avslag ---------- */
  await page.locator('[data-visning="sendt"]').click();
  await page.locator('.rad[data-id="sendt1"] [data-gjor="interview"]').click();
  await page.locator('.rad[data-id="sendt1"] [data-gjor="rediger"]').click();
  await page.locator("#skuff.er-apen").waitFor();
  assert.equal(await page.locator("#fintervju").isChecked(), true);
  await page.locator("#fStatus").selectOption("rejected");
  await page.locator("#lagreSkjema").click();
  /* Lagringen er utsatt litt; vent til avslaget står på disk. */
  let lagret;
  for(let i = 0; i < 50 && (lagret = await påDisk("sendt1")).status !== "rejected"; i++) await page.waitForTimeout(100);
  assert.equal(lagret.status, "rejected");
  assert.equal(lagret.intervju, true);

  /* Sendt: Equinor, Bekk, Statkraft, Cognite. Intervju: Equinor og Statkraft. */
  await page.locator('[data-visning="tall"]').click();
  const flis = await page.locator(".nokkel", { hasText: "Intervju" });
  assert.equal(await flis.locator(".nokkel__verdi").textContent(), "2");
  assert.equal(await flis.locator(".nokkel__under").textContent(), "50 % av de sendte");
  const trakt = await page.$$eval(".trakt__trinn", t => t.map(x => [x.querySelector(".trakt__navn").textContent,
    x.querySelector(".trakt__verdi").textContent]));
  assert.deepEqual(trakt, [["Sporet", "5"], ["Sendt", "4"], ["Fått svar", "3"], ["Fikk intervju", "2"]]);
  await page.screenshot({ path: path.join(dir, "tall.png"), fullPage: true });

  assert.deepEqual(feil, []);
  console.log(`Nettlesertest av skuffen bestått. Skjermbilder: ${dir}`);
}catch(e){
  console.error(`Nettlesertesten av skuffen feilet. Arbeidskatalog: ${dir}`);
  if(page) await page.screenshot({ path: path.join(dir, "feil.png"), fullPage: true }).catch(() => {});
  throw e;
}
finally{ await browser?.close(); await new Promise(r => server.close(r)); }
