import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { nav, jobbnorge, greenhouse, lever, teamtailor, jsonld, oppdagType, oppdagTypeFraSide,
         navLinjer, GRENSER, NAV_BASE } from "../src/radarkilder.mjs";

/* ============================================================
   Radarkildene mot de lagrede svarene i testdata/radar/. Nettet er
   falskt: hentJson og hentSide svarer fra filene og husker hva de ble
   spurt om. Ingen test går ut på nettet.
   ============================================================ */

const les = async navn => fs.readFile(new URL(`../testdata/radar/${navn}`, import.meta.url), "utf8");
const json = async navn => JSON.parse(await les(navn));
const ingenPause = async () => {};

function falskNett({ json: svarJson = () => { throw new Error("uventet hentJson"); }, side = () => { throw new Error("uventet hentSide"); } } = {}){
  const kall = [];
  return {
    kall,
    hentJson: async (url, valg) => { kall.push({ url, ...valg }); return svarJson(url, valg, kall.length); },
    hentSide: async url => { kall.push({ url }); return side(url); }
  };
}

test("NAV: første gang ?last, så videre fra next_url med én linje per annonse og pekeren lagret", async () => {
  const sider = { forste: await json("nav/feed-forste-side.json"), neste: await json("nav/feed-neste-side.json"), siste: await json("nav/feed-siste-side.json") };
  const nett = falskNett({ json: url => {
    if(url.endsWith("/api/v1/feed?last")) return { status: 200, json: sider.forste };
    if(url.includes(sider.forste.next_id)) return { status: 200, json: sider.neste };
    return { status: 200, json: sider.siste, etag: '"abc"', sistEndret: "Fri, 9 Oct 2026 10:11:18 GMT" };
  } });
  const r = await nav.hent({ nett, tilstand: {}, vent: ingenPause });
  assert.equal(nett.kall.length, 3);
  assert.ok(nett.kall.every(k => k.kilde === "nav"));
  assert.match(nett.kall[1].url, new RegExp(`^${NAV_BASE}/api/v1/feed/${sider.forste.next_id}\\?pageSize=200$`));
  /* 5 + 5 + 1 linjer, men overlappen og gjentakelsene gir 8 annonser. */
  const ider = r.kandidater.map(k => k.kildeId);
  assert.equal(new Set(ider).size, ider.length);
  assert.equal(ider.length, 8);
  assert.deepEqual(r.tilstand, { side: sider.siste.id, etag: '"abc"', sistEndret: "Fri, 9 Oct 2026 10:11:18 GMT" });
  const ss = r.kandidater.find(k => k.kildeId.startsWith("e16159f0"));
  assert.equal(ss.url, `https://arbeidsplassen.nav.no/stillinger/stilling/${ss.kildeId}`);
  assert.equal(ss.detaljert, false);

  /* Neste kjøring spør etter samme side med ETag og ett sekund ekstra, og 304 er «ingenting nytt». */
  const igjen = falskNett({ json: () => ({ status: 304, json: null }) });
  const r2 = await nav.hent({ nett: igjen, tilstand: r.tilstand, vent: ingenPause });
  assert.equal(igjen.kall[0].url, `${NAV_BASE}/api/v1/feed/${sider.siste.id}?pageSize=200`);
  assert.equal(igjen.kall[0].etag, '"abc"');
  assert.equal(igjen.kall[0].sistEndret, "Fri, 09 Oct 2026 10:11:19 GMT");
  assert.deepEqual(r2.kandidater, []);
  assert.deepEqual(r2.tilstand, r.tilstand);
});

test("NAV: gjentatte og inaktive linjer, maskerte felt og ukjent status", async () => {
  const side = await json("nav/feed-inaktive-og-gjentatte.json");
  const linjer = navLinjer(side.items);
  assert.equal(linjer.filter(l => l.id.startsWith("d11f92bd")).length, 1);
  assert.deepEqual(linjer.filter(l => l.status === "inaktiv").map(l => l.id.slice(0, 8)).sort(), ["5627e52b", "c0422257"]);
  const rar = navLinjer([{ id: "abc", _feed_entry: { status: "PAUSED", title: "x" } }]);
  assert.deepEqual(rar, [], "en status Radar ikke kjenner, skal ikke fjerne noe fra innboksen");
});

test("NAV: høyst 20 sider per kjøring, og pekeren står der den slapp", async () => {
  let n = 0;
  const nett = falskNett({ json: () => { n++; return { status: 200, json: { id: `side${n}`, next_id: `side${n + 1}`, next_url: `/api/v1/feed/side${n + 1}`, items: [] } }; } });
  const r = await nav.hent({ nett, tilstand: { side: "start" }, vent: ingenPause });
  assert.equal(nett.kall.length, GRENSER.navSider);
  assert.equal(r.tilstand.side, `side${GRENSER.navSider + 1}`);
});

