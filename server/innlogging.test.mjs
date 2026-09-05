import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { lagServer } from "./server.mjs";
import { lagBrukere, REGISTERFIL, BRUKERKATALOG } from "./brukere.mjs";

/* ============================================================
   De sju rutene, sett fra utsiden. Alt her går over HTTP, fordi
   det er der løftet står: adskillelsen håndheves på serveren,
   per forespørsel — ikke i flaten.

   Iterasjonstallet senkes til 1. Reglene er de samme; det er bare
   PBKDF2 som er billigere. server/brukere.test.mjs har et eget
   tilfelle som sjekker at drift bruker 600 000.
   ============================================================ */

async function start(valg = {}){
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "jobber-innlogging-"));
  const brukere = lagBrukere({ katalog, iterasjoner: 1 });
  const tjener  = lagServer({ katalog, brukere, ...valg });
  await new Promise(r => tjener.listen(0, "127.0.0.1", r));
  const port = tjener.address().port;
  const base = `http://127.0.0.1:${port}`;

  return { katalog, base, port, brukere,
           stopp: () => new Promise(r => tjener.close(r)) };
}

const PASSORD = "et-godt-nok-passord";

const send = (base, sti, valg = {}) => fetch(base + sti, {
  ...valg,
  headers: { "content-type": "application/json", ...(valg.headers || {}) },
  body: valg.kropp === undefined ? valg.body : JSON.stringify(valg.kropp)
});

const cookieFra = r => (r.headers.getSetCookie()[0] || "").split(";")[0];

async function nyKonto(base, epost = "ola@example.no", ekstra = {}){
  const r = await send(base, "/api/registrer",
    { method: "POST", kropp: { epost, passord: PASSORD, ...ekstra } });
  return { svar: r, kropp: await r.json(), cookie: cookieFra(r) };
}

const som = (cookie, valg = {}) => ({ ...valg, headers: { cookie, ...(valg.headers || {}) } });

const rad = (o = {}) => ({ id: "a1", selskap: "Equinor", stilling: "Sommerjobb",
  lenke: "", sted: "Stavanger", frist: null, status: "todo", sektor: "energi",
  notat: "", sendtDato: null, ...o });

/* fetch og URL normaliserer bort både «..» og et falskt Host-hode,
   så forsøket må sendes rått. Samme hjelper som i server.test.mjs. */
function råForespørsel(port, mål, vert = "127.0.0.1"){
  return new Promise((ok, feil) => {
    const s = net.connect(port, "127.0.0.1", () => {
      s.write(`GET ${mål} HTTP/1.1\r\nHost: ${vert}\r\nConnection: close\r\n\r\n`);
    });
    let ut = "";
    s.setEncoding("utf8");
    s.on("data", d => { ut += d; });
    s.on("end", () => ok(ut));
    s.on("error", feil);
  });
}

/* ---------- GET /api/okt ---------- */

test("GET /api/okt gir 200 uten cookie, og sier om det finnes brukere", async t => {
  const { base, stopp } = await start();
  t.after(stopp);

  const tom = await send(base, "/api/okt");
  assert.equal(tom.status, 200, "porten spør denne først — den skal aldri gi 401");
  assert.equal(tom.headers.get("cache-control"), "no-store");
  assert.deepEqual(await tom.json(), { innlogget: false, harBrukere: false });

  const { cookie } = await nyKonto(base);
  assert.deepEqual(await (await send(base, "/api/okt")).json(),
                   { innlogget: false, harBrukere: true });

  const inn = await (await send(base, "/api/okt", som(cookie))).json();
  assert.equal(inn.innlogget, true);
  assert.equal(inn.erFørste, true);
  assert.equal(inn.harNokkel, false);
  assert.deepEqual(Object.keys(inn.bruker).sort(), ["epost", "id", "navn"]);
});

test("GET /api/okt gir 200 selv når registeret er ødelagt", async t => {
  const { base, katalog, stopp } = await start();
  t.after(stopp);
  await nyKonto(base);
  await fs.writeFile(path.join(katalog, REGISTERFIL), "{ikke json");

  const r = await send(base, "/api/okt");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.innlogget, false);
  assert.equal(j.harBrukere, true, "flaten skal vise «logg inn», ikke «opprett første konto»");
  assert.equal(j.ødelagt, true);
});

