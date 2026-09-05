import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lagServer } from "./server.mjs";
import { lagBrukere, BRUKERKATALOG } from "./brukere.mjs";
import * as Økt from "../src/okt.js";

/* ============================================================
   Når økten ryker midt i noe.

   Sperren i lagring.js og økten i okt.js er to mekanismer som må
   passe sammen, og de møtes bare her: en endring som ikke rakk
   fram skal ligge i behold, ingen nye forsøk skal planlegges, og
   porten skal komme opp én gang — ikke én gang per kall.

   Det styggeste dette designet kan gjøre er å skrive den forrige
   brukerens ventende endring inn i den nyes fil. Den har sin egen
   test lenger nede, og den utløser alt som kan utløse en skriving.

   Samme nettleser i miniatyr som i server/flyt.test.mjs: én
   informasjonskapsel, relative stier, de to sidehendelsene. Her
   føres det i tillegg en logg over kallene, fordi «ingen gjentatte
   kall» er halve løftet.
   ============================================================ */

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
  const Lagring = await import("../src/lagring.js?nr=" + (++nr));

  let siste = null;
  Lagring.påTilstand(t => { siste = t; });

  /* Porten, sett fra app.js: én beskjed per bortfall, ikke én per kall. */
  const porter = [];
  const avPort = Økt.påUtlogget(m => porter.push(m));

  return {
    katalog, brukere, Lagring, bruker: konto.bruker, porter,
    katalogFor: id => path.join(katalog, BRUKERKATALOG, id),
    minKatalog: path.join(katalog, BRUKERKATALOG, konto.bruker.id),
    tilstand: () => siste,
    /* Kapselen forsvinner — slettet i utviklerverktøyene, eller utløpt. */
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

/* ---------- bortfallet ---------- */

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

  /* Ingenting skal planlegges på nytt: et forsøk til ville feilet like
     sikkert og bare fylt nettverksfanen. */
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

  /* app.js setter data = [] i denne grenen. Den tomme listen skal ikke
     kunne nå disken. */
  Lagring.lagre([]);
  await Lagring.nåMedEnGang();
  assert.equal((await påDisk(minKatalog)).jobber.length, 1);
});

/* ---------- tilbake igjen ---------- */

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

  /* Nøyaktig de fire stegene gjenoppta() i app.js tar. */
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

  /* Kari finnes fra før og har sin egen liste — på samme versjonstall som
     Olas. Uten det ville en feilsendt skriving blitt stoppet av
     versjonssjekken ved et lykketreff, og testen ikke sagt noe om sperren. */
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

  /* app.js laster siden på nytt her. Fram til den rekker det, skal alt
     som kan utløse en skriving møte sperren. */
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

  /* Den andre fanen var innlogget hele tiden og rakk å skrive. */
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

  /* Den ventende endringen ble laget mot versjon 1 og kjenner ikke
     raden den andre fanen la til. Skrives den likevel, er raden borte. */
  assert.deepEqual((await påDisk(minKatalog)).jobber.map(r => r.selskap),
    ["Equinor", "Annen fane"]);
});

/* ---------- de andre kallene som kan møte en 401 ---------- */

/* import.js drar med seg lagring.js, som krever addEventListener ved
   innlasting. Derfor lastes den her og ikke i toppen: statiske
   importer kjører før nettleseren i miniatyr er satt opp. */
const importmodulen = () => import("../src/import.js");

test("importen melder fra om økten på samme måte som lagringen", async t => {
  const { porter, glemKapsel, stopp } = await start();
  t.after(stopp);

  glemKapsel();
  const { importerFraLenke } = await importmodulen();
  const feil = await importerFraLenke("https://example.com/jobb").then(() => null, e => e);
  assert.equal(feil.navn, "utlogget");
  assert.equal(porter.length, 1);
});

test("importtallene er en opplysning, ikke en handling — en 401 der reiser ingen port", async t => {
  const { porter, glemKapsel, stopp } = await start();
  t.after(stopp);

  glemKapsel();
  const { importtall } = await importmodulen();
  assert.equal(await importtall(), null);
  assert.equal(porter.length, 0);
});
