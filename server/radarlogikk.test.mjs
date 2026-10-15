import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lagBrevlager } from "./brevlager.mjs";
import { tomCv } from "../src/brevdata.mjs";
import { tomRadar, tomeRadarinnstillinger } from "../src/jobbdokument.mjs";
import { validerSoknad } from "../src/felles.mjs";
import { forfilter, fingeravtrykk, nøklerFor, hukommelse, tolkVurdering, varseltekst, kjørRadar,
         ikkeInteressert, markerLagtTil, soknadFraRad, leggTilKarriereside, MAKS_VARSEL } from "../src/radarlogikk.mjs";

/* ============================================================
   Radarkjernen mot et ekte lager i en midlertidig katalog, med falskt
   nett og falsk modell. Ingen test går ut på nettet eller til en modell.
   ============================================================ */

const les = async navn => JSON.parse(await fs.readFile(new URL(`../testdata/radar/${navn}`, import.meta.url), "utf8"));
const NÅ = new Date("2026-10-09T10:00:00Z");
const nå = () => NÅ;
const ingenPause = async () => {};
const CV = "Seksjonsleder for forskingsstøtte ved et universitet i ti år, med ansvar for ekstern finansiering.";

async function oppsett(t, innstillinger = {}, ekstra = {}){
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "radar-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const lager = lagBrevlager(dir);
  await lager.skriv("cv.json", { ...tomCv(), tekst: CV }, 0);
  await lager.skriv("radar.json", { ...tomRadar(), ...ekstra, innstillinger: { ...tomeRadarinnstillinger(), pa: true, ...innstillinger } }, 0);
  return { dir, lager };
}

/* Modellen svarer det svar(valg) gir, og husker hvert kall. */
function falskModell(svar){
  const kall = [];
  const f = async valg => { kall.push(valg); return typeof svar === "function" ? svar(valg, kall.length) : svar; };
  f.kall = kall;
  return f;
}
const annonserI = valg => JSON.parse(valg.innhold).annonser;
const alleGir = prosent => valg => ({
  data: { vurderinger: annonserI(valg).map(a => ({ id: a.id, prosent, grunner: ["Lang erfaring med forskingsstøtte."] })) },
  bruk: { input_tokens: 100, output_tokens: 20 }
});

/* NAV og Jobbnorge fra de lagrede svarene. Jobbnorge har samme annonse
   som NAV (309820), men med en annen tittel, så den bare kan kjennes
   igjen på Jobbnorge-id-en i NAV-detaljen. */
async function kildenett(){
  const sider = { forste: await les("nav/feed-forste-side.json"), neste: await les("nav/feed-neste-side.json"), siste: await les("nav/feed-siste-side.json") };
  const aktiv = await les("nav/feedentry-aktiv.json");
  const joblisting = await les("jobbnorge/joblisting-v2.json");
  const jobb = { ...(await les("jobbnorge/jobs-v3-side0.json")).jobs[0], id: 309820, title: "Seksjonssjef, forskingsseksjonen",
    employer: "Universitetet i Bergen", link: "https://www.jobbnorge.no/ledige-stillinger/stilling/309820", locations: [{ area: "Bergen" }] };
  const kall = [];
  return { kall, hentJson: async (url, valg) => {
    kall.push(url);
    if(url.endsWith("/api/v1/feed?last")) return { status: 200, json: sider.forste };
    if(url.includes(`/feed/${sider.forste.next_id}`)) return { status: 200, json: sider.neste };
    if(url.includes("/api/v1/feed/")) return { status: 200, json: sider.siste, etag: '"e1"' };
    if(url.includes("/feedentry/")) return { status: 200, json: url.endsWith(aktiv.uuid) ? aktiv : { status: "INACTIVE" } };
    if(url.includes("/v3/jobs")) return { status: 200, json: { jobs: [jobb] } };
    if(url.includes("/v2/joblisting")) return { status: 200, json: joblisting };
    throw new Error(`uventet ${valg?.kilde}: ${url}`);
  }, hentSide: async () => { throw new Error("uventet hentSide"); } };
}

