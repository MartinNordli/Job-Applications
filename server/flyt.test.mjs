import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lagServer } from "./server.mjs";
import { lagBrukere, BRUKERKATALOG } from "./brukere.mjs";
import { ER_SENDT, ER_ARKIV } from "../src/felles.mjs";
import * as Økt from "../src/okt.js";

/* ============================================================
   De vanlige flytene — det en person faktisk gjør, hele veien
   fra src/lagring.js til brukerens egen jobber.json på disk.

   Alt dette virket før flerbruker. Spørsmålet testene her stiller
   er om det virker nå, når hver bruker har sin egen katalog og
   hvert kall går gjennom en økt.

   Klientlaget er skrevet for en nettleser, så det får en: én
   informasjonskapsel, relative stier og de to sidehendelsene
   lagring.js henger seg på. Alt annet er ekte — ekte server,
   ekte lager, ekte fil.
   ============================================================ */

/* Nettleseren i miniatyr. `addEventListener` finnes ikke i Node, og
   lagring.js kaller den ved innlasting; hendelsene tas vare på så en
   test kan utløse dem selv. */
const sidehendelser = new Map();
globalThis.addEventListener = (navn, fn) => {
  if(!sidehendelser.has(navn)) sidehendelser.set(navn, []);
  sidehendelser.get(navn).push(fn);
};
globalThis.document = { visibilityState: "visible" };

/* Én informasjonskapsel og relative stier, som i en fane. Uten
   kapselen ville hvert kall fra lagring.js møtt 401, og uten
   basen ville en relativ sti ikke vært en adresse i det hele tatt. */
const ekteFetch = globalThis.fetch;
let base = null, kake = null;
globalThis.fetch = async (sti, valg = {}) => {
  const adresse = typeof sti === "string" && sti.startsWith("/") ? base + sti : sti;
  const hoder = { ...(valg.headers || {}) };
  if(kake) hoder.cookie = kake;
  const svar = await ekteFetch(adresse, { ...valg, headers: hoder });
  for(const s of svar.headers.getSetCookie()){
    const par = s.split(";")[0];
    kake = par.endsWith("=") ? null : par;      /* Max-Age=0 tømmer den */
  }
  return svar;
};

const PASSORD = "et-godt-nok-passord";

/* lagring.js har tilstand i closuren — versjon, sperre, det som venter.
   Derfor lastes den på nytt per test med en spørrestreng; uten det
   ville forrige tests versjon lekket inn i neste. */
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
  const Lagring = await import("../src/lagring.js?nr=" + (++nr));

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

/* Venter på at stripa faktisk sier det den skal, i stedet for å sove.
   Lagringen melder fra ved hver overgang, så det er den vi lytter på. */
function vent(Lagring, navn){
  return new Promise(ok => {
    let av = null, ferdig = false;
    const se = t => { if(t.navn !== navn || ferdig) return; ferdig = true; if(av) av(); ok(t); };
    av = Lagring.påTilstand(se);
    if(ferdig) av();
  });
}

/* ---------- legge til, endre, bytte status ---------- */

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
  /* Rota er migreringskilden. Den skal ikke få nye rader stille lagt i seg. */
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

/* ---------- listens ytterkanter ---------- */

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

/* ---------- når det går galt ---------- */

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

  /* Den andre fanen er samme bruker, samme kapsel, eget PUT. */
  await fetch("/api/jobber", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ versjon: 1, jobber: [rad({ selskap: "Annen fane" })] })
  });

  Lagring.lagre([rad({ selskap: "Min fane" })]);
  await Lagring.nåMedEnGang();
  assert.equal(tilstand().navn, "konflikt");
  assert.equal(Lagring.erBlokkert(), true);
  assert.equal((await påDisk(minKatalog)).jobber[0].selskap, "Annen fane");

  /* Neste tastetrykk skal ikke slippe forbi sperren. */
  Lagring.lagre([rad({ selskap: "Min fane igjen" })]);
  await Lagring.nåMedEnGang();
  assert.equal((await påDisk(minKatalog)).jobber[0].selskap, "Annen fane");

  /* Å hente på nytt er veien videre — og bare den. */
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

  /* Samme tre stegene som «Hent inn sikkerhetskopien» i skuffen gjør. */
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
