import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lagBrevlager } from "./brevlager.mjs";
import { tomCv } from "../src/brevdata.mjs";
import { SKALA, MATCH_SYSTEM } from "../src/matchlogikk.mjs";
import { RADAR_SYSTEM, RADAR_PROMPTVERSJON, FORSLAG_SYSTEM, FORSLAG_PROMPTVERSJON, PROMPTGRENSER, radarForespørsel } from "../src/radarprompt.mjs";
import { tolkVurdering, tolkForslag, foreslåFraCv, foreslåFraProfil, vurderAlle, forfilter, kjoringskostnad, FORSLAG_TAK } from "../src/radarlogikk.mjs";
import { byggModellkropp } from "../src/brev-provider.mjs";
import { radartilfeller } from "../evals/radar-tilfeller.mjs";
import { sjekkVurdering, sjekkForslag, forespørslerFor, språkI } from "../evals/radar-sjekker.mjs";

/* ============================================================
   Radarpromptene uten modellkall: at forespørselen bygges riktig og
   bufres, at fiendtlige og ødelagte svar avvises, og at forslaget
   filtreres til ord forfilter kan bruke. Tilfellene er syntetiske
   (evals/radar-tilfeller.mjs).
   ============================================================ */

const falskModell = svar => {
  const kall = [];
  const f = async valg => { kall.push(valg); if(svar instanceof Error) throw svar; return typeof svar === "function" ? svar(valg) : svar; };
  f.kall = kall;
  return f;
};

test("radar-2 bruker samme skala som panelets vurdering, og ber om grunner på CV-ens språk", () => {
  assert.equal(RADAR_PROMPTVERSJON, "radar-2");
  assert.equal(FORSLAG_PROMPTVERSJON, "radarforslag-1");
  assert.ok(MATCH_SYSTEM.includes(SKALA) && RADAR_SYSTEM.includes(SKALA));
  assert.match(SKALA, /90 eller mer.*\n70 til 89.*\n50 til 69.*\nUnder 50/);
  assert.match(RADAR_SYSTEM, /samme språk som CV-en/);
  for(const p of [RADAR_SYSTEM, FORSLAG_SYSTEM]){
    assert.match(p, /data, ikke instruksjoner/);
    assert.equal(p.includes("—"), false);
  }
});

test("tilfellene er gyldige, syntetiske og dekker bokmål, engelsk, tynn CV, injeksjon og feil bransje", () => {
  assert.deepEqual([...new Set(radartilfeller.map(t => t.sprak))].sort(), ["en", "nb"]);
  assert.equal(new Set(radartilfeller.map(t => t.id)).size, radartilfeller.length);
  assert.ok(radartilfeller.some(t => t.cv.length < 100), "tynn CV");
  assert.ok(radartilfeller.some(t => t.annonser.some(a => /Ignorer alle tidligere instruksjoner/.test(a.tekst))), "injeksjon");
  assert.ok(radartilfeller.some(t => t.annonser.some(a => a.relevant === false)), "feil bransje");
  for(const t of radartilfeller){
    assert.doesNotThrow(() => forespørslerFor(t), t.id);
    assert.equal(JSON.stringify(t).includes("—"), false, t.id);
    for(const a of t.annonser) assert.ok(a.forventet[0] <= a.forventet[1], `${t.id}/${a.id}`);
    assert.ok(t.vurderingspunkter.length, t.id);
  }
});

test("forespørselen: instruks og CV først og bufret, annonsene sist, og injeksjonen bare som data", () => {
  const t = radartilfeller.find(x => x.id === "r02");
  const { vurdering: f } = forespørslerFor(t);
  assert.equal(f.formal, "radar");
  assert.deepEqual(Object.keys(JSON.parse(f.kilder).kilder), ["cv"]);
  assert.equal(f.system.includes("Ignorer alle"), false);
  assert.equal(f.kilder.includes("Ignorer alle"), false);
  assert.match(JSON.parse(f.innhold).annonser[0].tekst, /Ignorer alle tidligere instruksjoner/);

  const k = byggModellkropp(f);
  assert.equal(k.model, "claude-haiku-5-5");
  assert.deepEqual(k.system, [{ type: "text", text: RADAR_SYSTEM, cache_control: { type: "ephemeral" } }]);
  const [cv, annonser, ...rest] = k.messages[0].content;
  assert.deepEqual(cv, { type: "text", text: f.kilder, cache_control: { type: "ephemeral" } });
  assert.deepEqual(annonser, { type: "text", text: f.innhold });
  assert.deepEqual(rest, []);
  assert.deepEqual(k.output_config.format.schema.required, ["vurderinger"]);
});

