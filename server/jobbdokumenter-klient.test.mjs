import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lagServer } from "./server.mjs";
import { lagBrukere, BRUKERKATALOG } from "./brukere.mjs";
import { lagBrevlager } from "./brevlager.mjs";
import * as Økt from "../src/okt.js";
import * as Jobbdokumenter from "../src/jobbdokumenter.js";

/* ============================================================
   src/jobbdokumenter.js i nettlesermodus, mot en ekte server.

   Samme nettleser i miniatyr som i server/okt-flyt.test.mjs: én
   informasjonskapsel og relative stier. Appmodusen har sin egen fil,
   server/jobbdokumenter-app.test.mjs, fordi I_APP avgjøres når
   modulen lastes.
   ============================================================ */

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

const rad = { id: "j1", selskap: "Eksempel AS", stilling: "Rådgiver", lenke: "https://example.invalid/j1", sted: "Oslo",
  frist: null, status: "todo", sektor: "annet", notat: "", sendtDato: null };

test("klienten henter, lagrer, gir konflikt, utdrag og gjenoppretting over HTTP", async t => {
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "jobbdok-klient-"));
  const tjener = lagServer({ katalog, brukere: lagBrukere({ katalog, iterasjoner: 1 }) });
  await new Promise(r => tjener.listen(0, "127.0.0.1", r));
  t.after(async () => { await new Promise(r => tjener.close(r)); await fs.rm(katalog, { recursive: true, force: true }); });
  base = `http://127.0.0.1:${tjener.address().port}`;

  const konto = await Økt.registrer({ epost: "ola@example.no", passord: "et-godt-nok-passord" });
  assert.equal(konto.ok, true);
  assert.equal((await fetch("/api/jobber", { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ versjon: 0, jobber: [rad] }) })).status, 200);

  const tom = await Jobbdokumenter.hent("j1");
  assert.equal(tom.revisjon, 0);
  const lagret = await Jobbdokumenter.lagre("j1", { ...tom, annonse: { tekst: "Første.", kilde: "limt" } });
  assert.equal(lagret.revisjon, 1);
  await assert.rejects(Jobbdokumenter.lagre("j1", { ...tom, annonse: { tekst: "Gammel fane." } }),
    e => e.code === "konflikt" && e.status === 409);
  await Jobbdokumenter.lagre("j1", { ...lagret, annonse: { tekst: "Andre.", kilde: "limt" } });

  assert.deepEqual(await Jobbdokumenter.utdrag(["annonse.tekst", "annonse.kilde"]),
    { "jobb-j1.json": { "annonse.tekst": "Andre.", "annonse.kilde": "limt" } });
  assert.throws(() => Jobbdokumenter.utdrag(["__proto__"]), e => e.code === "ugyldig");
  await assert.rejects(Jobbdokumenter.hent("finnes-ikke"), e => e.code === "finnes-ikke" && e.status === 404);

  // Et skadet dokument viser seg som feil og kan legges tilbake fra forrige lagring.
  const profil = path.join(katalog, BRUKERKATALOG, konto.bruker.id);
  await fs.writeFile(path.join(profil, "jobb-j1.json"), "ødelagt");
  await assert.rejects(Jobbdokumenter.hent("j1"), e => e.code === "odelagt");
  assert.equal((await Jobbdokumenter.gjenopprett("j1")).annonse.tekst, "Første.");

  // Den samme lageret ser det klienten skrev: ingen egen kopi i nettleseren.
  assert.equal((await lagBrevlager(profil).les("jobb-j1.json")).annonse.tekst, "Første.");
});
