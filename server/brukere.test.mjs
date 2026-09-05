import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  lagBrukere, lagRatebegrenser, tolkCookies, byggØktcookie, byggSlettcookie,
  REGISTERFIL, REGISTER_FORRIGE, HEMMELIGHETSFIL, BRUKERKATALOG, COOKIE, MAKS_BRUKERE
} from "./brukere.mjs";
import { erGyldigBrukerId, tolkHash, ITERASJONER, kodNyttelast } from "../src/brukerlogikk.mjs";

/* ============================================================
   Registeret, øktene og lagrene — med et ekte filsystem, men
   alltid i en egen mkdtemp-katalog. Ingen test her ser data/.

   Iterasjonstallet senkes til 1: hver innlogging koster ellers
   et tredjedels sekund, og det vi tester her er reglene, ikke
   PBKDF2. Ett eget tilfelle nede sjekker at drift bruker 600 000.
   ============================================================ */

const RASKT = { iterasjoner: 1 };

async function nytt(valg = {}){
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "jobber-brukere-"));
  return { katalog, brukere: lagBrukere({ katalog, ...RASKT, ...valg }) };
}

const PASSORD = "et-godt-nok-passord";
const konto = (o = {}) => ({ epost: "ola@example.no", navn: "Ola", passord: PASSORD, ...o });

const finnes = async p => !!(await fs.stat(p).catch(() => null));
const modus  = async p => ((await fs.stat(p)).mode & 0o777).toString(8);

/* ---------- cookier ---------- */

test("cookienavnet og stiene er ASCII", () => {
  assert.equal(COOKIE, "okt");
  assert.match(byggØktcookie("abc.def"), /^okt=abc\.def;/);
  /* Et cookienavn er et RFC 6265-token; «økt» ville ikke vært lovlig. */
  assert.match(COOKIE, /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/);
});

test("cookien er HttpOnly og SameSite=Strict, men ikke Secure", () => {
  const c = byggØktcookie("token");
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Max-Age=2592000/);
  /* Secure ville gjort cookien ubrukelig: appen er http på loopback. */
  assert.doesNotMatch(c, /Secure/);
});

test("slettecookien nuller ut med Max-Age=0", () => {
  assert.match(byggSlettcookie(), /^okt=; .*Max-Age=0/);
});

test("cookier tolkes, første vinner, og hodet er bundet", () => {
  assert.equal(tolkCookies("a=1; okt=abc; b=2").okt, "abc");
  assert.equal(tolkCookies("okt=først; okt=sist").okt, "først");
  assert.equal(tolkCookies("okt=x".padEnd(9000, "y")).okt, undefined);
  assert.equal(tolkCookies(undefined).okt, undefined);
  /* Ingen prototype å forgifte. */
  assert.equal(Object.getPrototypeOf(tolkCookies("a=1")), null);
  assert.equal(tolkCookies("__proto__=x").toString, undefined);
});

/* ---------- ratebegrenser ---------- */

test("ratebegrenseren slipper gjennom til taket og sier hvor lenge", () => {
  const r = lagRatebegrenser({ tak: 3, vindu: 1000 });
  for(let i = 0; i < 3; i++){ assert.equal(r.sjekk("a", 0).ok, true); r.tell("a", 0); }
  const nei = r.sjekk("a", 100);
  assert.equal(nei.ok, false);
  assert.equal(nei.retryEtter, 1);
  assert.equal(r.sjekk("b", 100).ok, true, "andre nøkler er upåvirket");
  assert.equal(r.sjekk("a", 1001).ok, true, "vinduet skyver seg");
});

test("kartet i ratebegrenseren er bundet", () => {
  const r = lagRatebegrenser({ tak: 1, vindu: 60_000, maksNøkler: 10 });
  for(let i = 0; i < 100; i++) r.tell("n" + i);
  assert.equal(r.størrelse, 10);
});

/* ---------- hemmeligheten ---------- */

test("hemmelighetsfilen lages med 0600 og gjenbrukes", async () => {
  const { katalog, brukere } = await nytt();
  const a = await brukere._hemmelighet();
  const b = await brukere._hemmelighet();
  assert.equal(a.length, 32);
  assert.deepEqual([...a], [...b]);
  const sti = path.join(katalog, HEMMELIGHETSFIL);
  assert.equal(await modus(sti), "600");
  assert.match((await fs.readFile(sti, "utf8")).trim(), /^[0-9a-f]{64}$/);
});

