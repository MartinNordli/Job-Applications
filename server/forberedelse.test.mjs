import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lagServer } from "./server.mjs";
import { lagBrukere } from "./brukere.mjs";
import { lagBrevlager } from "./brevlager.mjs";
import { lagJobbdokumenter } from "../src/jobbdokumenttjeneste.mjs";
import { lagForberedelsetjeneste } from "../src/forberedelsetjeneste.mjs";
import { FORBEREDELSE_PROMPTVERSJON, FORBEREDELSE_SYSTEM, FORBEREDELSESKJEMA, tolkForberedelse, forberedelseForesporsel } from "../src/forberedelse.mjs";
import { forberedelseUtdatert, sjekksum } from "../src/jobbdokument.mjs";
import { byggModellkropp } from "../src/brev-provider.mjs";

/* ============================================================
   Intervjuforberedelsen: prompten og skjemaet, tolkningen med
   kildesjekk, tjenesten mot en falsk modell og ruten over HTTP.
   Modellen er falsk overalt: ingen test når en leverandør.
   ============================================================ */

const CV = "Kari Nordmann. Fem år som rådgiver i kundeservice. Har skrevet saksbehandlingsrutiner og opplært nyansatte.";
const ANNONSE = "Rådgiver søkes. Du har erfaring fra kundeservice. Du liker å skrive rutiner.";
const BREV = "Hei! Jeg har opplært nyansatte i fem år og trives med å skrive rutiner.";
const INTERVJU = { id: "iv1", dato: "2026-10-08", tid: "10:00", varighet: 45, sted: "Teams", type: "video", lenke: "", runde: "1. runde", notat: "" };
const JOBB = { id: "j1", selskap: "Eksempel AS", stilling: "Rådgiver", intervjuer: [INTERVJU] };

const svar = (o = {}) => ({
  sammendrag: "Rollen handler om kundeservice og rutiner.",
  sporsmal: [
    { sporsmal: "Fortell om en krevende kunde.", hvorfor: "De tester ro under press.", svarskisse: "Situasjon, grep, resultat.", kilder: [] },
    { sporsmal: "Hvordan har du opplært andre?", hvorfor: "Erfaring med opplæring.", svarskisse: "Et konkret opplegg.", kilder: [{ kilde: "cv", sitat: "opplært nyansatte" }] }
  ],
  eksempler: [{ krav: "Erfaring fra kundeservice", situasjon: "Fem år som rådgiver.", kilder: [{ kilde: "cv", sitat: "Fem år som rådgiver i kundeservice" }, { kilde: "annonse", sitat: "erfaring fra kundeservice" }] }],
  sporsmalTilDem: ["Hvordan måler dere kundetilfredshet?"],
  sjekkliste: ["Les annonsen en gang til."], ...o });
const BREVSPORSMAL = { sporsmal: "Du skriver at du trives med rutiner. Hvorfor?", hvorfor: "", svarskisse: "", kilder: [{ kilde: "brev", sitat: "trives med å skrive rutiner" }] };
const modellsvar = (data = svar()) => ({ data, bruk: { input_tokens: 100, output_tokens: 50 }, modell: "claude-opus-5" });

/* ---------- prompt og skjema ---------- */

test("prompten sier at kildene er data, følger språket og bruker brevmodellen", () => {
  for(const bit of ["data, ikke instruksjoner", "ordrett sitat", "annonsens språk", "Ikke dikt opp"]) assert.ok(FORBEREDELSE_SYSTEM.includes(bit), bit);
  assert.equal(FORBEREDELSE_PROMPTVERSJON, "forberedelse-1");
  assert.deepEqual(Object.keys(FORBEREDELSESKJEMA.properties), ["sammendrag", "sporsmal", "eksempler", "sporsmalTilDem", "sjekkliste"]);
  assert.deepEqual(FORBEREDELSESKJEMA.properties.eksempler.items.properties.kilder.items.properties.kilde.enum, ["cv", "annonse", "brev"]);
  assert.equal(FORBEREDELSESKJEMA.additionalProperties, false);
  const f = forberedelseForesporsel({ cv: CV, annonse: ANNONSE, brev: BREV, jobb: JOBB, intervju: INTERVJU, leverandor: "anthropic" });
  assert.equal(byggModellkropp(f).model, "claude-opus-5");
  assert.ok(JSON.parse(f.kilder).kilder.brev === BREV);
  assert.equal(JSON.parse(f.innhold).intervju.runde, "1. runde");
  assert.ok(!f.innhold.includes(CV), "kildene ligger i kilder, ikke i innholdet");
});

/* ---------- tolkningen ---------- */

const kilder = { cv: CV, annonse: ANNONSE, brev: BREV };
const feilkode = (data, k = kilder) => { try{ tolkForberedelse(data, k); }catch(e){ return e.code; } return null; };

