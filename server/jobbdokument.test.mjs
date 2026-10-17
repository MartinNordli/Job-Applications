import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { dokumenttype, dokumentId, navnFor } from "../src/dokumentnavn.mjs";
import { dokumentnavn, lesDokument, harInnhold, skjemaFor } from "../src/brevdata.mjs";
import { sjekksum, validerJobbdokument, validerRadar, tomtJobbdokument, normaliserMatch,
  matchUtdatert, forberedelseUtdatert, utdatert, MAKS_ANNONSE, tomRadar, RADAR } from "../src/jobbdokument.mjs";
import { tolkStier, utdragAv } from "../src/dokumentutdrag.mjs";

/* Den samme filen leses av Rust-testene i src-tauri/src/brev.rs. */
const felles = JSON.parse(await fs.readFile(new URL("../testdata/dokumenter.json", import.meta.url), "utf8"));

const match = (over = {}) => ({ prosent: 82, oppsummering: "Passer godt.", styrker: [], mangler: [], sprak: "nb",
  cvRevisjon: 3, annonseSjekksum: sjekksum("Annonse."), promptversjon: "match-1", leverandor: "anthropic",
  modell: "syntetisk", vurdert: "2026-10-01T10:00:00.000Z", bruk: { input_tokens: 10, output_tokens: 5 }, ...over });
const dok = (over = {}) => ({ skjemaVersjon: 1, revisjon: 1, annonse: { tekst: "Annonse.", url: "", kilde: "limt", hentet: null }, ...over });

/* ---------- navn ---------- */

test("dokumentnavnene er de samme som i Rust", () => {
  for(const [navn, type] of Object.entries(felles.navn.gyldige)){
    assert.equal(dokumenttype(navn), type, navn);
    assert.equal(dokumentnavn(navn), navn);
  }
  for(const navn of felles.navn.ugyldige){
    assert.equal(dokumenttype(navn), null, JSON.stringify(navn));
    assert.throws(() => dokumentnavn(navn), e => e.code === "ugyldig", JSON.stringify(navn));
  }
  for(const navn of [undefined, null, 1, {}, ["cv.json"]]) assert.equal(dokumenttype(navn), null);
});

test("id og navn går begge veier, og bare for typer med id", () => {
  assert.equal(dokumentId("jobb-abc.json"), "abc");
  assert.equal(dokumentId("brev-abc.json"), "abc");
  assert.equal(dokumentId("cv.json"), null);
  assert.equal(dokumentId("radar.json"), null);
  assert.equal(navnFor("jobb", "abc"), "jobb-abc.json");
  assert.equal(navnFor("jobb", "../x"), null);
  assert.equal(navnFor("radar", "x"), null);
  assert.equal(navnFor("__proto__", "x"), null);
});

/* ---------- sjekksum ---------- */

test("sjekksummen er FNV-1a og stabil over versjoner", () => {
  // Kjente testverdier for FNV-1a 32 bit, og én låst norsk tekst: endres
  // normaliseringen, blir alle lagrede vurderinger utdaterte på en gang.
  assert.equal(sjekksum(""), "811c9dc5");
  assert.equal(sjekksum("a"), "e40c292c");
  assert.equal(sjekksum("foobar"), "bf9cf968");
  assert.equal(sjekksum("Vi søker en rådgiver i Oslo."), "bcf4da54");
  assert.match(sjekksum("x".repeat(MAKS_ANNONSE)), /^[0-9a-f]{8}$/);
});

test("sjekksummen ser bort fra NFKC-forskjeller og mellomrom", () => {
  const like = [
    ["ﬁne", "fine"],                       // ligatur
    ["Ａ", "A"],                            // full bredde
    ["å", "å"],                       // dekomponert og sammensatt
    ["a b", "a b"],                    // hardt mellomrom
    ["  Vi søker\r\n\r\n\ten rådgiver  ", "Vi søker en rådgiver"],
    ["linje linje", "linje linje"]
  ];
  for(const [a, b] of like) assert.equal(sjekksum(a), sjekksum(b), `${JSON.stringify(a)} og ${JSON.stringify(b)}`);
  assert.notEqual(sjekksum("Vi søker en rådgiver"), sjekksum("Vi søker en Rådgiver"));
  assert.notEqual(sjekksum("ab"), sjekksum("a b"));
});

