/* Hendelsesloggen slik den vises: ventetiden og intervjuene på radene
   under Sendt, og flisene Svartid og Uten svar under Tall, i bred og
   smal visning. Isolert datakatalog og syntetisk konto. Skjermbildene
   blir liggende i arbeidskatalogen. */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { lagServer } from "../server/server.mjs";
import { isoDato } from "../src/fristvarsel.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hendelser-nettleser-"));
const server = lagServer({ katalog: path.join(dir, "data") });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;

const omDager = n => { const d = new Date(); d.setDate(d.getDate() + n); return isoDato(d); };
const MND_K = ["jan","feb","mar","apr","mai","jun","jul","aug","sep","okt","nov","des"];
const kort = iso => { const [, m, d] = iso.split("-").map(Number); return d + ". " + MND_K[m - 1]; };
const h = (til, dag) => ({ til, dato: omDager(dag), kilde: "bruker" });
const jobb = (id, selskap, status, o = {}) => ({ id, selskap, stilling: "ML Engineer", lenke: "", sted: "Oslo",
  frist: null, status, sektor: "energi", jobbtype: "fulltid", notat: "", sendtDato: null, ...o });

const JOBBER = [
  jobb("lenge", "Aker BP", "sent", { sendtDato: omDager(-40), hendelser: [h("sent", -40)] }),
  jobb("lenge2", "Statnett", "sent", { sendtDato: omDager(-31) }),
  jobb("grense", "Equinor", "sent", { sendtDato: omDager(-30) }),
  jobb("idag", "NBIM", "sent", { sendtDato: omDager(0) }),
  jobb("udatert", "Bain", "sent"),
  jobb("imorgen", "Abakus (Webcom og Bedcom)", "interview",
    { sendtDato: omDager(-20), hendelser: [h("sent", -20), h("interview", -3)],
      intervjuer: [{ id: "a", dato: omDager(1), tid: "10:00" }] }),
  jobb("senere", "Revolve NTNU", "interview",
    { sendtDato: omDager(-14), hendelser: [h("sent", -14), h("interview", -4)],
      intervjuer: [{ id: "b", dato: omDager(-9) }, { id: "c", dato: omDager(9) }] }),
  jobb("forbi", "Njord NTNU", "interview",
    { sendtDato: omDager(-30), hendelser: [h("sent", -30), h("interview", -21)] }),
  /* Svartid: 9, 10, 17 og 21 dager, median 13,5, vist som 14. Avslaget er ute av Sendt, men teller i svartiden. */
  jobb("avslag", "Cognite", "rejected",
    { sendtDato: omDager(-30), hendelser: [h("sent", -30), h("rejected", -9)] }),
  jobb("todo1", "Visma", "todo", { frist: omDager(-2), sektor: "teknologi" })
];

