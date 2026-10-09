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
  dokument_utdrag: [["bruker", "prefiks", "stier"], []]
};
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