test("en hemmelighetsfil på feil form overskrives ikke", async () => {
  const { katalog, brukere } = await nytt();
  await fs.writeFile(path.join(katalog, HEMMELIGHETSFIL), "ikke heks");
  await assert.rejects(() => brukere._hemmelighet(), /forventet form/);
  assert.equal(await fs.readFile(path.join(katalog, HEMMELIGHETSFIL), "utf8"), "ikke heks");
});

/* ---------- registrering ---------- */

test("første registrering gir konto, cookie og erFørste", async () => {
  const { katalog, brukere } = await nytt();
  const r = await brukere.registrer(konto());
  assert.equal(r.ok, true);
  assert.equal(r.erFørste, true);
  assert.ok(erGyldigBrukerId(r.bruker.id));
  assert.equal(r.bruker.epost, "ola@example.no");
  assert.equal(r.bruker.generasjon, 1);
  assert.match(r.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  /* Registeret ligger 0600 og har en sikkerhetskopi etter neste skriving. */
  assert.equal(await modus(path.join(katalog, REGISTERFIL)), "600");
  assert.equal(await finnes(path.join(katalog, REGISTER_FORRIGE)), false, "ingen forrige å kopiere ennå");

  await brukere.registrer(konto({ epost: "kari@example.no" }));
  assert.equal(await finnes(path.join(katalog, REGISTER_FORRIGE)), true);
  assert.equal(await modus(path.join(katalog, REGISTER_FORRIGE)), "600");
});

test("passordet lagres bare som pbkdf2-hash, aldri i klartekst", async () => {
  const { katalog, brukere } = await nytt();
  await brukere.registrer(konto());
  const rå = await fs.readFile(path.join(katalog, REGISTERFIL), "utf8");
  assert.equal(rå.includes(PASSORD), false);
  const dok = JSON.parse(rå);
  assert.equal(tolkHash(dok.brukere[0].hash).ok, true);
});

test("drift bruker 600 000 iterasjoner", async () => {
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "jobber-brukere-"));
  const b = lagBrukere({ katalog });                 /* uten RASKT */
  const r = await b.registrer(konto());
  assert.equal(tolkHash(r.bruker.hash).iterasjoner, ITERASJONER);
});

test("duplikat e-post gir «finnes», også på annen skrivemåte", async () => {
  const { brukere } = await nytt();
  assert.equal((await brukere.registrer(konto())).ok, true);
  assert.equal((await brukere.registrer(konto())).feil, "finnes");
  assert.equal((await brukere.registrer(konto({ epost: "  OLA@Example.NO " }))).feil, "finnes");
});