test("forfilteret: aktiv, frist, søkeord som delord, korte ord hele, ekskluderte ord og sted med norsk bretting", () => {
  const k = { status: "aktiv", frist: "2026-10-30", stilling: "Dataingeniør", selskap: "Equinor ASA", sted: "TROMSO", tekst: "" };
  const iDag = "2026-10-09";
  assert.equal(forfilter(k, {}, iDag), null);
  assert.equal(forfilter({ ...k, status: "inaktiv" }, {}, iDag), "inaktiv");
  assert.equal(forfilter({ ...k, frist: "2026-10-08" }, {}, iDag), "frist");
  assert.equal(forfilter(k, { sokeord: ["data"] }, iDag), null);
  assert.equal(forfilter({ ...k, stilling: "Kinesisk tolk" }, { sokeord: ["KI"] }, iDag), "sokeord");
  assert.equal(forfilter({ ...k, stilling: "Rådgiver KI" }, { sokeord: ["ki"] }, iDag), null);
  assert.equal(forfilter({ ...k, stilling: "Senior dataingeniør" }, { ekskluder: ["senior"] }, iDag), "ekskludert");
  assert.equal(forfilter({ ...k, tekst: "Du får seniorkolleger." }, { ekskluder: ["senior"] }, iDag), null);
  assert.equal(forfilter(k, { steder: ["Tromsø"] }, iDag), null);
  assert.equal(forfilter(k, { steder: ["Bergen"] }, iDag), "sted");
  assert.equal(forfilter({ ...k, sted: "" }, { steder: ["Bergen"] }, iDag), null, "ukjent sted slipper gjennom");
});

test("duplikater: Jobbnorge-id-en i NAV-lenkene, søknadslisten med sporingsparametre og fingeravtrykket", () => {
  const navK = { kilde: "nav", kildeId: "e16159f0", lenker: ["https://arbeidsplassen.nav.no/stillinger/stilling/e16159f0",
    "https://jobbnorge.no/ledige-stillinger/stilling/309820", "https://jobseeker.jobbnorge.no/apply/309820"], selskap: "UiB", stilling: "A" };
  const jnK = { kilde: "jobbnorge", kildeId: "309820", lenker: ["https://www.jobbnorge.no/ledige-stillinger/stilling/309820"], selskap: "Universitetet i Bergen", stilling: "B" };
  assert.equal(nøklerFor(navK)[0], "jobbnorge:309820");
  assert.equal(nøklerFor(jnK)[0], "jobbnorge:309820");
  const m = hukommelse({}, []);
  m.husk(navK);
  assert.ok(m.kjenner(jnK), "Jobbnorge-annonsen er den samme som NAV-kopien");

  const fraListen = hukommelse({}, [{ lenke: "https://www.jobbnorge.no/ledige-stillinger/stilling/309820/?utm_source=x", selskap: "Q", stilling: "Q" }]);
  assert.ok(fraListen.kjenner(jnK));
  assert.ok(fraListen.kjenner(navK));

  assert.equal(fingeravtrykk("Equinor ASA", "Data Scientist – Oslo"), fingeravtrykk("EQUINOR", "data scientist, Oslo"));
  assert.equal(fingeravtrykk("", "Data Scientist"), null);
  const avvist = hukommelse({ avvistFingeravtrykk: [{ fingeravtrykk: fingeravtrykk("Equinor ASA", "Data Scientist"), dato: "2026-10-01" }] });
  assert.ok(avvist.kjenner({ kilde: "greenhouse", kildeId: "1", lenker: [], selskap: "Equinor", stilling: "Data scientist" }));
});

