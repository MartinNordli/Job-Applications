import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { lagHentJson, lagNett } from "./nett.mjs";
import { sjekkJsonAdresse, erJsonType, tolkNavToken, hodeverdi, lagRadarnett, MAKS_JSON, NAV_TOKENFIL } from "../src/radarnett.mjs";

/* ============================================================
   hentJson uten nett: oppslaget og selve forespørselen er injisert.
   Reglene leses fra testdata/hentjson.json, den samme filen som
   Rust-testene i src-tauri/src/nett.rs leser.
   ============================================================ */

const felles = JSON.parse(await fs.readFile(new URL("../testdata/hentjson.json", import.meta.url), "utf8"));
const TOKENSVAR = await fs.readFile(new URL("../testdata/radar/nav/publicToken.txt", import.meta.url), "utf8");
const TOKEN = tolkNavToken(TOKENSVAR);

const utvendig = async () => [{ address: "93.184.216.34", family: 4 }];
const kropp = tekst => Readable.from([Buffer.from(tekst)]);
const json = (data, hoder = {}, status = 200) => ({ status, hoder: { "content-type": "application/json; charset=utf-8", ...hoder }, kropp: kropp(JSON.stringify(data)) });

/* En falsk transport som svarer fra en liste og husker hva den ble spurt. */
function falsk(svar){
  const kall = [];
  const forespør = async ({ url, hoder, adresse }) => {
    kall.push({ url: url.href, hoder, adresse });
    const s = typeof svar === "function" ? svar(url, hoder, kall.length) : svar.shift();
    if(s instanceof Error) throw s;
    return s;
  };
  return { forespør, kall };
}

test("vertslisten og adressereglene er de samme som i Rust", () => {
  for(const t of felles.adresser){
    if(t.ok) assert.doesNotThrow(() => sjekkJsonAdresse(t.url, t.kilde), t.url);
    else assert.throws(() => sjekkJsonAdresse(t.url, t.kilde), Error, `${t.url} (${t.om})`);
  }
});

test("bare application/json godtas, og tom type avvises", () => {
  for(const t of felles.typer) assert.equal(erJsonType(t.type), t.ok, JSON.stringify(t.type));
});

test("NAV-tokenet leses som siste linje og må ha formen til en JWT", () => {
  for(const t of felles.tokens) assert.equal(tolkNavToken(t.tekst), t.token, JSON.stringify(t.tekst));
  assert.ok(TOKEN && TOKEN.startsWith("eyJ"), "testtokenet ble ikke lest");
});

test("hodeverdier fra radar.json kan ikke bære linjeskift", () => {
  assert.equal(hodeverdi('W/"abc"'), 'W/"abc"');
  assert.equal(hodeverdi("Fri, 9 Oct 2026 09:11:18 +0200", 64), "Fri, 9 Oct 2026 09:11:18 +0200");
  for(const ond of ["a\r\nX-Injisert: ja", "a\nb", "", null, 7, "ø", "x".repeat(201)]) assert.equal(hodeverdi(ond), null);
});

test("et vellykket kall gir json, etag og sistEndret, og sender riktige hoder", async () => {
  const { forespør, kall } = falsk([json({ jobs: [] }, { etag: 'W/"1"', "last-modified": "Fri, 9 Oct 2026 09:11:18 GMT" })]);
  const hentJson = lagHentJson({ slåOpp: utvendig, forespør });
  const svar = await hentJson("https://publicapi.jobbnorge.no/v3/jobs?page=0", { kilde: "jobbnorge", etag: 'W/"0"', sistEndret: "Fri, 9 Oct 2026 09:00:00 GMT" });
  assert.deepEqual(svar, { status: 200, json: { jobs: [] }, etag: 'W/"1"', sistEndret: "Fri, 9 Oct 2026 09:11:18 GMT" });
  assert.equal(kall[0].hoder.Accept, "application/json");
  assert.equal(kall[0].hoder["If-None-Match"], 'W/"0"');
  assert.equal(kall[0].hoder["If-Modified-Since"], "Fri, 9 Oct 2026 09:00:00 GMT");
  assert.equal(kall[0].hoder.Authorization, undefined, "tokenet skal bare til NAV");
  assert.deepEqual(kall[0].adresse, { address: "93.184.216.34", family: 4 }, "tilkoblingen skal få den sjekkede adressen");
});

