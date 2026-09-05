import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lagFiler } from "./lager.mjs";
import { lagServer } from "./server.mjs";
import { lesNokkel, ManglerNokkel } from "./nett.mjs";
import {
  validerNokkel, settNokkel, fjernNokkel, nokkelStatus, hale,
  NOKKELFIL, MIN_NOKKEL, MAKS_NOKKEL, MIN_FOR_HALE
} from "./nokkel.mjs";

/* ============================================================
   Ett krav, én test. Listen står øverst i server/nokkel.mjs.

   Nøkkelen i testene er en løgn med riktig form — den skal aldri
   ut noe sted, og det er nettopp det som testes.
   ============================================================ */

const NOKKEL = "sk-ant-api03-en-nokkel-med-hale-XYZW";
const tomKatalog = () => fs.mkdtemp(path.join(os.tmpdir(), "jobber-nokkel-"));

async function medMiljø(verdier, fn){
  const før = {};
  for(const [k, v] of Object.entries(verdier)){
    før[k] = process.env[k];
    if(v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try{ return await fn(); }
  finally{
    for(const [k, v] of Object.entries(før)){
      if(v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const modus = async p => ((await fs.stat(p)).mode & 0o777).toString(8);

/* ---------- krav 1: validerNokkel er en sikkerhetsregel ---------- */

test("krav 1: bare synlig ASCII slipper gjennom", () => {
  for(const kode of [0x00, 0x09, 0x0a, 0x0d, 0x1b, 0x20, 0x7f]){
    const med = "sk-ant-" + String.fromCharCode(kode) + "x".repeat(20);
    assert.equal(validerNokkel(med).ok, false, "tegnkode 0x" + kode.toString(16));
  }
  /* Et linjeskift her ville blitt et ekstra HTTP-hode i kallet til
     modellen. Det er hodeinjeksjon, og den lukkes her. */
  assert.equal(validerNokkel("gyldig-nokkel-nummer-en\r\nX-Ond: 1").ok, false);
  assert.equal(validerNokkel("ugyldig nokkel med mellomrom her").ok, false);
});

test("krav 1: lengden er bundet i begge ender, etter trimming", () => {
  assert.equal(validerNokkel("x".repeat(MIN_NOKKEL - 1)).ok, false);
  assert.equal(validerNokkel("x".repeat(MIN_NOKKEL)).ok, true);
  assert.equal(validerNokkel("x".repeat(MAKS_NOKKEL)).ok, true);
  assert.equal(validerNokkel("x".repeat(MAKS_NOKKEL + 1)).ok, false);
  assert.equal(validerNokkel("  " + NOKKEL + "\n").verdi, NOKKEL, "trimmes");
  assert.equal(validerNokkel("").ok, false);
  assert.equal(validerNokkel(null).ok, false);
  assert.equal(validerNokkel(12345678901234567890).ok, false);
});

test("krav 1: formatet forøvrig valideres ikke", () => {
  /* «sk-ant-»-prefikset kan endre seg. Vi skal ikke være grunnen til
     at en gyldig nøkkel avvises. */
  assert.equal(validerNokkel("et-helt-annet-prefiks-som-er-langt-nok").ok, true);
  assert.equal(validerNokkel("0123456789012345678901234567890123").ok, true);
});

/* ---------- krav 2: 0600 fra første byte ---------- */

test("krav 2: nøkkelfilen er 0600, og tempfilen var det også", async () => {
  const katalog = await tomKatalog();
  const filer = lagFiler(katalog);
  assert.equal((await settNokkel(filer, NOKKEL)).ok, true);
  assert.equal(await modus(path.join(katalog, NOKKELFIL)), "600");

  /* Skriv én gang til: modusen settes på tempfilen ved åpning, så
     også en overskriving går aldri innom 0644. */
  await settNokkel(filer, NOKKEL + "2");
  assert.equal(await modus(path.join(katalog, NOKKELFIL)), "600");
  assert.deepEqual(await fs.readdir(katalog), [NOKKELFIL], "ingen tempfil ligger igjen");
});

/* ---------- krav 3: sletting gjennom filer-sømmen ---------- */

test("krav 3: sletting er idempotent og går gjennom filer.slett", async () => {
  const katalog = await tomKatalog();
  const filer = lagFiler(katalog);
  await fjernNokkel(filer);                 /* fantes aldri — ikke en feil */
  await settNokkel(filer, NOKKEL);
  await fjernNokkel(filer);
  await fjernNokkel(filer);
  assert.deepEqual(await fs.readdir(katalog), []);
  assert.equal(typeof filer.slett, "function");
});

/* ---------- krav 4: presedensen ---------- */

test("krav 4: brukerens egen nøkkel vinner over miljøvariabelen", async () => {
  const katalog = await tomKatalog();
  await settNokkel(lagFiler(katalog), NOKKEL);
  /* Snudd siden enbrukertiden, der miljøvariabelen gikk foran. Med
     nøkkel per bruker ville en delt miljøvariabel overstyrt hver
     enkelt brukers egen — og det er brukerens egen kreditt. */
  assert.equal(await medMiljø({ ANTHROPIC_API_KEY: "sk-ant-fra-miljoet-som-er-langt" },
                              () => lesNokkel({ katalog, tillatMiljø: true })), NOKKEL);
});

test("krav 4: miljøvariabelen gjelder bare når kallstedet tillater den", async () => {
  const katalog = await tomKatalog();
  await medMiljø({ ANTHROPIC_API_KEY: "sk-ant-fra-miljoet-som-er-langt" }, async () => {
    assert.equal(await lesNokkel({ katalog, tillatMiljø: true }), "sk-ant-fra-miljoet-som-er-langt");
    await assert.rejects(() => lesNokkel({ katalog, tillatMiljø: false }), ManglerNokkel);
    await assert.rejects(() => lesNokkel({ katalog }), ManglerNokkel, "fail closed som standard");
  });
});

test("krav 4: uten nøkkel noe sted er det en egen feil", async () => {
  const katalog = await tomKatalog();
  const e = await medMiljø({ ANTHROPIC_API_KEY: undefined },
    () => lesNokkel({ katalog, tillatMiljø: true }).then(() => null, x => x));
  assert.ok(e instanceof ManglerNokkel);
  assert.equal(e.navn, "mangler-nokkel");
  assert.match(e.message, /nokkel\.txt/);
});

test("krav 4: tomme verdier teller som ingen nøkkel", async () => {
  const katalog = await tomKatalog();
  await fs.writeFile(path.join(katalog, NOKKELFIL), "   \n");
  await assert.rejects(() => medMiljø({ ANTHROPIC_API_KEY: "   " },
    () => lesNokkel({ katalog, tillatMiljø: true })), ManglerNokkel);
});

/* ---------- krav 5: halen, og bare halen ---------- */

test("krav 5: hale er fire tegn, og bare fra tolv tegn og opp", () => {
  assert.equal(hale(NOKKEL), "XYZW");
  assert.equal(hale("x".repeat(MIN_FOR_HALE)), "xxxx");
  assert.equal(hale("x".repeat(MIN_FOR_HALE - 1)), null);
  assert.equal(hale(""), null);
  assert.equal(hale(null), null);
});

test("krav 5: statusen bærer kilde, aldri nøkkelen", async () => {
  const katalog = await tomKatalog();
  const filer = lagFiler(katalog);

  assert.deepEqual(await nokkelStatus(filer, { tillatMiljø: false }),
                   { finnes: false, kilde: "ingen" });

  await settNokkel(filer, NOKKEL);
  const st = await nokkelStatus(filer, { tillatMiljø: false });
  assert.equal(st.finnes, true);
  assert.equal(st.kilde, "egen");
  assert.equal(st.hale, "XYZW");
  assert.ok(st.satt);
  assert.equal(JSON.stringify(st).includes(NOKKEL), false);
});

test("krav 5: kilde «miljø» får aldri hale", async () => {
  const katalog = await tomKatalog();
  const st = await medMiljø({ ANTHROPIC_API_KEY: NOKKEL },
    () => nokkelStatus(lagFiler(katalog), { tillatMiljø: true }));
  /* Under DELT_NOKKEL=1 ville samme svar gått til alle. Det er
     operatørens nøkkel, ikke brukerens. */
  assert.deepEqual(st, { finnes: true, kilde: "miljø" });
});

test("krav 5: kilden kan falle tilbake til miljø etter sletting", async () => {
  const katalog = await tomKatalog();
  const filer = lagFiler(katalog);
  await settNokkel(filer, NOKKEL);
  await medMiljø({ ANTHROPIC_API_KEY: "sk-ant-fra-miljoet-som-er-langt" }, async () => {
    assert.equal((await nokkelStatus(filer, { tillatMiljø: true })).kilde, "egen");
    await fjernNokkel(filer);
    assert.equal((await nokkelStatus(filer, { tillatMiljø: true })).kilde, "miljø");
    assert.equal((await nokkelStatus(filer, { tillatMiljø: false })).kilde, "ingen");
  });
});

/* ---------- krav 6: over HTTP, hele veien ---------- */

async function start(nett){
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "jobber-nokkelapi-"));
  const tjener  = lagServer({ katalog, nett });
  await new Promise(r => tjener.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${tjener.address().port}`;

  const r = await fetch(`${base}/api/registrer`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ epost: "ola@example.no", passord: "et-godt-nok-passord" })
  });
  const cookie = r.headers.getSetCookie()[0].split(";")[0];
  const api = (sti, valg = {}) => fetch(base + sti,
    { ...valg, headers: { cookie, ...(valg.headers || {}) } });

  return { katalog, base, cookie, api, stopp: () => new Promise(x => tjener.close(x)) };
}

const settOverHttp = (api, nokkel) => api("/api/nokkel", {
  method: "PUT", headers: { "content-type": "application/json" },
  body: JSON.stringify({ nokkel })
});

test("krav 6: GET /api/nokkel svarer, og kroppen inneholder ikke nøkkelen", async t => {
  const { api, stopp } = await start();
  t.after(stopp);

  const tom = await api("/api/nokkel");
  assert.equal(tom.status, 200);
  assert.equal(tom.headers.get("cache-control"), "no-store");
  assert.deepEqual(await tom.json(), { finnes: false, kilde: "ingen" });

  assert.equal((await settOverHttp(api, NOKKEL)).status, 204);

  const r = await api("/api/nokkel");
  const tekst = await r.text();
  assert.equal(tekst.includes(NOKKEL), false, "hele nøkkelen kommer aldri tilbake");
  const j = JSON.parse(tekst);
  assert.equal(j.kilde, "egen");
  assert.equal(j.hale, "XYZW");
});

test("krav 6: Allow er GET, PUT, DELETE", async t => {
  const { api, stopp } = await start();
  t.after(stopp);
  const r = await api("/api/nokkel", { method: "PATCH" });
  assert.equal(r.status, 405);
  assert.equal(r.headers.get("allow"), "GET, PUT, DELETE");
});

test("krav 6: DELETE er idempotent", async t => {
  const { api, stopp } = await start();
  t.after(stopp);
  assert.equal((await api("/api/nokkel", { method: "DELETE" })).status, 204);
  await settOverHttp(api, NOKKEL);
  assert.equal((await api("/api/nokkel", { method: "DELETE" })).status, 204);
  assert.equal((await api("/api/nokkel", { method: "DELETE" })).status, 204);
  assert.equal((await (await api("/api/nokkel")).json()).finnes, false);
});

test("krav 6: en ugyldig nøkkel avvises uten å bli gjentatt i svaret", async t => {
  const { api, stopp } = await start();
  t.after(stopp);
  const ond = "sk-ant-ond\r\nX-Ond: 1-og-lang-nok-til-a-passere";
  const r = await settOverHttp(api, ond);
  assert.equal(r.status, 400);
  const tekst = await r.text();
  assert.equal(tekst.includes("X-Ond"), false, "meldingen gjentar ikke det som ble sendt");
  assert.match(JSON.parse(tekst).melding, /API-nøkkel/);
});

test("krav 6: nøkkelen krever økt", async t => {
  const { base, stopp } = await start();
  t.after(stopp);
  for(const metode of ["GET", "PUT", "DELETE"]){
    const r = await fetch(`${base}/api/nokkel`, { method: metode,
      headers: { "content-type": "application/json" },
      body: metode === "PUT" ? JSON.stringify({ nokkel: NOKKEL }) : undefined });
    assert.equal(r.status, 401, metode);
    assert.equal((await r.json()).feil, "utlogget");
  }
});

/* ---------- krav 6: heller ikke i importloggen ---------- */

test("krav 6: importlogg.jsonl inneholder ikke nøkkelen etter en import", async t => {
  const nett = {
    hentSide: async url => ({ status: 200, sluttUrl: url,
      html: "<h1>Utvikler</h1><p>Vi soker en utvikler til teamet vart i Oslo, med lang beskrivelse.</p>" }),
    /* Den ekte spørModell ville lest nøkkelen; her sjekker vi at det
       som skrives til loggen ikke bærer den uansett. */
    spørModell: async () => ({ usage: { input_tokens: 100, output_tokens: 20 },
      content: [{ type: "text", text: JSON.stringify({ selskap: "Equinor", stilling: "Utvikler" }) }] })
  };
  const { katalog, api, stopp } = await start(nett);
  t.after(stopp);

  await settOverHttp(api, NOKKEL);
  const r = await api("/api/importer", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/jobb" })
  });
  assert.equal(r.status, 200);

  /* Loggen skrives med vilje etter at svaret er sendt — en import som
     lyktes skal ikke feile fordi en linje ikke lot seg skrive. */
  const brukere = await fs.readdir(path.join(katalog, "brukere"));
  const sti = path.join(katalog, "brukere", brukere[0], "importlogg.jsonl");
  let logg = "";
  for(let i = 0; i < 50 && !logg; i++){
    logg = await fs.readFile(sti, "utf8").catch(() => "");
    if(!logg) await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(logg.includes("example.com"), "loggen ble skrevet");
  assert.equal(logg.includes(NOKKEL), false);
  assert.equal(logg.includes("XYZW"), false, "ikke engang halen");
});
