import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lagBrevlager } from "./brevlager.mjs";
import { tomCv } from "../src/brevdata.mjs";

/* ============================================================
   src/radarklient.js i appmodus, uten appen: kjernen kjører i
   webviewet over falske Tauri-kommandoer (som i
   server/jobbdokumenter-app.test.mjs), med falskt nett og falsk
   modell. Egen fil fordi I_APP avgjøres når modulene lastes.
   ============================================================ */

const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "radar-app-"));
const profil = bruker => bruker ? path.join(katalog, "brukere", bruker) : katalog;
const lesRå = async fil => { try{ return await fs.readFile(fil, "utf8"); }catch(e){ if(e.code === "ENOENT") return null; throw e; } };
const full = JSON.parse(await fs.readFile(new URL("../testdata/radar/greenhouse/cognite-jobs-content.json", import.meta.url), "utf8"));

const SIGNATURER = {
  data_katalog: [[], ["bruker"]],
  les_tekst: [["navn"], ["bruker"]],
  flytt_fil: [["fra", "til"], ["bruker"]],
  skriv_atomisk: [["navn", "tekst"], ["kopiTil", "bruker"]],
  brev_les: [["bruker", "navn"], ["forrige"]],
  brev_skriv: [["bruker", "navn", "tekst", "forventet"], []],
  brev_slett: [["bruker", "navn", "forventet"], []],
  brev_liste: [["bruker"], []],
  brev_gjenopprett: [["bruker", "navn"], []],
  dokument_utdrag: [["bruker", "prefiks", "stier"], []],
  hent_side: [["url"], []],
  hent_json: [["url", "kilde"], ["etag", "sistEndret", "bruker"]],
  brev_modell: [["bruker", "leverandor", "kropp", "kjoringId"], ["kanal"]],
  brev_avbryt_modell: [["bruker", "kjoringId"], []],
  radar_varsel: [["tekst"], []]
};
const modellkropper = [], varsler = [], kall = [];
const ramme = (hendelse, data) => `event: ${hendelse}\ndata: ${JSON.stringify(data)}\n\n`;
const sse = tekst => ramme("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } })
  + ramme("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
  + ramme("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: tekst } })
  + ramme("content_block_stop", { type: "content_block_stop", index: 0 })
  + ramme("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } })
  + ramme("message_stop", { type: "message_stop" });
const FALSK_MATCH = { prosent: 81, oppsummering: "Kravene er dekket.", sprak: "nb", mangler: [], styrker: [] };

async function utfør(navn, a){
  const dir = profil(a.bruker);
  const lager = lagBrevlager(dir);
  switch(navn){
    case "data_katalog": return dir;
    case "les_tekst": return lesRå(path.join(dir, a.navn));
    case "brev_les": return lesRå(path.join(dir, a.navn));
    case "brev_skriv": {
      const d = JSON.parse(a.tekst);
      if(d.revisjon !== a.forventet + 1) throw "ugyldig-revisjon";
      return JSON.stringify(await lager.skriv(a.navn, d, a.forventet));
    }
    case "brev_liste": return lager.liste();
    case "dokument_utdrag": return lager.utdrag(a.prefiks, a.stier);
    case "hent_json": return { status: 200, json: a.url.endsWith("/jobs") ? full : full.jobs.find(j => a.url.endsWith(`/${j.id}`)), etag: null, sistEndret: null };
    case "brev_modell": {
      const kropp = JSON.parse(a.kropp);
      modellkropper.push(kropp);
      if(/haiku/.test(kropp.model)){
        const ider = [...new Set([...JSON.stringify(kropp).matchAll(/\\"id\\":\\"(a\d+)\\"/g)].map(m => m[1]))];
        return sse(JSON.stringify({ vurderinger: ider.map(id => ({ id, prosent: 85, grunner: ["Passer."] })) }));
      }
      return sse(JSON.stringify(FALSK_MATCH));
    }
    case "brev_avbryt_modell": return null;
    case "radar_varsel": varsler.push(a.tekst); return true;
  }
}
const lagringsplass = new Map();
globalThis.window = {
  localStorage: { getItem: n => lagringsplass.get(n) ?? null, setItem: (n, v) => lagringsplass.set(n, String(v)), removeItem: n => lagringsplass.delete(n) },
  __TAURI__: { core: { async invoke(navn, a = {}){
    const sig = SIGNATURER[navn];
    if(!sig) throw `ukjent kommando ${navn}`;
    const [påkrevde, valgfrie] = sig;
    for(const k of Object.keys(a)) if(!påkrevde.includes(k) && !valgfrie.includes(k)) throw `${navn} har ikke argumentet ${k}`;
    for(const k of påkrevde) if(a[k] === undefined) throw `${navn} mangler ${k}`;
    kall.push(navn);
    try{ return await utfør(navn, a); }
    catch(e){ throw typeof e === "string" ? e : e?.code || "Fikk ikke skrevet dokumentet."; }
  } } }
};

const Økt = await import("../src/okt.js");
const Radar = await import("../src/radarklient.js");
test.after(() => fs.rm(katalog, { recursive: true, force: true }));

test("Radar i appen: innstillinger, karriereside, «Søk nå» med varsel og tak, «Legg til» med match, og timeplan", async () => {
  const konto = await Økt.registrer({ epost: "ola@example.no", passord: "et-godt-nok-passord" });
  assert.equal(konto.ok, true, JSON.stringify(konto));
  const dir = profil(konto.bruker.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "jobber.json"), JSON.stringify({ versjon: 1, jobber: [{ id: "j1", selskap: "Eksempel AS", stilling: "Rådgiver" }] }));
  await lagBrevlager(dir).skriv("cv.json", { ...tomCv(), tekst: "Dataingeniør med ti års erfaring." }, 0);

  const tom = await Radar.hentTilstand();
  assert.equal(tom.innstillinger.pa, false);
  assert.equal(tom.antallNye, 0);

  const lyttet = [];
  const avmeld = Radar.påEndring(t => lyttet.push(t.antallNye));
  await Radar.lagreInnstillinger({ pa: true, kilder: { nav: { pa: false }, jobbnorge: { pa: false } } });
  await assert.rejects(Radar.leggTilKarriereside({ url: "https://www.webcruiter.com/x" }), e => e.code === "ugyldig");
  const med = await Radar.leggTilKarriereside({ url: "https://job-boards.greenhouse.io/cognite", navn: "Cognite" });
  assert.equal(med.karrieresider.length, 1);

  const k = await Radar.sokNa();
  assert.equal(k.kjort, true);
  assert.equal(k.antallNye, full.jobs.length);
  assert.equal(k.tilstand.antallNye, full.jobs.length);
  assert.deepEqual(varsler, [k.varsel]);
  assert.match(varsler[0], /passer/);
  assert.equal(modellkropper.at(-1).model, "claude-haiku-5-5");
  await assert.rejects(Radar.sokNa(), e => e.code === "for-mange");
  assert.equal(modellkropper.length, 1);

  const rad = k.tilstand.innboks[0];
  assert.equal(rad.status, "ny");
  const antallFør = modellkropper.length;
  const etter = await Radar.lagtTil(rad.id, "j1");
  assert.equal(etter.innboks.find(r => r.id === rad.id).status, "lagtTil");
  const jobbdok = await lagBrevlager(dir).les("jobb-j1.json");
  assert.equal(jobbdok.annonse.kilde, "radar");
  assert.equal(jobbdok.annonse.tekst, rad.tekst);
  for(let i = 0; i < 50 && modellkropper.length === antallFør; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(modellkropper.at(-1).model, "claude-sonnet-5-5", "vanlig match startet av seg selv");
  await assert.rejects(Radar.lagtTil("finnes-ikke", "j1"), e => e.code === "finnes-ikke");

  const ikke = await Radar.ikkeInteressert(etter.innboks.find(r => r.status === "ny").id);
  assert.equal(ikke.antallNye, full.jobs.length - 2);

  /* Timeplanen: en fersk kjøring gir ingen ny ved start, og stopp stopper. */
  const resultater = [];
  const stopp = Radar.startTimeplan({ påResultat: r => resultater.push(r) });
  await new Promise(r => setTimeout(r, 100));
  stopp();
  assert.equal(resultater.length, 0);
  assert.equal(modellkropper.filter(k => /haiku/.test(k.model)).length, 1);

  const uten = await Radar.fjernKarriereside(med.karrieresider[0].id);
  assert.equal(uten.karrieresider.length, 0);
  avmeld();
  assert.ok(lyttet.length >= 5);
});
