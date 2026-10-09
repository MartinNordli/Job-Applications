import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lagServer } from "./server.mjs";
import { lagBrukere } from "./brukere.mjs";
import { lagBrevlager } from "./brevlager.mjs";
import { sjekksum } from "../src/jobbdokument.mjs";
import { hentefeil, annonseFraSide } from "../src/annonsetekst.mjs";
import { lagJobbdokumenter } from "../src/jobbdokumenttjeneste.mjs";
import { Brevfeil } from "../src/brevdata.mjs";

/* ============================================================
   Annonsen i jobbdokumentet: henting fra søknadens lenke, innliming,
   flyttingen fra brevdokumentet og hentingen av alt som mangler.

   Nettet er falskt overalt. sider er et kart fra adresse til det
   hentSide skal gjøre, og hentet teller hvilke adresser som ble
   spurt, så testene kan si at noe ikke ble hentet.
   ============================================================ */

const ANNONSE = "<main><h1>Rådgiver</h1><p>Eksempelbedrift søker en rådgiver som vil arbeide med kunder i hele landet.</p>"
  + "<p>Du har erfaring fra kundeservice og liker å skrive.</p></main>";
const rad = (o = {}) => ({ id: "j1", selskap: "Eksempelbedrift", stilling: "Rådgiver", lenke: "https://example.invalid/jobb",
  sted: "Oslo", frist: null, status: "todo", sektor: "annet", notat: "", sendtDato: null, ...o });

function falskNett(sider = {}){
  const hentet = [];
  return {
    hentet,
    hentSide: async url => {
      hentet.push(url);
      const s = sider[url];
      if(s instanceof Error) throw s;
      if(typeof s === "function") return s(url);
      return { status: 200, sluttUrl: url, html: s ?? ANNONSE };
    },
    spørModell: async () => { throw new Error("modellen skal ikke spørres"); }
  };
}

async function start(t, nett = falskNett()){
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "annonse-test-"));
  const brukere = lagBrukere({ katalog, iterasjoner: 1 });
  const server = lagServer({ katalog, brukere, nett });
  await new Promise((ok, feil) => { server.once("error", feil); server.listen(0, "127.0.0.1", ok); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(r => server.close(r)); await fs.rm(katalog, { recursive: true, force: true }); });
  const apiFor = cookie => async (p, method = "GET", body) => {
    const r = await fetch(base + p, { method, headers: { ...(cookie ? { cookie } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    return { status: r.status, data: await r.json() };
  };
  async function registrer(epost){
    const r = await fetch(base + "/api/registrer", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ epost, passord: "syntetisk-godt-passord" }) });
    assert.equal(r.status, 201);
    const { bruker } = await r.json();
    return { api: apiFor(r.headers.getSetCookie()[0].split(";")[0]), dir: path.join(katalog, "brukere", bruker.id) };
  }
  const { api, dir } = await registrer("alfa@example.no");
  return { api, dir, registrer, utenOkt: apiFor(), nett, katalog };
}
const medJobber = async (api, jobber = [rad()]) => assert.equal((await api("/api/jobber", "PUT", { versjon: 0, jobber })).status, 200);
const hent = (api, id = "j1") => api(`/api/jobber/${id}/annonse/hent`, "POST");

/* ---------- reglene ---------- */

test("hentefeilene skilles på det brukeren kan gjøre", () => {
  for(const s of [404, 410]) assert.equal(hentefeil(new Error(`Siden svarte ${s}.`)).code, "dod-lenke");
  // Rust sender feilen som en streng over invoke.
  assert.equal(hentefeil("Siden svarte 404.").code, "dod-lenke");
  assert.equal(hentefeil(new Brevfeil("appfeil", "Siden svarte 410.", 409)).code, "dod-lenke");
  assert.equal(hentefeil(new Error("Adressen peker ikke til en nettside.")).code, "ikke-nettside");
  const f = hentefeil(new Error("Siden svarte 503."));
  assert.equal(f.code, "henting");assert.match(f.melding, /503/);assert.equal(f.status, 502);
  assert.equal(hentefeil(new Error("Adressen peker til et internt nett.")).melding, "Adressen peker til et internt nett.");
  assert.equal(hentefeil(new Error("x".repeat(201))).melding, "Fikk ikke hentet siden.");
  assert.equal(hentefeil(null).melding, "Fikk ikke hentet siden.");
});

