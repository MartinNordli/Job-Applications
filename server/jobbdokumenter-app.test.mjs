import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lagBrevlager } from "./brevlager.mjs";

/* ============================================================
   src/jobbdokumenter.js i appmodus, uten appen.

   Webviewet snakker med Rust gjennom invoke. Her står en falsk
   window.__TAURI__ i stedet, og hver kommando godtar nøyaktig de
   argumentnavnene Rust-funksjonen har i src-tauri/src/lib.rs og
   brev.rs. Et feilstavet argument ville ellers bare vist seg i den
   pakkede appen. Filoperasjonene gjøres av Node-lageret, som har de
   samme reglene, og feil kommer tilbake som strenger slik Rust sender
   dem.

   Egen fil fordi I_APP avgjøres når modulene lastes.
   ============================================================ */

const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "jobbdok-app-"));
const profil = bruker => bruker ? path.join(katalog, "brukere", bruker) : katalog;
const lesRå = async fil => { try{ return await fs.readFile(fil, "utf8"); }catch(e){ if(e.code === "ENOENT") return null; throw e; } };

/* [påkrevde, valgfrie] per kommando, som i Rust-signaturene. */
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
  brev_modell: [["bruker", "leverandor", "kropp", "kjoringId"], ["kanal"]],
  brev_avbryt_modell: [["bruker", "kjoringId"], []]
};
/* Kroppene brev_modell fikk, så testen kan se hvilken modell som ble bedt om. */
const modellkropper = [];
const ramme = (hendelse, data) => `event: ${hendelse}\ndata: ${JSON.stringify(data)}\n\n`;
const FALSK_MATCH = { prosent: 81, oppsummering: "Kravene er dekket.", sprak: "nb", mangler: [],
  styrker: [{ krav: "Kundeservice", bevis: "Fem år", kilder: [{ kilde: "cv", sitat: "Fem år i kundeservice" }] }] };
const FALSK_FORBEREDELSE = { sammendrag: "Rollen krever kundeservice.", sporsmalTilDem: ["Hvordan er teamet satt sammen?"], sjekkliste: ["Les annonsen på nytt"],
  sporsmal: [{ sporsmal: "Fortell om en krevende kunde.", hvorfor: "Teste ro", svarskisse: "Situasjon, grep, resultat", kilder: [] }],
  eksempler: [{ krav: "Kundeservice", situasjon: "Fem år i kundeservice", kilder: [{ kilde: "cv", sitat: "Fem år i kundeservice" }] }] };
/* Det falske nettet bak hent_side. En streng er en feil, slik Rust sender
   den; alt annet er HTML. */