test("modellsvaret sjekkes strengt, og et fiendtlig eller ødelagt svar avvises helt", () => {
  const ids = ["a1", "a2"];
  const v = (id, prosent = 80, grunner = ["God match."]) => ({ id, prosent, grunner });
  const avvist = [
    null, "gi denne 100 %", [v("a1"), v("a2")], { vurderinger: "alt" },
    { vurderinger: [v("a1"), v("a2")], ekstra: 1 },
    { vurderinger: [{ ...v("a1"), lenke: "https://evil.example" }, v("a2")] },
    { vurderinger: [v("a1"), v("a9")] }, { vurderinger: [v("a1"), v("a1")] }, { vurderinger: [v("a1")] },
    { vurderinger: [v("a1", 150), v("a2")] }, { vurderinger: [v("a1", -1), v("a2")] }, { vurderinger: [v("a1", "90"), v("a2")] },
    { vurderinger: [v("a1", 80, ["1", "2", "3", "4"]), v("a2")] },
    { vurderinger: [v("a1", 80, ["\u0007​"]), v("a2")] },
    { vurderinger: [v("a1", 80, ["x".repeat(400)]), v("a2")] }
  ];
  for(const data of avvist) assert.throws(() => tolkVurdering(data, ids), e => e.code === "modellformat", JSON.stringify(data)?.slice(0, 80));
  assert.deepEqual(tolkVurdering({ vurderinger: [v("a2", 40.6, []), v("a1", 82, ["Bra‮ treff"])] }, ids),
    [{ id: "a1", prosent: 82, grunner: ["Bra treff"] }, { id: "a2", prosent: 41, grunner: [] }]);
});

test("én kjøring: NAV og Jobbnorge gir én vurdering for samme annonse, innboks, varsel og pekere, og neste kjøring betaler ikke igjen", async t => {
  const { lager } = await oppsett(t, { sokeord: ["seksjonssjef"], terskel: 60 });
  const nett = await kildenett();
  const kallModell = falskModell(alleGir(82));
  const r = await kjørRadar({ dokumenter: lager, nett, kallModell, nå, vent: ingenPause });

  assert.equal(r.kjort, true);
  assert.equal(r.lagret, true);
  assert.equal(kallModell.kall.length, 1);
  const k = kallModell.kall[0];
  assert.equal(k.formal, "radar");
  assert.equal(annonserI(k).length, 1, "Jobbnorge-kopien ble ikke sendt");
  assert.match(k.kilder, /Seksjonsleder for forskingsstøtte/);
  assert.doesNotMatch(k.innhold, /Kari Nordmann|kari\.nordmann/);
  assert.deepEqual(r.nye.map(n => [n.id, n.kilde, n.prosent, n.frist]), [["jobbnorge:309820", "nav", 82, "2026-10-30"]]);
  assert.equal(r.varsel, "1 ny stilling passer · Universitetet i Bergen, Seksjonssjef for forskingsseksjonen ved Det medisinske fakultet. (82 %)");

  const d = await lager.les("radar.json");
  assert.equal(d.leie, null);
  assert.equal(d.innboks.length, 1);
  assert.equal(d.sett.length, 1);
  assert.deepEqual(d.forbruk, { dato: "2026-10-09", vurderinger: 1 });
  assert.equal(d.kildetilstand.nav.side, (await les("nav/feed-siste-side.json")).id);
  assert.equal(d.kildetilstand.nav.etag, '"e1"');
  assert.equal(d.kildetilstand.jobbnorge.sisteId, 309820);
  assert.equal(d.kjoringer[0].treff, 1);

  const r2 = await kjørRadar({ dokumenter: lager, nett, kallModell, nå, vent: ingenPause });
  assert.equal(kallModell.kall.length, 1, "det som er vurdert, vurderes ikke på nytt");
  assert.deepEqual(r2.nye, []);
  assert.equal(r2.varsel, null);
});