test("for lite tekst på siden forklares som en side bygget med JavaScript", () => {
  assert.throws(() => annonseFraSide("<div id='app'></div>"), e => e.code === "tom-annonse" && e.status === 422 && /JavaScript/.test(e.melding));
  assert.throws(() => annonseFraSide("<main>" + "ord ".repeat(30000) + "</main>"), e => e.code === "for-lang" && e.status === 422);
  assert.match(annonseFraSide(ANNONSE), /kundeservice/);
});

/* ---------- hent fra lenken ---------- */

test("annonsen hentes fra søknadens lenke og lagres med kilde «hentet»", async t => {
  const nett = falskNett({ "https://example.invalid/jobb": url => ({ status: 200, sluttUrl: url + "/endelig", html: ANNONSE }) });
  const { api } = await start(t, nett);
  await medJobber(api);
  const før = Date.now();
  const r = await hent(api);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.revisjon, 1);
  assert.equal(r.data.annonse.kilde, "hentet");
  assert.equal(r.data.annonse.url, "https://example.invalid/jobb/endelig");
  assert.match(r.data.annonse.tekst, /Eksempelbedrift søker en rådgiver/);
  assert.equal(r.data.annonse.sjekksum, sjekksum(r.data.annonse.tekst));
  assert.ok(Date.parse(r.data.annonse.hentet) >= før - 1000);
  assert.deepEqual(nett.hentet, ["https://example.invalid/jobb"]);
  assert.equal((await api("/api/jobber/j1/dokument")).data.annonse.kilde, "hentet");
});

test("en vurdering i dokumentet står når annonsen hentes på nytt", async t => {
  const { api, dir } = await start(t);
  await medJobber(api);
  const lager = lagBrevlager(dir);
  await lager.skriv("jobb-j1.json", { revisjon: 0, match: { prosent: 71 } }, 0);
  const r = await hent(api);
  assert.equal(r.status, 200);assert.equal(r.data.match.prosent, 71);assert.equal(r.data.revisjon, 2);
});

test("feilene ved henting sier hva brukeren kan gjøre", async t => {
  const nett = falskNett({
    "https://example.invalid/borte": new Error("Siden svarte 404."),
    "https://example.invalid/fjernet": new Error("Siden svarte 410."),
    "https://example.invalid/pdf": new Error("Adressen peker ikke til en nettside."),
    "https://example.invalid/js": "<html><body><div id='app'></div><script>start()</script></body></html>",
    "https://example.invalid/nede": new Error("Siden svarte 503."),
    "https://example.invalid/intern": new Error("Adressen peker til et internt nett.")
  });
  const { api } = await start(t, nett);
  const rader = ["borte", "fjernet", "pdf", "js", "nede", "intern"].map(n => rad({ id: n, lenke: `https://example.invalid/${n}` }));
  await medJobber(api, [...rader, rad({ id: "uten", lenke: "" })]);
  const forventet = { borte: [502, "dod-lenke"], fjernet: [502, "dod-lenke"], pdf: [502, "ikke-nettside"],
    js: [422, "tom-annonse"], nede: [502, "henting"], intern: [502, "henting"], uten: [422, "mangler-lenke"] };
  for(const [id, [status, feil]] of Object.entries(forventet)){
    const r = await hent(api, id);
    assert.equal(r.status, status, id);assert.equal(r.data.feil, feil, id);
    assert.ok(r.data.melding && !r.data.melding.includes("/Users"), id);
  }
  assert.match((await hent(api, "borte")).data.melding, /Lim inn/);
  assert.match((await hent(api, "js")).data.melding, /JavaScript/);
  assert.ok(!nett.hentet.includes(""), "en søknad uten lenke skal ikke gå ut på nettet");
  // Ingenting ble skrevet for noen av dem.
  for(const id of Object.keys(forventet)) assert.equal((await api(`/api/jobber/${id}/dokument`)).data.revisjon, 0, id);
  assert.equal((await hent(api, "finnes-ikke")).status, 404);
});