/* ---------- dokumentet ---------- */

test("et tomt eller minimalt dokument får hele formen", () => {
  assert.deepEqual(lesDokument("jobb-j1.json", null), tomtJobbdokument("j1"));
  // Det Rust lager etter en sletting: bare skjema, revisjon og tidsstempel.
  const fraRust = lesDokument("jobb-j1.json", JSON.stringify({ skjemaVersjon: 1, revisjon: 4, oppdatert: null }));
  assert.deepEqual(fraRust, { ...tomtJobbdokument("j1"), revisjon: 4 });
  assert.deepEqual(lesDokument("radar.json", JSON.stringify({ skjemaVersjon: 1, revisjon: 2, oppdatert: null })),
    { ...tomRadar(), revisjon: 2 });
  assert.equal(skjemaFor("jobb-j1.json"), 1);
  assert.equal(skjemaFor("radar.json"), 2);
});

test("lesDokument velger validator etter navnet og avviser ukjent skjema", () => {
  const rå = JSON.stringify(dok({ jobbId: "noe-annet", ukjent: "felt", tekst: "brevfelt" }));
  const d = lesDokument("jobb-j1.json", rå);
  assert.equal(d.jobbId, "j1");
  assert.deepEqual(Object.keys(d).sort(), ["annonse", "forberedelser", "jobbId", "match", "oppdatert", "revisjon", "skjemaVersjon"]);
  assert.throws(() => lesDokument("jobb-j1.json", JSON.stringify(dok({ skjemaVersjon: 2 }))), e => e.code === "versjon" && e.status === 409);
  assert.throws(() => lesDokument("jobb-j1.json", "ikke json"), e => e.code === "odelagt" && e.status === 503);
  assert.throws(() => lesDokument("jobb-../x.json", null), e => e.code === "ugyldig");
  assert.throws(() => lesDokument("jobb-j1.json", JSON.stringify(dok({ revisjon: -1 }))), e => e.code === "ugyldig");
  // Uten skjemaversjon vet vi ikke hva det er, og da tolkes det ikke.
  assert.throws(() => lesDokument("jobb-j1.json", "[]"), e => e.code === "versjon");
  assert.throws(() => validerJobbdokument("j1", []), e => e.code === "ugyldig");
});

test("annonsen valideres strengt, og sjekksummen regnes alltid ut her", () => {
  const d = validerJobbdokument("j1", dok({ annonse: { tekst: "Annonse.", url: "https://example.invalid/a", kilde: "hentet",
    hentet: "2026-10-01T10:00:00.000Z", sjekksum: "deadbeef", ekstra: 1 } }));
  assert.deepEqual(d.annonse, { tekst: "Annonse.", url: "https://example.invalid/a", kilde: "hentet",
    hentet: "2026-10-01T10:00:00.000Z", sjekksum: sjekksum("Annonse.") });
  assert.equal(validerJobbdokument("j1", dok({ annonse: { tekst: "  \n " } })).annonse.sjekksum, null);
  assert.equal(validerJobbdokument("j1", dok({ annonse: { tekst: "x", hentet: "i går" } })).annonse.hentet, null);
  for(const kilde of ["import", "hentet", "limt", "radar", "brev", null])
    assert.equal(validerJobbdokument("j1", dok({ annonse: { tekst: "x", kilde } })).annonse.kilde, kilde);
  const ugyldige = [
    { tekst: "x".repeat(MAKS_ANNONSE + 1) }, { tekst: "a\0b" }, { tekst: 5 },
    { tekst: "x", url: "javascript:alert(1)" }, { tekst: "x", url: "file:///etc/passwd" }, { tekst: "x", url: "x".repeat(2001) },
    { tekst: "x", kilde: "modell" }, { tekst: "x", kilde: "" }, "tekst", []
  ];
  for(const annonse of ugyldige)
    assert.throws(() => validerJobbdokument("j1", dok({ annonse })), e => e.code === "ugyldig", JSON.stringify(annonse).slice(0, 60));
  assert.equal(validerJobbdokument("j1", dok({ annonse: { tekst: "x".repeat(MAKS_ANNONSE) } })).annonse.tekst.length, MAKS_ANNONSE);
});

