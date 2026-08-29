import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { validerSoknad, validerSamling } from "../src/felles.mjs";
import { lagLager } from "./lager.mjs";

/* Hver test får sin egen katalog, så den ekte data/ aldri røres. */
async function nyttLager(){
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "jobber-test-"));
  return { katalog, lager: lagLager({ katalog }) };
}

const rad = (o = {}) => ({
  id: "a1", selskap: "Equinor", stilling: "Sommerjobb",
  lenke: "https://example.com/jobb", sted: "Stavanger",
  frist: "2026-09-13", status: "todo", sektor: "energi",
  notat: "", sendtDato: null, ...o
});

const finnes = async p => !!(await fs.stat(p).catch(() => null));
const sov = ms => new Promise(r => setTimeout(r, ms));

/* ---------- validatoren ---------- */

test("frist: 2026-02-31 avvises, 2026-09-13 godtas", () => {
  assert.equal(validerSoknad(rad({ frist: "2026-02-31" })).ok, false);
  assert.equal(validerSoknad(rad({ frist: "2026-09-13" })).ok, true);
});

test("lenke: javascript: avvises, tom lenke godtas", () => {
  const dårlig = validerSoknad(rad({ lenke: "javascript:alert(1)" }));
  assert.equal(dårlig.ok, false);
  assert.ok(dårlig.feil.some(f => f.felt === "lenke"));
  assert.equal(validerSoknad(rad({ lenke: "" })).ok, true);
});

test("ukjent status avvises, ukjent sektor blir «annet»", () => {
  assert.equal(validerSoknad(rad({ status: "tullball" })).ok, false);
  assert.equal(validerSoknad(rad({ sektor: "romfart" })).verdi.sektor, "annet");
});

test("ukjente felt faller bort", () => {
  const r = validerSoknad(rad({ hemmelig: "x", __proto__ukjent: 1 }));
  assert.equal(r.ok, true);
  assert.equal("hemmelig" in r.verdi, false);
  assert.deepEqual(Object.keys(r.verdi).sort(), [
    "frist","id","lenke","notat","opprettet","oppdatert","sektor",
    "selskap","sendtDato","sted","stilling","status"
  ].sort());
});

test("duplikat id forkastes, første vinner", () => {
  const { gyldige, forkastet } = validerSamling([rad(), rad({ selskap: "Annen" })]);
  assert.equal(gyldige.length, 1);
  assert.equal(gyldige[0].selskap, "Equinor");
  assert.equal(forkastet.length, 1);
  assert.equal(forkastet[0].indeks, 1);
});

/* ---------- lesing ---------- */

test("manglende fil gir tom, og ingen fil opprettes", async () => {
  const { katalog, lager } = await nyttLager();
  const r = await lager.les();
  assert.deepEqual(r, { tom: true, versjon: 0, jobber: null });
  assert.deepEqual(await fs.readdir(katalog), []);
});

test("rundtur: skriv og les gir samme rader", async () => {
  const { lager } = await nyttLager();
  const skrevet = await lager.skriv([rad(), rad({ id: "b2", selskap: "DNV" })], 0);
  assert.equal(skrevet.ok, true);
  assert.equal(skrevet.versjon, 1);

  const lest = await lager.les();
  assert.equal(lest.versjon, 1);
  assert.deepEqual(lest.jobber, skrevet.jobber);
  assert.deepEqual(lest.jobber.map(j => j.id), ["a1", "b2"]);
});

test("ødelagt fil settes i karantene med innholdet i behold", async () => {
  const { katalog, lager } = await nyttLager();
  const sti = path.join(katalog, "jobber.json");
  const rå  = '{ dette er ikke json';
  await fs.writeFile(sti, rå);

  const r = await lager.les();
  assert.equal(r.ødelagt, true);
  assert.equal(await fs.readFile(r.sti, "utf8"), rå);      /* bytene overlevde */
  assert.equal(await finnes(sti), false);                  /* originalen ble ikke overskrevet */
  assert.match(path.basename(r.sti), /^jobber\.ødelagt-.*\.json$/);
  assert.equal(path.basename(r.sti).includes(":"), false);
});

test("feil toppnivåform settes i karantene", async () => {
  const { katalog, lager } = await nyttLager();
  await fs.writeFile(path.join(katalog, "jobber.json"), '{"noe":"helt annet"}');
  assert.equal((await lager.les()).ødelagt, true);
});

test("bar liste leses som eldre format, ikke karantene", async () => {
  const { katalog, lager } = await nyttLager();
  await fs.writeFile(path.join(katalog, "jobber.json"), JSON.stringify([rad()]));

  const r = await lager.les();
  assert.equal(r.ødelagt, undefined);
  assert.equal(r.versjon, 0);
  assert.equal(r.jobber.length, 1);
  assert.equal((await fs.readdir(katalog)).length, 1);
});