test("henting krever økt, POST og en gyldig id", async t => {
  const { api, utenOkt, nett } = await start(t);
  await medJobber(api);
  assert.equal((await utenOkt("/api/jobber/j1/annonse/hent", "POST")).status, 401);
  assert.equal((await utenOkt("/api/jobber/j1/annonse")).status, 401);
  assert.equal((await utenOkt("/api/jobber/j1/annonse", "PUT", { tekst: "x" })).status, 401);
  assert.equal((await utenOkt("/api/jobbdokumenter/hent-manglende", "POST", {})).status, 401);
  assert.equal(nett.hentet.length, 0);
  assert.equal((await api("/api/jobber/j1/annonse/hent")).status, 405);
  assert.equal((await api("/api/jobber/j1/annonse", "DELETE")).status, 405);
  assert.equal((await api("/api/jobber/a.b/annonse/hent", "POST")).status, 400);
  assert.equal((await api("/api/jobber/j1/annonse/annet", "POST")).status, 404);
});

test("taket er 30 hentinger i timen per profil, og en annen profil har sitt eget", async t => {
  const { api, registrer, nett } = await start(t);
  await medJobber(api);
  for(let i = 0; i < 30; i++) assert.equal((await hent(api)).status, 200, `henting ${i + 1}`);
  const r = await hent(api);
  assert.equal(r.status, 429);assert.equal(r.data.feil, "for-mange");assert.match(r.data.melding, /minutter/);
  assert.equal(nett.hentet.length, 30, "den 31. skal ikke gå ut på nettet");
  const beta = (await registrer("beta@example.no")).api;
  await medJobber(beta);
  assert.equal((await hent(beta)).status, 200);
  // Taket gjelder hentingen, ikke importen. Den falske modellen feiler, så
  // importen svarer 502, men den kom forbi sitt eget tak og ut på nettet.
  const imp = await api("/api/importer", "POST", { url: "https://example.invalid/ny" });
  assert.notEqual(imp.status, 429);assert.equal(nett.hentet.at(-1), "https://example.invalid/ny");
});

/* ---------- lim inn og import ---------- */