test("match normaliseres tilgivende og blir null uten gyldig prosent", () => {
  for(const prosent of [undefined, null, "82", -1, 101, NaN, Infinity])
    assert.equal(normaliserMatch(match({ prosent })), null, String(prosent));
  for(const m of [null, "match", [match()], 5]) assert.equal(normaliserMatch(m), null);
  const m = normaliserMatch(match({
    prosent: 81.6, ukjent: "bort", oppsummering: "ø".repeat(5000),
    styrker: [
      { krav: "Python", bevis: "Bygget kontroller.", kilder: [{ kilde: "cv", sitat: "Python" }, { kilde: "kontekst", sitat: "x" }, { kilde: "annonse", sitat: "" }, "x"] },
      { bevis: "uten krav" }, "tekst", { krav: "B" }, { krav: "C" }, { krav: "D" }, { krav: "E" }
    ],
    mangler: [{ krav: "Sertifisering", alvor: "hoy" }, { krav: "Førerkort", alvor: "katastrofe" }, { alvor: "lav" }],
    cvRevisjon: -2, annonseSjekksum: "IKKEHEX!", leverandor: "noen", modell: "", bruk: { input_tokens: 4, output_tokens: -1, hemmelig: 9 }
  }));
  assert.equal(m.prosent, 82);
  assert.equal(m.oppsummering.length, 1200);
  assert.equal(m.styrker.length, 4);
  assert.deepEqual(m.styrker[0], { krav: "Python", bevis: "Bygget kontroller.", kilder: [{ kilde: "cv", sitat: "Python" }] });
  assert.deepEqual(m.mangler, [{ krav: "Sertifisering", alvor: "hoy" }, { krav: "Førerkort", alvor: "middels" }]);
  assert.equal(m.cvRevisjon, null);
  assert.equal(m.annonseSjekksum, null);
  assert.equal(m.leverandor, null);
  assert.equal(m.modell, null);
  assert.deepEqual(m.bruk, { input_tokens: 4 });
  assert.equal("ukjent" in m, false);
  assert.deepEqual(Object.keys(normaliserMatch(match())).sort(), ["annonseSjekksum", "bruk", "cvRevisjon", "leverandor", "mangler",
    "modell", "oppsummering", "promptversjon", "prosent", "sprak", "styrker", "vurdert"]);
});

test("forberedelsene har gyldige intervju-id-er og kan ikke forurense prototypen", () => {
  const rå = `{"skjemaVersjon":1,"revisjon":1,"forberedelser":{"__proto__":{"forurenset":true},"i1":{"sammendrag":"Kort.","sporsmal":[{"sporsmal":"Hvorfor oss?","kilder":[{"kilde":"brev","sitat":"x"}]}],"sjekkliste":["a","",5,"b"],"brevVersjonId":"v1","ukjent":1},"../i2":{"sammendrag":"bort"},"i3":"tekst"}}`;
  const d = lesDokument("jobb-j1.json", rå);
  assert.deepEqual(Object.keys(d.forberedelser), ["i1"]);
  assert.equal(Object.getPrototypeOf(d.forberedelser), Object.prototype);
  assert.equal({}.forurenset, undefined);
  const f = d.forberedelser.i1;
  assert.equal(f.sporsmal[0].kilder[0].kilde, "brev");
  assert.deepEqual(f.sjekkliste, ["a", "b"]);
  assert.equal(f.brevVersjonId, "v1");
  assert.equal("ukjent" in f, false);
  const mange = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`i${i}`, { sammendrag: "x", sporsmal: Array(20).fill({ sporsmal: "?" }) }]));
  const n = validerJobbdokument("j1", dok({ forberedelser: mange }));
  assert.equal(Object.keys(n.forberedelser).length, 40);
  assert.equal(n.forberedelser.i0.sporsmal.length, 8);
});