test("to samtidige registreringer: nøyaktig én blir først", async () => {
  const { brukere } = await nytt();
  const [a, b] = await Promise.all([
    brukere.registrer(konto({ epost: "en@example.no" })),
    brukere.registrer(konto({ epost: "to@example.no" }))
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal([a.erFørste, b.erFørste].filter(Boolean).length, 1,
    "tomhetssjekken må ligge inne i skrivekøen");
  const reg = await brukere.lesRegister();
  assert.equal(reg.brukere.length, 2, "ingen skriving gikk tapt");
});

test("samme e-post to ganger samtidig gir én konto", async () => {
  const { brukere } = await nytt();
  const svar = await Promise.all([brukere.registrer(konto()), brukere.registrer(konto())]);
  assert.equal(svar.filter(s => s.ok).length, 1);
  assert.equal(svar.filter(s => s.feil === "finnes").length, 1);
});

test("kontotaket stenger registreringen", async () => {
  const { brukere } = await nytt();
  for(let i = 0; i < MAKS_BRUKERE; i++)
    assert.equal((await brukere.registrer(konto({ epost: `n${i}@example.no` }))).ok, true);
  const r = await brukere.registrer(konto({ epost: "en-for-mye@example.no" }));
  assert.equal(r.ok, false);
  assert.equal(r.feil, "stengt");
});

test("ugyldig registrering gir feil per felt og skriver ingenting", async () => {
  const { katalog, brukere } = await nytt();
  const r = await brukere.registrer({ epost: "nei", passord: "kort" });
  assert.equal(r.feil, "ugyldig");
  assert.deepEqual(r.detaljer.map(f => f.felt).sort(), ["epost", "passord"]);
  assert.equal(await finnes(path.join(katalog, REGISTERFIL)), false);
});

/* ---------- innlogging ---------- */

test("innlogging med riktig passord gir bruker og token", async () => {
  const { brukere } = await nytt();
  const r = await brukere.registrer(konto());
  const i = await brukere.loggInn({ epost: "OLA@example.no", passord: PASSORD });
  assert.equal(i.ok, true);
  assert.equal(i.bruker.id, r.bruker.id);
  assert.equal(i.erFørste, true);
  assert.ok(i.bruker.sistInnlogget);
});

test("feil passord og ukjent e-post gir samme svar", async () => {
  const { brukere } = await nytt();
  await brukere.registrer(konto());
  const feilPassord = await brukere.loggInn({ epost: "ola@example.no", passord: "feil-passordet" });
  const ukjent      = await brukere.loggInn({ epost: "ingen@example.no", passord: PASSORD });
  assert.deepEqual(feilPassord, { ok: false, feil: "feil-innlogging" });
  assert.deepEqual(ukjent, { ok: false, feil: "feil-innlogging" });
});

test("ukjent e-post koster et ekte pbkdf2-kall", async () => {
  /* Med et høyt iterasjonstall må ukjent e-post ta omtrent like lang
     tid som feil passord — ellers røper svartiden hvilke kontoer som
     finnes. Vi måler grovt: begge skal ligge langt over null. */
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "jobber-brukere-"));
  const b = lagBrukere({ katalog, iterasjoner: 200_000 });
  await b.registrer(konto());

  const mål = async epost => {
    const t = process.hrtime.bigint();
    await b.loggInn({ epost, passord: "feil-passordet" });
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const kjent = await mål("ola@example.no");
  const ukjent = await mål("ingen@example.no");
  assert.ok(ukjent > kjent / 3,
    `ukjent e-post (${ukjent.toFixed(0)} ms) skal ikke svare fort mot kjent (${kjent.toFixed(0)} ms)`);
});

test("for kort passord ved innlogging gir feil-innlogging, ikke «for kort»", async () => {
  const { brukere } = await nytt();
  await brukere.registrer(konto());
  assert.deepEqual(await brukere.loggInn({ epost: "ola@example.no", passord: "kort" }),
                   { ok: false, feil: "feil-innlogging" });
});

test("en svak hash skrives om ved neste vellykkede innlogging", async () => {
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "jobber-brukere-"));
  const svak = lagBrukere({ katalog, iterasjoner: 1 });
  await svak.registrer(konto());

  const sterk = lagBrukere({ katalog, iterasjoner: 5000 });
  const i = await sterk.loggInn({ epost: "ola@example.no", passord: PASSORD });
  assert.equal(i.ok, true);
  assert.equal(tolkHash(i.bruker.hash).iterasjoner, 5000);

  const reg = await sterk.lesRegister();
  assert.equal(tolkHash(reg.brukere[0].hash).iterasjoner, 5000, "den nye hashen ble skrevet");
  assert.equal((await sterk.loggInn({ epost: "ola@example.no", passord: PASSORD })).ok, true);
});

/* ---------- øktene ---------- */

test("et ferskt token verifiserer", async () => {
  const { brukere } = await nytt();
  const r = await brukere.registrer(konto());
  const ø = await brukere.verifiserToken(r.token);
  assert.equal(ø.bruker.id, r.bruker.id);
  assert.equal(ø.erFørste, true);
});

test("tuklet signatur og tuklet nyttelast avvises begge", async () => {
  const { brukere } = await nytt();
  const { token } = await brukere.registrer(konto());
  const [kropp, sig] = token.split(".");

  const bytt = s => (s[0] === "A" ? "B" : "A") + s.slice(1);
  assert.equal(await brukere.verifiserToken(`${kropp}.${bytt(sig)}`), null);
  assert.equal(await brukere.verifiserToken(`${bytt(kropp)}.${sig}`), null);
  assert.equal(await brukere.verifiserToken(`${kropp}.${sig}x`), null);
  assert.equal(await brukere.verifiserToken(kropp), null);
  assert.equal(await brukere.verifiserToken(""), null);
  assert.equal(await brukere.verifiserToken(undefined), null);
  assert.ok(await brukere.verifiserToken(token), "det urørte tokenet står fortsatt");
});