test("innlimt annonse lagres med kilde «limt» og søknadens lenke", async t => {
  const { api, nett } = await start(t);
  await medJobber(api);
  const r = await api("/api/jobber/j1/annonse", "PUT", { tekst: "Eksempelbedrift søker rådgiver.", kilde: "limt" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.annonse.kilde, "limt");
  assert.equal(r.data.annonse.url, "https://example.invalid/jobb");
  assert.ok(r.data.annonse.hentet);
  assert.equal(r.data.annonse.sjekksum, sjekksum("Eksempelbedrift søker rådgiver."));
  assert.equal(nett.hentet.length, 0);

  const imp = await api("/api/jobber/j1/annonse", "PUT", { tekst: "Fra importen.", url: "https://example.invalid/endelig",
    hentet: "2026-10-01T10:00:00.000Z", kilde: "import" });
  assert.equal(imp.status, 200);assert.equal(imp.data.revisjon, 2);
  assert.deepEqual({ ...imp.data.annonse, sjekksum: undefined },
    { tekst: "Fra importen.", url: "https://example.invalid/endelig", kilde: "import", hentet: "2026-10-01T10:00:00.000Z", sjekksum: undefined });

  for(const [kropp, feil] of [
    [{ tekst: "   ", kilde: "limt" }, "tom-annonse"],
    [{ tekst: "x", kilde: "hentet" }, "ugyldig"],
    [{ tekst: "x", kilde: "brev" }, "ugyldig"],
    [{ tekst: "x".repeat(100001), kilde: "limt" }, "ugyldig"],
    [{ tekst: "x", url: "javascript:alert(1)", kilde: "limt" }, "ugyldig"],
    [{ tekst: 7 }, "ugyldig"],
    [[1, 2], "ugyldig"],
    ["null", "ugyldig"]
  ]){
    const s = await api("/api/jobber/j1/annonse", "PUT", kropp);
    assert.equal(s.status, 400, JSON.stringify(kropp).slice(0, 80));assert.equal(s.data.feil, feil, JSON.stringify(kropp).slice(0, 80));
  }
  assert.equal((await api("/api/jobber/j1/dokument")).data.revisjon, 2);
  assert.equal((await api("/api/jobber/borte/annonse", "PUT", { tekst: "x" })).status, 404);
});

/* ---------- flyttingen fra brevet ---------- */

test("annonsen i brevet flyttes én gang, og bare når jobbdokumentet aldri har hatt en", async t => {
  const { api, dir } = await start(t);
  await medJobber(api, [rad(), rad({ id: "j2" }), rad({ id: "j3" }), rad({ id: "j4" })]);
  const lager = lagBrevlager(dir);
  const brevannonse = { tekst: "Annonsen fra brevet.", url: "https://example.invalid/brev", hentet: "2026-09-01T08:00:00.000Z" };
  for(const id of ["j1", "j2", "j3"]) await lager.skriv(`brev-${id}.json`, { ...(await lager.les(`brev-${id}.json`)), annonse: brevannonse }, 0);

  // j1: tomt jobbdokument, så annonsen flyttes.
  let r = await api("/api/jobber/j1/annonse");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ...brevannonse, kilde: "brev", sjekksum: sjekksum(brevannonse.tekst) });
  assert.equal((await api("/api/jobber/j1/dokument")).data.revisjon, 1);
  // Andre gang skrives ingenting.
  assert.equal((await api("/api/jobber/j1/annonse")).data.kilde, "brev");
  assert.equal((await api("/api/jobber/j1/dokument")).data.revisjon, 1);
  // Brevet er urørt.
  assert.equal((await lager.les("brev-j1.json")).annonse.tekst, brevannonse.tekst);

  // Tømmes annonsen senere, kommer ikke brevets tilbake.
  const d = (await api("/api/jobber/j1/dokument")).data;
  assert.equal((await api("/api/jobber/j1/dokument", "PUT", { ...d, annonse: { ...d.annonse, tekst: "" } })).status, 200);
  r = await api("/api/jobber/j1/annonse");
  assert.equal(r.data.tekst, "");assert.equal((await api("/api/jobber/j1/dokument")).data.revisjon, 2);

  // j2: jobbdokumentet har sin egen annonse, og den vinner.
  await api("/api/jobber/j2/annonse", "PUT", { tekst: "Limt inn.", kilde: "limt" });
  r = await api("/api/jobber/j2/annonse");
  assert.equal(r.data.tekst, "Limt inn.");assert.equal(r.data.kilde, "limt");
  assert.equal((await api("/api/jobber/j2/dokument")).data.revisjon, 1);

  // j3: et skadet brevdokument hindrer ikke svaret.
  await fs.writeFile(path.join(dir, "brev-j3.json"), "ødelagt");
  r = await api("/api/jobber/j3/annonse");
  assert.equal(r.status, 200);assert.equal(r.data.tekst, "");assert.equal(r.data.kilde, null);

  // j4: ingen brev, ingen annonse, ingen skriving.
  r = await api("/api/jobber/j4/annonse");
  assert.equal(r.status, 200);assert.equal(r.data.tekst, "");
  assert.equal((await api("/api/jobber/j4/dokument")).data.revisjon, 0);
  assert.equal((await api("/api/jobber/borte/annonse")).status, 404);
});

test("flyttingen tåler at noen skriver annonsen mens den pågår", async () => {
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "annonse-kappløp-"));
  try{
    const lager = lagBrevlager(katalog);
    await lager.skriv("brev-j1.json", { ...(await lager.les("brev-j1.json")), annonse: { tekst: "Fra brevet.", url: "", hentet: null } }, 0);
    let først = true;
    // Et lager som slipper inn en innliming mellom lesingen og skrivingen.
    const sniker = { ...lager, async skriv(navn, d, forventet){
      if(først && navn === "jobb-j1.json"){ først = false; await lager.skriv(navn, { ...(await lager.les(navn)), annonse: { tekst: "Limt inn.", kilde: "limt" } }, forventet); }
      return lager.skriv(navn, d, forventet);
    } };
    const j = lagJobbdokumenter({ lager: sniker, hentJobb: async id => id === "j1" ? rad() : null });
    const a = await j.annonseFor("j1");
    assert.equal(a.tekst, "Limt inn.");assert.equal(a.kilde, "limt");
    assert.equal((await lager.les("jobb-j1.json")).revisjon, 1);
  }finally{ await fs.rm(katalog, { recursive: true, force: true }); }
});