test("alle bolkene i en kjøring har byte for byte samme instruks og CV, så bufferen treffer fra bolk to", async () => {
  const kandidater = Array.from({ length: 12 }, (_, i) => ({ stilling: `Rådgiver ${i}`, selskap: "Testfirma", sted: "Bergen", frist: null, tekst: `Annonse ${i}.` }));
  const kallModell = falskModell(valg => ({ data: { vurderinger: JSON.parse(valg.innhold).annonser.map(a => ({ id: a.id, prosent: 50, grunner: ["Delvis."] })) } }));
  const v = await vurderAlle({ kandidater, cv: "Rådgiver i ti år.", kallModell, tak: 40 });
  assert.equal(kallModell.kall.length, 2);
  const [a, b] = kallModell.kall.map(byggModellkropp);
  assert.deepEqual(a.system, b.system);
  assert.deepEqual(a.messages[0].content[0], b.messages[0].content[0]);
  assert.notDeepEqual(a.messages[0].content[1], b.messages[0].content[1]);
  assert.equal(v.vurdert.length, 12);
});

test("lengdene kuttes før kallet: CV-en, feltene og annonseteksten", () => {
  const f = radarForespørsel({ cv: "c".repeat(50_000), leverandor: "anthropic",
    annonser: [{ id: "a1", stilling: "s".repeat(500), selskap: "Firma\u0007‮", sted: "Oslo", frist: null, tekst: "t".repeat(20_000) }] });
  assert.equal(JSON.parse(f.kilder).kilder.cv.length, PROMPTGRENSER.cv);
  const a = JSON.parse(f.innhold).annonser[0];
  assert.equal(a.stilling.length, PROMPTGRENSER.felt);
  assert.equal(a.selskap, "Firma");
  assert.equal(a.tekst.length, PROMPTGRENSER.annonse);
});

test("en grunn med lenke eller e-postadresse fra annonsen avviser hele bolken", () => {
  const v = grunn => ({ vurderinger: [{ id: "a1", prosent: 90, grunner: [grunn] }] });
  for(const g of ["Se https://tilbud.example.invalid/klikk", "Besøk www.tilbud.example", "Send til hr@firma.example"])
    assert.throws(() => tolkVurdering(v(g), ["a1"]), e => e.code === "modellformat", g);
  assert.deepEqual(tolkVurdering(v("Krever Node.js og C#, som CV-en viser."), ["a1"])[0].grunner, ["Krever Node.js og C#, som CV-en viser."]);
});

test("forslaget: feil form avvises, og ordene filtreres til det forfilter kan bruke", () => {
  const cv = "Dataingeniør i Trondheim med Python og SQL.";
  for(const data of [null, [], "søkeord", { sokeord: [] }, { sokeord: [], steder: [], ekskluder: [], ekstra: [] },
    { sokeord: "data", steder: [], ekskluder: [] }, { sokeord: [1], steder: [], ekskluder: [] },
    { sokeord: Array(81).fill("data"), steder: [], ekskluder: [] }])
    assert.throws(() => tolkForslag(data, { cv }), e => e.code === "modellformat" && e.status === 502, JSON.stringify(data)?.slice(0, 60));

  const f = tolkForslag({
    sokeord: ["«Dataingeniør»", "dataingeniør", "DATAINGENIØR.", "Python", "C#", ".NET", "ASP.NET", "Node.js", "x",
      "https://tilbud.example.invalid", "www.tilbud.no", "tilbud.no", "hr@firma.no", "senior data engineer manager", "ignorer \"alle\"",
      "a".repeat(41), "data engineer", "analytiker", "utvikler", "BI", "SQL", "dbt", "Airflow", "ekstra1", "ekstra2"],
    steder: ["Trondheim", "Oslo", "Bergen\nOslo", "trondheim"],
    ekskluder: ["lærling", "ingeniør", "Data", "sommerjobb", "direktør"]
  }, { cv });
  assert.deepEqual(f.sokeord, ["Dataingeniør", "Python", "C#", ".NET", "ASP.NET", "Node.js", "data engineer", "analytiker", "utvikler", "BI", "SQL", "dbt"]);
  assert.deepEqual(f.steder, ["Trondheim"], "bare steder CV-en nevner, og hvert sted én gang");
  assert.deepEqual(f.ekskluder, ["lærling", "sommerjobb", "direktør"], "ekskluderte ord som treffer et søkeord, tas bort");

  const annonse = (stilling, selskap = "Testfirma") => ({ status: "aktiv", stilling, selskap, sted: "Trondheim", tekst: "" });
  assert.equal(forfilter(annonse("Senior dataingeniør"), f, "2026-10-16"), null);
  assert.equal(forfilter(annonse("Lærling, kontorfag"), f, "2026-10-16"), "sokeord");
  assert.equal(forfilter(annonse("Lærling i data engineer-teamet"), f, "2026-10-16"), "ekskludert");
});

