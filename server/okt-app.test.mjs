import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lagAppØkt, ØKTNØKKEL } from "../src/okt-app.mjs";
import { lagFiler } from "./lager.mjs";
import { lagBrukere } from "./brukere.mjs";
import { REGISTERFIL, REGISTER_FORRIGE, BRUKERKATALOG, NOKKELFIL,
         tolkHash, erGyldigBrukerId, OKT_LEVETID } from "../src/brukerlogikk.mjs";

/* ============================================================
   Appmodus sin økt — reglene fra src/okt-app.mjs, kjørt i Node.

   Modulen har ingen Tauri i seg: den får `filerFor` og `minne`
   utenfra. Her er filerFor server/lager.mjs pekt på nøyaktig de
   katalogene bruker_katalog() i Rust ville pekt på — <katalog> for
   None og <katalog>/brukere/<id> for Some(id) — så det som testes
   er de samme stiene appen bruker.

   Iterasjonstallet senkes til 1: det som testes er reglene, ikke
   PBKDF2. Ett tilfelle nede går motsatt vei og logger inn på en
   hash server/brukere.mjs har skrevet, som er det som holder de to
   modiene på samme format.
   ============================================================ */

const PASSORD = "et-godt-nok-passord";
const konto = (o = {}) => ({ epost: "ola@example.no", navn: "Ola", passord: PASSORD, ...o });

/* Et minne som localStorage: bare de tre metodene modulen bruker. */
function lagMinne(){
  const kart = new Map();
  return {
    getItem: n => (kart.has(n) ? kart.get(n) : null),
    setItem: (n, v) => kart.set(n, String(v)),
    removeItem: n => kart.delete(n),
    get størrelse(){ return kart.size; }
  };
}

/* Samme oppdeling som bruker_katalog() i src-tauri/src/lib.rs. */
const filerFor = katalog => bruker =>
  lagFiler(bruker ? path.join(katalog, BRUKERKATALOG, bruker) : katalog);

async function nytt(valg = {}){
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "jobber-appokt-"));
  const minne = lagMinne();
  const økt = lagAppØkt({ filerFor: filerFor(katalog), minne, iterasjoner: 1, ...valg });
  return { katalog, minne, økt, påNytt: v => lagAppØkt({ filerFor: filerFor(katalog), minne,
                                                         iterasjoner: 1, ...v }) };
}

const finnes = async p => !!(await fs.stat(p).catch(() => null));
const les = (katalog, ...deler) => fs.readFile(path.join(katalog, ...deler), "utf8");

/* Rehashen legges i skrivekøen etter at innloggingen har svart, så den
   er ikke ferdig når kallet er det. Et fast antall millisekunder er en
   gjetning som ryker når maskinen er travel; her ventes det på filen. */