test("dokumentet har et tak på 4 MiB", () => {
  const kilder = Array(6).fill({ kilde: "cv", sitat: "æ".repeat(600) });
  const stor = { sammendrag: "æ".repeat(2000), sporsmal: Array(8).fill({ sporsmal: "æ".repeat(600), hvorfor: "æ".repeat(800), svarskisse: "æ".repeat(2000), kilder }),
    eksempler: Array(5).fill({ krav: "æ".repeat(400), situasjon: "æ".repeat(2000), kilder }) };
  const forberedelser = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`i${i}`, stor]));
  assert.throws(() => validerJobbdokument("j1", dok({ forberedelser })), e => e.code === "for-stort" && e.status === 413);
});

/* ---------- utdatert ---------- */

test("en vurdering er utdatert når CV, annonse eller prompt har endret seg", () => {
  const d = validerJobbdokument("j1", dok({ match: match() }));
  const nå = { cvRevisjon: 3, promptversjon: "match-1" };
  assert.deepEqual(matchUtdatert(d, nå), []);
  assert.deepEqual(matchUtdatert(d, { ...nå, cvRevisjon: 4 }), ["cvRevisjon"]);
  assert.deepEqual(matchUtdatert(d, { ...nå, promptversjon: "match-2" }), ["promptversjon"]);
  const nyAnnonse = validerJobbdokument("j1", { ...d, annonse: { tekst: "En annen annonse." } });
  assert.deepEqual(matchUtdatert(nyAnnonse, nå), ["annonseSjekksum"]);
  // Samme annonse limt inn med andre linjeskift er ikke en endring.
  const samme = validerJobbdokument("j1", { ...d, annonse: { tekst: " Annonse.\n" } });
  assert.deepEqual(matchUtdatert(samme, nå), []);
  const utenAnnonse = validerJobbdokument("j1", { ...d, annonse: null });
  assert.deepEqual(matchUtdatert(utenAnnonse, nå), ["annonseSjekksum"]);
  // Det som ikke er oppgitt, kan ikke ha endret seg. Ingen vurdering er aldri utdatert.
  assert.deepEqual(matchUtdatert(d, {}), []);
  assert.deepEqual(matchUtdatert(validerJobbdokument("j1", dok()), { cvRevisjon: 9 }), []);
  assert.deepEqual(utdatert(null, { cvRevisjon: 1 }), []);
});

test("en forberedelse er også utdatert når brevversjonen er byttet", () => {
  const f = { sammendrag: "Kort.", cvRevisjon: 3, annonseSjekksum: sjekksum("Annonse."), promptversjon: "forberedelse-1", brevVersjonId: "v1" };
  const d = validerJobbdokument("j1", dok({ forberedelser: { i1: f } }));
  const nå = { cvRevisjon: 3, promptversjon: "forberedelse-1", brevVersjonId: "v1" };
  assert.deepEqual(forberedelseUtdatert(d, "i1", nå), []);
  assert.deepEqual(forberedelseUtdatert(d, "i1", { ...nå, brevVersjonId: "v2", cvRevisjon: 4 }), ["cvRevisjon", "brevVersjonId"]);
  assert.deepEqual(forberedelseUtdatert(d, "finnes-ikke", nå), []);
  assert.deepEqual(forberedelseUtdatert(d, "__proto__", nå), []);
  assert.deepEqual(forberedelseUtdatert(d, "toString", nå), []);
});

/* ---------- radar.json ---------- */

const rad = (over = {}) => ({ id: "nav:a1", kilde: "nav", kildeId: "a1", url: "https://arbeidsplassen.nav.no/stillinger/stilling/a1",
  lenker: ["https://arbeidsplassen.nav.no/stillinger/stilling/a1"], selskap: "Eksempel AS", stilling: "Dataanalytiker", sted: "Oslo",
  frist: "2026-10-30", publisert: "2026-10-09T00:00:00+02:00", tekst: "Annonse.", prosent: 82, grunner: ["Python"],
  status: "ny", funnet: "2026-10-09T10:00:00.000Z", nokler: ["nav:a1"], fingeravtrykk: "eksempel|dataanalytiker", ...over });