test("NAV: en lagret side som feiler, gir én ny start fra ?last, men nede nett lar pekeren stå", async () => {
  const forste = await json("nav/feed-siste-side.json");
  const nett = falskNett({ json: url => {
    if(url.endsWith("/api/v1/feed?last")) return { status: 200, json: forste };
    throw new Error("NAV svarte 404.");
  } });
  const r = await nav.hent({ nett, tilstand: { side: "borte" }, vent: ingenPause });
  assert.deepEqual(nett.kall.map(k => k.url.endsWith("?last")), [false, true]);
  assert.equal(r.tilstand.side, forste.id);

  const nede = falskNett({ json: () => { throw new Error("Fikk ikke kontakt."); } });
  await assert.rejects(nav.hent({ nett: nede, tilstand: { side: "borte" }, vent: ingenPause }), /kontakt/);
  assert.equal(nede.kall.length, 2, "bare ett forsøk på ny start");
});

test("NAV: next_url til en annen vert stopper hentingen", async () => {
  const nett = falskNett({ json: () => ({ status: 200, json: { id: "a", next_id: "b", next_url: "https://evil.example/api/v1/feed/b", items: [] } }) });
  await assert.rejects(nav.hent({ nett, tilstand: { side: "a" }, vent: ingenPause }), /ukjent adresse/);
});

test("NAV: detaljen gir tekst, frist, sted og Jobbnorge-lenken, men aldri kontaktpersonen", async () => {
  const aktiv = await json("nav/feedentry-aktiv.json");
  const nett = falskNett({ json: url => ({ status: 200, json: url.endsWith(aktiv.uuid) ? aktiv : null }) });
  const k = await nav.detalj({ kilde: "nav", kildeId: aktiv.uuid, url: "https://arbeidsplassen.nav.no/x", lenker: [], selskap: "", stilling: "" }, { nett });
  assert.equal(k.selskap, "Universitetet i Bergen");
  assert.equal(k.frist, "2026-10-30");
  assert.equal(k.sted, "Bergen");
  assert.ok(k.lenker.includes("https://jobbnorge.no/ledige-stillinger/stilling/309820"));
  assert.match(k.tekst, /Kunnskap som formar samfunnet/);
  assert.doesNotMatch(k.tekst, /<h2>/);
  assert.doesNotMatch(JSON.stringify(k), /Kari Nordmann|kari\.nordmann|00000000/);
  assert.equal(k.detaljert, true);

  const inaktiv = await json("nav/feedentry-inaktiv.json");
  const k2 = await nav.detalj({ kilde: "nav", kildeId: inaktiv.uuid }, { nett: falskNett({ json: () => ({ status: 200, json: inaktiv }) }) });
  assert.equal(k2.status, "inaktiv");
});

test("Jobbnorge: søket gir kandidater og høyeste id, og detaljen setter sammen teksten uten bilder", async () => {
  const side0 = await json("jobbnorge/jobs-v3-side0.json");
  const nett = falskNett({ json: () => ({ status: 200, json: side0 }) });
  const r = await jobbnorge.hent({ nett, tilstand: {}, innstillinger: { kilder: { jobbnorge: { fylker: [3] } } }, vent: ingenPause });
  const u = new URL(nett.kall[0].url);
  assert.equal(u.searchParams.get("period"), "Week", "første gang en uke tilbake");
  assert.equal(u.searchParams.get("county"), "3");
  assert.equal(nett.kall.length, 1, "en side med færre enn 50 er den siste");
  assert.deepEqual(r.tilstand, { sisteId: 309687 });
  const k = r.kandidater[0];
  assert.deepEqual([k.kildeId, k.selskap, k.stilling, k.sted, k.frist, k.publisert],
    ["309687", "Brønnøysundregistrene", "Dataanalytiker", "Brønnøysund", "2026-10-30", "2026-10-08"]);

  const detalj = await json("jobbnorge/joblisting-v2.json");
  const d = await jobbnorge.detalj(k, { nett: falskNett({ json: () => ({ status: 200, json: detalj }) }) });
  assert.match(d.tekst, /Arbeidsoppgaver/);
  assert.doesNotMatch(d.tekst, /Image:|bilde\.jpg/);
  assert.equal(d.detaljert, true);

  const neste = falskNett({ json: () => ({ status: 200, json: side0 }) });
  await jobbnorge.hent({ nett: neste, tilstand: { sisteId: 309000 }, vent: ingenPause });
  assert.equal(new URL(neste.kall[0].url).searchParams.get("period"), "Day");
});

