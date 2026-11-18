import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lagServer } from "../../server/server.mjs";
import { lagBrukere, BRUKERKATALOG } from "../../server/brukere.mjs";
import * as Økt from "../../src/konto/okt.js";

const sidehendelser = new Map();
globalThis.addEventListener = (navn, fn) => {
  if(!sidehendelser.has(navn)) sidehendelser.set(navn, []);
  sidehendelser.get(navn).push(fn);
};
globalThis.document = { visibilityState: "visible" };

const ekteFetch = globalThis.fetch;
let base = null, kake = null, kall = [];
globalThis.fetch = async (sti, valg = {}) => {
  const adresse = typeof sti === "string" && sti.startsWith("/") ? base + sti : sti;
  kall.push(`${(valg.method || "GET").toUpperCase()} ${sti}`);
  const hoder = { ...(valg.headers || {}) };
  if(kake) hoder.cookie = kake;
  const svar = await ekteFetch(adresse, { ...valg, headers: hoder });
  for(const s of svar.headers.getSetCookie()){
    const par = s.split(";")[0];
    kake = par.endsWith("=") ? null : par;
  }
  return svar;
};

const PASSORD = "et-godt-nok-passord";
const ANNET_PASSORD = "et-annet-godt-passord";

let nr = 0;

async function start(){
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "jobber-øktflyt-"));
  const brukere = lagBrukere({ katalog, iterasjoner: 1 });
  const tjener  = lagServer({ katalog, brukere });
  await new Promise(r => tjener.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${tjener.address().port}`;
  kake = null;
  kall = [];

  const konto = await Økt.registrer({ epost: "ola@example.no", passord: PASSORD });
  assert.equal(konto.ok, true);

  sidehendelser.clear();
  const Lagring = await import("../../src/soknader/lagring.js?nr=" + (++nr));

  let siste = null;
  Lagring.påTilstand(t => { siste = t; });

  const porter = [];
  const avPort = Økt.påUtlogget(m => porter.push(m));

  return {
    katalog, brukere, Lagring, bruker: konto.bruker, porter,
    katalogFor: id => path.join(katalog, BRUKERKATALOG, id),
    minKatalog: path.join(katalog, BRUKERKATALOG, konto.bruker.id),
    tilstand: () => siste,
    glemKapsel: () => { kake = null; },
    skrivinger: () => kall.filter(k => k === "PUT /api/jobber").length,
    hendelse: (navn, synlighet) => {
      globalThis.document.visibilityState = synlighet || "visible";
      (sidehendelser.get(navn) || []).forEach(fn => fn());
      globalThis.document.visibilityState = "visible";
    },
    stopp: () => { avPort(); return new Promise(r => tjener.close(() => r())); }
  };
}

const rad = (o = {}) => ({
  id: "a1", selskap: "Equinor", stilling: "Sommerjobb",
  lenke: "https://example.com/jobb", sted: "Stavanger",
  frist: "2026-09-13", status: "todo", sektor: "energi",
  notat: "", sendtDato: null, ...o
});

const påDisk = async k => JSON.parse(await fs.readFile(path.join(k, "jobber.json"), "utf8"));
const finnes = async p => !!(await fs.stat(p).catch(() => null));

function vent(Lagring, navn){
  return new Promise(ok => {
    let av = null, ferdig = false;
    const se = t => { if(t.navn !== navn || ferdig) return; ferdig = true; if(av) av(); ok(t); };
    av = Lagring.påTilstand(se);
    if(ferdig) av();
  });
}

test("økten ryker midt i en skriving: endringen ligger i behold, og ingen nye kall sendes", async t => {
  const { Lagring, minKatalog, tilstand, porter, glemKapsel, skrivinger, stopp } = await start();
  t.after(stopp);

  await Lagring.hent();
  Lagring.lagre([rad()]);
  await Lagring.nåMedEnGang();

  glemKapsel();
  Lagring.lagre([rad(), rad({ id: "a2", selskap: "Cognite" })]);
  await Lagring.nåMedEnGang();

  assert.equal(tilstand().navn, "utlogget",
    "en 401 er ikke «avvist» — brukeren skal se porten, ikke «Lagringen avviste endringen»");
  assert.equal(Lagring.harUlagret(), true);
  assert.equal(Lagring.erBlokkert(), true);
  assert.equal(porter.length, 1);
  assert.equal((await påDisk(minKatalog)).jobber.length, 1);

  const før = skrivinger();
  Lagring.lagre([rad({ selskap: "Enda en endring" })]);
  await Lagring.nåMedEnGang();
  assert.equal(skrivinger(), før);
});

test("fem avviste kall gir én port, ikke fem", async t => {
  const { Lagring, porter, glemKapsel, stopp } = await start();
  t.after(stopp);

  await Lagring.hent();
  glemKapsel();
  for(let i = 0; i < 5; i++)
    assert.equal((await Lagring.hent().then(() => null, e => e))?.utlogget, true);

  assert.equal(porter.length, 1);
});

test("en henting på en død økt sperrer lagringen i stedet for å tømme filen", async t => {
  const { Lagring, minKatalog, glemKapsel, stopp } = await start();
  t.after(stopp);

  await Lagring.hent();
  Lagring.lagre([rad()]);
  await Lagring.nåMedEnGang();

  glemKapsel();
  const feil = await Lagring.hent().then(() => null, e => e);
  assert.equal(feil.utlogget, true);
  assert.equal(Lagring.erBlokkert(), true);

  Lagring.lagre([]);
  await Lagring.nåMedEnGang();
  assert.equal((await påDisk(minKatalog)).jobber.length, 1);
});

test("gjeninnlogging som samme bruker: den ulagrede endringen blir skrevet", async t => {
  const { Lagring, minKatalog, glemKapsel, stopp } = await start();
  t.after(stopp);

  await Lagring.hent();
  Lagring.lagre([rad()]);
  await Lagring.nåMedEnGang();

  glemKapsel();
  Lagring.lagre([rad(), rad({ id: "a2", selskap: "Cognite" })]);
  await Lagring.nåMedEnGang();
  assert.equal(Lagring.harUlagret(), true);

  const igjen = await Økt.loggInn({ epost: "ola@example.no", passord: PASSORD });
  assert.equal(igjen.ok, true);

  const ulagret = Lagring.harUlagret();
  await Lagring.hent({ beholdVentende: ulagret });
  Lagring.frigi();
  Lagring.prøvIgjen();
  await vent(Lagring, "lagret");

  assert.deepEqual((await påDisk(minKatalog)).jobber.map(r => r.id), ["a1", "a2"]);
});

test("gjeninnlogging som en annen bruker skriver ikke den forriges endring inn i den nyes fil", async t => {
  const { Lagring, minKatalog, katalogFor, glemKapsel, hendelse, skrivinger, stopp } = await start();
  t.after(stopp);

  await Lagring.hent();
  Lagring.lagre([rad()]);
  await Lagring.nåMedEnGang();

  const kari = await Økt.registrer({ epost: "kari@example.no", passord: ANNET_PASSORD });
  assert.equal(kari.ok, true);
  const hennes = await fetch("/api/jobber", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ versjon: 0, jobber: [rad({ id: "k1", selskap: "Karis søknad" })] })
  });
  assert.equal((await hennes.json()).versjon, Lagring.gjeldendeVersjon());
  assert.equal((await Økt.loggInn({ epost: "ola@example.no", passord: PASSORD })).ok, true);

  glemKapsel();
  Lagring.lagre([rad(), rad({ id: "a2", selskap: "Olas hemmelige søknad" })]);
  await Lagring.nåMedEnGang();
  assert.equal(Lagring.harUlagret(), true);

  assert.equal((await Økt.loggInn({ epost: "kari@example.no", passord: ANNET_PASSORD })).ok, true);

  const før = skrivinger();
  Lagring.lagre([rad(), rad({ id: "a2", selskap: "Olas hemmelige søknad" })]);
  hendelse("pagehide");
  hendelse("visibilitychange", "hidden");
  await Lagring.nåMedEnGang(true);

  assert.equal(skrivinger(), før, "ingen skriving skal sendes mens sperren står");
  assert.deepEqual((await påDisk(katalogFor(kari.bruker.id))).jobber.map(r => r.selskap),
    ["Karis søknad"], "Olas endring hører ikke hjemme i Karis fil");
  assert.equal((await påDisk(minKatalog)).jobber.length, 1);
});

test("en annen fane skrev mens økten var borte: den skrivingen skal ikke overskrives stille", async t => {
  const { Lagring, minKatalog, glemKapsel, stopp } = await start();
  t.after(stopp);

  await Lagring.hent();
  Lagring.lagre([rad()]);
  await Lagring.nåMedEnGang();

  glemKapsel();
  Lagring.lagre([rad({ selskap: "Min fane" })]);
  await Lagring.nåMedEnGang();
  assert.equal(Lagring.harUlagret(), true);

  const igjen = await Økt.loggInn({ epost: "ola@example.no", passord: PASSORD });
  assert.equal(igjen.ok, true);

  const annen = await fetch("/api/jobber", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ versjon: 1, jobber: [rad(), rad({ id: "a2", selskap: "Annen fane" })] })
  });
  assert.equal(annen.status, 200);

  const ulagret = Lagring.harUlagret();
  await Lagring.hent({ beholdVentende: ulagret });
  Lagring.frigi();
  Lagring.prøvIgjen();
  await Promise.race([vent(Lagring, "lagret"), vent(Lagring, "konflikt")]);

  assert.deepEqual((await påDisk(minKatalog)).jobber.map(r => r.selskap),
    ["Equinor", "Annen fane"]);
});

const importmodulen = () => import("../../src/import/import.js");

test("importen melder fra om økten på samme måte som lagringen", async t => {
  const { porter, glemKapsel, stopp } = await start();
  t.after(stopp);

  glemKapsel();
  const { importerFraLenke } = await importmodulen();
  const feil = await importerFraLenke("https://example.com/jobb").then(() => null, e => e);
  assert.equal(feil.navn, "utlogget");
  assert.equal(porter.length, 1);
});