test("radar.json får hele formen med standardverdier", () => {
  const d = validerRadar({ revisjon: 0 });
  assert.deepEqual(d.innstillinger, { pa: false, terskel: 50, maksVurderingerPerDogn: 150, sokeord: [], ekskluder: [], steder: [],
    kilder: { nav: { pa: true }, jobbnorge: { pa: true, fylker: [] } }, karrieresider: [] });
  assert.deepEqual(d.kildetilstand, {
    nav: { side: null, etag: null, sistEndret: null, sist: null, feil: null, sokAvtrykk: null, sokSide: null, sokFerdig: null },
    jobbnorge: { sisteId: null, sist: null, feil: null, sokAvtrykk: null, sokFerdig: null } });
  for(const k of ["innboks", "under", "ko", "sett", "avvist", "avvistFingeravtrykk", "kjoringer"]) assert.deepEqual(d[k], []);
  assert.deepEqual(d.forbruk, { dato: null, vurderinger: 0 });
  assert.equal(d.leie, null);
  // Det gamle formatet fra før Radar fantes, blir et gyldig dokument.
  assert.equal(validerRadar({ skjemaVersjon: 1, revisjon: 2, innstillinger: { pa: true, terskel: 60 }, ukjent: 1 }).innstillinger.terskel, 60);
});

test("en terskel på 70 i skjema 1 var den gamle standarden og blir 50, men bare der", () => {
  const med = (skjemaVersjon, terskel) => validerRadar({ skjemaVersjon, revisjon: 1, innstillinger: { terskel } }).innstillinger.terskel;
  assert.equal(med(1, 70), 50);
  assert.equal(med(undefined, 70), 50);
  assert.equal(med(2, 70), 70);
  assert.equal(med(1, 65), 65);
  // Et skjema 1-dokument på disk kan fortsatt leses, og løftes ved lesing.
  assert.equal(lesDokument("radar.json", JSON.stringify({ skjemaVersjon: 1, revisjon: 3, innstillinger: { terskel: 70 } })).innstillinger.terskel, 50);
  assert.equal(lesDokument("radar.json", JSON.stringify({ skjemaVersjon: 2, revisjon: 3, innstillinger: { terskel: 70 } })).innstillinger.terskel, 70);
  assert.throws(() => lesDokument("radar.json", JSON.stringify({ skjemaVersjon: 3 })), e => e.code === "versjon");
});