async function ventPåIterasjoner(katalog, iterasjoner){
  for(let i = 0; i < 400; i++){
    const h = JSON.parse(await les(katalog, REGISTERFIL)).brukere[0].hash;
    if(tolkHash(h).iterasjoner === iterasjoner) return h;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error(`hashen ble aldri skrevet om til ${iterasjoner} iterasjoner`);
}

/* ---------- registrering ---------- */

test("første registrering gir en økt, en id og en profil i registeret", async () => {
  const { katalog, minne, økt } = await nytt();

  const r = await økt.registrer(konto());
  assert.equal(r.ok, true);
  assert.equal(r.erFørste, true);
  assert.ok(erGyldigBrukerId(r.bruker.id));
  /* Aldri mer enn dette om en konto. */
  assert.deepEqual(Object.keys(r.bruker).sort(), ["epost", "id", "navn"]);

  const dok = JSON.parse(await les(katalog, REGISTERFIL));
  assert.equal(dok.versjon, 1);
  assert.equal(dok.brukere.length, 1);
  assert.ok(tolkHash(dok.brukere[0].hash).ok);
  assert.equal(dok.brukere[0].generasjon, 1);

  const lagret = JSON.parse(minne.getItem(ØKTNØKKEL));
  assert.equal(lagret.id, r.bruker.id);
  assert.ok(lagret.utløper > Math.floor(Date.now() / 1000));
  /* Ingen signatur — se hodet i okt-app.mjs. Bare id og utløp. */
  assert.deepEqual(Object.keys(lagret).sort(), ["id", "utløper"]);
});

test("passordet ligger aldri i registeret, og hashen er ikke passordet", async () => {
  const { katalog, økt } = await nytt();
  await økt.registrer(konto());
  const rå = await les(katalog, REGISTERFIL);
  assert.ok(!rå.includes(PASSORD), "passordet står i registeret");
});

test("duplikat e-post avvises, også med annen skrivemåte", async () => {
  const { økt } = await nytt();
  assert.equal((await økt.registrer(konto())).ok, true);

  const to = await økt.registrer(konto({ epost: "OLA@Example.NO" }));
  assert.equal(to.ok, false);
  assert.equal(to.feil, "finnes");
});

test("to samtidige registreringer på samme adresse: nøyaktig én lykkes", async () => {
  const { katalog, økt } = await nytt();
  const svar = await Promise.all([økt.registrer(konto()), økt.registrer(konto())]);

  assert.equal(svar.filter(s => s.ok).length, 1);
  assert.equal(svar.find(s => !s.ok).feil, "finnes");
  assert.equal(JSON.parse(await les(katalog, REGISTERFIL)).brukere.length, 1);
});

test("for kort passord og ugyldig adresse gir «ugyldig» med feltnavn", async () => {
  const { økt } = await nytt();
  const r = await økt.registrer(konto({ passord: "kort", epost: "ikke-en-adresse" }));
  assert.equal(r.ok, false);
  assert.equal(r.feil, "ugyldig");
  assert.deepEqual(r.detaljer.map(d => d.felt).sort(), ["epost", "passord"]);
});

/* ---------- migreringen ---------- */

test("den gamle enbrukerfilen tilfaller første profil, og originalen er urørt", async () => {
  const { katalog, økt } = await nytt();
  const rot = lagFiler(katalog);
  await rot.skrivAtomisk("jobber.json", '{"versjon":25,"jobber":[{"id":"a"}]}\n');
  await rot.skrivAtomisk("jobber.forrige.json", '{"versjon":24,"jobber":[]}\n');
  await rot.skrivAtomisk("importlogg.jsonl", '{"tid":"i går"}\n');
  await rot.skrivAtomisk(NOKKELFIL, "sk-ant-noe-som-ligner-en-nokkel\n");
  const før = await Promise.all(["jobber.json", "jobber.forrige.json", "importlogg.jsonl", NOKKELFIL]
    .map(n => les(katalog, n)));

  const r = await økt.registrer(konto());
  assert.deepEqual(r.migrert,
    ["jobber.json", "jobber.forrige.json", "importlogg.jsonl", NOKKELFIL]);

  const min = path.join(katalog, BRUKERKATALOG, r.bruker.id);
  assert.equal(await fs.readFile(path.join(min, "jobber.json"), "utf8"), før[0]);
  assert.equal(await fs.readFile(path.join(min, NOKKELFIL), "utf8"), før[3]);

  /* Kopi, ikke flytting: originalen er sikkerhetskopien vår. */
  const etter = await Promise.all(["jobber.json", "jobber.forrige.json", "importlogg.jsonl", NOKKELFIL]
    .map(n => les(katalog, n)));
  assert.deepEqual(etter, før);
});

test("profil nummer to arver ingenting", async () => {
  const { katalog, økt } = await nytt();
  await lagFiler(katalog).skrivAtomisk("jobber.json", '{"versjon":1,"jobber":[]}\n');

  const en = await økt.registrer(konto());
  const to = await økt.registrer(konto({ epost: "kari@example.no" }));
  assert.equal(to.ok, true);
  assert.equal(to.erFørste, false);
  assert.equal(to.migrert, undefined);

  assert.equal(await finnes(path.join(katalog, BRUKERKATALOG, en.bruker.id, "jobber.json")), true);
  assert.equal(await finnes(path.join(katalog, BRUKERKATALOG, to.bruker.id, "jobber.json")), false);
});

test("uten noe å migrere er registreringen like vellykket", async () => {
  const { økt } = await nytt();
  const r = await økt.registrer(konto());
  assert.equal(r.ok, true);
  assert.equal(r.migrert, undefined);
  assert.equal(r.migreringsfeil, undefined);
});

/* ---------- innlogging ---------- */

test("riktig passord logger inn, feil passord og ukjent adresse gir samme svar", async () => {
  const { minne, økt } = await nytt();
  await økt.registrer(konto());
  minne.removeItem(ØKTNØKKEL);

  const inn = await økt.loggInn({ epost: "ola@example.no", passord: PASSORD });
  assert.equal(inn.ok, true);
  assert.equal(inn.bruker.epost, "ola@example.no");
  assert.equal(inn.erFørste, true);
  assert.ok(minne.getItem(ØKTNØKKEL));

  const feil = await økt.loggInn({ epost: "ola@example.no", passord: "feil-passord-her" });
  const ukjent = await økt.loggInn({ epost: "ingen@example.no", passord: PASSORD });
  assert.equal(feil.feil, "feil-innlogging");
  assert.deepEqual({ ...ukjent }, { ...feil });
});

test("en hash skrevet av Node-siden verifiseres her, og omvendt", async () => {
  /* Det er dette som holder de to modiene på samme format: en konto
     laget av serveren skal kunne logge inn i appen. */
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "jobber-appokt-node-"));
  const brukere = lagBrukere({ katalog, iterasjoner: 1 });
  const laget = await brukere.registrer(konto());
  assert.equal(laget.ok, true);

  const økt = lagAppØkt({ filerFor: filerFor(katalog), minne: lagMinne(), iterasjoner: 1 });
  const inn = await økt.loggInn({ epost: "ola@example.no", passord: PASSORD });
  assert.equal(inn.ok, true, "appen godtok ikke serverens hash");
  assert.equal(inn.bruker.id, laget.bruker.id);

  /* Og motsatt vei: en konto laget i appen logger inn på serveren. */
  const iApp = await økt.registrer(konto({ epost: "kari@example.no" }));
  assert.equal(iApp.ok, true);
  const tilbake = await brukere.loggInn({ epost: "kari@example.no", passord: PASSORD });
  assert.equal(tilbake.ok, true, "serveren godtok ikke appens hash");
});