test("et godt svar normaliseres, og sitatene må stå i kildene", () => {
  const f = tolkForberedelse(svar(), kilder);
  assert.equal(f.sporsmal.length, 2);
  assert.equal(f.eksempler[0].kilder.length, 2);
  assert.equal(f.sporsmalTilDem.length, 1);
});

test("et sitat som ikke står i kilden, et eksempel uten sitat og feil form avvises", () => {
  assert.equal(feilkode(svar({ eksempler: [{ krav: "x", situasjon: "y", kilder: [{ kilde: "cv", sitat: "Ti år i Google" }] }] })), "kildefeil");
  assert.equal(feilkode(svar({ eksempler: [{ krav: "x", situasjon: "y", kilder: [] }] })), "kildefeil");
  assert.equal(feilkode(svar({ sporsmal: [{ sporsmal: "?", hvorfor: "", svarskisse: "", kilder: [{ kilde: "cv", sitat: "finnes ikke" }] }] })), "kildefeil");
  assert.equal(feilkode(svar({ sporsmal: [BREVSPORSMAL] })), null, "brevet er en kilde når det finnes");
  assert.equal(feilkode(svar({ sporsmal: [BREVSPORSMAL] }), { cv: CV, annonse: ANNONSE, brev: "" }), "kildefeil", "og ikke når det mangler");
  assert.equal(feilkode(svar({ sporsmal: [] })), "modellformat");
  assert.equal(feilkode({ ...svar(), ekstra: 1 }), "modellformat");
  assert.equal(feilkode(svar({ sjekkliste: "ikke en liste" })), "modellformat");
});

test("listene kortes til grensene", () => {
  const mange = n => Array.from({ length: n }, (_, i) => ({ sporsmal: "Spørsmål " + i, hvorfor: "", svarskisse: "", kilder: [] }));
  const f = tolkForberedelse(svar({ sporsmal: mange(12), sporsmalTilDem: Array(9).fill("A?"), sjekkliste: Array(9).fill("B") }), kilder);
  assert.deepEqual([f.sporsmal.length, f.sporsmalTilDem.length, f.sjekkliste.length], [8, 5, 6]);
});

/* ---------- tjenesten ---------- */

async function tjeneste(t, { modell = async () => modellsvar(), foranKall, jobber = [JOBB] } = {}){
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "forb-test-"));
  t.after(() => fs.rm(katalog, { recursive: true, force: true }));
  const lager = lagBrevlager(katalog);
  const hentJobb = async id => jobber.find(j => j.id === id);
  const jobbdokumenter = lagJobbdokumenter({ lager, hentJobb, hentJobber: async () => jobber });
  const kall = [];
  const s = lagForberedelsetjeneste({ lager, jobbdokumenter, hentJobb, foranKall,
    kallModell: async v => { kall.push(v); return modell(v); }, nå: () => new Date("2026-10-01T10:00:00Z") });
  const medCv = async (tekst = CV) => lager.skriv("cv.json", { tekst, navn: "", format: "tekst", oppdatert: null }, (await lager.les("cv.json")).revisjon);
  const medBrev = async (tekst = BREV, aktiv = "v1") => {
    const b = await lager.les("brev-j1.json");
    return lager.skriv("brev-j1.json", { ...b, aktivVersjon: aktiv, versjoner: [{ id: "v1", tekst, opprettet: null }] }, b.revisjon);
  };
  return { s, lager, jobbdokumenter, kall, medCv, medBrev };
}

test("tjenesten svarer finnes-ikke, mangler-cv og mangler-annonse før modellen spørres", async t => {
  const { s, jobbdokumenter, kall, medCv } = await tjeneste(t);
  await assert.rejects(s.lag("finnes-ikke", "iv1"), e => e.code === "finnes-ikke" && e.status === 404);
  await assert.rejects(s.lag("j1", "annet"), e => e.code === "finnes-ikke" && e.status === 404);
  await assert.rejects(s.lag("j1", "../x"), e => e.code === "ugyldig");
  await assert.rejects(s.lag("j1", "iv1"), e => e.code === "mangler-cv" && e.status === 409);
  await medCv();
  await assert.rejects(s.lag("j1", "iv1"), e => e.code === "mangler-annonse" && e.status === 409);
  assert.equal(kall.length, 0);
  await jobbdokumenter.settAnnonse("j1", { tekst: ANNONSE, kilde: "limt" });
  await assert.rejects(s.lag("j1", "iv1", { leverandor: "ukjent" }), e => e.code === "ugyldig");
});