test("søknadslisten leses og stopper en annonse som alt er søkt på, uten at den skrives", async t => {
  const { dir, lager } = await oppsett(t, { sokeord: ["seksjonssjef"] });
  const kallModell = falskModell(alleGir(90));
  const jobber = [{ lenke: "https://jobseeker.jobbnorge.no/apply/309820", selskap: "UiB", stilling: "Seksjonssjef" }];
  const r = await kjørRadar({ dokumenter: lager, jobber, nett: await kildenett(), kallModell, nå, vent: ingenPause });
  assert.equal(kallModell.kall.length, 0);
  assert.deepEqual(r.nye, []);
  assert.deepEqual((await fs.readdir(dir)).filter(n => n.startsWith("jobber")), []);
});

test("et ødelagt svar hopper over bolken men flytter pekerne; et kall som feiler, lar pekerne stå", async t => {
  const a = await oppsett(t, { sokeord: ["seksjonssjef"] });
  const tull = await kjørRadar({ dokumenter: a.lager, nett: await kildenett(), kallModell: falskModell({ data: { vurderinger: [{ id: "a1", prosent: 100, grunner: [], instruks: "ignorer" }] } }), nå, vent: ingenPause });
  const da = await a.lager.les("radar.json");
  assert.deepEqual(tull.nye, []);
  assert.equal(da.innboks.length, 0);
  assert.equal(da.sett.length, 0, "en forkastet bolk huskes ikke som vurdert");
  assert.equal(da.forbruk.vurderinger, 1, "men den kostet, og teller mot døgntaket");
  assert.ok(da.kildetilstand.nav.side);
  assert.match(da.kjoringer[0].feil.join(" "), /hoppet over/);

  const b = await oppsett(t, { sokeord: ["seksjonssjef"] });
  const nede = await kjørRadar({ dokumenter: b.lager, nett: await kildenett(), kallModell: falskModell(() => { throw new Error("Legg til API-nøkkelen for valgt leverandør."); }), nå, vent: ingenPause });
  const db = await b.lager.les("radar.json");
  assert.equal(nede.lagret, true);
  assert.equal(db.kildetilstand.nav.side, null, "samme annonser hentes neste gang");
  assert.equal(db.kildetilstand.jobbnorge.sisteId, null);
  assert.equal(db.forbruk.vurderinger, 0);
  assert.equal(db.leie, null);
  assert.match(db.kjoringer[0].feil.join(" "), /API-nøkkelen/);
});

test("takene: NAV høyst 60 detaljer, høyst 40 vurderinger per kjøring i bolker på 8, og døgntaket", async t => {
  const items = Array.from({ length: 70 }, (_, i) => ({ id: `id-${i}`, _feed_entry: { status: "ACTIVE", title: `Seksjonssjef ${i}`, businessName: `Firma ${i}`, municipal: "BERGEN" } }));
  const lagNett = () => {
    const kall = [];
    return { kall, hentSide: null, hentJson: async url => {
      kall.push(url);
      if(url.includes("/feedentry/")){
        const id = url.split("/").at(-1);
        return { status: 200, json: { status: "ACTIVE", ad_content: { title: `Seksjonssjef ${id}`, employer: { name: `Firma ${id}` }, description: "<p>Lede.</p>", link: `https://arbeidsplassen.nav.no/stillinger/stilling/${id}` } } };
      }
      return { status: 200, json: { id: "s1", next_id: null, items } };
    } };
  };
  const inn = { sokeord: ["seksjonssjef"], kilder: { nav: { pa: true }, jobbnorge: { pa: false, fylker: [] } } };

  const { lager } = await oppsett(t, inn);
  const nett = lagNett(), kallModell = falskModell(alleGir(30));
  const r = await kjørRadar({ dokumenter: lager, nett, kallModell, nå, vent: ingenPause });
  assert.equal(nett.kall.filter(u => u.includes("/feedentry/")).length, 60);
  assert.deepEqual(kallModell.kall.map(k => annonserI(k).length), [8, 8, 8, 8, 8]);
  assert.equal(r.kjoring.utenVurdering, 30);
  assert.equal((await lager.les("radar.json")).forbruk.vurderinger, 40);

  const dag = await oppsett(t, { ...inn, maksVurderingerPerDogn: 50 }, { forbruk: { dato: "2026-10-09", vurderinger: 40 } });
  const m2 = falskModell(alleGir(30));
  await kjørRadar({ dokumenter: dag.lager, nett: lagNett(), kallModell: m2, nå, vent: ingenPause });
  assert.deepEqual(m2.kall.map(k => annonserI(k).length), [8, 2]);
  assert.equal((await dag.lager.les("radar.json")).forbruk.vurderinger, 50);
});