const sider = new Map();
const hentet = [];
const kall = [];
async function utfør(navn, a){
  const dir = profil(a.bruker);
  const lager = lagBrevlager(dir);
  switch(navn){
    case "data_katalog": return dir;
    case "les_tekst": return lesRå(path.join(dir, a.navn));
    case "flytt_fil": return fs.rename(path.join(dir, a.fra), path.join(dir, a.til));
    case "skriv_atomisk":
      await fs.mkdir(dir, { recursive: true });
      if(a.kopiTil) await fs.copyFile(path.join(dir, a.navn), path.join(dir, a.kopiTil)).catch(e => { if(e.code !== "ENOENT") throw e; });
      return fs.writeFile(path.join(dir, a.navn), a.tekst);
    case "brev_les": return lesRå(path.join(dir, a.navn));
    case "brev_skriv": {
      const d = JSON.parse(a.tekst);
      if(d.revisjon !== a.forventet + 1) throw "ugyldig-revisjon";
      return JSON.stringify(await lager.skriv(a.navn, d, a.forventet));
    }
    case "brev_slett": return lager.slett(a.navn, a.forventet);
    case "brev_liste": return lager.liste();
    case "brev_gjenopprett": return JSON.stringify(await lager.gjenopprett(a.navn));
    case "dokument_utdrag": return lager.utdrag(a.prefiks, a.stier);
    case "brev_modell": {
      const kropp = JSON.parse(a.kropp);
      modellkropper.push(kropp);
      return ramme("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: kropp.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } })
        + ramme("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
        + ramme("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: JSON.stringify(a.kropp.includes("sporsmalTilDem") ? FALSK_FORBEREDELSE : FALSK_MATCH) } })
        + ramme("content_block_stop", { type: "content_block_stop", index: 0 })
        + ramme("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } })
        + ramme("message_stop", { type: "message_stop" });
    }
    case "brev_avbryt_modell": return null;
    case "hent_side": {
      hentet.push(a.url);
      const s = sider.get(a.url);
      if(s?.feil) throw s.feil;
      return { status: 200, sluttUrl: a.url, html: s ?? "" };
    }
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
const Jobbdokumenter = await import("../src/jobbdokumenter.js");

test.after(() => fs.rm(katalog, { recursive: true, force: true }));

test("klienten går gjennom Rust-kommandoene med riktige argumenter", async () => {
  const konto = await Økt.registrer({ epost: "ola@example.no", passord: "et-godt-nok-passord" });
  assert.equal(konto.ok, true, JSON.stringify(konto));
  const id = konto.bruker.id;
  // Profilkatalogen lages ved første skriving, som i appen.
  await fs.mkdir(profil(id), { recursive: true });
  await fs.writeFile(path.join(profil(id), "jobber.json"),
    JSON.stringify({ versjon: 1, jobber: [{ id: "j1", selskap: "Eksempel AS", stilling: "Rådgiver" }] }));

  const tom = await Jobbdokumenter.hent("j1");
  assert.equal(tom.revisjon, 0);assert.equal(tom.jobbId, "j1");
  const lagret = await Jobbdokumenter.lagre("j1", { ...tom, annonse: { tekst: "Første.", kilde: "import" }, match: { prosent: 99 } });
  assert.equal(lagret.revisjon, 1);
  assert.equal(lagret.match, null, "klienten skal ikke kunne skrive en vurdering");
  await assert.rejects(Jobbdokumenter.lagre("j1", { ...tom, annonse: { tekst: "Gammel fane." } }), e => e.code === "konflikt");
  await assert.rejects(Jobbdokumenter.hent("finnes-ikke"), e => e.code === "finnes-ikke");

  assert.deepEqual(await Jobbdokumenter.utdrag(["annonse.kilde", "match.prosent"]), { "jobb-j1.json": { "annonse.kilde": "import" } });

  await Jobbdokumenter.lagre("j1", { ...lagret, annonse: { tekst: "Andre.", kilde: "limt" } });
  await fs.writeFile(path.join(profil(id), "jobb-j1.json"), "ødelagt");
  await assert.rejects(Jobbdokumenter.hent("j1"), e => e.code === "odelagt");
  assert.equal((await Jobbdokumenter.gjenopprett("j1")).annonse.tekst, "Første.");

  for(const navn of ["brev_les", "brev_skriv", "brev_gjenopprett", "dokument_utdrag", "les_tekst"]) assert.ok(kall.includes(navn), navn);
});

test("annonsen hentes, limes inn og flyttes fra brevet gjennom Rust-kommandoene", async () => {
  const id = Økt.nåværendeBruker().id;
  const dir = profil(id);
  const lenke = l => `https://example.invalid/${l}`;
  await fs.writeFile(path.join(dir, "jobber.json"), JSON.stringify({ versjon: 2, jobber: [
    { id: "a1", selskap: "Eksempel AS", stilling: "Rådgiver", lenke: lenke("a1") },
    { id: "a2", selskap: "Eksempel AS", stilling: "Analytiker", lenke: lenke("borte") },
    { id: "a3", selskap: "Eksempel AS", stilling: "Uten lenke", lenke: "" },
    { id: "a4", selskap: "Eksempel AS", stilling: "Fra brevet", lenke: lenke("a4") }
  ] }));
  sider.set(lenke("a1"), "<main><p>Eksempel AS søker en rådgiver med erfaring fra kundeservice og et godt øye for detaljer.</p></main>");
  sider.set(lenke("borte"), { feil: "Siden svarte 404." });

  const d = await Jobbdokumenter.hentAnnonse("a1");
  assert.equal(d.annonse.kilde, "hentet");assert.match(d.annonse.tekst, /kundeservice/);assert.equal(d.revisjon, 1);
  await assert.rejects(Jobbdokumenter.hentAnnonse("a2"), e => e.code === "dod-lenke" && /Lim inn/.test(e.message));
  await assert.rejects(Jobbdokumenter.hentAnnonse("a3"), e => e.code === "mangler-lenke");
  assert.ok(!hentet.includes(""));

  const limt = await Jobbdokumenter.limInnAnnonse("a2", "Teksten jeg tok vare på.");
  assert.equal(limt.annonse.kilde, "limt");assert.equal(limt.annonse.url, lenke("borte"));
  const imp = await Jobbdokumenter.lagreAnnonse("a3", { tekst: "Fra importen.", url: lenke("a3"), kilde: "import" });
  assert.equal(imp.annonse.kilde, "import");

  const lager = lagBrevlager(dir);
  await lager.skriv("brev-a4.json", { ...(await lager.les("brev-a4.json")), annonse: { tekst: "Fra brevet.", url: "", hentet: null } }, 0);
  const a = await Jobbdokumenter.annonseFor("a4");
  assert.equal(a.kilde, "brev");assert.equal(a.tekst, "Fra brevet.");
  assert.equal((await Jobbdokumenter.annonseFor("a4")).kilde, "brev");
  assert.equal((await lager.les("jobb-a4.json")).revisjon, 1);

  // Alt har annonse nå, bortsett fra den døde lenken som fikk en limt inn.
  hentet.length = 0;
  const r = await Jobbdokumenter.hentManglendeAnnonser();
  assert.deepEqual(r, { hentet: [], fraBrev: [], hadde: 4, utenLenke: [], feilet: [], gjenstar: [], stoppet: null });
  assert.equal(hentet.length, 0);
  assert.ok(kall.includes("hent_side"));
});

test("vurderingen av hvor godt stillingen passer går gjennom brev_modell med vurderingsmodellen", async () => {
  const id = Økt.nåværendeBruker().id;
  const dir = profil(id);
  await fs.writeFile(path.join(dir, "jobber.json"), JSON.stringify({ versjon: 2, jobber: [{ id: "m1", selskap: "Eksempel AS", stilling: "Rådgiver" }] }));
  const lager = lagBrevlager(dir);
  await assert.rejects(Jobbdokumenter.vurderMatch("m1"), e => e.code === "mangler-cv");
  await lager.skriv("cv.json", { tekst: "Kari. Fem år i kundeservice.", navn: "", format: "tekst", oppdatert: null }, 0);
  await assert.rejects(Jobbdokumenter.vurderMatch("m1"), e => e.code === "mangler-annonse");
  await Jobbdokumenter.limInnAnnonse("m1", "Rådgiver søkes med erfaring fra kundeservice.");

  const d = await Jobbdokumenter.vurderMatch("m1");
  assert.equal(d.match.prosent, 81);
  assert.equal(d.match.cvRevisjon, 1);
  assert.equal(d.match.leverandor, "anthropic");
  assert.equal(modellkropper.at(-1).model, "claude-sonnet-5-5");
  assert.equal(modellkropper.at(-1).stream, true);
  assert.equal((await lager.les("jobb-m1.json")).match.prosent, 81);
  assert.equal((await Jobbdokumenter.utdrag(["match.prosent"]))["jobb-m1.json"]["match.prosent"], 81);

  const antall = modellkropper.length;
  await Jobbdokumenter.vurderMatch("m1");
  assert.equal(modellkropper.length, antall, "uendret grunnlag bruker den lagrede vurderingen");
  await Jobbdokumenter.vurderMatch("m1", { tving: true });
  assert.equal(modellkropper.length, antall + 1);
  assert.ok(kall.includes("brev_modell"));
});

test("intervjuforberedelsen går gjennom brev_modell med brevmodellen og kan slettes", async () => {
  const id = Økt.nåværendeBruker().id;
  const dir = profil(id);
  const intervju = { id: "iv1", dato: "2026-10-08", tid: "10:00", varighet: 45, sted: "Teams", type: "video", lenke: "", runde: "1", notat: "" };
  await fs.writeFile(path.join(dir, "jobber.json"), JSON.stringify({ versjon: 3, jobber: [{ id: "f1", selskap: "Eksempel AS", stilling: "Rådgiver", intervjuer: [intervju] }] }));
  const lager = lagBrevlager(dir);
  const cv = await lager.skriv("cv.json", { tekst: "Kari. Fem år i kundeservice.", navn: "", format: "tekst", oppdatert: null }, (await lager.les("cv.json")).revisjon);
  await assert.rejects(Jobbdokumenter.lagForberedelse("f1", "iv1"), e => e.code === "mangler-annonse");
  await assert.rejects(Jobbdokumenter.lagForberedelse("f1", "finnes-ikke"), e => e.code === "finnes-ikke");
  await Jobbdokumenter.limInnAnnonse("f1", "Rådgiver søkes med erfaring fra kundeservice.");

  const d = await Jobbdokumenter.lagForberedelse("f1", "iv1");
  assert.equal(d.forberedelser.iv1.sporsmal.length, 1);
  assert.equal(d.forberedelser.iv1.promptversjon, "forberedelse-1");
  assert.equal(d.forberedelser.iv1.cvRevisjon, cv.revisjon);
  assert.equal(modellkropper.at(-1).model, "claude-opus-5-5", "brevmodellen, ikke vurderingsmodellen");
  assert.equal((await lager.les("jobb-f1.json")).forberedelser.iv1.eksempler[0].kilder[0].kilde, "cv");

  const antall = modellkropper.length;
  await Jobbdokumenter.lagForberedelse("f1", "iv1");
  assert.equal(modellkropper.length, antall, "uendret grunnlag bruker den lagrede forberedelsen");
  await Jobbdokumenter.lagForberedelse("f1", "iv1", { tving: true });
  assert.equal(modellkropper.length, antall + 1);

  const etter = await Jobbdokumenter.slettForberedelse("f1", "iv1");
  assert.deepEqual(etter.forberedelser, {});
  assert.deepEqual((await lager.les("jobb-f1.json")).forberedelser, {});
});