test("304 er ingenting nytt, ikke en feil", async () => {
  const { forespør } = falsk([{ status: 304, hoder: {}, kropp: kropp("") }]);
  const hentJson = lagHentJson({ slåOpp: utvendig, forespør });
  assert.deepEqual(await hentJson("https://boards-api.greenhouse.io/v1/boards/x/jobs", { kilde: "greenhouse", etag: 'W/"e"' }),
    { status: 304, json: null, etag: 'W/"e"', sistEndret: null });
});

test("videresendinger følges ikke", async () => {
  for(const status of [301, 302, 307, 308]){
    const { forespør, kall } = falsk([{ status, hoder: { location: "https://169.254.169.254/" }, kropp: kropp("") }]);
    const hentJson = lagHentJson({ slåOpp: utvendig, forespør });
    await assert.rejects(hentJson("https://api.lever.co/v0/postings/bekk?mode=json", { kilde: "lever" }), /sendte oss videre/);
    assert.equal(kall.length, 1);
  }
});

test("feil type, feil status og ugyldig JSON gir hver sin feil", async () => {
  const tilfeller = [
    [{ status: 200, hoder: { "content-type": "text/html" }, kropp: kropp("<html>") }, /ikke med JSON/],
    [{ status: 200, hoder: {}, kropp: kropp("{}") }, /ikke med JSON/],
    [{ status: 404, hoder: { "content-type": "application/json" }, kropp: kropp("{}") }, /^Error: Kilden svarte 404\.$/],
    [{ status: 204, hoder: {}, kropp: kropp("") }, /svarte 204/],
    [json(null, {}, 500), /svarte 500/],
    [{ status: 200, hoder: { "content-type": "application/json" }, kropp: kropp("{ikke json") }, /ugyldig JSON/]
  ];
  for(const [svar, feil] of tilfeller){
    const hentJson = lagHentJson({ slåOpp: utvendig, forespør: falsk([svar]).forespør });
    await assert.rejects(hentJson("https://api.lever.co/v0/postings/bekk", { kilde: "lever" }), feil);
  }
});

test("over 5 MiB er en feil og ikke et stille kutt, også når lengden lyver", async () => {
  const bit = Buffer.alloc(1024 * 1024, 0x20);
  const stor = Readable.from(Array.from({ length: 6 }, () => bit));
  const hentJson = lagHentJson({ slåOpp: utvendig,
    forespør: falsk([{ status: 200, hoder: { "content-type": "application/json", "content-length": "10" }, kropp: stor }]).forespør });
  await assert.rejects(hentJson("https://api.lever.co/v0/postings/bekk", { kilde: "lever" }), /større enn 5 MiB/);
  assert.equal(stor.destroyed, true, "strømmen skal stenges ved taket");
  // Akkurat på taket er greit.
  const akkurat = "[" + " ".repeat(MAKS_JSON - 2) + "]";
  const ok = lagHentJson({ slåOpp: utvendig, forespør: falsk([{ status: 200, hoder: { "content-type": "application/json" }, kropp: kropp(akkurat) }]).forespør });
  assert.deepEqual((await ok("https://api.lever.co/v0/postings/bekk", { kilde: "lever" })).json, []);
});

test("interne adresser stoppes før noen tilkobling, også når bare én av dem er intern", async () => {
  for(const treff of [[{ address: "127.0.0.1", family: 4 }], [{ address: "93.184.216.34", family: 4 }, { address: "::1", family: 6 }],
    [{ address: "169.254.169.254", family: 4 }], [{ address: "::ffff:10.0.0.1", family: 6 }]]){
    const { forespør, kall } = falsk([json({})]);
    const hentJson = lagHentJson({ slåOpp: async () => treff, forespør });
    await assert.rejects(hentJson("https://api.lever.co/v0/postings/bekk", { kilde: "lever" }), /internt nett/);
    assert.equal(kall.length, 0);
  }
  const { forespør, kall } = falsk([json({})]);
  await assert.rejects(lagHentJson({ slåOpp: async () => { throw new Error("ENOTFOUND"); }, forespør })("https://api.lever.co/v0/postings/x", { kilde: "lever" }),
    /Fant ikke serveren/);
  await assert.rejects(lagHentJson({ slåOpp: async () => [], forespør })("https://api.lever.co/v0/postings/x", { kilde: "lever" }), /Fant ikke serveren/);
  assert.equal(kall.length, 0);
});

