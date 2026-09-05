import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  lesIdentifikator, appdatakatalog, standardKatalog, velgKatalog,
  sikreKatalog, beskjedOmGammelData, PROSJEKTDATA, TAURI_KONFIG
} from "./katalog.mjs";
import { lagServer } from "./server.mjs";
import { lagBrukere, BRUKERKATALOG } from "./brukere.mjs";
import { REGISTERFIL } from "../src/brukerlogikk.mjs";
import { FILNAVN } from "../src/lagerlogikk.mjs";

/* ============================================================
   Hvor dataene ligger.

   Serveren og Mac-appen deler katalog nå, og den katalogen er
   appens: ~/Library/Application Support/<identifikator>/. Testene
   her holder Node på nøyaktig samme regnestykke som Tauris
   app_data_dir(), og passer på at DATA_KATALOG fortsatt vinner.

   Ingen test tar veien om den ekte katalogen eller data/ i
   prosjektet: identifikatoren leses fra konfigfilen (kildekode,
   ikke data), alt annet er mkdtemp og injiserte verdier.
   ============================================================ */

const ROT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tomKatalog = () => fs.mkdtemp(path.join(os.tmpdir(), "jobber-katalog-"));

/* ---------- identifikatoren, ett sted ---------- */

test("identifikatoren leses fra tauri.conf.json, ikke fra en kopi i koden", async () => {
  const konf = JSON.parse(await fs.readFile(TAURI_KONFIG, "utf8"));
  assert.equal(lesIdentifikator(), konf.identifier);
  assert.equal(lesIdentifikator(), "no.nordli.jobbsoknader");
});

test("en identifikator vi ikke forstår gir ingen sti", async () => {
  const k = await tomKatalog();
  const skriv = async verdi => {
    const sti = path.join(k, "tauri.conf.json");
    await fs.writeFile(sti, JSON.stringify({ identifier: verdi }));
    return sti;
  };

  for(const dårlig of ["", "..", ".", "../../etc", "no.nordli/jobb", "a\\b", "a b", 42, null]){
    const sti = await skriv(dårlig);
    assert.throws(() => lesIdentifikator(sti), /DATA_KATALOG/,
      `${JSON.stringify(dårlig)} skulle vært avvist`);
  }
});

test("borte eller ødelagt konfigfil sier hva man skal gjøre, og gjetter ikke", async () => {
  const k = await tomKatalog();
  assert.throws(() => lesIdentifikator(path.join(k, "finnes-ikke.json")), /DATA_KATALOG/);
  const ugyldig = path.join(k, "tauri.conf.json");
  await fs.writeFile(ugyldig, "{ikke json");
  assert.throws(() => lesIdentifikator(ugyldig), /gyldig JSON/);
});

/* ---------- stien per plattform ---------- */

const ID = "no.nordli.jobbsoknader";

test("macOS: samme sti som Tauris app_data_dir()", () => {
  assert.equal(
    appdatakatalog({ identifikator: ID, plattform: "darwin", hjem: "/Users/ola", miljø: {} }),
    "/Users/ola/Library/Application Support/no.nordli.jobbsoknader");
});

test("standardKatalog setter sammen konfigfil og plattform", () => {
  assert.equal(standardKatalog({ plattform: "darwin", hjem: "/Users/ola", miljø: {} }),
    `/Users/ola/Library/Application Support/${ID}`);
});

test("andre plattformer krasjer ikke, og følger dirs::data_dir()", () => {
  assert.equal(appdatakatalog({ identifikator: ID, plattform: "linux",
                                hjem: "/home/ola", miljø: {} }),
    `/home/ola/.local/share/${ID}`);
  assert.equal(appdatakatalog({ identifikator: ID, plattform: "linux", hjem: "/home/ola",
                                miljø: { XDG_DATA_HOME: "/data/ola" } }),
    `/data/ola/${ID}`);
  /* Relativ XDG_DATA_HOME er ikke en katalog vi kan stole på. */
  assert.equal(appdatakatalog({ identifikator: ID, plattform: "linux", hjem: "/home/ola",
                                miljø: { XDG_DATA_HOME: "relativ" } }),
    `/home/ola/.local/share/${ID}`);
  assert.equal(appdatakatalog({ identifikator: ID, plattform: "freebsd",
                                hjem: "/home/ola", miljø: {} }),
    `/home/ola/.local/share/${ID}`);
  assert.equal(appdatakatalog({ identifikator: ID, plattform: "win32", hjem: "C:\\Users\\Ola",
                                miljø: { APPDATA: "C:\\Users\\Ola\\AppData\\Roaming" } }),
    path.join("C:\\Users\\Ola\\AppData\\Roaming", ID));
});

test("uten hjemmekatalog nektes det, i stedet for å lande i cwd", () => {
  assert.throws(() => appdatakatalog({ identifikator: ID, plattform: "darwin",
                                       hjem: "", miljø: {} }), /DATA_KATALOG/);
});