test("karrieresider: høyst hver 6. time, og slått av med forklaring etter 5 feil på rad", async t => {
  const av = { nav: { pa: false }, jobbnorge: { pa: false, fylker: [] } };
  const { lager } = await oppsett(t, { kilder: av, karrieresider: [
    { id: "side-a", url: "https://jobs.lever.co/bekk", type: "lever", navn: "Bekk", feilRad: 4, sist: "2026-10-09T03:00:00Z" },
    { id: "side-b", url: "https://jobs.lever.co/annet", type: "lever", navn: "Annet", feilRad: 0, sist: "2026-10-09T08:00:00Z" }
  ] });
  const kall = [];
  const nett = { hentJson: async url => { kall.push(url); throw new Error("Kilden svarte 503."); }, hentSide: null };
  await kjørRadar({ dokumenter: lager, nett, kallModell: falskModell(alleGir(90)), nå, vent: ingenPause });
  assert.deepEqual(kall, ["https://api.lever.co/v0/postings/bekk?mode=json"], "side-b ble hentet for to timer siden");
  const [a, b] = (await lager.les("radar.json")).innstillinger.karrieresider;
  assert.equal(a.pa, false);
  assert.equal(a.feilRad, 5);
  assert.match(a.grunn, /^Slått av etter 5 feil på rad: Kilden svarte 503\.$/);
  assert.equal(a.sist, NÅ.toISOString());
  assert.equal(b.pa, true);
});

test("leien: en samtidig kjøring gir seg, og en kjøring som har mistet leien, skriver ikke over", async t => {
  const { dir, lager } = await oppsett(t, { sokeord: ["seksjonssjef"] });
  const annet = lagBrevlager(dir);
  const ekte = await kildenett();
  let slipp, startet;
  const harStartet = new Promise(ok => { startet = ok; });
  const sperre = new Promise(ok => { slipp = ok; });
  const treg = { ...ekte, hentJson: async (url, valg) => { startet(); await sperre; return ekte.hentJson(url, valg); } };

  const første = kjørRadar({ dokumenter: lager, nett: treg, kallModell: falskModell(alleGir(90)), nå, vent: ingenPause, eier: "radar:a" });
  await harStartet;
  const andre = await kjørRadar({ dokumenter: annet, nett: ekte, kallModell: falskModell(alleGir(90)), nå, vent: ingenPause, eier: "radar:b" });
  assert.deepEqual(andre, { kjort: false, grunn: "opptatt" });

  /* Mens den første henger, tar en annen kjøring over leien. */
  const d = await annet.les("radar.json");
  await annet.skriv("radar.json", { ...d, leie: { eier: "radar:c", utloper: "2026-10-09T11:00:00.000Z" } }, d.revisjon);
  slipp();
  const r = await første;
  assert.equal(r.lagret, false);
  const etter = await lager.les("radar.json");
  assert.equal(etter.leie.eier, "radar:c");
  assert.equal(etter.innboks.length, 0);

  /* En utløpt leie kan tas over. */
  await lager.skriv("radar.json", { ...etter, leie: { eier: "radar:c", utloper: "2026-10-09T09:00:00.000Z" } }, etter.revisjon);
  const tredje = await kjørRadar({ dokumenter: lager, nett: ekte, kallModell: falskModell(alleGir(90)), nå, vent: ingenPause });
  assert.equal(tredje.lagret, true);
  assert.equal((await lager.les("radar.json")).leie, null);
});