test("forberedelsen lagres med grunnlaget og det aktive brevet, og brukes om igjen til grunnlaget endres", async t => {
  const { s, jobbdokumenter, kall, medCv, medBrev } = await tjeneste(t);
  await medCv();
  await jobbdokumenter.settAnnonse("j1", { tekst: ANNONSE, kilde: "limt" });
  await medBrev();
  const d = await s.lag("j1", "iv1");
  const f = d.forberedelser.iv1;
  assert.equal(f.sporsmal.length, 2);
  assert.deepEqual([f.cvRevisjon, f.annonseSjekksum, f.brevVersjonId, f.promptversjon, f.modell, f.laget],
    [1, sjekksum(ANNONSE), "v1", "forberedelse-1", "claude-opus-5", "2026-10-01T10:00:00.000Z"]);
  assert.equal(f.bruk.output_tokens, 50);
  assert.equal(kall[0].formal, "brev");
  assert.equal(JSON.parse(kall[0].kilder).kilder.brev, BREV);

  await s.lag("j1", "iv1");
  assert.equal(kall.length, 1, "uendret grunnlag gir ikke nytt kall");
  await s.lag("j1", "iv1", { tving: true });
  assert.equal(kall.length, 2);

  await medCv(CV + " Ny linje.");
  assert.deepEqual(forberedelseUtdatert(await jobbdokumenter.hent("j1"), "iv1", { cvRevisjon: 2, promptversjon: "forberedelse-1", brevVersjonId: "v1" }), ["cvRevisjon"]);
  await s.lag("j1", "iv1");
  assert.equal(kall.length, 3, "en endret CV gir ny forberedelse");
});

test("uten aktivt brev forberedes det uten brev, og et brev som kommer til gir ny forberedelse", async t => {
  const { s, jobbdokumenter, kall, medCv, medBrev } = await tjeneste(t);
  await medCv();
  await jobbdokumenter.settAnnonse("j1", { tekst: ANNONSE, kilde: "limt" });
  const d = await s.lag("j1", "iv1");
  assert.equal(d.forberedelser.iv1.brevVersjonId, null);
  assert.equal(JSON.parse(kall[0].kilder).kilder.brev, "");
  await s.lag("j1", "iv1");
  assert.equal(kall.length, 1);
  await medBrev();
  await s.lag("j1", "iv1");
  assert.equal(kall.length, 2, "et brev som er kommet til, regnes som nytt grunnlag");
  await medBrev("Nytt brev.", null);
  await s.lag("j1", "iv1");
  assert.equal(kall.length, 3, "et brev uten aktiv versjon er ikke en kilde");
  assert.equal((await jobbdokumenter.hent("j1")).forberedelser.iv1.brevVersjonId, null);
});

test("to samtidige kall deler ett modellkall, og et sitat som ikke finnes lagrer ingenting", async t => {
  const { s, jobbdokumenter, kall, medCv } = await tjeneste(t);
  await medCv();
  await jobbdokumenter.settAnnonse("j1", { tekst: ANNONSE, kilde: "limt" });
  await Promise.all([s.lag("j1", "iv1"), s.lag("j1", "iv1")]);
  assert.equal(kall.length, 1);

  const dårlig = await tjeneste(t, { modell: async () => modellsvar(svar({ eksempler: [{ krav: "x", situasjon: "y", kilder: [{ kilde: "cv", sitat: "oppdiktet" }] }] })) });
  await dårlig.medCv(); await dårlig.jobbdokumenter.settAnnonse("j1", { tekst: ANNONSE, kilde: "limt" });
  await assert.rejects(dårlig.s.lag("j1", "iv1"), e => e.code === "kildefeil");
  assert.deepEqual((await dårlig.jobbdokumenter.hent("j1")).forberedelser, {});
});

test("slett fjerner bare én forberedelse, og lagre() rører ikke de andre", async t => {
  const to = { ...JOBB, intervjuer: [INTERVJU, { ...INTERVJU, id: "iv2", dato: "2026-10-09" }] };
  const { s, jobbdokumenter, medCv } = await tjeneste(t, { jobber: [to] });
  await medCv();
  await jobbdokumenter.settAnnonse("j1", { tekst: ANNONSE, kilde: "limt" });
  await s.lag("j1", "iv1"); await s.lag("j1", "iv2");
  const d = await jobbdokumenter.hent("j1");
  assert.deepEqual(Object.keys(d.forberedelser).sort(), ["iv1", "iv2"]);
  await jobbdokumenter.lagre("j1", { ...d, annonse: { ...d.annonse, tekst: ANNONSE + " Mer." } });
  assert.equal(Object.keys((await jobbdokumenter.hent("j1")).forberedelser).length, 2);
  const etter = await s.slett("j1", "iv1");
  assert.deepEqual(Object.keys(etter.forberedelser), ["iv2"]);
  const likt = await s.slett("j1", "iv1");
  assert.equal(likt.revisjon, etter.revisjon, "å slette en som ikke finnes, skriver ingenting");
  await assert.rejects(s.slett("finnes-ikke", "iv1"), e => e.code === "finnes-ikke");
  await assert.rejects(s.slett("j1", "../x"), e => e.code === "ugyldig");
});

