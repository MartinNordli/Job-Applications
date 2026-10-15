import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lagServer } from "./server.mjs";
import { lagBrukere } from "./brukere.mjs";
import { startRadartimer } from "./radar-api.mjs";
import { lagBrevlager } from "./brevlager.mjs";
import { tomCv } from "../src/brevdata.mjs";
import { tomRadar, tomeRadarinnstillinger } from "../src/jobbdokument.mjs";
import { leggTilFraRad } from "../src/radarlogikk.mjs";

/* ============================================================
   Radar over HTTP mot en ekte server i en midlertidig katalog, med
   falskt nett (Greenhouse-svarene i testdata/) og falsk modell.
   Ingen test går ut på nettet eller til en modell.
   ============================================================ */

const full = JSON.parse(await fs.readFile(new URL("../testdata/radar/greenhouse/cognite-jobs-content.json", import.meta.url), "utf8"));
const SIDE = "https://job-boards.greenhouse.io/cognite";
const jobbRad = { id: "j1", selskap: "Eksempelbedrift", stilling: "Rådgiver", lenke: "https://example.invalid/jobb", sted: "Oslo",
  frist: null, status: "todo", sektor: "annet", notat: "", sendtDato: null };

async function start(t){
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "radar-http-"));
  const modellkall = [];
  const brukere = lagBrukere({ katalog, iterasjoner: 1 });
  const nett = {
    hentJson: async url => ({ status: 200, json: url.endsWith("/jobs") ? full : full.jobs.find(j => url.endsWith(`/${j.id}`)) }),
    hentSide: async () => { throw new Error("uventet hentSide"); }
  };
  const server = lagServer({ katalog, brukere, nett, brevModellFor: () => async valg => {
    modellkall.push(valg);
    const annonser = JSON.parse(valg.innhold).annonser;
    return { data: { vurderinger: annonser.map(a => ({ id: a.id, prosent: 80, grunner: ["Passer."] })) }, bruk: { input_tokens: 100, output_tokens: 20 } };
  } });
  await new Promise((ok, feil) => { server.once("error", feil); server.listen(0, "127.0.0.1", ok); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(r => server.close(r)); await fs.rm(katalog, { recursive: true, force: true }); });
  const apiFor = cookie => async (p, method = "GET", body) => {
    const r = await fetch(base + p, { method, headers: { ...(cookie ? { cookie } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, data: await r.json(), headers: r.headers };
  };
  const registrer = async epost => {
    const r = await apiFor()("/api/registrer", "POST", { epost, passord: "syntetisk-godt-passord" });
    assert.equal(r.status, 201);
    return apiFor(r.headers.getSetCookie()[0].split(";")[0]);
  };
  const api = await registrer("alfa@example.no");
  const cv = await api("/api/cv");
  assert.equal((await api("/api/cv", "PUT", { ...cv.data, tekst: "Dataingeniør med ti års erfaring." })).status, 200);
  return { api, registrer, utenOkt: apiFor(), modellkall, katalog, server, brukere };
}

/* Radar på, bare én karriereside som kilde. */
async function slåPå(api){
  let r = await api("/api/radar/innstillinger", "PUT", { pa: true, kilder: { nav: { pa: false }, jobbnorge: { pa: false } } });
  assert.equal(r.status, 200);
  r = await api("/api/radar/karrieresider", "POST", { url: SIDE, navn: "Cognite" });
  assert.equal(r.status, 200);
  return r.data.tilstand;
}

test("rutene krever økt, og «Søk nå» gir innboks og varsel, og en ny kjøring innen et minutt gir 429", async t => {
  const { api, utenOkt, modellkall } = await start(t);
  for(const [p, m, b] of [["/api/radar", "GET"], ["/api/radar/kjor", "POST", {}], ["/api/radar/innstillinger", "PUT", {}]])
    assert.equal((await utenOkt(p, m, b)).status, 401, p);

  const før = await slåPå(api);
  assert.equal(før.karrieresider.length, 1);
  assert.equal((await api("/api/radar/karrieresider", "POST", { url: SIDE })).status, 409, "samme side to ganger");

  const k = await api("/api/radar/kjor", "POST", {});
  assert.equal(k.status, 200);
  assert.equal(k.data.kjort, true);
  assert.equal(k.data.antallNye, full.jobs.length);
  assert.match(k.data.varsel, /passer/);
  assert.equal(k.data.tilstand.antallNye, full.jobs.length);
  assert.equal(k.data.tilstand.kjoringer.length, 1);
  assert.ok(k.data.tilstand.kjoringer[0].kostnad > 0);
  assert.equal(k.data.tilstand.forbruk.vurderinger, full.jobs.length);
  assert.equal(modellkall.length, 1);

  const igjen = await api("/api/radar/kjor", "POST", {});
  assert.equal(igjen.status, 429);
  assert.match(igjen.data.melding, /sekunder/);
  assert.equal(modellkall.length, 1, "ingen nytt kall til modellen");
});

test("to samtidige «Søk nå» gir én kjøring", async t => {
  const { api, modellkall } = await start(t);
  await slåPå(api);
  const svar = await Promise.all([api("/api/radar/kjor", "POST", {}), api("/api/radar/kjor", "POST", {})]);
  assert.deepEqual(svar.map(s => s.status).sort(), [200, 429]);
  assert.equal(modellkall.length, 1);
});

test("«Ikke interessert» tar raden ut, og en rad som er borte gir 404", async t => {
  const { api } = await start(t);
  await slåPå(api);
  const { tilstand } = (await api("/api/radar/kjor", "POST", {})).data;
  const id = tilstand.innboks[0].id;
  const r = await api("/api/radar/ikke-interessert", "POST", { id });
  assert.equal(r.status, 200);
  assert.equal(r.data.tilstand.innboks.some(x => x.id === id), false);
  assert.equal((await api("/api/radar/ikke-interessert", "POST", { id })).status, 404);
  assert.equal((await api("/api/radar/ikke-interessert", "POST", {})).status, 400);
});

test("«Legg til»: annonsen havner i jobbdokumentet, raden merkes, og matchen settes i gang", async t => {
  const { api } = await start(t);
  await slåPå(api);
  const { tilstand } = (await api("/api/radar/kjor", "POST", {})).data;
  const rad = tilstand.innboks[0];
  assert.equal((await api("/api/jobber", "PUT", { versjon: 0, jobber: [jobbRad] })).status, 200);

  const vurdert = [];
  const lagreAnnonse = async (id, a) => {
    const r = await api(`/api/jobber/${id}/annonse`, "PUT", a);
    assert.equal(r.status, 200);
    return r.data;
  };
  const marker = async id => (await api("/api/radar/lagt-til", "POST", { id })).data;
  await leggTilFraRad({ rad, jobbId: "j1", lagreAnnonse, marker, vurder: async id => { vurdert.push(id); } });

  const dok = await api("/api/jobber/j1/annonse");
  assert.equal(dok.data.kilde, "radar");
  assert.equal(dok.data.tekst, rad.tekst);
  const etter = await api("/api/radar");
  assert.equal(etter.data.tilstand.innboks.find(x => x.id === rad.id).status, "lagtTil");
  assert.equal(etter.data.tilstand.antallNye, full.jobs.length - 1);
  assert.deepEqual(vurdert, ["j1"], "vanlig match kjøres for søknaden");

  /* Feiler annonsen, står raden som ny, så den kan legges til igjen. */
  await assert.rejects(leggTilFraRad({ rad: etter.data.tilstand.innboks[1], jobbId: "j1",
    lagreAnnonse: async () => { throw new Error("nei"); }, marker, vurder: async () => { vurdert.push("feil"); } }));
  assert.equal(vurdert.length, 1);
  assert.equal((await api("/api/radar")).data.tilstand.antallNye, full.jobs.length - 1);
});

test("en profil ser ikke en annen profils Radar", async t => {
  const { api, registrer } = await start(t);
  await slåPå(api);
  await api("/api/radar/kjor", "POST", {});
  const beta = await registrer("beta@example.no");
  const r = await beta("/api/radar");
  assert.equal(r.status, 200);
  assert.equal(r.data.tilstand.innboks.length, 0);
  assert.equal(r.data.tilstand.karrieresider.length, 0);
  assert.equal(r.data.tilstand.innstillinger.pa, false);
  assert.equal((await beta("/api/radar/ikke-interessert", "POST", { id: "x" })).status, 404);
});

test("innstillingene normaliseres og døgntaket kan ikke settes over taket", async t => {
  const { api } = await start(t);
  const r = await api("/api/radar/innstillinger", "PUT", { pa: true, maksVurderingerPerDogn: 999999, terskel: 70, sokeord: ["data", 5, "x".repeat(500)] });
  assert.equal(r.status, 200);
  assert.equal(r.data.tilstand.innstillinger.maksVurderingerPerDogn, 150);
  assert.equal(r.data.tilstand.innstillinger.terskel, 70);
  assert.deepEqual(r.data.tilstand.innstillinger.sokeord, ["data"]);
  assert.equal((await api("/api/radar/innstillinger", "PUT", [1])).status, 400);
});

test("karrieresider kan fjernes, og en side som ikke finnes gir 404", async t => {
  const { api } = await start(t);
  const { karrieresider } = await slåPå(api);
  assert.equal((await api("/api/radar/karrieresider/finnes-ikke", "DELETE")).status, 404);
  const r = await api(`/api/radar/karrieresider/${karrieresider[0].id}`, "DELETE");
  assert.equal(r.status, 200);
  assert.equal(r.data.tilstand.karrieresider.length, 0);
});

test("timen kjører profiler som har Radar på og en gammel kjøring, hopper over ferske, og stopper når serveren stopper", async t => {
  const { api, server, brukere, modellkall, katalog } = await start(t);
  await slåPå(api);
  const reg = await brukere.lesRegister();
  const dok = lagBrevlager(path.join(katalog, "brukere", reg.brukere[0].id));
  const logg = { error(){} };

  const timer = startRadartimer({ brukere: server.brukere, tjeneste: server.radartjeneste, logg });
  await timer.første;
  assert.equal((await dok.les("radar.json")).kjoringer.length, 1);
  assert.equal(modellkall.length, 1);

  /* Ny oppstart med en fersk kjøring: ingenting skjer. */
  const igjen = startRadartimer({ brukere: server.brukere, tjeneste: server.radartjeneste, logg });
  await igjen.første;
  assert.equal((await dok.les("radar.json")).kjoringer.length, 1);
  await igjen.stopp();
  await timer.stopp();

  /* Etter stopp starter ingen ny kjøring. */
  const radar = await dok.les("radar.json");
  await dok.skriv("radar.json", { ...radar, kjoringer: [] }, radar.revisjon);
  const stoppet = startRadartimer({ brukere: server.brukere, tjeneste: server.radartjeneste, logg });
  await stoppet.stopp();
  assert.ok((await dok.les("radar.json")).kjoringer.length <= 1);
});