test("NAV-søket: startpunktet 90 dager tilbake med en liten side, så store sider uten hodet, høyst 60 per kjøring", async () => {
  const nå = new Date("2026-10-17T12:00:00Z");
  let n = 0;
  const nett = falskNett({ json: () => { n++; return { status: 200, json: { id: `side${n}`, next_id: `side${n + 1}`, next_url: `/api/v1/feed/side${n + 1}`,
    items: [{ id: `ad${n}`, _feed_entry: { status: "ACTIVE", title: "Data Engineer", businessName: "X", municipal: "OSLO" } }] } }; } });
  const r = await nav.søk({ nett, tilstand: {}, avtrykk: "nav-1", nå, vent: ingenPause });
  assert.equal(nett.kall[0].url, `${NAV_BASE}/api/v1/feed?pageSize=2`);
  assert.equal(nett.kall[0].sistEndret, "Sun, 19 Jul 2026 12:00:00 GMT");
  assert.equal(nett.kall[1].url, `${NAV_BASE}/api/v1/feed/side2?pageSize=${GRENSER.navSokSidestorrelse}`);
  assert.equal(nett.kall[1].sistEndret, null, "If-Modified-Since bare på oppslaget av startpunktet");
  assert.equal(nett.kall.length, GRENSER.navSokSider);
  assert.deepEqual(r.tilstand, { sokAvtrykk: "nav-1", sokSide: `side${GRENSER.navSokSider + 1}`, sokFerdig: null });
  assert.equal(r.kandidater.length, GRENSER.navSokSider);

  /* Neste kjøring fortsetter, men nye innstillinger begynner på nytt. */
  const videre = falskNett({ json: () => ({ status: 200, json: { id: "slutt", next_id: null, items: [] }, etag: '"e"' }) });
  const r2 = await nav.søk({ nett: videre, tilstand: r.tilstand, avtrykk: "nav-1", nå, vent: ingenPause });
  assert.equal(videre.kall[0].url, `${NAV_BASE}/api/v1/feed/side${GRENSER.navSokSider + 1}?pageSize=${GRENSER.navSokSidestorrelse}`);
  assert.deepEqual(r2.tilstand, { sokAvtrykk: "nav-1", sokSide: null, sokFerdig: nå.toISOString(), side: "slutt", etag: '"e"', sistEndret: null });
  const nytt = falskNett({ json: () => ({ status: 200, json: { id: "s", next_id: null, items: [] } }) });
  await nav.søk({ nett: nytt, tilstand: r.tilstand, avtrykk: "nav-2", nå, vent: ingenPause });
  assert.equal(nytt.kall[0].url, `${NAV_BASE}/api/v1/feed?pageSize=2`);

  /* next_url til en annen vert stopper også søket. */
  const ond = falskNett({ json: () => ({ status: 200, json: { id: "a", next_id: "b", next_url: "https://evil.example/api/v1/feed/b", items: [] } }) });
  await assert.rejects(nav.søk({ nett: ond, tilstand: {}, avtrykk: "nav-1", nå, vent: ingenPause }), /ukjent adresse/);
});

test("Jobbnorge-søket: alle aktive i sider på 1000 med fylkene brukeren valgte, og høyeste id flyttes", async () => {
  const side0 = await json("jobbnorge/jobs-v3-side0.json");
  const full = { jobs: Array.from({ length: 1000 }, (_, i) => ({ ...side0.jobs[0], id: 400000 + i })) };
  const nett = falskNett({ json: (url, _, nr) => ({ status: 200, json: nr === 1 ? full : side0 }) });
  const nå = new Date("2026-10-17T12:00:00Z");
  const r = await jobbnorge.søk({ nett, tilstand: { sisteId: 309000 }, innstillinger: { kilder: { jobbnorge: { fylker: [3, 50] } } }, avtrykk: "jobbnorge-1", nå, vent: ingenPause });
  assert.equal(nett.kall.length, 2, "en side med færre enn 1000 er den siste");
  const u = new URL(nett.kall[1].url);
  assert.deepEqual([u.searchParams.get("period"), u.searchParams.get("results"), u.searchParams.get("page"), u.searchParams.getAll("county").join(",")],
    ["All", "1000", "1", "3,50"]);
  assert.equal(u.searchParams.has("term"), false, "søkeordene sjekkes av forfilteret, ikke av term");
  assert.deepEqual(r.tilstand, { sisteId: 400999, sokAvtrykk: "jobbnorge-1", sokFerdig: nå.toISOString() });
  assert.equal(r.kandidater.length, 1000 + side0.jobs.length);
});