test("en nyttelast uten signatur kommer ingen vei", async () => {
  const { brukere } = await nytt();
  const r = await brukere.registrer(konto());
  const kropp = kodNyttelast({ b: r.bruker.id, g: 1, u: 0, e: 2 ** 31 });
  assert.equal(await brukere.verifiserToken(`${kropp}.AAAA`), null);
});

test("et utløpt token avvises", async () => {
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "jobber-brukere-"));
  let klokke = new Date("2026-01-01T00:00:00Z");
  const b = lagBrukere({ katalog, ...RASKT, nå: () => klokke });
  const { token } = await b.registrer(konto());
  assert.ok(await b.verifiserToken(token));
  klokke = new Date("2026-03-01T00:00:00Z");          /* 59 dager senere */
  assert.equal(await b.verifiserToken(token), null);
});

test("gammel generasjon faller etter «logg ut overalt» og etter passordbytte", async () => {
  const { brukere } = await nytt();
  const r = await brukere.registrer(konto());
  assert.ok(await brukere.verifiserToken(r.token));

  const ut = await brukere.loggUtAlle(r.bruker.id);
  assert.equal(ut.ok, true);
  assert.equal(ut.bruker.generasjon, 2);
  assert.equal(await brukere.verifiserToken(r.token), null);

  const nyØkt = await brukere.loggInn({ epost: "ola@example.no", passord: PASSORD });
  assert.ok(await brukere.verifiserToken(nyØkt.token));

  const bytte = await brukere.byttPassord(r.bruker.id, PASSORD, "et-helt-nytt-passord");
  assert.equal(bytte.ok, true);
  assert.equal(await brukere.verifiserToken(nyØkt.token), null, "passordbytte tilbakekaller alt");
  assert.ok(await brukere.verifiserToken(bytte.token), "den som byttet får en ny økt");
});

test("token for en bruker som ikke finnes i registeret avvises", async () => {
  const { katalog, brukere } = await nytt();
  const r = await brukere.registrer(konto());
  const dok = JSON.parse(await fs.readFile(path.join(katalog, REGISTERFIL), "utf8"));
  dok.brukere = [];
  await fs.writeFile(path.join(katalog, REGISTERFIL), JSON.stringify(dok));
  assert.equal(await brukere.verifiserToken(r.token), null);
});

test("et token fra en annen hemmelighet avvises", async () => {
  const a = await nytt();
  const b = await nytt();
  const r = await a.brukere.registrer(konto());
  await b.brukere.registrer(konto());
  assert.equal(await b.brukere.verifiserToken(r.token), null);
});

/* ---------- passordbytte ---------- */

test("feil gammelt passord gir feil-passord og endrer ingenting", async () => {
  const { brukere } = await nytt();
  const r = await brukere.registrer(konto());
  const b = await brukere.byttPassord(r.bruker.id, "helt-feil-passord", "et-nytt-langt-passord");
  assert.equal(b.feil, "feil-passord");
  assert.ok(await brukere.verifiserToken(r.token), "økten står");
  assert.equal((await brukere.loggInn({ epost: "ola@example.no", passord: PASSORD })).ok, true);
});

test("et for kort nytt passord avvises", async () => {
  const { brukere } = await nytt();
  const r = await brukere.registrer(konto());
  const b = await brukere.byttPassord(r.bruker.id, PASSORD, "kort");
  assert.equal(b.feil, "ugyldig");
  assert.equal(b.detaljer[0].felt, "nytt");
});

/* ---------- et ødelagt register ---------- */

test("et uleselig register blir liggende, og alt nekter å svare", async () => {
  const { katalog, brukere } = await nytt();
  const r = await brukere.registrer(konto());
  await fs.writeFile(path.join(katalog, REGISTERFIL), "{ikke json");

  const st = await brukere.status();
  assert.equal(st.ødelagt, true);
  assert.equal((await brukere.registrer(konto({ epost: "ny@example.no" }))).feil, "ødelagt-register");
  assert.equal((await brukere.loggInn({ epost: "ola@example.no", passord: PASSORD })).feil, "ødelagt-register");
  assert.equal(await brukere.verifiserToken(r.token), null);

  /* Registeret bærer passordhashene. Det settes aldri i karantene av
     seg selv slik datafilen blir — det ville låst brukeren ute for godt. */
  assert.equal(await fs.readFile(path.join(katalog, REGISTERFIL), "utf8"), "{ikke json");
});