/* ---------- alt som mangler ---------- */

test("manglende annonser hentes én om gangen, med flytting først og lenkeløse hoppet over", async t => {
  const nett = falskNett({ "https://example.invalid/borte": new Error("Siden svarte 404.") });
  const { api, dir } = await start(t, nett);
  await medJobber(api, [
    rad({ id: "har" }), rad({ id: "brev", lenke: "https://example.invalid/brev" }), rad({ id: "uten", lenke: "" }),
    rad({ id: "hent", lenke: "https://example.invalid/hent" }), rad({ id: "borte", lenke: "https://example.invalid/borte" })
  ]);
  await api("/api/jobber/har/annonse", "PUT", { tekst: "Har allerede.", kilde: "limt" });
  const lager = lagBrevlager(dir);
  await lager.skriv("brev-brev.json", { ...(await lager.les("brev-brev.json")), annonse: { tekst: "Fra brevet.", url: "", hentet: null } }, 0);

  const r = await api("/api/jobbdokumenter/hent-manglende", "POST", {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data, { hentet: ["hent"], fraBrev: ["brev"], hadde: 1, utenLenke: ["uten"],
    feilet: [{ id: "borte", feil: "dod-lenke", melding: "Annonsen ligger ikke lenger på den adressen. Lim inn teksten hvis du har den." }],
    gjenstar: [], stoppet: null });
  assert.deepEqual(nett.hentet, ["https://example.invalid/hent", "https://example.invalid/borte"]);
  assert.equal((await api("/api/jobber/hent/annonse")).data.kilde, "hentet");

  // ider avgrenser, og ugyldige lister avvises før noe hentes.
  const avgrenset = await api("/api/jobbdokumenter/hent-manglende", "POST", { ider: ["borte"] });
  assert.equal(avgrenset.data.feilet.length, 1);assert.deepEqual(avgrenset.data.hentet, []);
  for(const kropp of [{ ider: "borte" }, { ider: ["a.b"] }, { ider: [1] }, [1]])
    assert.equal((await api("/api/jobbdokumenter/hent-manglende", "POST", kropp)).status, 400, JSON.stringify(kropp));
  assert.equal((await api("/api/jobbdokumenter/hent-manglende")).status, 405);
});

test("hentingen av det som mangler stopper ved taket og sier hva som gjenstår", async t => {
  const { api, nett } = await start(t);
  const rader = Array.from({ length: 33 }, (_, i) => rad({ id: `j${i}`, lenke: `https://example.invalid/${i}` }));
  await medJobber(api, rader);
  const r = await api("/api/jobbdokumenter/hent-manglende", "POST", {});
  assert.equal(r.status, 200);
  assert.equal(r.data.hentet.length, 30);
  assert.equal(r.data.stoppet, "for-mange");
  assert.deepEqual(r.data.gjenstar, ["j30", "j31", "j32"]);
  assert.equal(nett.hentet.length, 30);
});

test("den utgåtte /api/annonsetekst sier fortsatt hvorfor hentingen feilet", async t => {
  const nett = falskNett({ "https://example.invalid/intern": new Error("Adressen peker til et internt nett."),
    "https://example.invalid/borte": new Error("Siden svarte 404.") });
  const { api } = await start(t, nett);
  let r = await api("/api/annonsetekst", "POST", { url: "https://example.invalid/intern" });
  assert.equal(r.status, 502);assert.equal(r.data.melding, "Adressen peker til et internt nett.");
  r = await api("/api/annonsetekst", "POST", { url: "https://example.invalid/borte" });
  assert.equal(r.data.feil, "dod-lenke");
  r = await api("/api/annonsetekst", "POST", { url: "https://example.invalid/jobb" });
  assert.equal(r.status, 200);assert.match(r.data.tekst, /kundeservice/);
});