test("ugyldige rader hoppes over med advarsel", async () => {
  const { katalog, lager } = await nyttLager();
  await fs.writeFile(path.join(katalog, "jobber.json"), JSON.stringify({
    versjon: 3, jobber: [rad(), rad({ id: "b2", selskap: "" })]
  }));

  const r = await lager.les();
  assert.equal(r.versjon, 3);
  assert.equal(r.jobber.length, 1);
  assert.equal(r.forkastet.length, 1);
  assert.match(r.advarsel, /rad/i);
});

/* ---------- skriving ---------- */

test("ugyldige rader skrives ikke", async () => {
  const { katalog, lager } = await nyttLager();
  const r = await lager.skriv([rad({ lenke: "javascript:alert(1)" })], 0);
  assert.equal(r.ok, false);
  assert.equal(r.feil, "ugyldig");
  assert.equal(r.detaljer[0].indeks, 0);
  assert.deepEqual(await fs.readdir(katalog), []);
});

test("utdatert versjon gir konflikt og lar filen stå urørt", async () => {
  const { katalog, lager } = await nyttLager();
  await lager.skriv([rad()], 0);
  const sti  = path.join(katalog, "jobber.json");
  const før  = await fs.readFile(sti, "utf8");

  const r = await lager.skriv([rad({ selskap: "Kaprer" })], 0);
  assert.equal(r.ok, false);
  assert.equal(r.feil, "konflikt");
  assert.equal(r.versjon, 1);
  assert.equal(r.jobber[0].selskap, "Equinor");
  assert.equal(await fs.readFile(sti, "utf8"), før);
});

test("samtidige skrivinger serialiseres og teller riktig", async () => {
  const { lager } = await nyttLager();
  const svar = await Promise.all([
    lager.skriv([rad({ id: "a" })]),
    lager.skriv([rad({ id: "a" }), rad({ id: "b" })]),
    lager.skriv([rad({ id: "a" }), rad({ id: "b" }), rad({ id: "c" })]),
    lager.skriv([rad({ id: "d" })])
  ]);
  assert.deepEqual(svar.map(s => s.versjon), [1, 2, 3, 4]);

  const lest = await lager.les();
  assert.equal(lest.versjon, 4);
  assert.deepEqual(lest.jobber.map(j => j.id), ["d"]);
});

test("ingen .tmp-fil blir liggende igjen", async () => {
  const { katalog, lager } = await nyttLager();
  await lager.skriv([rad()], 0);
  const filer = await fs.readdir(katalog);
  assert.equal(filer.some(f => f.includes(".tmp")), false);
});

test("jobber.forrige.json holder forrige dokument", async () => {
  const { katalog, lager } = await nyttLager();
  await lager.skriv([rad()], 0);
  await lager.skriv([rad({ selskap: "DNV" })], 1);

  const forrige = JSON.parse(await fs.readFile(path.join(katalog, "jobber.forrige.json"), "utf8"));
  assert.equal(forrige.versjon, 1);
  assert.equal(forrige.jobber[0].selskap, "Equinor");
});

test("filen er lesbar for mennesker og har envelope", async () => {
  const { katalog, lager } = await nyttLager();
  await lager.skriv([rad()], 0);
  const tekst = await fs.readFile(path.join(katalog, "jobber.json"), "utf8");
  assert.match(tekst, /^\{\n  "versjon": 1,\n  "oppdatert": "/);
  assert.match(JSON.parse(tekst).oppdatert, /^\d{4}-\d{2}-\d{2}T/);
});

test("tidsstempler: opprettet består, oppdatert flytter seg, urørt rad står stille", async () => {
  const { lager } = await nyttLager();
  const først = await lager.skriv([rad({ id: "a" }), rad({ id: "b" })], 0);
  const [a0, b0] = først.jobber;
  await sov(5);

  const så = await lager.skriv([rad({ id: "a", stilling: "Fast stilling" }), rad({ id: "b" })], 1);
  const [a1, b1] = så.jobber;

  assert.equal(a1.opprettet, a0.opprettet);
  assert.notEqual(a1.oppdatert, a0.oppdatert);
  assert.ok(Date.parse(a1.oppdatert) > Date.parse(a0.oppdatert));

  assert.equal(b1.opprettet, b0.opprettet);
  assert.equal(b1.oppdatert, b0.oppdatert);
});

test("klientens tidsstempler overstyres av serveren", async () => {
  const { lager } = await nyttLager();
  const r = await lager.skriv([rad({ opprettet: "1999-01-01T00:00:00.000Z",
                                     oppdatert: "1999-01-01T00:00:00.000Z" })], 0);
  assert.notEqual(r.jobber[0].opprettet, "1999-01-01T00:00:00.000Z");
  assert.ok(Date.parse(r.jobber[0].opprettet) > Date.parse("2020-01-01T00:00:00.000Z"));
});

test("skriving mot ødelagt fil nekter i stedet for å overskrive", async () => {
  const { katalog, lager } = await nyttLager();
  await fs.writeFile(path.join(katalog, "jobber.json"), "ikke json");
  const r = await lager.skriv([rad()]);
  assert.equal(r.ok, false);
  assert.equal(r.feil, "ødelagt");
});