test("et register fra en nyere versjon nektes i stedet for å skrives over", async () => {
  const { katalog, brukere } = await nytt();
  await fs.writeFile(path.join(katalog, REGISTERFIL),
    JSON.stringify({ versjon: 99, brukere: [] }));
  assert.equal((await brukere.status()).ødelagt, true);
  assert.equal((await brukere.registrer(konto())).feil, "ødelagt-register");
  assert.match(JSON.parse(await fs.readFile(path.join(katalog, REGISTERFIL), "utf8")).versjon + "", /99/);
});

/* ---------- lagerinstanser ---------- */

test("samme bruker får samme lagerinstans — én kø, ingen tapt skriving", async () => {
  const { brukere } = await nytt();
  const r = await brukere.registrer(konto());
  const a = brukere.lagerFor(r.bruker.id);
  const b = brukere.lagerFor(r.bruker.id);
  assert.equal(a, b);
  assert.equal(a.lager, b.lager);
});

test("lagerkatalogen ligger under brukere/<id> og er adskilt", async () => {
  const { katalog, brukere } = await nytt();
  const a = await brukere.registrer(konto({ epost: "a@example.no" }));
  const b = await brukere.registrer(konto({ epost: "b@example.no" }));

  const la = brukere.lagerFor(a.bruker.id), lb = brukere.lagerFor(b.bruker.id);
  assert.equal(la.katalog, path.join(katalog, BRUKERKATALOG, a.bruker.id));
  assert.notEqual(la.katalog, lb.katalog);

  const rad = { id: "a1", selskap: "Equinor", stilling: "Sommerjobb", status: "todo" };
  assert.equal((await la.lager.skriv([rad], 0)).ok, true);
  assert.deepEqual((await lb.lager.les()).jobber, null, "B ser ingenting av A");
  assert.equal((await lb.lager.les()).tom, true);
});

test("ugyldig bruker-id kommer aldri fram til en katalog", async () => {
  const { brukere } = await nytt();
  for(const id of ["../etc", "a/b", "..", "", "AAAAAAAAAAAAAAAA"])
    assert.throws(() => brukere.lagerFor(id), /ugyldig bruker-id/, JSON.stringify(id));
});

test("cachen vokser ikke forbi kontotaket", async () => {
  const { brukere } = await nytt();
  const ider = [];
  for(let i = 0; i < 5; i++)
    ider.push((await brukere.registrer(konto({ epost: `n${i}@example.no` }))).bruker.id);
  for(const id of ider) brukere.lagerFor(id);
  assert.equal(brukere.antallLagre, 5);
  for(let i = 0; i < 3; i++) brukere.lagerFor(ider[0]);
  assert.equal(brukere.antallLagre, 5, "gjenbruk lager ikke nye instanser");
  assert.ok(brukere.antallLagre <= MAKS_BRUKERE);
});

test("to samtidige skrivinger fra samme bruker havner begge på disk", async () => {
  const { brukere } = await nytt();
  const r = await brukere.registrer(konto());
  const { lager } = brukere.lagerFor(r.bruker.id);
  const rad = (id, selskap) => ({ id, selskap, stilling: "S", status: "todo" });

  const [a, b] = await Promise.all([
    lager.skriv([rad("a1", "Equinor")]),
    lager.skriv([rad("a1", "Equinor"), rad("a2", "Aker BP")])
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.versjon, a.versjon + 1, "køen serialiserte dem");
  assert.equal((await lager.les()).jobber.length, 2);
});

/* ---------- migreringen ---------- */

async function medGamleData(){
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "jobber-brukere-"));
  const gammel = JSON.stringify({ versjon: 25, oppdatert: "2026-01-01T00:00:00.000Z", jobber: [
    { id: "g1", selskap: "Equinor", stilling: "Sommerjobb", status: "sent" },
    { id: "g2", selskap: "Aker BP", stilling: "Graduate", status: "todo" }
  ]}, null, 2) + "\n";
  await fs.writeFile(path.join(katalog, "jobber.json"), gammel);
  await fs.writeFile(path.join(katalog, "jobber.forrige.json"), '{"versjon":24,"jobber":[]}');
  await fs.writeFile(path.join(katalog, "importlogg.jsonl"), '{"tid":"2026-01-01T00:00:00.000Z"}\n');
  await fs.writeFile(path.join(katalog, "nokkel.txt"), "sk-ant-en-nokkel-som-er-lang-nok\n", { mode: 0o600 });
  return { katalog, gammel, brukere: lagBrukere({ katalog, ...RASKT }) };
}

