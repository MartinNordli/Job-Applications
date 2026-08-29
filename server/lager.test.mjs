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

test("ødelagt fil blir liggende urørt ved lesing", async () => {
  const { katalog, lager } = await nyttLager();
  const sti = path.join(katalog, "jobber.json");
  const rå  = '{ dette er ikke json';
  await fs.writeFile(sti, rå);

  const r = await lager.les();
  assert.equal(r.ødelagt, true);
  /* Filen skal ikke flyttes under lesing: gjorde den det, ville
     katalogen stått tom og neste skriving blitt godtatt. */
  assert.equal(await fs.readFile(sti, "utf8"), rå);
  assert.equal(r.sti, sti);
});

test("ødelagt fil sperrer alle senere skrivinger, ikke bare den første", async () => {
  const { katalog, lager } = await nyttLager();
  const sti = path.join(katalog, "jobber.json");
  await lager.skriv([rad({ id: "e1", selskap: "EKTE1" })], undefined);
  /* Andre skriving, så jobber.forrige.json faktisk finnes. */
  await lager.skriv([rad({ id: "e1", selskap: "EKTE1" }), rad({ id: "e2", selskap: "EKTE2" })], 1);
  await fs.writeFile(sti, '{ ødelagt');

  await lager.les();                                    /* som ved sidelasting */
  const a = await lager.skriv([rad({ id: "n1", selskap: "NY" })], 0);
  const b = await lager.skriv([rad({ id: "n2", selskap: "NY2" })], 0);
  assert.equal(a.ok, false); assert.equal(a.feil, "ødelagt");
  assert.equal(b.ok, false); assert.equal(b.feil, "ødelagt");

  /* Sikkerhetskopien må fortsatt holde de ekte radene. */
  const kopi = JSON.parse(await fs.readFile(path.join(katalog, "jobber.forrige.json"), "utf8"));
  assert.deepEqual(kopi.jobber.map(r => r.selskap), ["EKTE1"]);
});

test("bevisst gjenoppretting setter den ødelagte filen i karantene og skriver", async () => {
  const { katalog, lager } = await nyttLager();
  const sti = path.join(katalog, "jobber.json");
  const rå  = '{ ødelagt';
  await fs.writeFile(sti, rå);
  await lager.les();

  const r = await lager.skriv([rad({ id: "g1", selskap: "GJENOPPRETTET" })], undefined, { overstyrOdelagt: true });
  assert.equal(r.ok, true);
  assert.match(path.basename(r.karantene), /^jobber\.ødelagt-.*\.json$/);
  assert.equal(path.basename(r.karantene).includes(":"), false);
  assert.equal(await fs.readFile(r.karantene, "utf8"), rå);   /* bytene overlevde */

  const dok = JSON.parse(await fs.readFile(sti, "utf8"));
  assert.deepEqual(dok.jobber.map(x => x.selskap), ["GJENOPPRETTET"]);
});

test("en rad validatoren ikke forstår overlever senere skrivinger", async () => {
  const { katalog, lager } = await nyttLager();
  const sti = path.join(katalog, "jobber.json");
  /* Håndredigert fil: én rad med umulig dato. */
  await fs.writeFile(sti, JSON.stringify({ versjon: 1, jobber: [
    rad({ id: "a1", selskap: "Equinor" }),
    rad({ id: "a2", selskap: "Håndredigert", frist: "2026-02-31" })
  ]}, null, 2));

  const lest = await lager.les();
  assert.equal(lest.jobber.length, 1);
  assert.ok(lest.advarsel);

  await lager.skriv(lest.jobber, lest.versjon);
  const dok = JSON.parse(await fs.readFile(sti, "utf8"));
  assert.equal(dok.jobber.length, 1);
  /* Raden er ikke slettet — den er tatt vare på ved siden av. */
  assert.equal(dok.ugyldige.length, 1);
  assert.equal(dok.ugyldige[0].selskap, "Håndredigert");
});

test("feil toppnivåform meldes som ødelagt", async () => {
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
