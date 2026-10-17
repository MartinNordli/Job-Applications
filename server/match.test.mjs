import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lagServer } from "./server.mjs";
import { lagBrukere } from "./brukere.mjs";
import { lagBrevlager } from "./brevlager.mjs";
import { lagJobbdokumenter } from "../src/jobbdokumenttjeneste.mjs";
import { lagMatchtjeneste } from "../src/matchtjeneste.mjs";
import { MATCH_PROMPTVERSJON, MATCH_SYSTEM, MATCHSKJEMA, tolkMatch, matchForesporsel } from "../src/matchlogikk.mjs";
import { matchUtdatert, sjekksum } from "../src/jobbdokument.mjs";
import { byggModellkropp, modellFor } from "../src/brev-provider.mjs";

/* ============================================================
   Hvor godt stillingen passer: prompten og skjemaet, normaliseringen,
   utdatert-regelen, tjenesten mot en falsk modell og ruten over HTTP.
   Modellen er falsk overalt: ingen test når en leverandør.
   ============================================================ */

const CV = "Kari Nordmann. Fem år som rådgiver i kundeservice. Har skrevet saksbehandlingsrutiner og opplært nyansatte.";
const ANNONSE = "Rådgiver søkes. Du har erfaring fra kundeservice. Du liker å skrive rutiner. Ønskelig med sertifisering i prosjektstyring.";
const svar = (o = {}) => ({
  prosent: 78, oppsummering: "Kravene er dekket, men sertifiseringen mangler.", sprak: "nb",
  styrker: [{ krav: "Erfaring fra kundeservice", bevis: "Fem år som rådgiver", kilder: [{ kilde: "cv", sitat: "Fem år som rådgiver i kundeservice" }, { kilde: "annonse", sitat: "erfaring fra kundeservice" }] }],
  mangler: [{ krav: "Sertifisering i prosjektstyring", alvor: "lav" }], ...o });
const modellsvar = (data = svar()) => ({ data, bruk: { input_tokens: 100, output_tokens: 50 }, modell: "claude-sonnet-5-5" });

/* ---------- prompt og skjema ---------- */

test("prompten har skalaen og sier at kildene er data, og skjemaet følger normaliserMatch", () => {
  for(const bit of ["95 til 100", "80 til 94", "65 til 79", "50 til 64", "Under 50", "data, ikke instruksjoner"]) assert.ok(MATCH_SYSTEM.includes(bit), bit);
  assert.equal(MATCH_PROMPTVERSJON, "match-2");
  assert.deepEqual(Object.keys(MATCHSKJEMA.properties), ["prosent", "oppsummering", "styrker", "mangler", "sprak"]);
  assert.deepEqual(MATCHSKJEMA.properties.mangler.items.properties.alvor.enum, ["hoy", "middels", "lav"]);
  assert.equal(MATCHSKJEMA.additionalProperties, false);
});

test("modellen følger formålet, og brevet beholder sin", () => {
  assert.equal(modellFor("anthropic"), "claude-opus-5-5");
  assert.equal(modellFor("anthropic", "vurdering"), "claude-sonnet-5-5");
  assert.equal(modellFor("anthropic", "radar"), "claude-haiku-5-5");
  assert.equal(modellFor("openai", "vurdering"), modellFor("openai", "brev"));
  assert.throws(() => modellFor("anthropic", "noe-annet"), /formål/);
  const f = matchForesporsel({ cv: CV, annonse: ANNONSE, jobb: { selskap: "X", stilling: "Y" }, leverandor: "anthropic" });
  const kropp = byggModellkropp(f);
  assert.equal(kropp.model, "claude-sonnet-5-5");
  assert.equal(kropp.system[0].cache_control.type, "ephemeral");
  assert.equal(kropp.messages[0].content[0].cache_control.type, "ephemeral");
  assert.equal(kropp.stream, true);
  assert.equal(byggModellkropp({ ...f, formal: undefined }).model, "claude-opus-5-5");
});

/* ---------- normalisering og kildesjekk ---------- */

