import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lagServer } from "./server.mjs";
import { lagBrukere, BRUKERKATALOG } from "./brukere.mjs";

/* Fristvarselet over HTTP: innstillingen per profil og sjekken som
   fører loggen. Ekte server, ekte filer, og en fast klokke. */

const NÅ = new Date(2026, 9, 4, 9, 0);            /* søndag 4. oktober, lokal tid */

async function start(){
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "jobber-varsel-"));
  const brukere = lagBrukere({ katalog, iterasjoner: 1 });
  const tjener = lagServer({ katalog, brukere, nå: () => NÅ });
  await new Promise(r => tjener.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${tjener.address().port}`;
  return { katalog, base, stopp: () => new Promise(r => tjener.close(() => r())) };
}

/* Én konto med sin egen informasjonskapsel. */
async function konto(base, epost){
  const r = await fetch(base + "/api/registrer", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ epost, passord: "et-godt-nok-passord" }) });
  assert.equal(r.status, 201);
  const kake = r.headers.getSetCookie()[0].split(";")[0];
  const { bruker } = await r.json();
  const kall = (sti, metode = "GET", data) => fetch(base + sti, { method: metode,
    headers: { cookie: kake, "content-type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data) });
  return { id: bruker.id, kall };
}

async function leggInn(k, jobber){
  const v = await (await k.kall("/api/jobber")).json();
  const r = await k.kall("/api/jobber", "PUT", { versjon: v.versjon, jobber });
  assert.equal(r.status, 200);
}

const jobb = (o = {}) => ({ id: "a1", selskap: "Aker BP", stilling: "ML Engineer", lenke: "",
  sted: "Oslo", frist: "2026-10-05", status: "todo", sektor: "energi", notat: "", sendtDato: null, ...o });

test("innstillingen har en standard, lagres per profil og avviser ugyldige verdier", async t => {
  const s = await start(); t.after(s.stopp);
  const ola = await konto(s.base, "ola@example.no");
  const kari = await konto(s.base, "kari@example.no");

  assert.deepEqual(await (await ola.kall("/api/varsel")).json(), { på: true, dagerFør: 1 });

  const r = await ola.kall("/api/varsel", "PUT", { på: false, dagerFør: 3 });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { på: false, dagerFør: 3 });
  assert.deepEqual(await (await ola.kall("/api/varsel")).json(), { på: false, dagerFør: 3 });
  assert.deepEqual(JSON.parse(await fs.readFile(
    path.join(s.katalog, BRUKERKATALOG, ola.id, "varsel.json"), "utf8")),
    { versjon: 1, på: false, dagerFør: 3 });

  /* Kari ser ikke Olas valg. */
  assert.deepEqual(await (await kari.kall("/api/varsel")).json(), { på: true, dagerFør: 1 });

  const feil = await ola.kall("/api/varsel", "PUT", { på: true, dagerFør: 30 });
  assert.equal(feil.status, 400);
  assert.equal((await feil.json()).feil, "ugyldig");
  assert.equal((await ola.kall("/api/varsel", "DELETE")).status, 405);
});

test("uten økt er begge endepunktene stengt", async t => {
  const s = await start(); t.after(s.stopp);
  assert.equal((await fetch(s.base + "/api/varsel")).status, 401);
  assert.equal((await fetch(s.base + "/api/varsel/sjekk", { method: "POST" })).status, 401);
});

test("sjekken varsler en frist én gang og fører den i loggen", async t => {
  const s = await start(); t.after(s.stopp);
  const ola = await konto(s.base, "ola@example.no");
  await leggInn(ola, [jobb(), jobb({ id: "b2", frist: "2026-10-09" }), jobb({ id: "c3", status: "sent" })]);

  const første = await (await ola.kall("/api/varsel/sjekk", "POST")).json();
  assert.deepEqual(første.varsler, [{ id: "a1", dager: 1, tittel: "Frist i morgen: Aker BP",
                                      tekst: "ML Engineer · søknadsfristen er mandag 5. oktober." }]);
  const logg = JSON.parse(await fs.readFile(path.join(s.katalog, BRUKERKATALOG, ola.id, "varslet.json"), "utf8"));
  assert.deepEqual(Object.keys(logg), ["a1|2026-10-05"]);

  assert.deepEqual((await (await ola.kall("/api/varsel/sjekk", "POST")).json()).varsler, []);

  /* Lengre varsel fanger den neste, men ikke den som alt er varslet. */
  await ola.kall("/api/varsel", "PUT", { på: true, dagerFør: 5 });
  assert.deepEqual((await (await ola.kall("/api/varsel/sjekk", "POST")).json()).varsler.map(v => v.id), ["b2"]);

  assert.equal((await ola.kall("/api/varsel/sjekk")).status, 405);
});

test("avslått varsel sender ingenting og skriver ingen logg", async t => {
  const s = await start(); t.after(s.stopp);
  const ola = await konto(s.base, "ola@example.no");
  await leggInn(ola, [jobb()]);
  await ola.kall("/api/varsel", "PUT", { på: false, dagerFør: 1 });
  assert.deepEqual((await (await ola.kall("/api/varsel/sjekk", "POST")).json()).varsler, []);
  await assert.rejects(fs.stat(path.join(s.katalog, BRUKERKATALOG, ola.id, "varslet.json")));
});

test("to samtidige sjekker varsler fristen bare én gang", async t => {
  const s = await start(); t.after(s.stopp);
  const ola = await konto(s.base, "ola@example.no");
  await leggInn(ola, [jobb()]);
  const svar = await Promise.all([1, 2, 3].map(() => ola.kall("/api/varsel/sjekk", "POST").then(r => r.json())));
  assert.equal(svar.flatMap(s => s.varsler).length, 1);
});
