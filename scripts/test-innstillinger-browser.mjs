/* Innstillingene i en ekte nettleser: alle fargetemaene og fristvarselet.
   Isolert datakatalog, syntetisk konto, og nettleserens Notification
   byttet ut med et opptak, så testen ser hva som ville blitt vist.
   Skjermbildene av hvert tema blir liggende i arbeidskatalogen. */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { lagServer } from "../server/server.mjs";
import { isoDato } from "../src/fristvarsel.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "innstillinger-nettleser-"));
const server = lagServer({ katalog: path.join(dir, "data") });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;

const omDager = n => { const d = new Date(); d.setDate(d.getDate() + n); return isoDato(d); };
const jobb = (id, selskap, frist) => ({ id, selskap, stilling: "ML Engineer", lenke: "", sted: "Oslo",
  frist, status: "todo", sektor: "energi", jobbtype: "fulltid", notat: "", sendtDato: null });

/* Bunnfargen hvert tema skal gi. System følger lys modus her. */
const BUNN = { system: "rgb(235, 232, 225)", lys: "rgb(235, 232, 225)", mork: "rgb(22, 19, 15)",
               ink: "rgb(247, 245, 240)", blush: "rgb(251, 245, 246)", midnatt: "rgb(15, 21, 32)" };

const varsler = () => page.evaluate(() => window.__varsler.map(v => v.tittel));
const innstilling = async () => (await (await page.context().request.get(url + "/api/varsel")).json());

let browser, page;
try{
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE
    ? { executablePath: process.env.BROWSER_EXECUTABLE }
    : process.platform === "darwin" ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } : {}) });
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, colorScheme: "light" });
  await context.addInitScript(() => {
    window.__varsler = [];
    window.Notification = class { constructor(tittel, valg){ window.__varsler.push({ tittel, ...valg }); } };
    window.Notification.permission = "granted";
    window.Notification.requestPermission = async () => "granted";
  });

  const reg = await context.request.post(url + "/api/registrer",
    { data: { epost: "test@eksempel.no", navn: "Astrid Eksempel", passord: "syntetisk-passord-123" } });
  assert.ok(reg.ok());
  const v = await (await context.request.get(url + "/api/jobber")).json();
  assert.ok((await context.request.put(url + "/api/jobber", { data: { versjon: v.versjon, jobber: [
    jobb("imorgen", "Aker BP", omDager(1)), jobb("om3", "Equinor", omDager(3)),
    jobb("om10", "Statkraft", omDager(10))] } })).ok());

  page = await context.newPage();
  const feil = [];
  page.on("pageerror", e => feil.push(e.message));
  await page.goto(url);
  await page.locator(".rad").first().waitFor();

  /* Oppstarten sjekker fristene: med standarden varsles bare den i morgen. */
  await page.waitForFunction(() => window.__varsler.length > 0);
  assert.deepEqual(await varsler(), ["Frist i morgen: Aker BP"]);

  /* ---------- temaene ---------- */
  await page.locator("#apneInnstillinger").click();
  await page.locator("#skuff.er-apen").waitFor();
  assert.equal(await page.locator("#skuffTittel").textContent(), "Innstillinger");
  const temaer = await page.$$eval('input[name="tema"]', r => r.map(x => [x.value, x.checked]));
  assert.deepEqual(temaer.map(t => t[0]), ["system", "lys", "mork", "ink", "blush", "midnatt"]);
  assert.deepEqual(temaer.filter(t => t[1]).map(t => t[0]), ["system"]);

  for(const id of Object.keys(BUNN)){
    await page.locator(`label.tema:has(input[value="${id}"])`).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.tema ?? "system"), id);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), BUNN[id], id);
    assert.equal(await page.locator("#temafarge").getAttribute("content"), BUNN[id]);
    await page.screenshot({ path: path.join(dir, `tema-${id}-skuff.png`) });
    await page.keyboard.press("Escape");
    await page.locator("#skuff.er-apen").waitFor({ state: "detached" });
    await page.screenshot({ path: path.join(dir, `tema-${id}.png`) });
    await page.locator("#apneInnstillinger").click();
    await page.locator("#skuff.er-apen").waitFor();
  }

  /* Valget overlever en omlasting, og piltastene går mellom temaene. */
  await page.reload();
  await page.locator(".rad").first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.tema), "midnatt");
  await page.locator("#apneInnstillinger").click();
  await page.locator('input[name="tema"][value="midnatt"]').focus();
  await page.keyboard.press("ArrowLeft");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.tema), "blush");
  await page.locator('label.tema:has(input[value="system"])').click();
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-tema")), false);

  /* ---------- fristvarselet ---------- */
  await page.waitForFunction(() => !document.querySelector("#varselPa").disabled);
  assert.equal(await page.locator("#varselPa").isChecked(), true);
  assert.equal(await page.locator("#varselDager").inputValue(), "1");
  assert.match(await page.locator("#varselHjelp").textContent(), /mens Hired er åpen/);

  /* Lengre varsel fanger fristen om tre dager. Den i morgen er varslet
     før omlastingen og kommer ikke igjen, selv om opptaket er tømt. */
  await page.locator("#varselDager").selectOption("3");
  await page.waitForFunction(() => window.__varsler.length > 0);
  assert.deepEqual(await varsler(), ["Frist om 3 dager: Equinor"]);
  assert.deepEqual(await innstilling(), { på: true, dagerFør: 3 });

  await page.locator("#varselPa").uncheck();
  await page.waitForFunction(() => document.querySelector("#varselDager").disabled);
  await page.waitForFunction(() => !document.querySelector("#varselPa").disabled);
  assert.deepEqual(await innstilling(), { på: false, dagerFør: 3 });
  assert.match(await page.locator("#varselHjelp").textContent(), /Ingen varsler/);
  await page.screenshot({ path: path.join(dir, "varsel-av.png") });

  /* Innstillingen står på disk og leses tilbake når panelet åpnes på nytt. */
  await page.keyboard.press("Escape");
  await page.locator("#apneInnstillinger").click();
  await page.waitForFunction(() => !document.querySelector("#varselPa").disabled);
  assert.equal(await page.locator("#varselPa").isChecked(), false);
  assert.equal(await page.locator("#varselDager").inputValue(), "3");
  await page.locator("#varselPa").check();
  await page.waitForFunction(() => !document.querySelector("#varselDager").disabled);
  await page.keyboard.press("Escape");

  /* ---------- smal skjerm: innstillingene er et ikon i toppstripa ---------- */
  await page.setViewportSize({ width: 600, height: 820 });
  const boks = await page.locator("#apneInnstillinger").boundingBox();
  assert.ok(boks && boks.width === 44 && boks.height === 44, JSON.stringify(boks));
  assert.equal(await page.locator("#apneInnstillinger").getAttribute("aria-label"), null);
  assert.equal((await page.getByRole("button", { name: "Innstillinger" }).count()), 1);
  await page.screenshot({ path: path.join(dir, "smal.png") });
  await page.locator("#apneInnstillinger").click();
  await page.locator("#skuff.er-apen").waitFor();
  await page.screenshot({ path: path.join(dir, "smal-skuff.png") });

  assert.deepEqual(feil, []);
  console.log(`Nettlesertest av innstillingene bestått. Skjermbilder: ${dir}`);
}catch(e){
  console.error(`Nettlesertesten av innstillingene feilet. Arbeidskatalog: ${dir}`);
  if(page) await page.screenshot({ path: path.join(dir, "feil.png"), fullPage: true }).catch(() => {});
  throw e;
}
finally{ await browser?.close(); await new Promise(r => server.close(r)); }