test("radar.json normaliseres tilgivende og dropper det som ikke passer", () => {
  const d = validerRadar({ revisjon: 1,
    innstillinger: { pa: "ja", terskel: 101, maksVurderingerPerDogn: -1, sokeord: ["data", "data", 3, " ki ", "x".repeat(81)],
      kilder: { nav: { pa: false }, jobbnorge: { fylker: [3, 3, "4", 0, 42] } },
      karrieresider: [{ id: "s1", url: "https://boards.greenhouse.io/cognite", type: "greenhouse", navn: "Cognite" },
        { id: "s1", url: "https://example.no", type: "jsonld" }, { id: "../x", url: "https://example.no", type: "jsonld" },
        { id: "s2", url: "javascript:alert(1)", type: "jsonld" }, { id: "s3", url: "https://example.no", type: "workday" }] },
    kildetilstand: { nav: { side: "../../etc", etag: "W/\"x\"", sokSide: "../x", sokAvtrykk: "nav-1\r\nX: y", sokFerdig: "aldri" },
      jobbnorge: { sisteId: "9", sokAvtrykk: "jobbnorge-0a1b2c3d", sokFerdig: "2026-10-09T10:00:00.000Z" } },
    ko: [{ kilde: "nav", kildeId: "a1", url: "https://arbeidsplassen.nav.no/stillinger/stilling/a1", stilling: "Data Engineer", tekst: "x".repeat(2000), dato: "2026-10-09", forsok: 99 },
      { kilde: "nav", kildeId: "a1", url: "https://arbeidsplassen.nav.no/stillinger/stilling/a1", dato: "2026-10-09" },
      { kilde: "greenhouse", kildeId: "g1", url: "https://boards.greenhouse.io/x/jobs/1", dato: "2026-10-09" },
      { kilde: "jobbnorge", kildeId: "1", url: "javascript:alert(1)", dato: "2026-10-09" },
      { kilde: "jobbnorge", kildeId: "2", url: "https://www.jobbnorge.no/ledige-stillinger/stilling/2" }],
    innboks: [rad(), rad(), rad({ id: "nav:a2", prosent: 101 }), rad({ id: "nav:a3", url: "file:///etc/passwd" }),
      rad({ id: "nav:a4", status: "slettet", grunner: ["a", "b", "c", "d"], tekst: "x".repeat(7000), lenker: ["https://a.no", "ftp://b.no"] })],
    sett: [{ nokler: ["nav:a1"], dato: "2026-10-09" }, { nokler: [], dato: "2026-10-09" }, { nokler: ["x"], dato: "i går" }],
    avvistFingeravtrykk: [{ fingeravtrykk: "a|b", dato: "2026-10-01" }, { fingeravtrykk: "a|b", dato: "2026-10-02" }],
    kjoringer: [{ start: "2026-10-09T10:00:00.000Z", vurdert: 3, kilder: [{ kilde: "nav", hentet: 5 }, { kilde: "finn" }], feil: ["Kilden svarte 500."] }, { start: "nå" }],
    leie: { eier: "a", utloper: "aldri" } });
  assert.equal(d.innstillinger.pa, false);
  assert.equal(d.innstillinger.terskel, 50);
  assert.equal(d.innstillinger.maksVurderingerPerDogn, 150);
  assert.deepEqual(d.innstillinger.sokeord, ["data", "ki"]);
  assert.deepEqual(d.innstillinger.kilder, { nav: { pa: false }, jobbnorge: { pa: true, fylker: [3, 42] } });
  assert.deepEqual(d.innstillinger.karrieresider, [{ id: "s1", url: "https://boards.greenhouse.io/cognite", type: "greenhouse", navn: "Cognite",
    pa: true, feilRad: 0, sist: null, grunn: null }]);
  assert.equal(d.kildetilstand.nav.side, null);
  assert.equal(d.kildetilstand.jobbnorge.sisteId, null);
  assert.deepEqual([d.kildetilstand.nav.sokSide, d.kildetilstand.nav.sokAvtrykk, d.kildetilstand.nav.sokFerdig], [null, null, null]);
  assert.deepEqual([d.kildetilstand.jobbnorge.sokAvtrykk, d.kildetilstand.jobbnorge.sokFerdig], ["jobbnorge-0a1b2c3d", "2026-10-09T10:00:00.000Z"]);
  assert.deepEqual(d.ko.map(r => [r.kilde, r.kildeId, r.tekst.length, r.forsok]), [["nav", "a1", RADAR.koTekst, 10]],
    "køen tar bare NAV og Jobbnorge, med lenke og dato, én gang hver og uten lang tekst");
  assert.deepEqual(d.innboks.map(r => r.id), ["nav:a1", "nav:a4"]);
  const a4 = d.innboks[1];
  assert.equal(a4.status, "ny");
  assert.equal(a4.grunner.length, 3);
  assert.equal(a4.tekst.length, RADAR.tekst);
  assert.deepEqual(a4.lenker, ["https://a.no"]);
  assert.equal(d.sett.length, 1);
  assert.equal(d.avvistFingeravtrykk.length, 1);
  assert.equal(d.kjoringer.length, 1);
  assert.deepEqual(d.kjoringer[0].kilder, [{ kilde: "nav", navn: "", hentet: 5, sok: false, feil: null }]);
  assert.deepEqual([d.kjoringer[0].passet, d.kjoringer[0].venter], [null, null], "en kjøring fra før passet fantes, er ukjent, ikke null treff");
  assert.equal(d.leie, null);
});

