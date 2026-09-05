import test from "node:test";
import assert from "node:assert/strict";

import {
  tilBase64url, fraBase64url, likeBytes, tilBytes, fraBytes,
  lagBrukerId, erGyldigBrukerId, ID_BYTES,
  formaterHash, tolkHash, måHashesPåNytt, ITERASJONER, ALGORITME,
  normaliserEpost, validerEpost, validerNavn, validerPassord,
  validerRegistrering, validerInnlogging, offentligBruker,
  validerRegister, migrerRegister, tomtRegister, REGISTER_VERSJON,
  lagNyttelast, kodNyttelast, tolkNyttelast, delToken, erUtløpt,
  MIN_PASSORD, MAKS
} from "../src/brukerlogikk.mjs";

/* ============================================================
   Rene regler. Ingen fil, ingen server, ingen krypto — modulen
   skal kunne lastes rett inn i et nettleservindu, og testene her
   rører ingenting den ikke kan.
   ============================================================ */

/* ---------- base64url ---------- */

test("base64url koder og dekoder alle lengder tilbake til seg selv", () => {
  for(let n = 0; n <= 40; n++){
    const b = new Uint8Array(n);
    for(let i = 0; i < n; i++) b[i] = (i * 37 + n) & 255;
    const s = tilBase64url(b);
    assert.match(s, /^[A-Za-z0-9_-]*$/, `ingen fyll eller + og / for n=${n}`);
    assert.deepEqual([...fraBase64url(s)], [...b], `rundtur for n=${n}`);
  }
});

test("base64url avviser ugyldig tekst i stedet for å kaste", () => {
  assert.equal(fraBase64url("a+b/c"), null);
  assert.equal(fraBase64url("abcde="), null);
  assert.equal(fraBase64url("abcde"), null);        /* lengde % 4 === 1 er umulig */
  assert.equal(fraBase64url(null), null);
  assert.equal(fraBase64url(42), null);
});