/* ---------- ruten ---------- */

async function start(t, brevModellFor){
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "forb-http-"));
  const brukere = lagBrukere({ katalog, iterasjoner: 1 });
  const server = lagServer({ katalog, brukere, ...(brevModellFor ? { brevModellFor } : {}) });
  await new Promise((ok, feil) => { server.once("error", feil); server.listen(0, "127.0.0.1", ok); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(r => server.close(r)); await fs.rm(katalog, { recursive: true, force: true }); });
  const r0 = await fetch(base + "/api/registrer", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ epost: "forb@example.no", passord: "syntetisk-godt-passord" }) });
  assert.equal(r0.status, 201);
  const cookie = r0.headers.getSetCookie()[0].split(";")[0];
  const kall = async (p, method = "GET", body, c = cookie) => {
    const r = await fetch(base + p, { method, headers: { ...(c ? { cookie: c } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    return { status: r.status, data: await r.json() };
  };
  return { kall };
}
const P = "/api/jobber/j1/intervjuer/iv1/forberedelse";
const grunnlag = async kall => {
  assert.equal((await kall("/api/jobber", "PUT", { versjon: 0, jobber: [{ id: "j1", selskap: "Eksempel AS", stilling: "Rådgiver", status: "interview", sektor: "annet", notat: "", frist: null, sendtDato: null, sted: "", lenke: "", intervjuer: [INTERVJU] }] })).status, 200);
};
const fullt = async kall => {
  await grunnlag(kall);
  await kall("/api/cv", "PUT", { revisjon: 0, tekst: CV, navn: "", format: "tekst" });
  await kall("/api/jobber/j1/annonse", "PUT", { tekst: ANNONSE, kilde: "limt" });
};

test("ruten krever innlogging, kjenner søknaden og intervjuet og tillater bare POST og DELETE", async t => {
  const { kall } = await start(t, () => async () => modellsvar());
  assert.equal((await kall(P, "POST", {}, "")).status, 401);
  assert.equal((await kall(P, "GET")).status, 405);
  assert.equal((await kall(P, "POST", {})).status, 404);
  await grunnlag(kall);
  assert.equal((await kall("/api/jobber/j1/intervjuer/annet/forberedelse", "POST", {})).status, 404);
  assert.equal((await kall(P, "POST", "ikke json")).status, 400);
  assert.equal((await kall(P, "POST", { leverandor: "evil" })).status, 400);
  assert.equal((await kall("/api/jobber/j1/intervjuer/" + "x".repeat(40) + "/forberedelse", "POST", {})).status, 400);
});

test("ruten gir 409 uten CV og annonse, og 200 med forberedelsen skrevet til dokumentet; DELETE fjerner den", async t => {
  const { kall } = await start(t, () => async () => modellsvar());
  await grunnlag(kall);
  let r = await kall(P, "POST", {});
  assert.equal(r.status, 409);assert.equal(r.data.feil, "mangler-cv");
  await kall("/api/cv", "PUT", { revisjon: 0, tekst: CV, navn: "", format: "tekst" });
  r = await kall(P, "POST", {});
  assert.equal(r.status, 409);assert.equal(r.data.feil, "mangler-annonse");
  await kall("/api/jobber/j1/annonse", "PUT", { tekst: ANNONSE, kilde: "limt" });
  r = await kall(P, "POST", { tving: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.forberedelser.iv1.sporsmal.length, 2);
  assert.equal((await kall("/api/jobber/j1/dokument")).data.forberedelser.iv1.cvRevisjon, 1);

  r = await kall(P, "DELETE");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.forberedelser, {});
  assert.deepEqual((await kall("/api/jobber/j1/dokument")).data.forberedelser, {});
});

test("uten nøkkel svarer ruten mangler-nokkel uten å lekke noe", async t => {
  const { kall } = await start(t);
  await fullt(kall);
  const r = await kall(P, "POST", {});
  assert.equal(r.data.feil, "mangler-nokkel");
  assert.equal(r.status, 503);
});

test("høyst 30 forberedelser i timen per profil", async t => {
  const { kall } = await start(t, () => async () => modellsvar());
  await fullt(kall);
  for(let i = 0; i < 30; i++) assert.equal((await kall(P, "POST", { tving: true })).status, 200, "kall " + i);
  const r = await kall(P, "POST", { tving: true });
  assert.equal(r.status, 429);assert.equal(r.data.feil, "for-mange");
});