test("første bruker arver de gamle radene, og originalen er bit for bit uendret", async () => {
  const { katalog, gammel, brukere } = await medGamleData();
  const før = await fs.readFile(path.join(katalog, "jobber.json"));

  const r = await brukere.registrer(konto());
  assert.equal(r.ok, true);
  assert.deepEqual(r.migrert, ["jobber.json", "jobber.forrige.json", "importlogg.jsonl", "nokkel.txt"]);

  const min = path.join(katalog, BRUKERKATALOG, r.bruker.id);
  assert.equal(await fs.readFile(path.join(min, "jobber.json"), "utf8"), gammel);
  assert.equal((await brukere.lagerFor(r.bruker.id).lager.les()).jobber.length, 2);

  /* Originalen er sikkerhetskopien vår. Kopi, aldri flytting. */
  assert.deepEqual(await fs.readFile(path.join(katalog, "jobber.json")), før);
  assert.equal(await finnes(path.join(katalog, "nokkel.txt")), true);
  assert.equal(await modus(path.join(min, "nokkel.txt")), "600", "nøkkelen ligger 0600 hos brukeren");
});

test("bruker nummer to arver ingenting", async () => {
  const { katalog, brukere } = await medGamleData();
  await brukere.registrer(konto());
  const to = await brukere.registrer(konto({ epost: "kari@example.no" }));
  assert.equal(to.erFørste, false);
  assert.equal(to.migrert, undefined);
  assert.equal(await finnes(path.join(katalog, BRUKERKATALOG, to.bruker.id, "jobber.json")), false);
  assert.equal((await brukere.lagerFor(to.bruker.id).lager.les()).tom, true);
});

test("migreringen parser ikke — en ødelagt rotfil stopper ikke registreringen", async () => {
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "jobber-brukere-"));
  await fs.writeFile(path.join(katalog, "jobber.json"), "{ikke json i det hele tatt");
  const brukere = lagBrukere({ katalog, ...RASKT });

  const r = await brukere.registrer(konto());
  assert.equal(r.ok, true);
  assert.deepEqual(r.migrert, ["jobber.json"]);
  /* Filen fulgte med som den var — lagerlogikken tar seg av at den er
     ødelagt, på nøyaktig samme måte som før flerbruker. */
  assert.equal(await fs.readFile(path.join(katalog, BRUKERKATALOG, r.bruker.id, "jobber.json"), "utf8"),
               "{ikke json i det hele tatt");
  assert.equal((await brukere.lagerFor(r.bruker.id).lager.les()).ødelagt, true);
});

test("uten gamle data er det ingenting å migrere", async () => {
  const { brukere } = await nytt();
  const r = await brukere.registrer(konto());
  assert.equal(r.migrert, undefined);
  assert.equal(r.migreringsfeil, undefined);
});

/* ---------- status ---------- */

test("status sier om det finnes brukere i det hele tatt", async () => {
  const { brukere } = await nytt();
  assert.deepEqual(await brukere.status(), { harBrukere: false, antall: 0 });
  await brukere.registrer(konto());
  assert.deepEqual(await brukere.status(), { harBrukere: true, antall: 1 });
});

test("erFørste peker på den første raden i registeret", async () => {
  const { brukere } = await nytt();
  const a = await brukere.registrer(konto({ epost: "a@example.no" }));
  const b = await brukere.registrer(konto({ epost: "b@example.no" }));
  assert.equal(await brukere.erFørste(a.bruker.id), true);
  assert.equal(await brukere.erFørste(b.bruker.id), false);
});