test("adresser utenfor vertslisten hentes aldri", async () => {
  const { forespør, kall } = falsk(() => json({}));
  const hentJson = lagHentJson({ slåOpp: utvendig, forespør });
  for(const t of felles.adresser.filter(t => !t.ok)) await assert.rejects(hentJson(t.url, { kilde: t.kilde }));
  assert.equal(kall.length, 0);
});

test("tidsavbrudd og brudd gir meldinger brukeren kan lese", async () => {
  const tid = new Error("x"); tid.name = "TimeoutError";
  await assert.rejects(lagHentJson({ slåOpp: utvendig, forespør: falsk([tid]).forespør })("https://pam-stilling-feed.nav.no/api/publicToken", { kilde: "nav" }),
    /innen 30 sekunder/);
  await assert.rejects(lagHentJson({ slåOpp: utvendig, forespør: falsk([tid]).forespør })("https://api.lever.co/v0/postings/x", { kilde: "lever" }),
    /innen 15 sekunder/);
  const brudd = new Readable({ read(){ this.destroy(new Error("ECONNRESET")); } });
  await assert.rejects(lagHentJson({ slåOpp: utvendig, forespør: falsk([{ status: 200, hoder: { "content-type": "application/json" }, kropp: brudd }]).forespør })(
    "https://api.lever.co/v0/postings/x", { kilde: "lever" }), /Mistet forbindelsen/);
});

/* ---------- NAV-tokenet ---------- */

const NAVFEED = "https://pam-stilling-feed.nav.no/api/v1/feed?last";
const tokensvar = (tekst = TOKENSVAR) => ({ status: 200, hoder: { "content-type": "text/plain;charset=utf-8" }, kropp: kropp(tekst) });

test("NAV får det offentlige tokenet, og det hentes bare én gang", async () => {
  const { forespør, kall } = falsk(url => url.pathname === "/api/publicToken" ? tokensvar() : json({ items: [] }));
  const hentJson = lagHentJson({ slåOpp: utvendig, forespør });
  await hentJson(NAVFEED, { kilde: "nav" });
  await hentJson(NAVFEED, { kilde: "nav" });
  assert.deepEqual(kall.map(k => new URL(k.url).pathname), ["/api/publicToken", "/api/v1/feed", "/api/v1/feed"]);
  assert.equal(kall[1].hoder.Authorization, `Bearer ${TOKEN}`);
  assert.equal(kall[0].hoder.Authorization, undefined, "tokenkallet har ikke noe token");
});

test("401 gir nytt token og ett nytt forsøk, og to 401 på rad gir opp", async () => {
  let n = 0;
  const { forespør, kall } = falsk((url, hoder) => {
    if(url.pathname === "/api/publicToken") return tokensvar(`Current public token:\neyJ.nytt${++n}.x`);
    return hoder.Authorization === "Bearer eyJ.nytt2.x" ? json({ items: [1] }) : json({ title: "Unauthorized" }, {}, 401);
  });
  const hentJson = lagHentJson({ slåOpp: utvendig, forespør });
  assert.deepEqual((await hentJson(NAVFEED, { kilde: "nav" })).json, { items: [1] });
  assert.deepEqual(kall.map(k => new URL(k.url).pathname), ["/api/publicToken", "/api/v1/feed", "/api/publicToken", "/api/v1/feed"]);

  const alltid401 = falsk(url => url.pathname === "/api/publicToken" ? tokensvar() : json({}, {}, 401));
  const h2 = lagHentJson({ slåOpp: utvendig, forespør: alltid401.forespør });
  await assert.rejects(h2(NAVFEED, { kilde: "nav" }), /NAV avviste tokenet/);
  assert.equal(alltid401.kall.length, 4, "ett nytt token og ett nytt forsøk, ikke flere");
});

test("uten offentlig token hoppes kjøringen over med en forklaring", async () => {
  const { forespør } = falsk([{ status: 404, hoder: { "content-type": "text/plain" }, kropp: kropp("Public token is not currently available") }]);
  await assert.rejects(lagHentJson({ slåOpp: utvendig, forespør })(NAVFEED, { kilde: "nav" }), /ikke et offentlig token/);
  const { forespør: f2 } = falsk([tokensvar("<html>innlogging</html>")]);
  await assert.rejects(lagHentJson({ slåOpp: utvendig, forespør: f2 })(NAVFEED, { kilde: "nav" }), /gyldig token/);
});