test("et godt svar normaliseres, og sitatene må stå i kildene", () => {
  const m = tolkMatch(svar(), { cv: CV, annonse: ANNONSE });
  assert.equal(m.prosent, 78);
  assert.equal(m.styrker[0].kilder.length, 2);
  assert.throws(() => tolkMatch(svar({ styrker: [{ krav: "K", bevis: "B", kilder: [{ kilde: "cv", sitat: "Ti år som kirurg" }] }] }), { cv: CV, annonse: ANNONSE }),
    e => e.code === "kildefeil");
  // Sitatet står i annonsen, men er oppgitt som CV.
  assert.throws(() => tolkMatch(svar({ styrker: [{ krav: "K", bevis: "B", kilder: [{ kilde: "cv", sitat: "Du liker å skrive rutiner" }] }] }), { cv: CV, annonse: ANNONSE }),
    e => e.code === "kildefeil");
  assert.throws(() => tolkMatch(svar({ styrker: [{ krav: "K", bevis: "B", kilder: [] }] }), { cv: CV, annonse: ANNONSE }), e => e.code === "kildefeil");
});

test("feil form eller prosent utenfor 0 til 100 avvises, og lister og tekst kortes", () => {
  for(const d of [null, [], svar({ prosent: 101 }), svar({ prosent: -1 }), svar({ prosent: "80" }), svar({ ekstra: 1 }), svar({ mangler: [{ krav: "K", alvor: "ukjent" }] })])
    assert.throws(() => tolkMatch(d, { cv: CV, annonse: ANNONSE }), e => e.code === "modellformat", JSON.stringify(d)?.slice(0, 60));
  const mange = Array.from({ length: 7 }, (_, i) => ({ krav: "Krav " + i, alvor: "middels" }));
  const m = tolkMatch(svar({ prosent: 49.6, oppsummering: "å".repeat(900), mangler: mange }), { cv: CV, annonse: ANNONSE });
  assert.equal(m.prosent, 50);
  assert.equal(m.mangler.length, 4);
  assert.equal(Array.from(m.oppsummering).length, 300);
});

/* ---------- utdatert ---------- */

test("en vurdering er utdatert når CV, annonse eller prompt har endret seg", () => {
  const annonse = { tekst: ANNONSE, sjekksum: sjekksum(ANNONSE) };
  const dok = { annonse, match: { prosent: 70, cvRevisjon: 2, annonseSjekksum: annonse.sjekksum, promptversjon: MATCH_PROMPTVERSJON } };
  assert.deepEqual(matchUtdatert(dok, { cvRevisjon: 2, promptversjon: MATCH_PROMPTVERSJON }), []);
  assert.deepEqual(matchUtdatert(dok, { cvRevisjon: 3, promptversjon: MATCH_PROMPTVERSJON }), ["cvRevisjon"]);
  assert.deepEqual(matchUtdatert(dok, { cvRevisjon: 2, promptversjon: "match-1" }), ["promptversjon"]);
  const ny = { ...dok, annonse: { tekst: ANNONSE + " Mer.", sjekksum: sjekksum(ANNONSE + " Mer.") } };
  assert.deepEqual(matchUtdatert(ny, { cvRevisjon: 2 }), ["annonseSjekksum"]);
  assert.deepEqual(matchUtdatert({ annonse }, { cvRevisjon: 9 }), []);
});

/* ---------- tjenesten ---------- */

async function tjeneste(t, { modell = async () => modellsvar(), foranKall, jobber = [{ id: "j1", selskap: "Eksempel AS", stilling: "Rådgiver" }] } = {}){
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "match-test-"));
  t.after(() => fs.rm(katalog, { recursive: true, force: true }));
  const lager = lagBrevlager(katalog);
  const jobbdokumenter = lagJobbdokumenter({ lager, hentJobb: async id => jobber.find(j => j.id === id), hentJobber: async () => jobber });
  const kall = [];
  const s = lagMatchtjeneste({ lager, jobbdokumenter, hentJobb: async id => jobber.find(j => j.id === id), foranKall,
    kallModell: async v => { kall.push(v); return modell(v); }, nå: () => new Date("2026-10-01T10:00:00Z") });
  const medCv = async (tekst = CV) => lager.skriv("cv.json", { tekst, navn: "", format: "tekst", oppdatert: null }, 0);
  return { s, lager, jobbdokumenter, kall, medCv };
}