/* ---------- DATA_KATALOG overstyrer, som før ---------- */

test("rekkefølgen: kallstedet, så DATA_KATALOG, så standarden", () => {
  const std = { plattform: "darwin", hjem: "/Users/ola", miljø: {} };

  assert.equal(velgKatalog({ ...std, katalog: "/et/valg" }), "/et/valg");
  assert.equal(velgKatalog({ ...std, katalog: "/et/valg",
                             miljø: { DATA_KATALOG: "/fra/miljo" } }), "/et/valg");
  assert.equal(velgKatalog({ ...std, miljø: { DATA_KATALOG: "/fra/miljo" } }), "/fra/miljo");
  assert.equal(velgKatalog(std), `/Users/ola/Library/Application Support/${ID}`);
});

test("DATA_KATALOG fra det ekte miljøet virker uten at noe injiseres", () => {
  const før = process.env.DATA_KATALOG;
  process.env.DATA_KATALOG = "/fra/ekte/miljo";
  try{ assert.equal(velgKatalog(), "/fra/ekte/miljo"); }
  finally{
    if(før === undefined) delete process.env.DATA_KATALOG; else process.env.DATA_KATALOG = før;
  }
});

test("serveren tar katalogen fra DATA_KATALOG og lager den hvis den mangler", async t => {
  const rot = await tomKatalog();
  const ny  = path.join(rot, "finnes", "ikke", "ennå");
  const før = process.env.DATA_KATALOG;
  process.env.DATA_KATALOG = ny;

  let tjener;
  try{
    tjener = lagServer({ brukere: lagBrukere({ katalog: ny, iterasjoner: 1 }) });
  }finally{
    if(før === undefined) delete process.env.DATA_KATALOG; else process.env.DATA_KATALOG = før;
  }
  assert.ok(await fs.stat(ny), "katalogen skal være opprettet");

  await new Promise(r => tjener.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => tjener.close(() => r())));
  const port = tjener.address().port;

  const svar = await fetch(`http://127.0.0.1:${port}/api/registrer`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ epost: "ola@example.no", passord: "et-godt-nok-passord" })
  });
  assert.equal(svar.status, 201);
  assert.ok(await fs.stat(path.join(ny, REGISTERFIL)), "registeret skal ligge i DATA_KATALOG");
});

test("sikreKatalog sier fra i stedet for å kaste en systemfeil videre", async () => {
  const rot = await tomKatalog();
  const fil = path.join(rot, "en-fil");
  await fs.writeFile(fil, "");
  assert.throws(() => sikreKatalog(path.join(fil, "under")), /DATA_KATALOG/);
});

/* ---------- beskjeden om data som ble liggende igjen ---------- */

async function oppsett(){
  const rot = await tomKatalog();
  const ny = path.join(rot, "app"), gammel = path.join(rot, "prosjekt-data");
  await fs.mkdir(ny); await fs.mkdir(gammel);
  return { ny, gammel };
}

test("beskjeden kommer når den nye katalogen er tom og data/ ikke er det", async () => {
  const { ny, gammel } = await oppsett();
  await fs.writeFile(path.join(gammel, REGISTERFIL), "{}");

  const b = beskjedOmGammelData({ katalog: ny, prosjektdata: gammel });
  assert.ok(b, "beskjeden skulle kommet");
  assert.ok(b.includes(gammel), "den må si hvor dataene ligger");
  assert.ok(b.includes(ny), "den må si hvor de skal");
  assert.match(b, /Flytt/, "den må si at de må flyttes");
});

test("bare en gammel jobber.json holder — en konto trenger ikke ha rukket å bli laget", async () => {
  const { ny, gammel } = await oppsett();
  await fs.writeFile(path.join(gammel, FILNAVN), "{}");
  assert.ok(beskjedOmGammelData({ katalog: ny, prosjektdata: gammel }));
});

test("ingen beskjed når den nye katalogen alt har et register", async () => {
  const { ny, gammel } = await oppsett();
  await fs.writeFile(path.join(gammel, REGISTERFIL), "{}");
  await fs.writeFile(path.join(ny, REGISTERFIL), "{}");
  assert.equal(beskjedOmGammelData({ katalog: ny, prosjektdata: gammel }), null);
});

test("ingen beskjed når data/ er tom eller borte", async () => {
  const { ny, gammel } = await oppsett();
  assert.equal(beskjedOmGammelData({ katalog: ny, prosjektdata: gammel }), null);
  assert.equal(beskjedOmGammelData({ katalog: ny, prosjektdata: path.join(gammel, "borte") }), null);
});