test("en for svak hash skrives om ved neste innlogging", async () => {
  const { katalog, økt, påNytt } = await nytt();
  await økt.registrer(konto());
  const før = JSON.parse(await les(katalog, REGISTERFIL)).brukere[0].hash;
  assert.equal(tolkHash(før).iterasjoner, 1);

  /* Samme register, men nå med dagens innstilling. */
  const strengere = påNytt({ iterasjoner: 3 });
  assert.equal((await strengere.loggInn({ epost: "ola@example.no", passord: PASSORD })).ok, true);

  const etter = await ventPåIterasjoner(katalog, 3);
  assert.notEqual(etter, før);
  assert.equal((await strengere.loggInn({ epost: "ola@example.no", passord: PASSORD })).ok, true);
});

/* ---------- økten ---------- */

test("økten overlever at appen startes på nytt", async () => {
  const { økt, påNytt } = await nytt();
  const r = await økt.registrer(konto());

  const etterOmstart = påNytt();
  const status = await etterOmstart.hentØkt();
  assert.equal(status.innlogget, true);
  assert.equal(status.bruker.id, r.bruker.id);
  assert.equal(status.erFørste, true);
  assert.equal(status.harNokkel, false);
});

test("utløpt økt er ingen økt", async () => {
  const { minne, økt } = await nytt();
  await økt.registrer(konto());

  const om40dager = () => new Date(Date.now() + 40 * 24 * 3600 * 1000);
  const senere = lagAppØkt({ filerFor: filerFor("/finnes-ikke"), minne, nå: om40dager,
                             iterasjoner: 1 });
  /* Utløpet avgjøres uten å røre filsystemet — derfor holder det med
     en katalog som ikke finnes her. */
  assert.equal(OKT_LEVETID, 30 * 24 * 3600);
  assert.equal((await senere.hentØkt()).innlogget, false);
});