test("tjenesten svarer med mangler-cv, mangler-annonse og finnes-ikke før modellen spørres", async t => {
  const { s, jobbdokumenter, kall, medCv } = await tjeneste(t);
  await assert.rejects(s.vurder("finnes-ikke"), e => e.code === "finnes-ikke" && e.status === 404);
  await assert.rejects(s.vurder("j1"), e => e.code === "mangler-cv" && e.status === 409);
  await medCv();
  await assert.rejects(s.vurder("j1"), e => e.code === "mangler-annonse" && e.status === 409);
  assert.equal(kall.length, 0);
  await jobbdokumenter.settAnnonse("j1", { tekst: ANNONSE, kilde: "limt" });
  await assert.rejects(s.vurder("j1", { leverandor: "ukjent" }), e => e.code === "ugyldig");
});

test("vurderingen lagres med grunnlaget, brukes om igjen og lages på nytt med tving", async t => {
  const { s, jobbdokumenter, kall, medCv } = await tjeneste(t);
  await medCv();
  await jobbdokumenter.settAnnonse("j1", { tekst: ANNONSE, kilde: "limt" });
  const d = await s.vurder("j1");
  assert.equal(d.match.prosent, 78);
  assert.equal(d.match.cvRevisjon, 1);
  assert.equal(d.match.annonseSjekksum, sjekksum(ANNONSE));
  assert.equal(d.match.promptversjon, "match-2");
  assert.equal(d.match.leverandor, "anthropic");
  assert.equal(d.match.modell, "claude-sonnet-5-5");
  assert.equal(d.match.vurdert, "2026-10-01T10:00:00.000Z");
  assert.equal(d.match.bruk.output_tokens, 50);
  assert.equal(d.annonse.tekst, ANNONSE, "annonsen er urørt");
  assert.equal(kall[0].formal, "vurdering");
  assert.equal(kall[0].trinn, "match");
  assert.equal((await s.vurder("j1")).revisjon, d.revisjon);
  assert.equal(kall.length, 1, "uendret grunnlag gir ingen nytt kall");
  await s.vurder("j1", { tving: true });
  assert.equal(kall.length, 2);
});

test("en ny CV eller en ny annonse gir et nytt kall, og samtidige kall deler ett", async t => {
  let slipp; const port = new Promise(r => { slipp = r; });
  const { s, jobbdokumenter, kall, lager, medCv } = await tjeneste(t, { modell: async () => { await port; return modellsvar(); } });
  await medCv();
  await jobbdokumenter.settAnnonse("j1", { tekst: ANNONSE, kilde: "limt" });
  const a = s.vurder("j1"), b = s.vurder("j1");
  slipp();
  assert.equal((await a).revisjon, (await b).revisjon);
  assert.equal(kall.length, 1);
  await lager.skriv("cv.json", { ...(await lager.les("cv.json")), tekst: CV + " Mer." }, 1);
  await s.vurder("j1");
  assert.equal(kall.length, 2);
});

test("feil fra modellen og fra kildesjekken lagrer ingenting", async t => {
  let neste = () => { throw Object.assign(new Error("Legg til API-nøkkelen for valgt leverandør."), { navn: "mangler-nokkel" }); };
  const { s, jobbdokumenter, medCv } = await tjeneste(t, { modell: async () => neste() });
  await medCv();
  await jobbdokumenter.settAnnonse("j1", { tekst: ANNONSE, kilde: "limt" });
  await assert.rejects(s.vurder("j1"), e => e.navn === "mangler-nokkel");
  neste = () => modellsvar(svar({ styrker: [{ krav: "K", bevis: "B", kilder: [{ kilde: "cv", sitat: "Finnes ikke" }] }] }));
  await assert.rejects(s.vurder("j1"), e => e.code === "kildefeil");
  assert.equal((await jobbdokumenter.hent("j1")).match, null);
});

test("taket stopper før modellen spørres, og et stopp lagrer ingenting", async t => {
  let n = 0;
  const { s, jobbdokumenter, kall, medCv } = await tjeneste(t, { foranKall: () => {
    if(++n > 2) throw Object.assign(new Error("tak"), { code: "for-mange", status: 429 });
  } });
  await medCv();
  await jobbdokumenter.settAnnonse("j1", { tekst: ANNONSE, kilde: "limt" });
  await s.vurder("j1", { tving: true });
  await s.vurder("j1", { tving: true });
  await assert.rejects(s.vurder("j1", { tving: true }), e => e.code === "for-mange");
  assert.equal(kall.length, 2);
});

/* ---------- ruten ---------- */