let browser, page;
try{
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE
    ? { executablePath: process.env.BROWSER_EXECUTABLE }
    : process.platform === "darwin" ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });

  assert.ok((await context.request.post(url + "/api/registrer",
    { data: { epost: "test@eksempel.no", navn: "Astrid Eksempel", passord: "syntetisk-passord-123" } })).ok());
  const v = await (await context.request.get(url + "/api/jobber")).json();
  assert.ok((await context.request.put(url + "/api/jobber", { data: { versjon: v.versjon, jobber: JOBBER } })).ok());

  page = await context.newPage();
  const feil = [];
  page.on("pageerror", e => feil.push(e.message));
  await page.goto(url);
  await page.locator(".rad").first().waitFor();

  /* ---------- radene under Sendt ---------- */
  await page.locator('[data-visning="sendt"]').click();
  const om = id => page.locator(`.rad[data-id="${id}"] .rad__om`);
  assert.equal(await om("lenge").textContent(), "venter 40 dager");
  assert.equal(await om("lenge2").textContent(), "venter 31 dager");
  assert.equal(await om("idag").textContent(), "sendt i dag");
  assert.equal(await om("udatert").textContent(), "", "uten dato gjettes det ikke");
  assert.equal(await om("imorgen").textContent(), "intervju i morgen");
  assert.equal(await om("senere").textContent(), "intervju " + kort(omDager(9)), "det neste intervjuet, ikke det forrige");
  assert.equal(await om("forbi").textContent(), "i intervju i 21 dager");
  assert.equal(await om("imorgen").getAttribute("data-kommer"), "");
  assert.equal(await om("forbi").getAttribute("data-kommer"), null);

  /* Den tomme kolonnen holder bredden, så selskapsnavnet står likt. */
  const bredde = id => om(id).evaluate(el => el.getBoundingClientRect().width);
  assert.ok(await bredde("udatert") >= 92, "kolonnen skal være reservert også når den er tom");
  assert.equal(await page.locator('.rad[data-id="imorgen"] .monogram').textContent(), "AW");
  await page.screenshot({ path: path.join(dir, "sendt.png"), fullPage: true });

  /* ---------- flisene under Tall ---------- */
  await page.locator('[data-visning="tall"]').click();
  const flis = navn => page.locator(".nokkel", { has: page.locator(".nokkel__merke", { hasText: new RegExp("^" + navn + "$") }) });
  assert.equal(await page.locator(".nokkel").count(), 7);
  assert.equal(await flis("Svartid").locator(".nokkel__verdi").textContent(), "14 dager");
  assert.match(await flis("Svartid").locator(".nokkel__under").textContent(), /^Median av 4 søknader/);
  assert.equal(await flis("Uten svar").locator(".nokkel__verdi").textContent(), "2");
  assert.equal(await flis("Uten svar").locator(".nokkel__under").textContent(), "Over 30 dager: Aker BP, Statnett",
    "den som har ventet lengst står først, og 30 dager er ikke over 30");

  /* Tallene i én rad står på samme linje, også når en underlinje brytes. */
  const linjer = await page.$$eval(".nokkel__verdi", v => v.map(x => Math.round(x.getBoundingClientRect().top)));
  assert.equal(new Set(linjer.slice(0, 3)).size, 1, "første rad");
  assert.equal(new Set(linjer.slice(3)).size, 1, "andre rad");
  await page.screenshot({ path: path.join(dir, "tall-bred.png") });

  /* Uten ekte svar står flisen tom og sier hvordan den fylles. */
  await page.locator("#filtSektor").selectOption("teknologi");
  assert.equal(await flis("Svartid").locator(".nokkel__verdi").textContent(), "–");
  assert.match(await flis("Svartid").locator(".nokkel__under").textContent(), /^Måles fra du merker/);
  assert.equal(await flis("Uten svar").locator(".nokkel__under").textContent(), "Ingen har ventet over 30 dager");
  await page.locator("#filtSektor").selectOption("");

  /* ---------- telefonbredde ---------- */
  await page.setViewportSize({ width: 390, height: 844 });
  /* En del av en underlinje brytes aldri inni seg selv. */
  const brutt = await page.$$eval(".nokkel__del", d => d.filter(x => x.getClientRects().length > 1).map(x => x.textContent));
  assert.deepEqual(brutt, []);
  const verdier = await page.$$eval(".nokkel__verdi", v => v.map(x => Math.round(x.getBoundingClientRect().top)));
  assert.equal(new Set(verdier.slice(1, 3)).size, 1, "flisene står parvis");
  await page.screenshot({ path: path.join(dir, "tall-390.png"), fullPage: true });

  /* Alle radknappene er innenfor kortet, også «Slett» helt til slutt. */
  await page.locator('[data-visning="sendt"]').click();
  const utenfor = await page.$$eval(".rad", rader => rader.flatMap(r => {
    const kant = r.closest(".stabel").getBoundingClientRect().right;
    return [...r.querySelectorAll(".handling")].filter(k => k.getBoundingClientRect().right > kant + 0.5)
      .map(k => r.dataset.id + ": " + k.textContent);
  }));
  assert.deepEqual(utenfor, []);
  await page.screenshot({ path: path.join(dir, "sendt-390.png"), fullPage: true });

  assert.deepEqual(feil, []);
  console.log(`Nettlesertest av hendelsene bestått. Skjermbilder: ${dir}`);
}catch(e){
  console.error(`Nettlesertesten av hendelsene feilet. Arbeidskatalog: ${dir}`);
  if(page) await page.screenshot({ path: path.join(dir, "feil.png"), fullPage: true }).catch(() => {});
  throw e;
}
finally{ await browser?.close(); await new Promise(r => server.close(r)); }