test("ingen beskjed når katalogen er data/ selv — da er dataene alt der de skal", async () => {
  const { gammel } = await oppsett();
  await fs.writeFile(path.join(gammel, FILNAVN), "{}");
  assert.equal(beskjedOmGammelData({ katalog: gammel, prosjektdata: gammel }), null);
  assert.equal(beskjedOmGammelData({ katalog: gammel + path.sep, prosjektdata: gammel }), null);
});

test("PROSJEKTDATA peker på data/ i prosjektet, og leses aldri", () => {
  assert.equal(PROSJEKTDATA, path.join(ROT, "data"));
  /* Sjekken er en existsSync på et filnavn, aldri en lesing.
     Den injiserte varianten viser at ingenting annet trengs. */
  const spor = [];
  beskjedOmGammelData({ katalog: "/ny", prosjektdata: "/gammel",
                        finnes: p => { spor.push(p); return false; } });
  assert.deepEqual(spor, [path.join("/ny", REGISTERFIL), path.join("/gammel", REGISTERFIL),
                          path.join("/gammel", FILNAVN)]);
});

/* ---------- to prosesser, én fil ---------- */
/*
   Én katalog betyr at appen og npm start kan skrive i samme
   jobber.json samtidig. Skrivekøen er per prosess og hjelper ikke
   der. Vernet er versjonssjekken, og den virker fordi filen leses
   på nytt inne i køen — se kommentaren over utfør() i
   src/lagerlogikk.mjs. To lagBrukere-instanser er to prosesser:
   hver sin kø, hver sin lagercache, samme disk.
*/
async function toProsesser(t){
  const katalog = await tomKatalog();
  const lag = async () => {
    const tjener = lagServer({ katalog, brukere: lagBrukere({ katalog, iterasjoner: 1 }) });
    await new Promise(r => tjener.listen(0, "127.0.0.1", r));
    t.after(() => new Promise(r => tjener.close(() => r())));
    return `http://127.0.0.1:${tjener.address().port}`;
  };
  return { katalog, a: await lag(), b: await lag() };
}

const rad = (o = {}) => ({
  id: "a1", selskap: "Equinor", stilling: "Sommerjobb",
  lenke: "https://example.com/jobb", sted: "Stavanger",
  frist: "2026-09-13", status: "todo", sektor: "energi",
  notat: "", sendtDato: null, ...o
});

test("to prosesser deler konto: cookien fra den ene virker i den andre", async t => {
  const { katalog, a, b } = await toProsesser(t);

  const laget = await fetch(`${a}/api/registrer`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ epost: "ola@example.no", passord: "et-godt-nok-passord" })
  });
  assert.equal(laget.status, 201);
  const kake = laget.headers.getSetCookie()[0].split(";")[0];
  const bruker = (await laget.json()).bruker;

  const sett = await fetch(`${b}/api/jobber`, { headers: { cookie: kake } });
  assert.equal(sett.status, 200, "samme register, samme hemmelighet, samme økt");

  const skrev = await fetch(`${b}/api/jobber`, {
    method: "PUT", headers: { "content-type": "application/json", cookie: kake },
    body: JSON.stringify({ jobber: [rad()], versjon: (await sett.json()).versjon })
  });
  assert.equal(skrev.status, 200);

  const påDisk = JSON.parse(await fs.readFile(
    path.join(katalog, BRUKERKATALOG, bruker.id, FILNAVN), "utf8"));
  assert.deepEqual(påDisk.jobber.map(r => r.selskap), ["Equinor"],
    "begge prosessene skriver i samme fil");
});

test("versjonssjekken holder på tvers av prosesser: den utdaterte får 409", async t => {
  const { a, b } = await toProsesser(t);

  const laget = await fetch(`${a}/api/registrer`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ epost: "kari@example.no", passord: "et-godt-nok-passord" })
  });
  const kake = laget.headers.getSetCookie()[0].split(";")[0];

  /* Prosess A leser, prosess B skriver, A skriver på sin gamle versjon. */
  const først = await (await fetch(`${a}/api/jobber`, { headers: { cookie: kake } })).json();

  const bSkrev = await fetch(`${b}/api/jobber`, {
    method: "PUT", headers: { "content-type": "application/json", cookie: kake },
    body: JSON.stringify({ jobber: [rad({ selskap: "Aker BP" })], versjon: først.versjon })
  });
  assert.equal(bSkrev.status, 200);

  const aSkrev = await fetch(`${a}/api/jobber`, {
    method: "PUT", headers: { "content-type": "application/json", cookie: kake },
    body: JSON.stringify({ jobber: [rad({ selskap: "Yara" })], versjon: først.versjon })
  });
  assert.equal(aSkrev.status, 409, "A skrev på en versjon som ikke fantes lenger");

  const konflikt = await aSkrev.json();
  assert.equal(konflikt.versjon, først.versjon + 1);
  assert.deepEqual(konflikt.jobber.map(r => r.selskap), ["Aker BP"],
    "409 gir det som faktisk står på disk, så flaten kan hente på nytt");
});