test("feil metode på /api/okt gir 405", async t => {
  const { base, stopp } = await start();
  t.after(stopp);
  const r = await send(base, "/api/okt", { method: "POST", kropp: {} });
  assert.equal(r.status, 405);
  assert.equal(r.headers.get("allow"), "GET");
});

/* ---------- POST /api/registrer ---------- */

test("registrering gir 201, en cookie uten Secure, og ingen hash i svaret", async t => {
  const { base, stopp } = await start();
  t.after(stopp);

  const { svar, kropp } = await nyKonto(base, "ola@example.no", { navn: "Ola" });
  assert.equal(svar.status, 201);
  assert.deepEqual(kropp.bruker, { id: kropp.bruker.id, epost: "ola@example.no", navn: "Ola" });
  assert.equal(kropp.erFørste, true);
  assert.equal(JSON.stringify(kropp).includes("pbkdf2"), false);

  const satt = svar.headers.getSetCookie()[0];
  assert.match(satt, /^okt=[A-Za-z0-9_.-]+;/);
  assert.match(satt, /HttpOnly/);
  assert.match(satt, /SameSite=Strict/);
  assert.doesNotMatch(satt, /Secure/, "http på loopback — Secure ville gjort cookien ubrukelig");
});

test("registrering: for kort passord gir 400 per felt, duplikat gir 409", async t => {
  const { base, stopp } = await start();
  t.after(stopp);

  const kort = await send(base, "/api/registrer",
    { method: "POST", kropp: { epost: "a@b.no", passord: "kort" } });
  assert.equal(kort.status, 400);
  assert.equal((await kort.json()).detaljer[0].felt, "passord");

  await nyKonto(base, "ola@example.no");
  const igjen = await send(base, "/api/registrer",
    { method: "POST", kropp: { epost: "OLA@Example.no", passord: PASSORD } });
  assert.equal(igjen.status, 409);
  assert.equal((await igjen.json()).feil, "finnes");
});

test("to samtidige registreringer: bare én er først", async t => {
  const { base, stopp } = await start();
  t.after(stopp);
  const [a, b] = await Promise.all([
    send(base, "/api/registrer", { method: "POST", kropp: { epost: "a@b.no", passord: PASSORD } }),
    send(base, "/api/registrer", { method: "POST", kropp: { epost: "c@d.no", passord: PASSORD } })
  ]);
  const [ja, jb] = [await a.json(), await b.json()];
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal([ja.erFørste, jb.erFørste].filter(Boolean).length, 1);
});

/* ---------- POST /api/logg-inn ---------- */

test("innlogging gir 200 og cookie; feil passord og ukjent e-post gir samme 401", async t => {
  const { base, stopp } = await start();
  t.after(stopp);
  await nyKonto(base);

  const ok = await send(base, "/api/logg-inn",
    { method: "POST", kropp: { epost: "ola@example.no", passord: PASSORD } });
  assert.equal(ok.status, 200);
  assert.match(cookieFra(ok), /^okt=/);

  const feilPassord = await send(base, "/api/logg-inn",
    { method: "POST", kropp: { epost: "ola@example.no", passord: "helt-feil-passord" } });
  const ukjent = await send(base, "/api/logg-inn",
    { method: "POST", kropp: { epost: "ingen@example.no", passord: PASSORD } });

  assert.equal(feilPassord.status, 401);
  assert.equal(ukjent.status, 401);
  assert.deepEqual(await feilPassord.json(), await ukjent.json());
});

test("elleve mislykkede forsøk gir 429 med retryEtter", async t => {
  const { base, stopp } = await start();
  t.after(stopp);
  await nyKonto(base);

  const prøv = () => send(base, "/api/logg-inn",
    { method: "POST", kropp: { epost: "ola@example.no", passord: "helt-feil-passord" } });

  for(let i = 0; i < 10; i++) assert.equal((await prøv()).status, 401, `forsøk ${i + 1}`);
  const nr11 = await prøv();
  assert.equal(nr11.status, 429);
  const j = await nr11.json();
  assert.equal(j.feil, "for-mange");
  assert.ok(j.retryEtter > 0);

  /* Sperren gjelder også riktig passord — ellers er den ingen sperre. */
  assert.equal((await send(base, "/api/logg-inn",
    { method: "POST", kropp: { epost: "ola@example.no", passord: PASSORD } })).status, 429);
});

