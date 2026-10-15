import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lagServer } from "./server.mjs";
import { lagBrukere, BRUKERKATALOG } from "./brukere.mjs";
import { lagBrevlager } from "./brevlager.mjs";
import * as Økt from "../src/okt.js";
import * as Radar from "../src/radarklient.js";

/* src/radarklient.js i nettlesermodus mot en ekte server, med falskt nett
   og falsk modell. Appmodusen har sin egen fil. */
const full = JSON.parse(await fs.readFile(new URL("../testdata/radar/greenhouse/cognite-jobs-content.json", import.meta.url), "utf8"));

const ekteFetch = globalThis.fetch;
let base = null, kake = null;
globalThis.fetch = async (sti, valg = {}) => {
  const adresse = typeof sti === "string" && sti.startsWith("/") ? base + sti : sti;
  const hoder = { ...(valg.headers || {}) };
  if(kake) hoder.cookie = kake;
  const svar = await ekteFetch(adresse, { ...valg, headers: hoder });
  for(const s of svar.headers.getSetCookie()){
    const par = s.split(";")[0];
    kake = par.endsWith("=") ? null : par;
  }
  return svar;
};

test("klienten snakker med Radar-rutene og legger til en stilling med annonse og match", async t => {
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "radar-klient-"));
  const modeller = [];
  const nett = { hentSide: async () => { throw new Error("uventet"); },
    hentJson: async url => ({ status: 200, json: url.endsWith("/jobs") ? full : full.jobs.find(j => url.endsWith(`/${j.id}`)) }) };
  const tjener = lagServer({ katalog, brukere: lagBrukere({ katalog, iterasjoner: 1 }), nett, brevModellFor: () => async valg => {
    modeller.push(valg.formal);
    if(valg.trinn === "radarforslag") return { data: { sokeord: ["dataingeniør", "dataingeniør"], steder: ["Bergen"], ekskluder: ["lærling"] }, bruk: { input_tokens: 10, output_tokens: 5 } };
    if(valg.formal === "radar") return { data: { vurderinger: JSON.parse(valg.innhold).annonser.map(a => ({ id: a.id, prosent: 90, grunner: ["Passer."] })) }, bruk: { input_tokens: 10, output_tokens: 5 } };
    return { data: { prosent: 70, oppsummering: "Ok.", sprak: "nb", mangler: [], styrker: [] }, bruk: { input_tokens: 10, output_tokens: 5 }, modell: "test" };
  } });
  await new Promise(r => tjener.listen(0, "127.0.0.1", r));
  t.after(async () => { await new Promise(r => tjener.close(r)); await fs.rm(katalog, { recursive: true, force: true }); });
  base = `http://127.0.0.1:${tjener.address().port}`;

  const konto = await Økt.registrer({ epost: "ola@example.no", passord: "et-godt-nok-passord" });
  assert.equal(konto.ok, true);
  const json = { "Content-Type": "application/json" };
  const cv = await (await fetch("/api/cv")).json();
  await fetch("/api/cv", { method: "PUT", headers: json, body: JSON.stringify({ ...cv, tekst: "Dataingeniør." }) });
  await fetch("/api/jobber", { method: "PUT", headers: json, body: JSON.stringify({ versjon: 0, jobber: [{ id: "j1", selskap: "Eksempel", stilling: "Rådgiver", lenke: "https://example.invalid/1", sted: "Oslo", frist: null, status: "todo", sektor: "annet", notat: "", sendtDato: null }] }) });

  await Radar.lagreInnstillinger({ pa: true, kilder: { nav: { pa: false }, jobbnorge: { pa: false } } });
  await Radar.leggTilKarriereside({ url: "https://job-boards.greenhouse.io/cognite" });
  const k = await Radar.sokNa({ leverandor: "anthropic" });
  assert.equal(k.antallNye, full.jobs.length);
  await assert.rejects(Radar.sokNa(), e => e.code === "for-mange" && e.status === 429);
  assert.deepEqual(await Radar.foreslaFraCv({ leverandor: "anthropic" }), { sokeord: ["dataingeniør"], steder: [], ekskluder: ["lærling"] });

  const rad = (await Radar.hentTilstand()).innboks[0];
  const etter = await Radar.lagtTil(rad.id, "j1");
  assert.equal(etter.innboks.find(r => r.id === rad.id).status, "lagtTil");
  const profil = path.join(katalog, BRUKERKATALOG, konto.bruker.id);
  assert.equal((await lagBrevlager(profil).les("jobb-j1.json")).annonse.kilde, "radar");
  for(let i = 0; i < 50 && !modeller.includes("vurdering"); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(modeller.includes("vurdering"), "vanlig match startet av seg selv: " + modeller);
  await assert.rejects(Radar.ikkeInteressert("finnes-ikke"), e => e.code === "finnes-ikke" && e.status === 404);
});
