import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lagServer } from "../../server/server.mjs";
import { lagBrukere, BRUKERKATALOG } from "../../server/brukere.mjs";
import { ER_SENDT, ER_ARKIV } from "../../src/felles/felles.mjs";
import * as Økt from "../../src/konto/okt.js";

const sidehendelser = new Map();
globalThis.addEventListener = (navn, fn) => {
  if(!sidehendelser.has(navn)) sidehendelser.set(navn, []);
  sidehendelser.get(navn).push(fn);
};
globalThis.document = { visibilityState: "visible" };

const ekteFetch = globalThis.fetch;
let base = null, kake = null;
globalThis.fetch = async (sti, valg = {}) => {
  const adresse = typeof sti === "string" && sti.startsWith("/") ? base + sti : sti;
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

let nr = 0;

async function start(){
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "jobber-flyt-"));
  const brukere = lagBrukere({ katalog, iterasjoner: 1 });
  const tjener  = lagServer({ katalog, brukere });
  await new Promise(r => tjener.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${tjener.address().port}`;
  kake = null;

  const konto = await Økt.registrer({ epost: "ola@example.no", passord: PASSORD });
  assert.equal(konto.ok, true, "kontoen må opprettes før flyten kan kjøres");

  sidehendelser.clear();
  const Lagring = await import("../../src/soknader/lagring.js?nr=" + (++nr));

  let siste = null;
  Lagring.påTilstand(t => { siste = t; });

  return {
    katalog, brukere, tjener, Lagring, bruker: konto.bruker,
    port: tjener.address().port,
    minKatalog: path.join(katalog, BRUKERKATALOG, konto.bruker.id),
    tilstand: () => siste,
    hendelse: navn => (sidehendelser.get(navn) || []).forEach(fn => fn()),
    stopp: () => new Promise(r => tjener.close(() => r()))
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

test("en ny søknad havner i brukerens egen fil, og rotkatalogen røres ikke", async t => {
  const { Lagring, minKatalog, katalog, stopp } = await start();
  t.after(stopp);

  await Lagring.hent();
  Lagring.lagre([rad()]);
  await Lagring.nåMedEnGang();

  assert.equal(Lagring.gjeldendeVersjon(), 1);
  assert.equal(Lagring.harUlagret(), false);

  const dok = await påDisk(minKatalog);
  assert.equal(dok.jobber.length, 1);
  assert.equal(dok.jobber[0].selskap, "Equinor");
  assert.equal(await finnes(path.join(katalog, "jobber.json")), false);
});

test("å redigere en søknad beholder opprettet-tiden og teller versjonen ett opp", async t => {
  const { Lagring, minKatalog, stopp } = await start();
  t.after(stopp);

  await Lagring.hent();
  Lagring.lagre([rad()]);
  await Lagring.nåMedEnGang();
  const opprettet = (await påDisk(minKatalog)).jobber[0].opprettet;

  Lagring.lagre([rad({ stilling: "Fast stilling", notat: "ringte på fredag" })]);
  await Lagring.nåMedEnGang();

  const dok = await påDisk(minKatalog);
  assert.equal(dok.versjon, 2);
  assert.equal(dok.jobber.length, 1);
  assert.equal(dok.jobber[0].stilling, "Fast stilling");
  assert.equal(dok.jobber[0].opprettet, opprettet);
});

test("statusbytte til sendt tar med sendtDato, og arkivering overlever rundturen", async t => {
  const { Lagring, minKatalog, stopp } = await start();
  t.after(stopp);

  await Lagring.hent();
  Lagring.lagre([rad()]);
  await Lagring.nåMedEnGang();

  Lagring.lagre([rad({ status: "sent", sendtDato: "2026-09-05" })]);
  await Lagring.nåMedEnGang();
  let dok = await påDisk(minKatalog);
  assert.equal(ER_SENDT(dok.jobber[0].status), true);
  assert.equal(dok.jobber[0].sendtDato, "2026-09-05");

  Lagring.lagre([rad({ status: "rejected", sendtDato: "2026-09-05" })]);
  await Lagring.nåMedEnGang();
  dok = await påDisk(minKatalog);
  assert.equal(ER_ARKIV(dok.jobber[0].status), true);
  assert.equal(dok.jobber[0].sendtDato, "2026-09-05",
    "sendtDato hører til søknaden, ikke til statusen den har nå");
});

test("et intervju blir stående når søknaden senere får avslag", async t => {
  const { Lagring, minKatalog, stopp } = await start();
  t.after(stopp);

  await Lagring.hent();
  Lagring.lagre([rad({ status: "interview", sendtDato: "2026-09-05" })]);
  await Lagring.nåMedEnGang();
  let dok = await påDisk(minKatalog);
  assert.equal(dok.jobber[0].intervju, true);

  Lagring.lagre([{ ...dok.jobber[0], status: "rejected" }]);
  await Lagring.nåMedEnGang();
  dok = await påDisk(minKatalog);
  assert.equal(dok.jobber[0].status, "rejected");
  assert.equal(dok.jobber[0].intervju, true, "intervjuet hører til søknaden, ikke til statusen den har nå");
});

test("å slette og angre gir raden tilbake på sin plass", async t => {
  const { Lagring, minKatalog, stopp } = await start();
  t.after(stopp);

  const liste = [rad({ id: "a1" }),
                 rad({ id: "a2", selskap: "Cognite" }),
                 rad({ id: "a3", selskap: "DNB" })];
  await Lagring.hent();
  Lagring.lagre(liste.slice());
  await Lagring.nåMedEnGang();

  const uten = liste.slice();
  const [fjernet] = uten.splice(1, 1);
  Lagring.lagre(uten.slice());
  await Lagring.nåMedEnGang();
  assert.deepEqual((await påDisk(minKatalog)).jobber.map(r => r.id), ["a1", "a3"]);

  uten.splice(1, 0, fjernet);
  Lagring.lagre(uten.slice());
  await Lagring.nåMedEnGang();
  assert.deepEqual((await påDisk(minKatalog)).jobber.map(r => r.id), ["a1", "a2", "a3"]);
});

test("hundre søknader lagres i én skriving og kommer hele tilbake", async t => {
  const { Lagring, minKatalog, stopp } = await start();
  t.after(stopp);

  const mange = Array.from({ length: 100 },
    (_, i) => rad({ id: "s" + i, selskap: "Selskap " + i }));
  await Lagring.hent();
  Lagring.lagre(mange);
  await Lagring.nåMedEnGang();

  assert.equal(Lagring.gjeldendeVersjon(), 1);
  assert.equal((await påDisk(minKatalog)).jobber.length, 100);

  const igjen = await Lagring.hent();
  assert.equal(igjen.jobber.length, 100);
  assert.equal(igjen.jobber[99].selskap, "Selskap 99");
});

test("et selskapsnavn på tre hundre tegn avvises, og det som lå der står urørt", async t => {
  const { Lagring, minKatalog, tilstand, stopp } = await start();
  t.after(stopp);

  await Lagring.hent();
  Lagring.lagre([rad()]);
  await Lagring.nåMedEnGang();

  Lagring.lagre([rad(), rad({ id: "a2", selskap: "S".repeat(300) })]);
  await Lagring.nåMedEnGang();

  assert.equal(tilstand().navn, "ulagret");
  assert.equal(Lagring.harUlagret(), true, "endringen skal ligge i behold, ikke forsvinne");
  const dok = await påDisk(minKatalog);
  assert.equal(dok.versjon, 1);
  assert.equal(dok.jobber.length, 1);
});

test("en søknad uten frist lagres som null, både fra tomt felt og fra avkrysning", async t => {
  const { Lagring, minKatalog, stopp } = await start();
  t.after(stopp);

  await Lagring.hent();
  Lagring.lagre([rad({ id: "a1", frist: null }), rad({ id: "a2", frist: "" })]);
  await Lagring.nåMedEnGang();

  const dok = await påDisk(minKatalog);
  assert.equal(dok.jobber[0].frist, null);
  assert.equal(dok.jobber[1].frist, null);

  const igjen = await Lagring.hent();
  assert.deepEqual(igjen.jobber.map(r => r.frist), [null, null]);
});

test("serveren er nede: endringen blir liggende, og «prøv igjen» får den fram", async t => {
  const { Lagring, minKatalog, katalog, brukere, tjener, port, tilstand, stopp } = await start();
  t.after(stopp);

  await Lagring.hent();
  Lagring.lagre([rad()]);
  await Lagring.nåMedEnGang();

  await new Promise(r => tjener.close(() => r()));
  Lagring.lagre([rad(), rad({ id: "a2", selskap: "Cognite" })]);
  await Lagring.nåMedEnGang();

  assert.equal(tilstand().navn, "frakoblet");
  assert.equal(Lagring.harUlagret(), true);
  assert.equal((await påDisk(minKatalog)).jobber.length, 1);

  const igjen = lagServer({ katalog, brukere });
  await new Promise(r => igjen.listen(port, "127.0.0.1", r));
  t.after(() => new Promise(r => igjen.close(() => r())));

  Lagring.prøvIgjen();
  await vent(Lagring, "lagret");
  assert.equal((await påDisk(minKatalog)).jobber.length, 2);
  assert.equal(Lagring.harUlagret(), false);
});

test("en annen fane har skrevet: sperren står, og ingenting overskrives", async t => {
  const { Lagring, minKatalog, tilstand, stopp } = await start();
  t.after(stopp);

  await Lagring.hent();
  Lagring.lagre([rad()]);
  await Lagring.nåMedEnGang();

  await fetch("/api/jobber", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ versjon: 1, jobber: [rad({ selskap: "Annen fane" })] })
  });

  Lagring.lagre([rad({ selskap: "Min fane" })]);
  await Lagring.nåMedEnGang();
  assert.equal(tilstand().navn, "konflikt");
  assert.equal(Lagring.erBlokkert(), true);
  assert.equal((await påDisk(minKatalog)).jobber[0].selskap, "Annen fane");

  Lagring.lagre([rad({ selskap: "Min fane igjen" })]);
  await Lagring.nåMedEnGang();
  assert.equal((await påDisk(minKatalog)).jobber[0].selskap, "Annen fane");

  const friskt = await Lagring.hent();
  assert.equal(friskt.jobber[0].selskap, "Annen fane");
  assert.equal(Lagring.erBlokkert(), false);
});

test("en ødelagt datafil sperrer lagringen, og filen blir liggende urørt", async t => {
  const { Lagring, minKatalog, stopp } = await start();
  t.after(stopp);

  await fs.mkdir(minKatalog, { recursive: true });
  await fs.writeFile(path.join(minKatalog, "jobber.json"), "{halv skrevet");

  const feil = await Lagring.hent().then(() => null, e => e);
  assert.ok(feil && feil.ødelagt, "en uleselig fil skal komme som «ødelagt», ikke som frakoblet");
  assert.equal(Lagring.erBlokkert(), true);

  Lagring.lagre([rad()]);
  await Lagring.nåMedEnGang();
  assert.equal(await fs.readFile(path.join(minKatalog, "jobber.json"), "utf8"), "{halv skrevet");
});

test("sikkerhetskopien hentes inn, og den ødelagte filen settes i karantene", async t => {
  const { Lagring, minKatalog, stopp } = await start();
  t.after(stopp);

  await Lagring.hent();
  Lagring.lagre([rad()]);
  await Lagring.nåMedEnGang();
  Lagring.lagre([rad(), rad({ id: "a2", selskap: "Cognite" })]);
  await Lagring.nåMedEnGang();

  await fs.writeFile(path.join(minKatalog, "jobber.json"), "ikke json i det hele tatt");

  const feil = await Lagring.hent().then(() => null, e => e);
  assert.ok(feil && feil.ødelagt);
  assert.equal(feil.sikkerhetskopi.jobber.length, 1, "kopien er dokumentet før siste skriving");

  Lagring.settVersjon(0);
  Lagring.frigi(true);
  Lagring.lagre(feil.sikkerhetskopi.jobber);
  await Lagring.nåMedEnGang();

  const dok = await påDisk(minKatalog);
  assert.equal(dok.jobber.length, 1);
  assert.equal(dok.jobber[0].selskap, "Equinor");
  const igjen = await fs.readdir(minKatalog);
  assert.ok(igjen.some(n => n.startsWith("jobber.ødelagt-")),
    "den uleselige filen skal flyttes til side, aldri skrives over");
});