test("en vellykket innlogging nullstiller telleren", async t => {
  const { base, stopp } = await start();
  t.after(stopp);
  await nyKonto(base);

  for(let i = 0; i < 5; i++) await send(base, "/api/logg-inn",
    { method: "POST", kropp: { epost: "ola@example.no", passord: "helt-feil-passord" } });
  assert.equal((await send(base, "/api/logg-inn",
    { method: "POST", kropp: { epost: "ola@example.no", passord: PASSORD } })).status, 200);
  for(let i = 0; i < 10; i++) assert.equal((await send(base, "/api/logg-inn",
    { method: "POST", kropp: { epost: "ola@example.no", passord: "helt-feil-passord" } })).status, 401);
});

/* ---------- POST /api/logg-ut ---------- */

test("utlogging nuller cookien og er idempotent uten den", async t => {
  const { base, stopp } = await start();
  t.after(stopp);
  const { cookie } = await nyKonto(base);

  const ut = await send(base, "/api/logg-ut", som(cookie, { method: "POST" }));
  assert.equal(ut.status, 200);
  assert.match(ut.headers.getSetCookie()[0], /Max-Age=0/);

  const uten = await send(base, "/api/logg-ut", { method: "POST" });
  assert.equal(uten.status, 200, "idempotent uten cookie");

  /* Cookien er nullet i nettleseren, men tokenet er fortsatt gyldig —
     det er meningen. «allePlasser» er det som faktisk tilbakekaller. */
  assert.equal((await send(base, "/api/jobber", som(cookie))).status, 200);
});

test("allePlasser gjør alle utstedte økter ugyldige", async t => {
  const { base, stopp } = await start();
  t.after(stopp);
  const { cookie } = await nyKonto(base);
  const annenFane = cookieFra(await send(base, "/api/logg-inn",
    { method: "POST", kropp: { epost: "ola@example.no", passord: PASSORD } }));

  await send(base, "/api/logg-ut", som(cookie, { method: "POST", kropp: { allePlasser: true } }));
  assert.equal((await send(base, "/api/jobber", som(cookie))).status, 401);
  assert.equal((await send(base, "/api/jobber", som(annenFane))).status, 401);
});

/* ---------- POST /api/passord ---------- */

test("passordbytte gir ny cookie og feller alle gamle økter", async t => {
  const { base, stopp } = await start();
  t.after(stopp);
  const { cookie } = await nyKonto(base);
  const gammelFane = cookieFra(await send(base, "/api/logg-inn",
    { method: "POST", kropp: { epost: "ola@example.no", passord: PASSORD } }));

  const r = await send(base, "/api/passord",
    som(cookie, { method: "POST", kropp: { gammelt: PASSORD, nytt: "et-helt-nytt-passord" } }));
  assert.equal(r.status, 200);
  const ny = cookieFra(r);

  assert.equal((await send(base, "/api/jobber", som(gammelFane))).status, 401);
  assert.equal((await send(base, "/api/jobber", som(ny))).status, 200);
  assert.equal((await send(base, "/api/logg-inn",
    { method: "POST", kropp: { epost: "ola@example.no", passord: "et-helt-nytt-passord" } })).status, 200);
});

test("feil gammelt passord gir 403, og uten økt gir 401", async t => {
  const { base, stopp } = await start();
  t.after(stopp);
  const { cookie } = await nyKonto(base);

  const feil = await send(base, "/api/passord",
    som(cookie, { method: "POST", kropp: { gammelt: "helt-feil-passord", nytt: "et-nytt-langt-passord" } }));
  assert.equal(feil.status, 403);
  assert.equal((await feil.json()).feil, "feil-passord");

  const kort = await send(base, "/api/passord",
    som(cookie, { method: "POST", kropp: { gammelt: PASSORD, nytt: "kort" } }));
  assert.equal(kort.status, 400);

  const uten = await send(base, "/api/passord",
    { method: "POST", kropp: { gammelt: PASSORD, nytt: "et-nytt-langt-passord" } });
  assert.equal(uten.status, 401);
});

/* ---------- de tre gamle endepunktene ---------- */