test("radar.json kan ikke forurense prototyper og har tak", () => {
  const rå = `{"skjemaVersjon":1,"revisjon":1,"__proto__":{"x":1},"innstillinger":{"__proto__":{"pa":true},"constructor":{"prototype":{"y":1}}},"innboks":[{"__proto__":{"z":1}}]}`;
  const r = lesDokument("radar.json", rå);
  assert.equal(Object.hasOwn(r, "__proto__"), false);
  assert.equal(r.innstillinger.pa, false);
  assert.deepEqual(r.innboks, []);
  assert.equal({}.x, undefined);
  assert.equal({}.pa, undefined);
  assert.throws(() => validerRadar({ skjemaVersjon: 1 }), e => e.code === "ugyldig");
  assert.throws(() => validerRadar([]), e => e.code === "ugyldig");
  const mange = Array.from({ length: RADAR.innboks + 50 }, (_, i) => rad({ id: `nav:${i}` }));
  assert.equal(validerRadar({ revisjon: 1, innboks: mange }).innboks.length, RADAR.innboks);
  const stor = Array.from({ length: RADAR.innboks }, (_, i) => rad({ id: `nav:${i}`, tekst: "ø".repeat(RADAR.tekst), lenker: Array(5).fill(0).map((_, j) => `https://e.no/${"x".repeat(1900)}${j}`) }));
  assert.throws(() => validerRadar({ revisjon: 1, innboks: stor, sett: Array.from({ length: RADAR.sett }, (_, i) => ({ nokler: [`https://e.no/${"x".repeat(1900)}${i}`], dato: "2026-10-09" })) }),
    e => e.code === "for-stort");
});

test("innhold betyr det en gjenoppretting ville skrevet over", () => {
  assert.equal(harInnhold("jobb-j1.json", tomtJobbdokument("j1")), false);
  assert.equal(harInnhold("jobb-j1.json", { ...tomtJobbdokument("j1"), revisjon: 5 }), false);
  assert.equal(harInnhold("jobb-j1.json", validerJobbdokument("j1", dok())), true);
  assert.equal(harInnhold("jobb-j1.json", validerJobbdokument("j1", { revisjon: 1, match: match() })), true);
  assert.equal(harInnhold("jobb-j1.json", validerJobbdokument("j1", { revisjon: 1, forberedelser: { i1: {} } })), true);
  assert.equal(harInnhold("radar.json", { skjemaVersjon: 1, revisjon: 3, oppdatert: null }), false);
  // Standardverdiene alene er ikke innhold, og heller ikke en leie.
  assert.equal(harInnhold("radar.json", { ...tomRadar(), revisjon: 3, leie: { eier: "a", utloper: "2026-10-09T10:00:00.000Z" } }), false);
  assert.equal(harInnhold("radar.json", validerRadar({ revisjon: 3, innstillinger: { pa: true } })), true);
  assert.equal(harInnhold("radar.json", validerRadar({ revisjon: 3, avvistFingeravtrykk: [{ fingeravtrykk: "a|b", dato: "2026-10-01" }] })), true);
});

/* ---------- utdrag ---------- */

test("utdraget følger de samme tilfellene som Rust", () => {
  for(const t of felles.utdrag) assert.deepEqual(utdragAv(t.dok, tolkStier(t.stier)), t.ventet, t.om);
  for(const stier of felles.ugyldigeStier) assert.throws(() => tolkStier(stier), e => e.code === "ugyldig", JSON.stringify(stier));
  assert.deepEqual(tolkStier("match.prosent, annonse.hentet,match.prosent"), ["match.prosent", "annonse.hentet"]);
  for(const inn of [undefined, null, 5, {}, "", ",", Array(101).fill("a")]) assert.throws(() => tolkStier(inn), e => e.code === "ugyldig");
  // Arvede nøkler følges aldri, heller ikke de som ser harmløse ut.
  assert.deepEqual(utdragAv({ a: {} }, ["a.toString", "a.hasOwnProperty", "valueOf"]), {});
});
