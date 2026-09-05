import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { lagServer } from "./server.mjs";
import { lagBrukere, BRUKERKATALOG } from "./brukere.mjs";

/* Egen katalog og port 0 per test — ingenting deles mellom testene.

   Alt under /api krever nå en økt. Testene her handler om lageret og
   om de statiske filene, ikke om innloggingen — den har sin egen fil —
   så vi oppretter én bruker og lar cookien følge med hvert kall.
   `minKatalog` er brukerens egen mappe, som er der datafilen faktisk
   ligger etter at flerbruker kom til. */
async function start(){
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "jobber-http-"));
  const brukere = lagBrukere({ katalog, iterasjoner: 1 });
  const tjener  = lagServer({ katalog, brukere });
  await new Promise(r => tjener.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${tjener.address().port}`;

  const r = await fetch(`${base}/api/registrer`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ epost: "ola@example.no", passord: "et-godt-nok-passord" })
  });
  const { bruker } = await r.json();
  const cookie = r.headers.getSetCookie()[0].split(";")[0];
  const api = (sti, valg = {}) => fetch(base + sti,
    { ...valg, headers: { cookie, ...(valg.headers || {}) } });

  return { katalog, minKatalog: path.join(katalog, BRUKERKATALOG, bruker.id),
           tjener, base, api, cookie,
           stopp: () => new Promise(x => tjener.close(x)) };
}

const rad = (o = {}) => ({
  id: "a1", selskap: "Equinor", stilling: "Sommerjobb",
  lenke: "https://example.com/jobb", sted: "Stavanger",
  frist: "2026-09-13", status: "todo", sektor: "energi",
  notat: "", sendtDato: null, ...o
});

const put = (api, kropp) => api("/api/jobber", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: typeof kropp === "string" ? kropp : JSON.stringify(kropp)
});

/* fetch og URL normaliserer bort «..», så forsøket må sendes rått. */
function råForespørsel(port, mål){
  return new Promise((ok, feil) => {
    const s = net.connect(port, "127.0.0.1", () => {
      s.write(`GET ${mål} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let ut = "";
    s.setEncoding("utf8");
    s.on("data", d => { ut += d; });
    s.on("end", () => ok(ut));
    s.on("error", feil);
  });
}

test("GET på tom katalog gir tom:true", async t => {
  const { api, stopp, minKatalog } = await start();
  t.after(stopp);

  const r = await api("/api/jobber");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await r.json(), { versjon: 0, jobber: null, tom: true });
  /* En lesing skriver ingenting — brukerkatalogen finnes ikke engang. */
  assert.equal(await fs.stat(minKatalog).then(() => true, () => false), false);
});

test("PUT lagrer og GET henter det tilbake", async t => {
  const { api, stopp } = await start();
  t.after(stopp);

  const s = await put(api, { versjon: 0, jobber: [rad()] });
  assert.equal(s.status, 200);
  const lagret = await s.json();
  assert.equal(lagret.versjon, 1);
  assert.equal(lagret.jobber[0].selskap, "Equinor");
  assert.ok(lagret.jobber[0].opprettet, "serveren setter opprettet");

  const h = await api("/api/jobber");
  assert.deepEqual(await h.json(), { versjon: 1, jobber: lagret.jobber });
});

test("utdatert versjon gir 409 med gjeldende tilstand", async t => {
  const { api, stopp } = await start();
  t.after(stopp);

  await put(api, { versjon: 0, jobber: [rad()] });
  const r = await put(api, { versjon: 0, jobber: [rad({ selskap: "Kaprer" })] });
  assert.equal(r.status, 409);

  const k = await r.json();
  assert.equal(k.feil, "konflikt");
  assert.equal(k.versjon, 1);
  assert.equal(k.jobber[0].selskap, "Equinor");
});

test("javascript:-lenke gir 400 med detaljer", async t => {
  const { api, stopp } = await start();
  t.after(stopp);

  const r = await put(api, { versjon: 0, jobber: [rad({ lenke: "javascript:alert(1)" })] });
  assert.equal(r.status, 400);
  const k = await r.json();
  assert.equal(k.feil, "ugyldig");
  assert.equal(k.detaljer[0].indeks, 0);
  assert.ok(k.detaljer[0].feil.some(f => f.felt === "lenke"));
});

test("ødelagt json i kroppen gir 400", async t => {
  const { api, stopp } = await start();
  t.after(stopp);

  const r = await put(api, "{ikke json");
  assert.equal(r.status, 400);
  assert.equal((await r.json()).feil, "ugyldig json");
});

test("feil form på kroppen gir 400", async t => {
  const { api, stopp } = await start();
  t.after(stopp);
  assert.equal((await put(api, { versjon: 0 })).status, 400);
});

test("for stor kropp gir 413", async t => {
  const { api, stopp } = await start();
  t.after(stopp);

  const stor = "x".repeat(6 * 1024 * 1024);
  const r = await put(api, { versjon: 0, jobber: [rad({ notat: stor })] });
  assert.equal(r.status, 413);
});

test("ødelagt datafil gir 503", async t => {
  const { api, minKatalog, stopp } = await start();
  t.after(stopp);

  await fs.mkdir(minKatalog, { recursive: true });
  await fs.writeFile(path.join(minKatalog, "jobber.json"), "ikke json");
  const r = await api("/api/jobber");
  assert.equal(r.status, 503);
  const k = await r.json();
  assert.equal(k.feil, "ødelagt");

  /* Filen skal ligge urørt, og en vanlig PUT skal fortsatt nektes —
     ellers ville neste lagring blitt godtatt mot en tom katalog. */
  assert.equal(await fs.readFile(path.join(minKatalog, "jobber.json"), "utf8"), "ikke json");
  const p2 = await api("/api/jobber", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ versjon: 0, jobber: [] })
  });
  assert.equal(p2.status, 503);
});

test("ukjent sti gir 404 og feil metode gir 405", async t => {
  const { api, base, stopp } = await start();
  t.after(stopp);

  assert.equal((await api("/finnes-ikke")).status, 404);
  assert.equal((await api("/api/annet")).status, 404);
  /* Uten økt røper ikke en ukjent api-sti om den finnes. */
  assert.equal((await fetch(`${base}/api/annet`)).status, 401);

  const m = await api("/api/jobber", { method: "DELETE" });
  assert.equal(m.status, 405);
  assert.equal(m.headers.get("allow"), "GET, PUT");
});

test("stier utenfor prosjektet gir 403", async t => {
  const { tjener, stopp } = await start();
  t.after(stopp);
  const port = tjener.address().port;

  for(const mål of ["/../package.json", "/src/../../etc/passwd", "/%2e%2e/package.json"]){
    const svar = await råForespørsel(port, mål);
    assert.match(svar.split("\r\n")[0], /^HTTP\/1\.1 403/, `forventet 403 for ${mål}`);
  }
});

test("index.html serveres på / med no-cache", async t => {
  const { base, stopp } = await start();
  t.after(stopp);

  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(r.headers.get("cache-control"), "no-cache");
});

test("/src/felles.mjs serveres som javascript", async t => {
  const { base, stopp } = await start();
  t.after(stopp);

  const r = await fetch(`${base}/src/felles.mjs`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(await r.text(), /validerSamling/);
});