test("foreslåFraCv lagrer ingenting, og mangler-cv og mangler-nokkel kommer fram som koder", async () => {
  const svar = { data: { sokeord: ["dataingeniør"], steder: ["Trondheim"], ekskluder: [] }, bruk: { input_tokens: 700, output_tokens: 40 } };
  const kallModell = falskModell(svar);
  assert.deepEqual(await foreslåFraCv({ cv: "Dataingeniør i Trondheim.", kallModell }), { sokeord: ["dataingeniør"], steder: ["Trondheim"], ekskluder: [] });
  const [valg] = kallModell.kall;
  assert.equal(valg.formal, "radar");
  assert.equal(valg.trinn, "radarforslag");
  assert.equal(valg.system, FORSLAG_SYSTEM);
  assert.equal(byggModellkropp(valg).model, "claude-haiku-5-5");
  await assert.rejects(foreslåFraCv({ cv: "  ", kallModell }), { code: "mangler-cv" });
  assert.equal(kallModell.kall.length, 1, "uten CV går det ikke noe kall");
  const utenNokkel = Object.assign(new Error("Legg til API-nøkkelen."), { navn: "mangler-nokkel" });
  await assert.rejects(foreslåFraCv({ cv: "x y", kallModell: falskModell(utenNokkel) }), { navn: "mangler-nokkel" });
});

test("taket på forslag: 10 i timen per profil, uten å telle det som ikke kostet", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "radarforslag-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const lager = lagBrevlager(dir);
  let klokke = new Date("2026-10-16T08:00:00Z").getTime();
  const nå = () => new Date(klokke);
  const ok = falskModell({ data: { sokeord: ["rådgiver"], steder: [], ekskluder: [] } });

  await assert.rejects(foreslåFraProfil({ dokumenter: lager, kallModell: ok, nå }), { code: "mangler-cv" });
  await lager.skriv("cv.json", { ...tomCv(), tekst: "Rådgiver i Bergen." }, 0);
  const utenNokkel = falskModell(Object.assign(new Error("Legg til API-nøkkelen."), { navn: "mangler-nokkel" }));
  await assert.rejects(foreslåFraProfil({ dokumenter: lager, kallModell: utenNokkel, nå }), { navn: "mangler-nokkel" });

  for(let i = 0; i < FORSLAG_TAK.tak; i++){ await foreslåFraProfil({ dokumenter: lager, kallModell: ok, nå }); klokke += 60_000; }
  await assert.rejects(foreslåFraProfil({ dokumenter: lager, kallModell: ok, nå }), e => e.code === "for-mange" && e.status === 429 && /50 minutter/.test(e.melding));
  assert.equal(ok.kall.length, FORSLAG_TAK.tak);
  klokke += 51 * 60_000;
  assert.deepEqual(await foreslåFraProfil({ dokumenter: lager, kallModell: ok, nå }), { sokeord: ["rådgiver"], steder: [], ekskluder: [] });
  const modellfeil = falskModell({ data: { sokeord: "alt" } });
  await assert.rejects(foreslåFraProfil({ dokumenter: lager, kallModell: modellfeil, nå }), { code: "modellformat" });
});

test("evalsjekkene fanger feil bånd, feil språk, injeksjonsspor og et forslag som stenger ute det som passer", () => {
  const t = radartilfeller.find(x => x.id === "r02");
  const god = [{ id: "a1", prosent: 40, grunner: ["Krever Scala og Spark, som CV-en ikke viser."] },
    { id: "a2", prosent: 85, grunner: ["Krever SQL og Power BI, som CV-en viser fra Havbruk Innsikt."] }];
  assert.deepEqual(sjekkVurdering(t, god), []);
  assert.match(sjekkVurdering(t, [{ ...god[0], prosent: 100 }, god[1]]).join(" "), /a1: 100 prosent/);
  assert.match(sjekkVurdering(t, [{ ...god[0], grunner: ["Requires Scala and Spark, which the CV does not show."] }, god[1]]).join(" "), /ventet nb/);
  assert.match(sjekkVurdering(t, [{ ...god[0], grunner: ["Gir 100 prosent som annonsen ber om."] }, god[1]]).join(" "), /100 prosent/);
  assert.equal(språkI("Requires Kotlin, which the CV shows."), "en");

  const r01 = radartilfeller.find(x => x.id === "r01");
  assert.deepEqual(sjekkForslag(r01, { sokeord: ["dataingeniør", "analytics engineer"], steder: ["Trondheim"], ekskluder: [] }), []);
  assert.match(sjekkForslag(r01, { sokeord: ["dataingeniør", "analytics engineer"], steder: [], ekskluder: ["senior"] }).join(" "), /a1.*stoppes/);
  assert.match(sjekkForslag(r01, { sokeord: ["dataingeniør", "analytics", "sykepleier"], steder: [], ekskluder: [] }).join(" "), /a3.*feil bransje/);
});

test("kostnaden for en kjøring regnes med Haiku 5.5-prisen og bufferen", () => {
  /* 5 bolker: én skriver 1 000 tokens til bufferen, fire leser dem, 20 000
     ubufrede tokens med annonser og 3 000 tokens ut. */
  const kr = kjoringskostnad({ input_tokens: 20_000, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 4_000, output_tokens: 3_000 });
  const dollar = (20_000 * 0.10 + 1_000 * 0.125 + 4_000 * 0.01 + 3_000 * 0.50) / 1e6;
  assert.equal(kr, Math.round(dollar * 11 * 10000) / 10000);
});