test("jobber, importer og importlogg krever økt", async t => {
  const { base, stopp } = await start({ nett: { hentSide: async () => ({ html: "" }) } });
  t.after(stopp);

  for(const [sti, valg] of [["/api/jobber", {}],
                            ["/api/jobber", { method: "PUT", kropp: { versjon: 0, jobber: [] } }],
                            ["/api/importer", { method: "POST", kropp: { url: "https://example.com" } }],
                            ["/api/importlogg", {}]]){
    const r = await send(base, sti, valg);
    assert.equal(r.status, 401, sti + " " + (valg.method || "GET"));
    assert.equal((await r.json()).feil, "utlogget");
    assert.equal(r.headers.get("cache-control"), "no-store");
  }
});

test("to brukere ser hvert sitt lager, på hver sin katalog", async t => {
  const { base, katalog, stopp } = await start();
  t.after(stopp);

  const a = await nyKonto(base, "a@example.no");
  const b = await nyKonto(base, "b@example.no");

  const lagret = await send(base, "/api/jobber",
    som(a.cookie, { method: "PUT", kropp: { versjon: 0, jobber: [rad()] } }));
  assert.equal(lagret.status, 200);

  const bSer = await (await send(base, "/api/jobber", som(b.cookie))).json();
  assert.deepEqual(bSer, { versjon: 0, jobber: null, tom: true });

  const aSer = await (await send(base, "/api/jobber", som(a.cookie))).json();
  assert.equal(aSer.jobber[0].selskap, "Equinor");

  /* Adskillelsen er på filsystemet, ikke i et filter: As rader ligger
     i As katalog, og B har ikke engang fått en katalog ennå — den
     lages først når B selv skriver noe. */
  assert.deepEqual(await fs.readdir(path.join(katalog, BRUKERKATALOG, a.kropp.bruker.id)),
                   ["jobber.json"]);
  assert.deepEqual(await fs.readdir(path.join(katalog, BRUKERKATALOG)), [a.kropp.bruker.id]);

  await send(base, "/api/jobber", som(b.cookie,
    { method: "PUT", kropp: { versjon: 0, jobber: [rad({ selskap: "Aker BP" })] } }));
  assert.deepEqual((await fs.readdir(path.join(katalog, BRUKERKATALOG))).sort(),
                   [a.kropp.bruker.id, b.kropp.bruker.id].sort());
});

test("B kan ikke overskrive A ved å sende As versjon", async t => {
  const { base, stopp } = await start();
  t.after(stopp);
  const a = await nyKonto(base, "a@example.no");
  const b = await nyKonto(base, "b@example.no");

  await send(base, "/api/jobber", som(a.cookie, { method: "PUT", kropp: { versjon: 0, jobber: [rad()] } }));
  await send(base, "/api/jobber", som(b.cookie,
    { method: "PUT", kropp: { versjon: 1, jobber: [rad({ selskap: "Kaprer" })] } }));

  const aSer = await (await send(base, "/api/jobber", som(a.cookie))).json();
  assert.equal(aSer.jobber[0].selskap, "Equinor", "B skrev i sin egen katalog, ikke i As");
});

test("importloggen er per bruker", async t => {
  const { base, stopp } = await start();
  t.after(stopp);
  const a = await nyKonto(base, "a@example.no");
  const r = await send(base, "/api/importlogg", som(a.cookie));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { sammendrag: null });
});

/* ---------- tuklede token ---------- */

test("ett endret tegn i signaturen eller nyttelasten gir 401", async t => {
  const { base, stopp } = await start();
  t.after(stopp);
  const { cookie } = await nyKonto(base);
  const token = cookie.slice("okt=".length);
  const [kropp, sig] = token.split(".");
  const bytt = s => (s[0] === "A" ? "B" : "A") + s.slice(1);

  for(const t2 of [`${kropp}.${bytt(sig)}`, `${bytt(kropp)}.${sig}`,
                   `${kropp}.${sig}A`, kropp, "", "tull", "a.b.c"])
    assert.equal((await send(base, "/api/jobber", som("okt=" + t2))).status, 401,
                 JSON.stringify(t2));

  assert.equal((await send(base, "/api/jobber", som(cookie))).status, 200);
});