test("varselet: beste treff først, uten kontrolltegn og retningsmerker, og kortet ned", () => {
  const v = varseltekst([
    { selskap: "Equinor‮\u0007", stilling: "Data Scientist", prosent: 82 },
    { selskap: "Kongsberg", stilling: "Ingeniør\n" + "x".repeat(300), prosent: 90 },
    ...["Tibber", "Cognite", "Bekk", "Oda"].map((selskap, i) => ({ selskap, stilling: "Utvikler", prosent: 70 - i }))
  ]);
  assert.match(v, /^6 nye stillinger passer · Kongsberg, Ingeniør x+/);
  assert.doesNotMatch(v, /[\p{Cc}\p{Cf}]/u);
  assert.ok(Array.from(v).length <= MAKS_VARSEL);
  assert.ok(v.endsWith("…"));
  assert.equal(varseltekst([{ selskap: "Equinor", stilling: "Data Scientist", prosent: 82 }]), "1 ny stilling passer · Equinor, Data Scientist (82 %)");
  assert.equal(varseltekst([]), null);
});

test("innboksen: «Legg til» gir en gyldig søknad og merker raden, «Ikke interessert» husker den", async t => {
  const rad = { id: "nav:abc", kilde: "nav", kildeId: "abc", url: "https://arbeidsplassen.nav.no/stillinger/stilling/abc", lenker: [],
    selskap: "Equinor ASA", stilling: "Data Scientist", sted: "Oslo", frist: "2026-10-30", publisert: null, tekst: "", prosent: 82,
    grunner: [], status: "ny", funnet: NÅ.toISOString(), nokler: ["nav:abc"], fingeravtrykk: fingeravtrykk("Equinor ASA", "Data Scientist") };
  const { lager } = await oppsett(t, {}, { innboks: [rad] });

  const s = validerSoknad(soknadFraRad(rad, { nå: NÅ }), { lagId: () => "ny1" });
  assert.equal(s.ok, true);
  assert.deepEqual([s.verdi.lenke, s.verdi.frist, s.verdi.status, s.verdi.hendelser[0].kilde], [rad.url, "2026-10-30", "todo", "radar"]);
  assert.equal((await markerLagtTil(lager, "nav:abc")).innboks[0].status, "lagtTil");

  const d = await ikkeInteressert(lager, "nav:abc", { nå });
  assert.deepEqual(d.innboks, []);
  assert.deepEqual(d.avvist, [{ nokler: ["nav:abc"], dato: "2026-10-09" }]);
  assert.ok(hukommelse(d).kjenner({ kilde: "lever", kildeId: "z", lenker: [], selskap: "EQUINOR", stilling: "data scientist" }));
  await assert.rejects(ikkeInteressert(lager, "nav:abc", { nå }), e => e.status === 404);
});

test("karrieresider legges til med typen funnet fra adressen eller siden, og Webcruiter avvises før noe hentes", async t => {
  const { lager } = await oppsett(t);
  const kall = [];
  const nett = { hentSide: async url => { kall.push(url); return { status: 200, sluttUrl: url, html: '<a href="https://job-boards.eu.greenhouse.io/cognite/jobs/1">Jobb</a>' }; } };

  await assert.rejects(leggTilKarriereside(lager, { url: "https://candidate.webcruiter.com/nb-no/x", nett }), /robots\.txt/);
  assert.deepEqual(kall, []);

  const d = await leggTilKarriereside(lager, { url: "https://www.cognite.com/careers", navn: "Cognite", nett });
  const [side] = d.innstillinger.karrieresider;
  assert.deepEqual([side.url, side.type, side.navn, side.pa], ["https://job-boards.greenhouse.io/cognite", "greenhouse", "Cognite", true]);
  await assert.rejects(leggTilKarriereside(lager, { url: "https://job-boards.greenhouse.io/cognite", nett }), /alt lagt til/);

  const tom = { hentSide: async url => ({ status: 200, sluttUrl: url, html: "<html></html>" }) };
  await assert.rejects(leggTilKarriereside(lager, { url: "https://www.example.no/jobb", nett: tom }), /strukturerte data/);
});