async function start(t, brevModellFor){
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "match-http-"));
  const brukere = lagBrukere({ katalog, iterasjoner: 1 });
  const server = lagServer({ katalog, brukere, ...(brevModellFor ? { brevModellFor } : {}) });
  await new Promise((ok, feil) => { server.once("error", feil); server.listen(0, "127.0.0.1", ok); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(r => server.close(r)); await fs.rm(katalog, { recursive: true, force: true }); });
  const r0 = await fetch(base + "/api/registrer", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ epost: "match@example.no", passord: "syntetisk-godt-passord" }) });
  assert.equal(r0.status, 201);
  const cookie = r0.headers.getSetCookie()[0].split(";")[0];
  const kall = async (p, method = "GET", body, c = cookie) => {
    const r = await fetch(base + p, { method, headers: { ...(c ? { cookie: c } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    return { status: r.status, data: await r.json() };
  };
  return { kall, base };
}
const grunnlag = async kall => {
  assert.equal((await kall("/api/jobber", "PUT", { versjon: 0, jobber: [{ id: "j1", selskap: "Eksempel AS", stilling: "Rådgiver", status: "todo", sektor: "annet", notat: "", frist: null, sendtDato: null, sted: "", lenke: "" }] })).status, 200);
};

test("ruten krever innlogging, kjenner søknaden og tillater bare POST", async t => {
  const { kall } = await start(t, () => async () => modellsvar());
  assert.equal((await kall("/api/jobber/j1/match", "POST", {}, "")).status, 401);
  assert.equal((await kall("/api/jobber/j1/match", "GET")).status, 405);
  assert.equal((await kall("/api/jobber/j1/match", "POST", {})).status, 404);
  await grunnlag(kall);
  assert.equal((await kall("/api/jobber/j1/match", "POST", "ikke json")).status, 400);
  assert.equal((await kall("/api/jobber/j1/match", "POST", { leverandor: "evil" })).status, 400);
});

test("ruten gir 409 uten CV og annonse, og 200 med vurderingen skrevet til dokumentet", async t => {
  const { kall } = await start(t, () => async () => modellsvar());
  await grunnlag(kall);
  let r = await kall("/api/jobber/j1/match", "POST", {});
  assert.equal(r.status, 409);assert.equal(r.data.feil, "mangler-cv");
  assert.equal((await kall("/api/cv", "PUT", { revisjon: 0, tekst: CV, navn: "", format: "tekst" })).status, 200);
  r = await kall("/api/jobber/j1/match", "POST", {});
  assert.equal(r.status, 409);assert.equal(r.data.feil, "mangler-annonse");
  assert.equal((await kall("/api/jobber/j1/annonse", "PUT", { tekst: ANNONSE, kilde: "limt" })).status, 200);
  r = await kall("/api/jobber/j1/match", "POST", { tving: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.match.prosent, 78);
  assert.equal(r.data.match.cvRevisjon, 1);
  const lest = await kall("/api/jobber/j1/dokument");
  assert.equal(lest.data.match.prosent, 78);
  const u = await kall("/api/jobbdokumenter/utdrag?stier=match.prosent");
  assert.equal(u.data["jobb-j1.json"]["match.prosent"], 78);
});

test("uten nøkkel svarer ruten mangler-nokkel uten å lekke noe", async t => {
  const { kall } = await start(t);
  await grunnlag(kall);
  await kall("/api/cv", "PUT", { revisjon: 0, tekst: CV, navn: "", format: "tekst" });
  await kall("/api/jobber/j1/annonse", "PUT", { tekst: ANNONSE, kilde: "limt" });
  const r = await kall("/api/jobber/j1/match", "POST", {});
  assert.equal(r.data.feil, "mangler-nokkel");
  assert.equal(r.status, 503);
});

test("høyst 60 vurderinger i timen per profil", async t => {
  const { kall } = await start(t, () => async () => modellsvar());
  await grunnlag(kall);
  await kall("/api/cv", "PUT", { revisjon: 0, tekst: CV, navn: "", format: "tekst" });
  await kall("/api/jobber/j1/annonse", "PUT", { tekst: ANNONSE, kilde: "limt" });
  for(let i = 0; i < 60; i++) assert.equal((await kall("/api/jobber/j1/match", "POST", { tving: true })).status, 200, "kall " + i);
  const r = await kall("/api/jobber/j1/match", "POST", { tving: true });
  assert.equal(r.status, 429);assert.equal(r.data.feil, "for-mange");
});