test("modulen holder seg fri for Node- og nettleserspesifikke API-er", async () => {
  const { readFile } = await import("node:fs/promises");
  const kilde = await readFile(new URL("../src/brukerlogikk.mjs", import.meta.url), "utf8");
  /* Kommentarene nevner Buffer og atob for å forklare hvorfor de ikke
     brukes. Testen ser derfor bare på koden. */
  const kode = kilde.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(kode, /\bBuffer\b/);
  assert.doesNotMatch(kode, /\batob\b|\bbtoa\b/);
  assert.doesNotMatch(kode, /from ["']node:/);
});

test("likeBytes er sann bare for like lengder og likt innhold", () => {
  assert.equal(likeBytes(tilBytes("abc"), tilBytes("abc")), true);
  assert.equal(likeBytes(tilBytes("abc"), tilBytes("abd")), false);
  assert.equal(likeBytes(tilBytes("abc"), tilBytes("abcd")), false);
  assert.equal(fraBytes(tilBytes("æøå")), "æøå");
});

/* ---------- bruker-id ---------- */

test("bruker-id er 16 heksadesimale tegn og ingenting annet", () => {
  const id = lagBrukerId(new Uint8Array([0, 1, 15, 16, 200, 255, 128, 7]));
  assert.equal(id, "00010f10c8ff8007");
  assert.equal(id.length, 16);
  assert.ok(erGyldigBrukerId(id));
  /* Tegnene Rust-siden allerede godtar i trygt_navn(). */
  assert.match(id, /^[0-9a-f]+$/);
});

test("bruker-id avviser feil lengde og alt som ikke er ren heks", () => {
  assert.throws(() => lagBrukerId(new Uint8Array(ID_BYTES - 1)));
  for(const v of ["", "..", "../x", "ABCDEF0123456789", "0123456789abcde", null, 1])
    assert.equal(erGyldigBrukerId(v), false, String(v));
});

/* ---------- hashformat ---------- */

test("hashen er selvbeskrivende og tolkes tilbake", () => {
  const salt = new Uint8Array(16).fill(3);
  const nøkkel = new Uint8Array(32).fill(9);
  const s = formaterHash({ iterasjoner: ITERASJONER, salt, nøkkel });
  assert.match(s, /^pbkdf2\$sha256\$600000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);

  const h = tolkHash(s);
  assert.equal(h.ok, true);
  assert.equal(h.algoritme, ALGORITME);
  assert.equal(h.iterasjoner, ITERASJONER);
  assert.deepEqual([...h.salt], [...salt]);
  assert.deepEqual([...h.nøkkel], [...nøkkel]);
});

test("tolkHash avviser tull uten å kaste", () => {
  for(const s of ["", "pbkdf2$sha256$600000$aaaa", "scrypt$sha256$1$aa$bb",
                  "pbkdf2$md5$600000$aaaaaaaaaaaa$aaaaaaaaaaaaaaaaaaaaaa",
                  "pbkdf2$sha256$0$aaaaaaaaaaaa$aaaaaaaaaaaaaaaaaaaaaa",
                  "pbkdf2$sha256$9999999999$aaaaaaaaaaaa$aaaaaaaaaaaaaaaaaaaaaa",
                  "pbkdf2$sha256$600000$aa$aaaaaaaaaaaaaaaaaaaaaa",
                  "pbkdf2$sha256$600000$aaaaaaaaaaaa$aa",
                  "pbkdf2$sha256$600000$++++$aaaaaaaaaaaaaaaaaaaaaa",
                  "x".repeat(MAKS.hash + 1), null, {}])
    assert.equal(tolkHash(s).ok, false, String(s));
});

test("måHashesPåNytt fanger for lavt iterasjonstall, men ikke dagens", () => {
  const salt = new Uint8Array(16).fill(1), nøkkel = new Uint8Array(32).fill(2);
  assert.equal(måHashesPåNytt(formaterHash({ iterasjoner: ITERASJONER, salt, nøkkel })), false);
  assert.equal(måHashesPåNytt(formaterHash({ iterasjoner: 1000, salt, nøkkel })), true);
  assert.equal(måHashesPåNytt(formaterHash({ iterasjoner: ITERASJONER, salt: new Uint8Array(8), nøkkel })), true);
  assert.equal(måHashesPåNytt("tull"), false, "ugyldig er ødelagt, ikke gammelt");
});

/* ---------- validering ---------- */

test("e-post normaliseres til små bokstaver og trimmes", () => {
  assert.equal(normaliserEpost("  Ola@Example.NO \n"), "ola@example.no");
  assert.equal(validerEpost("Ola@Example.no").verdi, "ola@example.no");
});

test("e-post avviser det som ikke er en adresse", () => {
  const medLinjeskift = "ola@ex.no" + String.fromCharCode(13, 10) + "X: 1";
  for(const v of ["", "ola", "ola@", "@example.no", "ola@example", "ola example@x.no",
                  medLinjeskift, "a".repeat(250) + "@example.no"])
    assert.equal(validerEpost(v).ok, false, JSON.stringify(v));
  assert.equal(validerEpost("ola.nordmann+jobb@under.example.no").ok, true);
});

test("passordregelen er lengde, ikke tegnklasser", () => {
  assert.equal(validerPassord("x".repeat(MIN_PASSORD - 1)).ok, false);
  assert.equal(validerPassord("x".repeat(MIN_PASSORD)).ok, true);
  assert.equal(validerPassord("x".repeat(MAKS.passord)).ok, true);
  assert.equal(validerPassord("x".repeat(MAKS.passord + 1)).ok, false);
  assert.equal(validerPassord("aaaaaaaaaa!").ok, true);
  assert.equal(validerPassord("     mellomrom teller     ").ok, true, "passord trimmes ikke");
  assert.equal(validerPassord(12345678901).ok, false);
});

test("navn er valgfritt, men bundet og uten kontrolltegn", () => {
  assert.deepEqual(validerNavn(undefined), { ok: true, verdi: "" });
  assert.equal(validerNavn("Ola").verdi, "Ola");
  assert.equal(validerNavn("x".repeat(MAKS.navn + 1)).ok, false);
  assert.equal(validerNavn("O" + String.fromCharCode(9) + "la").ok, false);
});

test("validerRegistrering samler feil per felt", () => {
  const r = validerRegistrering({ epost: "nei", passord: "kort" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.feil.map(f => f.felt).sort(), ["epost", "passord"]);

  const g = validerRegistrering({ epost: " A@b.no ", navn: " Ola ", passord: "passordet-mitt" });
  assert.deepEqual(g.verdi, { epost: "a@b.no", navn: "Ola", passord: "passordet-mitt" });
});

test("validerInnlogging sier bare ja eller nei — aldri hvorfor", () => {
  /* Et for kort passord skal ikke gi en annen beskjed enn et feil et:
     «for kort» ville røpet at kontoen ikke har det passordet. */
  const r = validerInnlogging({ epost: "a@b.no", passord: "kort" });
  assert.equal(r.ok, true, "lengden avgjøres ikke her");
  assert.equal(validerInnlogging({ epost: "", passord: "x" }).ok, false);
  assert.equal(validerInnlogging({ epost: "a@b.no", passord: "" }).ok, false);
  assert.equal(validerInnlogging(null).ok, false);
});

test("offentligBruker slipper aldri hash, salt eller generasjon ut", () => {
  const b = offentligBruker({ id: "00112233445566aa", epost: "a@b.no", navn: "Ola",
                              hash: "pbkdf2$…", generasjon: 7, sistInnlogget: "i går" });
  assert.deepEqual(Object.keys(b).sort(), ["epost", "id", "navn"]);
  assert.equal(JSON.stringify(b).includes("pbkdf2"), false);
  assert.equal(offentligBruker(null), null);
});

/* ---------- registeret ---------- */

const rad = (o = {}) => ({
  id: "00112233445566aa", epost: "a@b.no", navn: "Ola",
  hash: formaterHash({ iterasjoner: ITERASJONER, salt: new Uint8Array(16).fill(1),
                       nøkkel: new Uint8Array(32).fill(2) }),
  generasjon: 1, opprettet: "2026-01-01T00:00:00.000Z", sistInnlogget: null, ...o
});

test("registeret godtar en fil på riktig form", () => {
  const r = validerRegister({ versjon: 1, brukere: [rad()] });
  assert.equal(r.ok, true);
  assert.equal(r.brukere.length, 1);
  assert.equal(r.brukere[0].epost, "a@b.no");
});

test("ukjente felt faller bort og __proto__ forgifter ingenting", () => {
  const dok = JSON.parse('{"versjon":1,"brukere":[{"id":"00112233445566aa",'
    + '"epost":"a@b.no","navn":"Ola","hash":' + JSON.stringify(rad().hash) + ','
    + '"generasjon":1,"erAdmin":true,"__proto__":{"forgiftet":1}}]}');
  const r = validerRegister(dok);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.brukere[0]).sort(),
    ["epost", "generasjon", "hash", "id", "navn", "opprettet", "sistInnlogget"]);
  assert.equal({}.forgiftet, undefined);
  assert.equal(Object.prototype.forgiftet, undefined);
});

test("ugyldige rader forkastes, resten overlever", () => {
  const r = validerRegister({ versjon: 1, brukere: [
    rad(), { id: "kort" }, rad({ id: "aabbccddeeff0011", epost: "b@b.no" }),
    null, rad({ id: "00000000000000ff", epost: "c@c.no", hash: "tull" })
  ]});
  assert.equal(r.ok, true);
  assert.deepEqual(r.brukere.map(b => b.epost), ["a@b.no", "b@b.no"]);
  assert.deepEqual(r.forkastet, [1, 3, 4]);
});

test("duplikat id og duplikat e-post forkastes — første vinner", () => {
  const r = validerRegister({ versjon: 1, brukere: [
    rad({ navn: "Først" }),
    rad({ navn: "Samme id" }),
    rad({ id: "aabbccddeeff0011", navn: "Samme e-post" })
  ]});
  assert.equal(r.brukere.length, 1);
  assert.equal(r.brukere[0].navn, "Først");
});

test("rekkefølgen bevares — første rad er første bruker", () => {
  const r = validerRegister({ versjon: 1, brukere: [
    rad({ epost: "en@b.no" }),
    rad({ id: "aabbccddeeff0011", epost: "to@b.no" })
  ]});
  assert.equal(r.brukere[0].epost, "en@b.no");
});

test("register uten versjon eller på feil form avvises", () => {
  for(const d of [null, {}, [], { brukere: [] }, { versjon: 0, brukere: [] },
                  { versjon: 1, brukere: "nei" }])
    assert.equal(validerRegister(d).ok, false, JSON.stringify(d));
});

test("en nyere registerversjon nektes i stedet for å skrives over", () => {
  const m = migrerRegister({ versjon: REGISTER_VERSJON + 1, brukere: [rad()] });
  assert.equal(m.ok, false);
  assert.match(m.grunn, /nyere versjon/);
});

test("migreringen gir dagens versjon tilbake", () => {
  const m = migrerRegister({ versjon: REGISTER_VERSJON, brukere: [rad()] });
  assert.equal(m.ok, true);
  assert.equal(m.register.versjon, REGISTER_VERSJON);
  assert.deepEqual(tomtRegister(), { versjon: REGISTER_VERSJON, brukere: [] });
});

/* ---------- øktens nyttelast ---------- */

test("nyttelasten kodes og tolkes tilbake", () => {
  const n = lagNyttelast({ id: "00112233445566aa", generasjon: 3, utstedt: 1000, levetid: 60 });
  assert.deepEqual(n, { b: "00112233445566aa", g: 3, u: 1000, e: 1060 });
  assert.deepEqual(tolkNyttelast(kodNyttelast(n)), n);
});

test("tolkNyttelast avviser alt som ikke er en hel nyttelast", () => {
  const gyldig = { b: "00112233445566aa", g: 1, u: 10, e: 20 };
  const kod = o => kodNyttelast(o);
  assert.equal(tolkNyttelast(kod({ ...gyldig, b: "../etc" })), null);
  assert.equal(tolkNyttelast(kod({ ...gyldig, g: 0 })), null);
  assert.equal(tolkNyttelast(kod({ ...gyldig, g: 1.5 })), null);
  assert.equal(tolkNyttelast(kod({ ...gyldig, e: 10 })), null, "utløp må ligge etter utstedelse");
  assert.equal(tolkNyttelast(kod([1, 2, 3])), null);
  assert.equal(tolkNyttelast("ikke base64url +"), null);
  assert.equal(tolkNyttelast(""), null);
});

test("token er nøyaktig to deler", () => {
  assert.deepEqual(delToken("aaa.bbb"), { kropp: "aaa", signatur: "bbb" });
  for(const t of ["", "aaa", "aaa.", ".bbb", "aaa.bbb.ccc", null, "x".repeat(MAKS.token + 1)])
    assert.equal(delToken(t), null, JSON.stringify(t));
});

test("erUtløpt ser på utløpstiden, ikke utstedelsen", () => {
  const n = { b: "00112233445566aa", g: 1, u: 100, e: 200 };
  assert.equal(erUtløpt(n, 199), false);
  assert.equal(erUtløpt(n, 200), true);
  assert.equal(erUtløpt(null, 0), true);
});