test("et privat token i profilen brukes i stedet, og avvises det, sier vi fra", async t => {
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "hentjson-"));
  t.after(() => fs.rm(katalog, { recursive: true, force: true }));
  await fs.writeFile(path.join(katalog, NAV_TOKENFIL), "eyJ.privat.token\n", { mode: 0o600 });
  const { forespør, kall } = falsk(() => json({ items: [] }));
  await lagHentJson({ slåOpp: utvendig, forespør })(NAVFEED, { kilde: "nav", katalog });
  assert.deepEqual(kall.map(k => new URL(k.url).pathname), ["/api/v1/feed"]);
  assert.equal(kall[0].hoder.Authorization, "Bearer eyJ.privat.token");

  const avvist = falsk(() => json({}, {}, 401));
  await assert.rejects(lagHentJson({ slåOpp: utvendig, forespør: avvist.forespør })(NAVFEED, { kilde: "nav", katalog }), /tokenet i nav-token.txt/);
  assert.equal(avvist.kall.length, 1, "ingen stille overgang til det offentlige tokenet");

  await fs.writeFile(path.join(katalog, NAV_TOKENFIL), "ikke et token\r\nX-Injisert: ja");
  const ingen = falsk(() => json({}));
  await assert.rejects(lagHentJson({ slåOpp: utvendig, forespør: ingen.forespør })(NAVFEED, { kilde: "nav", katalog }), /ikke et gyldig token/);
  assert.equal(ingen.kall.length, 0);
});

test("tokenet havner aldri i en feilmelding eller i et svar", async () => {
  const { forespør } = falsk(url => url.pathname === "/api/publicToken" ? tokensvar() : json({}, {}, 401));
  const feil = await lagHentJson({ slåOpp: utvendig, forespør })(NAVFEED, { kilde: "nav" }).catch(e => e);
  assert.ok(!String(feil.message).includes(TOKEN));
  const ok = await lagHentJson({ slåOpp: utvendig, forespør: falsk(url => url.pathname === "/api/publicToken" ? tokensvar() : json({ a: 1 })).forespør })(NAVFEED, { kilde: "nav" });
  assert.ok(!JSON.stringify(ok).includes(TOKEN));
});

test("lagNett har hentJson, og den ekte transporten nekter interne adresser uten å koble til", async () => {
  const nett = lagNett();
  assert.equal(typeof nett.hentJson, "function");
  await assert.rejects(nett.hentJson("https://127.0.0.1/api", { kilde: "nav" }), /hører ikke til kilden/);
});

/* ---------- transportvalget ---------- */

test("lagRadarnett sender bare de kjente feltene, til Rust eller til Node", async () => {
  const kall = [];
  const invoke = async (navn, arg) => { kall.push([navn, arg]); return { status: 200 }; };
  const app = lagRadarnett({ invoke, bruker: "0123456789abcdef" });
  await app.hentJson("https://api.lever.co/v0/postings/bekk", { kilde: "lever", etag: "a\r\nb", sistEndret: "Fri, 9 Oct 2026 09:11:18 GMT", token: "x" });
  await app.hentSide("https://tibber.teamtailor.com/jobs.rss");
  assert.deepEqual(kall, [
    ["hent_json", { url: "https://api.lever.co/v0/postings/bekk", kilde: "lever", etag: null, sistEndret: "Fri, 9 Oct 2026 09:11:18 GMT", bruker: "0123456789abcdef" }],
    ["hent_side", { url: "https://tibber.teamtailor.com/jobs.rss" }]
  ]);
  const node = { hentJson: async (url, valg) => ({ url, valg }), hentSide: async url => ({ url }) };
  const server = lagRadarnett({ node, katalog: "/tmp/profil" });
  assert.deepEqual(await server.hentJson("https://api.lever.co/x", { kilde: "lever" }),
    { url: "https://api.lever.co/x", valg: { kilde: "lever", etag: null, sistEndret: null, katalog: "/tmp/profil" } });
  assert.throws(() => lagRadarnett({}), /vei ut/);
});