test("Greenhouse: listen hentes uten content, og detaljen avkodes én gang", async () => {
  const full = await json("greenhouse/cognite-jobs-content.json");
  const uten = { ...full, jobs: full.jobs.map(({ content, ...j }) => j) };
  const side = { url: "https://job-boards.eu.greenhouse.io/cognite", navn: "Cognite" };
  const nett = falskNett({ json: url => ({ status: 200, json: url.endsWith("/jobs") ? uten : full.jobs.find(j => url.endsWith(`/${j.id}`)) }) });
  const r = await greenhouse.hent({ nett, side });
  assert.equal(nett.kall[0].url, "https://boards-api.greenhouse.io/v1/boards/cognite/jobs");
  assert.equal(nett.kall[0].kilde, "greenhouse");
  assert.equal(r.kandidater.length, 2);
  const k = r.kandidater[0];
  assert.deepEqual([k.selskap, k.sted, k.detaljert], ["Cognite", "India (Bengaluru)", false]);
  const d = await greenhouse.detalj(k, { nett, side });
  assert.equal(nett.kall[1].url, `https://boards-api.greenhouse.io/v1/boards/cognite/jobs/${k.kildeId}`);
  assert.match(d.tekst, /What Cognite is/);
  assert.doesNotMatch(d.tekst, /&lt;|<div/);
});

test("Lever: hele teksten i listen, og en tom «Åpen søknad» tåles", async () => {
  const liste = await json("lever/bekk-postings.json");
  const nett = falskNett({ json: () => ({ status: 200, json: liste }) });
  const r = await lever.hent({ nett, side: { url: "https://jobs.lever.co/bekk", navn: "" } });
  assert.equal(nett.kall[0].url, "https://api.lever.co/v0/postings/bekk?mode=json");
  assert.deepEqual(r.kandidater.map(k => [k.stilling, k.selskap, k.sted, k.detaljert]),
    [["Åpen søknad", "bekk", "Oslo", true], ["Digital forretningsutvikler", "bekk", "Oslo", true]]);
  assert.equal(r.kandidater[1].lenker.length, 2);
});

test("Teamtailor: jobs.rss gjennom hentSide, med byene og selskapet fra kanalen", async () => {
  const rss = await les("teamtailor/tibber-jobs.rss");
  const nett = falskNett({ side: () => ({ status: 200, html: rss }) });
  const r = await teamtailor.hent({ nett, side: { url: "https://tibber.teamtailor.com/jobs", navn: "" } });
  assert.equal(nett.kall[0].url, "https://tibber.teamtailor.com/jobs.rss");
  assert.equal(r.kandidater.length, 2);
  const k = r.kandidater[0];
  assert.deepEqual([k.selskap, k.stilling, k.sted, k.kildeId], ["Tibber", "Senior Engineering Manager", "Berlin / Stockholm", "d27b61b8-47b3-4c68-a3b4-da35bb7e8fde"]);
  assert.doesNotMatch(k.tekst, /&lt;|<p>/);
});

test("JSON-LD: JobPosting på siden, og en side uten er en feil med forklaring", async () => {
  const jp = await les("jsonld/teamtailor-jobposting.json");
  const html = `<html><head><script type="application/ld+json">{ ødelagt</script><script type="application/ld+json">${jp}</script></head></html>`;
  const r = await jsonld.hent({ nett: falskNett({ side: url => ({ status: 200, sluttUrl: url, html }) }), side: { url: "https://jobs.tibber.com/jobs/8497810", navn: "" } });
  assert.equal(r.kandidater.length, 1);
  const k = r.kandidater[0];
  assert.deepEqual([k.kildeId, k.selskap, k.sted, k.publisert], ["8497810", "Tibber", "Berlin / Stockholm", "2026-10-05T11:32:43+02:00"]);
  await assert.rejects(jsonld.hent({ nett: falskNett({ side: () => ({ html: "<html></html>" }) }), side: { url: "https://x.example/" } }), /JobPosting/);
});

test("typegjenkjenning: kjente tavler fra adressen, Webcruiter og Workday avvist med grunn", () => {
  assert.deepEqual(oppdagType("https://job-boards.eu.greenhouse.io/cognite/jobs/123"), { type: "greenhouse", nokkel: "cognite" });
  assert.deepEqual(oppdagType("https://jobs.lever.co/bekk"), { type: "lever", nokkel: "bekk" });
  assert.deepEqual(oppdagType("https://tibber.teamtailor.com/jobs"), { type: "teamtailor", nokkel: "https://tibber.teamtailor.com" });
  assert.equal(oppdagType("https://www.example.no/karriere").type, "jsonld");
  for(const url of ["https://candidate.webcruiter.com/nb-no/Home/companyadverts?companylock=1", "https://equinor.wd3.myworkdayjobs.com/EQNR"]){
    const o = oppdagType(url);
    assert.equal(o.type, null, url);
    assert.ok(o.grunn.length > 10, url);
  }
  assert.equal(oppdagType("ftp://x.example/").type, null);
  assert.deepEqual(oppdagTypeFraSide('<a href="https://job-boards.greenhouse.io/cognite/jobs/1">', "https://www.cognite.com/careers"),
    { type: "greenhouse", nokkel: "cognite" });
});