test("økt for en profil som ikke finnes ryddes bort", async () => {
  const { katalog, minne, økt } = await nytt();
  await økt.registrer(konto());
  /* Registeret redigeres for hånd — det er dokumentert som veien ut
     hvis noen glemmer passordet sitt. */
  await lagFiler(katalog).skrivAtomisk(REGISTERFIL,
    JSON.stringify({ versjon: 1, brukere: [] }));

  assert.equal((await økt.hentØkt()).innlogget, false);
  assert.equal(minne.getItem(ØKTNØKKEL), null, "økten ble liggende igjen");
});

test("utlogging glemmer økten, men rører ikke registeret", async () => {
  const { katalog, minne, økt } = await nytt();
  await økt.registrer(konto());
  const før = await les(katalog, REGISTERFIL);

  assert.deepEqual(await økt.loggUt({ allePlasser: true }), { ok: true });
  assert.equal(minne.getItem(ØKTNØKKEL), null);
  assert.equal(await les(katalog, REGISTERFIL), før);
});

test("tomt register betyr «ingen profiler ennå», ikke en feil", async () => {
  const { økt } = await nytt();
  assert.deepEqual(await økt.hentØkt(), { innlogget: false, harBrukere: false });
});

/* ---------- et register vi ikke forstår ---------- */

test("ødelagt register blir liggende urørt, og ingenting skrives over det", async () => {
  const { katalog, økt } = await nytt();
  await lagFiler(katalog).skrivAtomisk(REGISTERFIL, "{ikke json");

  const status = await økt.hentØkt();
  assert.equal(status.innlogget, false);
  assert.equal(status.harBrukere, true);
  assert.equal(status.ødelagt, true);
  assert.match(status.melding, /brukere\.json/);

  const r = await økt.registrer(konto());
  assert.equal(r.feil, "ødelagt-register");
  assert.equal(await les(katalog, REGISTERFIL), "{ikke json", "den ødelagte filen ble skrevet over");
});

test("et register fra en nyere versjon røres ikke", async () => {
  const { katalog, økt } = await nytt();
  await lagFiler(katalog).skrivAtomisk(REGISTERFIL,
    JSON.stringify({ versjon: 99, brukere: [] }));

  assert.equal((await økt.hentØkt()).ødelagt, true);
  assert.equal((await økt.registrer(konto())).feil, "ødelagt-register");
  assert.match(await les(katalog, REGISTERFIL), /99/);
});

test("forrige register tas vare på før det skrives over", async () => {
  const { katalog, økt } = await nytt();
  await økt.registrer(konto());
  assert.equal(await finnes(path.join(katalog, REGISTER_FORRIGE)), false,
               "ingen forrige å kopiere ennå");

  await økt.registrer(konto({ epost: "kari@example.no" }));
  assert.equal(JSON.parse(await les(katalog, REGISTER_FORRIGE)).brukere.length, 1);
});

/* ---------- passordbytte ---------- */

test("passordbytte krever det gamle passordet og hever generasjonen", async () => {
  const { katalog, økt } = await nytt();
  await økt.registrer(konto());

  assert.equal((await økt.byttPassord({ gammelt: "noe-annet-helt", nytt: "et-nytt-langt-passord" })).feil,
               "feil-passord");
  assert.equal((await økt.byttPassord({ gammelt: PASSORD, nytt: "kort" })).feil, "ugyldig");

  assert.deepEqual(await økt.byttPassord({ gammelt: PASSORD, nytt: "et-nytt-langt-passord" }),
                   { ok: true });
  assert.equal(JSON.parse(await les(katalog, REGISTERFIL)).brukere[0].generasjon, 2);

  assert.equal((await økt.loggInn({ epost: "ola@example.no", passord: PASSORD })).feil,
               "feil-innlogging");
  assert.equal((await økt.loggInn({ epost: "ola@example.no", passord: "et-nytt-langt-passord" })).ok,
               true);
});