test("et gyldig token for en slettet bruker gir 401", async t => {
  const { base, katalog, stopp } = await start();
  t.after(stopp);
  const { cookie } = await nyKonto(base);
  const dok = JSON.parse(await fs.readFile(path.join(katalog, REGISTERFIL), "utf8"));
  dok.brukere = [];
  await fs.writeFile(path.join(katalog, REGISTERFIL), JSON.stringify(dok));
  assert.equal((await send(base, "/api/jobber", som(cookie))).status, 401);
});

/* ---------- host og opphav ---------- */

test("et fremmed Host-hode gir 403, sendt rått", async t => {
  const { port, stopp } = await start();
  t.after(stopp);

  for(const vert of ["ond.example", "ond.example:4173", "0.0.0.0", "192.168.1.9"]){
    const svar = await råForespørsel(port, "/api/jobber", vert);
    assert.match(svar.split("\r\n")[0], /^HTTP\/1\.1 403/, `forventet 403 for Host: ${vert}`);
    assert.match(svar, /feil-opphav/);
  }
  /* Også statiske filer: DNS-rebinding leser like gjerne index.html
     og henter cookien derfra. */
  assert.match((await råForespørsel(port, "/", "ond.example")).split("\r\n")[0], /^HTTP\/1\.1 403/);

  for(const vert of ["127.0.0.1", "127.0.0.1:4173", "localhost", "[::1]:4173"])
    assert.doesNotMatch((await råForespørsel(port, "/api/okt", vert)).split("\r\n")[0],
                        /^HTTP\/1\.1 403/, vert);
});

test("et fremmed Origin-hode gir 403, også med gyldig cookie", async t => {
  const { base, stopp } = await start();
  t.after(stopp);
  const { cookie } = await nyKonto(base);

  for(const opphav of ["https://ond.example", "http://127.0.0.1.ond.example", "null", "file://"]){
    const r = await send(base, "/api/jobber", som(cookie, { headers: { origin: opphav } }));
    assert.equal(r.status, 403, opphav);
    assert.equal((await r.json()).feil, "feil-opphav");
  }
  assert.equal((await send(base, "/api/jobber",
    som(cookie, { headers: { origin: base } }))).status, 200);
});

/* ---------- grenser ---------- */

test("en for stor kropp gir 413 også på auth-rutene", async t => {
  const { base, stopp } = await start();
  t.after(stopp);
  const r = await send(base, "/api/registrer",
    { method: "POST", body: JSON.stringify({ epost: "a@b.no", passord: "x".repeat(6 * 1024 * 1024) }) });
  assert.equal(r.status, 413);
});

test("ødelagt json i kroppen gir 400, ikke 500", async t => {
  const { base, stopp } = await start();
  t.after(stopp);
  for(const sti of ["/api/registrer", "/api/logg-inn"]){
    const r = await send(base, sti, { method: "POST", body: "{ikke json" });
    assert.equal(r.status, 400, sti);
    assert.equal((await r.json()).feil, "ugyldig json");
  }
});

test("statiske filer er fortsatt åpne — ellers får ingen se porten", async t => {
  const { base, stopp } = await start();
  t.after(stopp);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/src/brukerlogikk.mjs`)).status, 200);
  assert.equal((await fetch(`${base}/api/finnes-ikke`)).status, 401,
    "ukjent api-sti uten økt røper ikke om den finnes");
});

test("importen har sin egen grense per bruker", async t => {
  const nett = { hentSide: async () => ({ status: 200, sluttUrl: "https://example.com/x", html: "<p>x</p>" }),
                 spørModell: async () => ({ content: [{ type: "text", text: "{}" }] }) };
  const { base, stopp } = await start({ nett });
  t.after(stopp);
  const a = await nyKonto(base, "a@example.no");
  const b = await nyKonto(base, "b@example.no");

  const imp = (cookie, n) => send(base, "/api/importer",
    som(cookie, { method: "POST", kropp: { url: `https://example.com/jobb/${n}` } }));

  for(let i = 0; i < 30; i++) assert.notEqual((await imp(a.cookie, i)).status, 429, `import ${i}`);
  const stopp31 = await imp(a.cookie, 31);
  assert.equal(stopp31.status, 429);
  assert.ok((await stopp31.json()).retryEtter > 0);

  assert.notEqual((await imp(b.cookie, 1)).status, 429, "grensen er per bruker");
});