test("passordbytte uten økt gjør ingenting", async () => {
  const { minne, økt } = await nytt();
  await økt.registrer(konto());
  minne.removeItem(ØKTNØKKEL);
  assert.equal((await økt.byttPassord({ gammelt: PASSORD, nytt: "et-nytt-langt-passord" })).feil,
               "utlogget");
});

/* ---------- nøkkelen ---------- */

const NØKKEL = "sk-ant-en-nokkel-som-er-lang-nok-1234";

test("nøkkelen går inn og aldri ut — bare halen", async () => {
  const { katalog, økt } = await nytt();
  const r = await økt.registrer(konto());

  assert.deepEqual(await økt.settNokkel(NØKKEL), { ok: true });
  const status = await økt.hentNokkel();
  assert.equal(status.finnes, true);
  assert.equal(status.kilde, "egen");
  assert.equal(status.hale, "1234");
  assert.ok(!JSON.stringify(status).includes(NØKKEL), "hele nøkkelen kom tilbake i svaret");

  /* Den ligger i profilens katalog, ikke i rota. */
  assert.equal((await les(katalog, BRUKERKATALOG, r.bruker.id, NOKKELFIL)).trim(), NØKKEL);
  assert.equal(await finnes(path.join(katalog, NOKKELFIL)), false);

  assert.equal((await økt.hentØkt()).harNokkel, true);
});

test("en nøkkel med linjeskift eller feil lengde avvises før den skrives", async () => {
  const { økt } = await nytt();
  await økt.registrer(konto());

  /* Et \r her ville blitt et ekstra HTTP-hode i kallet til modellen. */
  const medCR = await økt.settNokkel("sk-ant-noe\r\nx-annet-hode: ja-takk-1234");
  assert.equal(medCR.ok, false);
  assert.equal(medCR.feil, "ugyldig");

  assert.equal((await økt.settNokkel("for-kort")).ok, false);
  assert.equal((await økt.hentNokkel()).finnes, false);
});

test("å fjerne nøkkelen er idempotent og etterlater ingen nøkkel", async () => {
  const { katalog, økt } = await nytt();
  const r = await økt.registrer(konto());
  await økt.settNokkel(NØKKEL);

  assert.deepEqual(await økt.fjernNokkel(), { ok: true });
  assert.deepEqual(await økt.fjernNokkel(), { ok: true });

  const status = await økt.hentNokkel();
  assert.equal(status.finnes, false);
  assert.equal(status.kilde, "ingen");
  /* Rust har ingen sletting: en tom fil er ingen nøkkel. */
  assert.equal((await les(katalog, BRUKERKATALOG, r.bruker.id, NOKKELFIL)).trim(), "");
  assert.equal((await økt.hentØkt()).harNokkel, false);
});

test("nøkkeloppslag uten økt svarer «utlogget», ikke «ingen nøkkel»", async () => {
  const { økt } = await nytt();
  assert.equal((await økt.hentNokkel()).feil, "utlogget");
  assert.equal((await økt.settNokkel(NØKKEL)).feil, "utlogget");
  assert.equal((await økt.fjernNokkel()).feil, "utlogget");
});

/* ---------- profilene er adskilte ---------- */

test("to profiler deler verken nøkkel eller katalog", async () => {
  const { katalog, minne, økt } = await nytt();
  const a = await økt.registrer(konto());
  await økt.settNokkel(NØKKEL);

  minne.removeItem(ØKTNØKKEL);
  const b = await økt.registrer(konto({ epost: "kari@example.no" }));

  assert.notEqual(a.bruker.id, b.bruker.id);
  assert.equal((await økt.hentNokkel()).finnes, false, "profil to så profil éns nøkkel");
  assert.equal(await finnes(path.join(katalog, BRUKERKATALOG, b.bruker.id, NOKKELFIL)), false);

  /* Og profil én har fortsatt sin. */
  assert.equal((await les(katalog, BRUKERKATALOG, a.bruker.id, NOKKELFIL)).trim(), NØKKEL);
});
