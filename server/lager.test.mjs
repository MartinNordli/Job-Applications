import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { validerSoknad, validerSamling, validerIntervju,
         MAKS_HENDELSER, MAKS_INTERVJU } from "../src/felles.mjs";
import { lagLager } from "./lager.mjs";

/* Hver test får sin egen katalog, så den ekte data/ aldri røres. */
async function nyttLager(valg = {}){
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "jobber-test-"));
  return { katalog, lager: lagLager({ katalog, ...valg }) };
}

const rad = (o = {}) => ({
  id: "a1", selskap: "Equinor", stilling: "Sommerjobb",
  lenke: "https://example.com/jobb", sted: "Stavanger",
  frist: "2026-09-13", status: "todo", sektor: "energi",
  notat: "", sendtDato: null, ...o
});

const finnes = async p => !!(await fs.stat(p).catch(() => null));
const sov = ms => new Promise(r => setTimeout(r, ms));

/* ---------- validatoren ---------- */

test("frist: 2026-02-31 avvises, 2026-09-13 godtas", () => {
  assert.equal(validerSoknad(rad({ frist: "2026-02-31" })).ok, false);
  assert.equal(validerSoknad(rad({ frist: "2026-09-13" })).ok, true);
});

test("lenke: javascript: avvises, tom lenke godtas", () => {
  const dårlig = validerSoknad(rad({ lenke: "javascript:alert(1)" }));
  assert.equal(dårlig.ok, false);
  assert.ok(dårlig.feil.some(f => f.felt === "lenke"));
  assert.equal(validerSoknad(rad({ lenke: "" })).ok, true);
});

test("ukjent status avvises, ukjent sektor blir «annet»", () => {
  assert.equal(validerSoknad(rad({ status: "tullball" })).ok, false);
  assert.equal(validerSoknad(rad({ sektor: "romfart" })).verdi.sektor, "annet");
});

test("ukjente felt faller bort", () => {
  const r = validerSoknad(rad({ hemmelig: "x", __proto__ukjent: 1 }));
  assert.equal(r.ok, true);
  assert.equal("hemmelig" in r.verdi, false);
  assert.deepEqual(Object.keys(r.verdi).sort(), [
    "frist","id","jobbtype","lenke","notat","opprettet","oppdatert","sektor",
    "intervju","selskap","sendtDato","sted","stilling","status",
    "hendelser","intervjuer"
  ].sort());
});

/* ---------- hendelser og intervjuer på raden ---------- */

const hendelse = (o = {}) => ({ til: "sent", dato: "2026-10-01", ...o });
const intervjuet = (o = {}) => ({
  id: "i1", dato: "2026-10-12", tid: "09:30", varighet: 60, sted: "Forusbeen 50",
  type: "fysisk", lenke: "", runde: "Første runde", notat: "", ...o
});

test("hendelser: mangler eller er ikke en liste gir tom liste, ikke en avvist rad", () => {
  assert.deepEqual(validerSoknad(rad()).verdi.hendelser, []);
  for(const rusk of ["tekst", 42, { til: "sent" }, null]){
    const r = validerSoknad(rad({ hendelser: rusk }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.verdi.hendelser, []);
  }
});

test("hendelser: ugyldige oppføringer droppes, ukjente felt og kilder faller bort", () => {
  const r = validerSoknad(rad({ hendelser: [
    hendelse(),
    hendelse({ til: "tullball" }),
    hendelse({ dato: "2026-02-31" }),
    hendelse({ dato: "1. okt" }),
    "sent", null, [hendelse()],
    JSON.parse('{"til":"interview","dato":"2026-10-05","kilde":"hacker","ekstra":"x",'
             + '"tid":"1","__proto__":{"forurenset":true}}'),
    hendelse({ til: "rejected", dato: "2026-10-06", tid: "2026-10-06T08:00:00.000Z", kilde: "lager" })
  ] }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.verdi.hendelser, [
    { til: "sent", dato: "2026-10-01" },
    { til: "interview", dato: "2026-10-05" },
    { til: "rejected", dato: "2026-10-06", tid: "2026-10-06T08:00:00.000Z", kilde: "lager" }
  ]);
  assert.equal({}.forurenset, undefined);
  assert.equal(Object.getPrototypeOf(r.verdi.hendelser[1]), Object.prototype);
});

test("hendelser: sorteres på dato og så tid, stabilt, og tid sammenlignes som tidspunkt", () => {
  const r = validerSoknad(rad({ hendelser: [
    hendelse({ til: "rejected", dato: "2026-10-03" }),
    hendelse({ til: "interview", dato: "2026-10-02", tid: "2026-10-02T12:00:00+02:00" }),
    hendelse({ til: "sent", dato: "2026-10-02", tid: "2026-10-02T09:00:00.000Z" }),
    hendelse({ til: "todo", dato: "2026-10-02" }),
    hendelse({ til: "trukket", dato: "2026-10-03" })
  ] })).verdi.hendelser;
  /* 12:00+02:00 er 10:00Z, altså etter 09:00Z. Uten tid står først den dagen. */
  assert.deepEqual(r.map(h => h.til), ["todo", "sent", "interview", "rejected", "trukket"]);
});

test("hendelser: over taket beholdes den første og de nyeste", () => {
  const mange = Array.from({ length: 75 }, (_, i) =>
    hendelse({ til: i % 2 ? "sent" : "todo", dato: "2026-10-01",
               tid: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() }));
  const r = validerSoknad(rad({ hendelser: mange })).verdi.hendelser;
  assert.equal(r.length, MAKS_HENDELSER);
  assert.equal(r[0].tid, mange[0].tid);
  assert.equal(r[1].tid, mange[75 - (MAKS_HENDELSER - 1)].tid);
  assert.equal(r.at(-1).tid, mange.at(-1).tid);
});

test("intervjuer: et gyldig intervju kommer gjennom normalisert", () => {
  const r = validerSoknad(rad({ intervjuer: [intervjuet({ varighet: "45", type: "romskip",
                                                          ukjent: 1, sted: "  Forus  " })] }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.verdi.intervjuer, [{
    id: "i1", dato: "2026-10-12", tid: "09:30", varighet: 45, sted: "Forus",
    type: "", lenke: "", runde: "Første runde", notat: ""
  }]);
});

test("intervjuer: ugyldige droppes, resten av raden lagres", () => {
  const ugyldige = [
    intervjuet({ id: "" }), intervjuet({ id: "a b" }), intervjuet({ id: "x".repeat(33) }),
    intervjuet({ dato: "2026-02-30" }), intervjuet({ tid: "24:00" }), intervjuet({ tid: "9:30" }),
    intervjuet({ varighet: 0 }), intervjuet({ varighet: 601 }), intervjuet({ varighet: 1.5 }),
    intervjuet({ sted: "x".repeat(201) }), intervjuet({ runde: "x".repeat(81) }),
    intervjuet({ notat: "x".repeat(1001) }), intervjuet({ lenke: "javascript:alert(1)" }),
    "intervju", null
  ];
  for(const i of ugyldige){
    const r = validerSoknad(rad({ intervjuer: [i] }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.verdi.intervjuer, [], JSON.stringify(i));
  }
  assert.deepEqual(validerSoknad(rad({ intervjuer: "nei" })).verdi.intervjuer, []);
});

test("intervjuer: grensene selv godtas, tom tid og varighet blir null", () => {
  const r = validerIntervju(intervjuet({ tid: "", varighet: "", sted: "x".repeat(200),
    runde: "x".repeat(80), notat: "x".repeat(1000), type: "video",
    lenke: "https://meet.example.com/abc", id: "x".repeat(32) }));
  assert.equal(r.ok, true);
  assert.equal(r.verdi.tid, null);
  assert.equal(r.verdi.varighet, null);
  assert.equal(validerIntervju(intervjuet({ varighet: 600 })).verdi.varighet, 600);
});

test("intervjuer: strenge meldinger til skjemaet", () => {
  const r = validerIntervju(intervjuet({ dato: "", tid: "kl 9" }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.feil.map(f => f.felt), ["dato", "tid"]);
});

test("intervjuer: duplikat id droppes, sortert på dato og tid, høyst 20 og de seneste", () => {
  const r = validerSoknad(rad({ intervjuer: [
    intervjuet({ id: "b", dato: "2026-10-12", tid: "13:00" }),
    intervjuet({ id: "a", dato: "2026-10-12", tid: null }),
    intervjuet({ id: "c", dato: "2026-10-01" }),
    intervjuet({ id: "b", dato: "2026-12-01" })
  ] })).verdi.intervjuer;
  assert.deepEqual(r.map(i => i.id), ["c", "a", "b"]);

  const mange = Array.from({ length: 25 }, (_, i) =>
    intervjuet({ id: "i" + i, dato: `2026-11-${String(i + 1).padStart(2, "0")}` }));
  const kuttet = validerSoknad(rad({ intervjuer: mange })).verdi.intervjuer;
  assert.equal(kuttet.length, MAKS_INTERVJU.antall);
  assert.equal(kuttet[0].id, "i5");
  assert.equal(kuttet.at(-1).id, "i24");
});

test("intervju: bare ekte true teller, og intervju- eller videre-status gir det alltid", () => {
  assert.equal(validerSoknad(rad()).verdi.intervju, false);
  assert.equal(validerSoknad(rad({ status: "rejected", intervju: true })).verdi.intervju, true);
  assert.equal(validerSoknad(rad({ status: "rejected", intervju: "true" })).verdi.intervju, false);
  assert.equal(validerSoknad(rad({ status: "interview" })).verdi.intervju, true);
  assert.equal(validerSoknad(rad({ status: "accepted", intervju: false })).verdi.intervju, true);
});

test("duplikat id forkastes, første vinner", () => {
  const { gyldige, forkastet } = validerSamling([rad(), rad({ selskap: "Annen" })]);
  assert.equal(gyldige.length, 1);
  assert.equal(gyldige[0].selskap, "Equinor");
  assert.equal(forkastet.length, 1);
  assert.equal(forkastet[0].indeks, 1);
});

/* ---------- lesing ---------- */

test("manglende fil gir tom, og ingen fil opprettes", async () => {
  const { katalog, lager } = await nyttLager();
  const r = await lager.les();
  assert.deepEqual(r, { tom: true, versjon: 0, jobber: null });
  assert.deepEqual(await fs.readdir(katalog), []);
});

test("rundtur: skriv og les gir samme rader", async () => {
  const { lager } = await nyttLager();
  const skrevet = await lager.skriv([rad(), rad({ id: "b2", selskap: "DNV" })], 0);
  assert.equal(skrevet.ok, true);
  assert.equal(skrevet.versjon, 1);

  const lest = await lager.les();
  assert.equal(lest.versjon, 1);
  assert.deepEqual(lest.jobber, skrevet.jobber);
  assert.deepEqual(lest.jobber.map(j => j.id), ["a1", "b2"]);
});

test("ødelagt fil blir liggende urørt ved lesing", async () => {
  const { katalog, lager } = await nyttLager();
  const sti = path.join(katalog, "jobber.json");
  const rå  = '{ dette er ikke json';
  await fs.writeFile(sti, rå);

  const r = await lager.les();
  assert.equal(r.ødelagt, true);
  /* Filen skal ikke flyttes under lesing: gjorde den det, ville
     katalogen stått tom og neste skriving blitt godtatt. */
  assert.equal(await fs.readFile(sti, "utf8"), rå);
  assert.equal(r.sti, sti);
});

test("ødelagt fil sperrer alle senere skrivinger, ikke bare den første", async () => {
  const { katalog, lager } = await nyttLager();
  const sti = path.join(katalog, "jobber.json");
  await lager.skriv([rad({ id: "e1", selskap: "EKTE1" })], undefined);
  /* Andre skriving, så jobber.forrige.json faktisk finnes. */
  await lager.skriv([rad({ id: "e1", selskap: "EKTE1" }), rad({ id: "e2", selskap: "EKTE2" })], 1);
  await fs.writeFile(sti, '{ ødelagt');

  await lager.les();                                    /* som ved sidelasting */
  const a = await lager.skriv([rad({ id: "n1", selskap: "NY" })], 0);
  const b = await lager.skriv([rad({ id: "n2", selskap: "NY2" })], 0);
  assert.equal(a.ok, false); assert.equal(a.feil, "ødelagt");
  assert.equal(b.ok, false); assert.equal(b.feil, "ødelagt");

  /* Sikkerhetskopien må fortsatt holde de ekte radene. */
  const kopi = JSON.parse(await fs.readFile(path.join(katalog, "jobber.forrige.json"), "utf8"));
  assert.deepEqual(kopi.jobber.map(r => r.selskap), ["EKTE1"]);
});

test("bevisst gjenoppretting setter den ødelagte filen i karantene og skriver", async () => {
  const { katalog, lager } = await nyttLager();
  const sti = path.join(katalog, "jobber.json");
  const rå  = '{ ødelagt';
  await fs.writeFile(sti, rå);
  await lager.les();

  const r = await lager.skriv([rad({ id: "g1", selskap: "GJENOPPRETTET" })], undefined, { overstyrOdelagt: true });
  assert.equal(r.ok, true);
  assert.match(path.basename(r.karantene), /^jobber\.ødelagt-.*\.json$/);
  assert.equal(path.basename(r.karantene).includes(":"), false);
  assert.equal(await fs.readFile(r.karantene, "utf8"), rå);   /* bytene overlevde */

  const dok = JSON.parse(await fs.readFile(sti, "utf8"));
  assert.deepEqual(dok.jobber.map(x => x.selskap), ["GJENOPPRETTET"]);
});

test("en rad validatoren ikke forstår overlever senere skrivinger", async () => {
  const { katalog, lager } = await nyttLager();
  const sti = path.join(katalog, "jobber.json");
  /* Håndredigert fil: én rad med umulig dato. */
  await fs.writeFile(sti, JSON.stringify({ versjon: 1, jobber: [
    rad({ id: "a1", selskap: "Equinor" }),
    rad({ id: "a2", selskap: "Håndredigert", frist: "2026-02-31" })
  ]}, null, 2));

  const lest = await lager.les();
  assert.equal(lest.jobber.length, 1);
  assert.ok(lest.advarsel);

  await lager.skriv(lest.jobber, lest.versjon);
  const dok = JSON.parse(await fs.readFile(sti, "utf8"));
  assert.equal(dok.jobber.length, 1);
  /* Raden er ikke slettet — den er tatt vare på ved siden av. */
  assert.equal(dok.ugyldige.length, 1);
  assert.equal(dok.ugyldige[0].selskap, "Håndredigert");
});

test("feil toppnivåform meldes som ødelagt", async () => {
  const { katalog, lager } = await nyttLager();
  await fs.writeFile(path.join(katalog, "jobber.json"), '{"noe":"helt annet"}');
  assert.equal((await lager.les()).ødelagt, true);
});

test("bar liste leses som eldre format, ikke karantene", async () => {
  const { katalog, lager } = await nyttLager();
  await fs.writeFile(path.join(katalog, "jobber.json"), JSON.stringify([rad()]));

  const r = await lager.les();
  assert.equal(r.ødelagt, undefined);
  assert.equal(r.versjon, 0);
  assert.equal(r.jobber.length, 1);
  assert.equal((await fs.readdir(katalog)).length, 1);
});

test("ugyldige rader hoppes over med advarsel", async () => {
  const { katalog, lager } = await nyttLager();
  await fs.writeFile(path.join(katalog, "jobber.json"), JSON.stringify({
    versjon: 3, jobber: [rad(), rad({ id: "b2", selskap: "" })]
  }));

  const r = await lager.les();
  assert.equal(r.versjon, 3);
  assert.equal(r.jobber.length, 1);
  assert.equal(r.forkastet.length, 1);
  assert.match(r.advarsel, /rad/i);
});

/* ---------- skriving ---------- */

test("ugyldige rader skrives ikke", async () => {
  const { katalog, lager } = await nyttLager();
  const r = await lager.skriv([rad({ lenke: "javascript:alert(1)" })], 0);
  assert.equal(r.ok, false);
  assert.equal(r.feil, "ugyldig");
  assert.equal(r.detaljer[0].indeks, 0);
  assert.deepEqual(await fs.readdir(katalog), []);
});

test("utdatert versjon gir konflikt og lar filen stå urørt", async () => {
  const { katalog, lager } = await nyttLager();
  await lager.skriv([rad()], 0);
  const sti  = path.join(katalog, "jobber.json");
  const før  = await fs.readFile(sti, "utf8");

  const r = await lager.skriv([rad({ selskap: "Kaprer" })], 0);
  assert.equal(r.ok, false);
  assert.equal(r.feil, "konflikt");
  assert.equal(r.versjon, 1);
  assert.equal(r.jobber[0].selskap, "Equinor");
  assert.equal(await fs.readFile(sti, "utf8"), før);
});

test("samtidige skrivinger serialiseres og teller riktig", async () => {
  const { lager } = await nyttLager();
  const svar = await Promise.all([
    lager.skriv([rad({ id: "a" })]),
    lager.skriv([rad({ id: "a" }), rad({ id: "b" })]),
    lager.skriv([rad({ id: "a" }), rad({ id: "b" }), rad({ id: "c" })]),
    lager.skriv([rad({ id: "d" })])
  ]);
  assert.deepEqual(svar.map(s => s.versjon), [1, 2, 3, 4]);

  const lest = await lager.les();
  assert.equal(lest.versjon, 4);
  assert.deepEqual(lest.jobber.map(j => j.id), ["d"]);
});

test("ingen .tmp-fil blir liggende igjen", async () => {
  const { katalog, lager } = await nyttLager();
  await lager.skriv([rad()], 0);
  const filer = await fs.readdir(katalog);
  assert.equal(filer.some(f => f.includes(".tmp")), false);
});

test("jobber.forrige.json holder forrige dokument", async () => {
  const { katalog, lager } = await nyttLager();
  await lager.skriv([rad()], 0);
  await lager.skriv([rad({ selskap: "DNV" })], 1);

  const forrige = JSON.parse(await fs.readFile(path.join(katalog, "jobber.forrige.json"), "utf8"));
  assert.equal(forrige.versjon, 1);
  assert.equal(forrige.jobber[0].selskap, "Equinor");
});

test("filen er lesbar for mennesker og har envelope", async () => {
  const { katalog, lager } = await nyttLager();
  await lager.skriv([rad()], 0);
  const tekst = await fs.readFile(path.join(katalog, "jobber.json"), "utf8");
  assert.match(tekst, /^\{\n  "versjon": 1,\n  "oppdatert": "/);
  assert.match(JSON.parse(tekst).oppdatert, /^\d{4}-\d{2}-\d{2}T/);
});

test("tidsstempler: opprettet består, oppdatert flytter seg, urørt rad står stille", async () => {
  const { lager } = await nyttLager();
  const først = await lager.skriv([rad({ id: "a" }), rad({ id: "b" })], 0);
  const [a0, b0] = først.jobber;
  await sov(5);

  const så = await lager.skriv([rad({ id: "a", stilling: "Fast stilling" }), rad({ id: "b" })], 1);
  const [a1, b1] = så.jobber;

  assert.equal(a1.opprettet, a0.opprettet);
  assert.notEqual(a1.oppdatert, a0.oppdatert);
  assert.ok(Date.parse(a1.oppdatert) > Date.parse(a0.oppdatert));

  assert.equal(b1.opprettet, b0.opprettet);
  assert.equal(b1.oppdatert, b0.oppdatert);
});

test("klientens tidsstempler overstyres av serveren", async () => {
  const { lager } = await nyttLager();
  const r = await lager.skriv([rad({ opprettet: "1999-01-01T00:00:00.000Z",
                                     oppdatert: "1999-01-01T00:00:00.000Z" })], 0);
  assert.notEqual(r.jobber[0].opprettet, "1999-01-01T00:00:00.000Z");
  assert.ok(Date.parse(r.jobber[0].opprettet) > Date.parse("2020-01-01T00:00:00.000Z"));
});

test("skriving mot ødelagt fil nekter i stedet for å overskrive", async () => {
  const { katalog, lager } = await nyttLager();
  await fs.writeFile(path.join(katalog, "jobber.json"), "ikke json");
  const r = await lager.skriv([rad()]);
  assert.equal(r.ok, false);
  assert.equal(r.feil, "ødelagt");
});

/* ---------- sikkerhetsnettet for hendelsesloggen ---------- */

/* Kvart over midnatt lokal tid. I enhver sone øst for UTC er det
   fortsatt i går i UTC, så en dato hentet fra toISOString ville
   bommet. Lageret skal datere med kalenderdagen brukeren ser. */
const KLOKKE = new Date(2026, 9, 9, 0, 15);
const lagerMedKlokke = () => nyttLager({ nå: () => KLOKKE });
const LAGERHENDELSE = { dato: "2026-10-09", tid: KLOKKE.toISOString(), kilde: "lager" };

test("lageret: første lagring i en tom fil dikter ikke opp historikk", async () => {
  const { lager } = await lagerMedKlokke();
  const r = await lager.skriv([rad({ status: "rejected" }), rad({ id: "b", status: "sent" })], 0);
  assert.deepEqual(r.jobber.map(j => j.hendelser), [[], []]);
});

test("lageret: ny rad i en liste i bruk får en første hendelse, datert lokalt", async () => {
  const { lager } = await lagerMedKlokke();
  await lager.skriv([rad()], 0);
  const r = await lager.skriv([rad(), rad({ id: "b", status: "sent" })], 1);
  assert.deepEqual(r.jobber[0].hendelser, []);
  assert.deepEqual(r.jobber[1].hendelser, [{ til: "sent", ...LAGERHENDELSE }]);
});

test("lageret: ny rad med egne hendelser beholder dem urørt", async () => {
  const { lager } = await lagerMedKlokke();
  await lager.skriv([rad()], 0);
  const egne = [{ til: "todo", dato: "2026-10-08", tid: "2026-10-08T10:00:00.000Z", kilde: "bruker" }];
  const r = await lager.skriv([rad(), rad({ id: "b", hendelser: egne })], 1);
  assert.deepEqual(r.jobber[1].hendelser, egne);
});

test("lageret: statusskift uten hendelse fra klienten gir én hendelse fra lageret", async () => {
  const { lager } = await lagerMedKlokke();
  await lager.skriv([rad()], 0);
  const r = await lager.skriv([rad({ status: "sent", sendtDato: "2026-10-09" })], 1);
  assert.deepEqual(r.jobber[0].hendelser, [{ til: "sent", ...LAGERHENDELSE }]);
  assert.deepEqual((await lager.les()).jobber[0].hendelser, r.jobber[0].hendelser);
});

test("lageret: klienten logget selv, så lageret legger ikke til en til", async () => {
  const { lager } = await lagerMedKlokke();
  await lager.skriv([rad()], 0);
  const egne = [{ til: "sent", dato: "2026-10-09", tid: "2026-10-08T22:14:00.000Z", kilde: "bruker" }];
  const r = await lager.skriv([rad({ status: "sent", hendelser: egne })], 1);
  assert.deepEqual(r.jobber[0].hendelser, egne);
});

test("lageret: angre med klientens forrige hendelser etterlater ingen ny hendelse", async () => {
  const { lager } = await lagerMedKlokke();
  const før = [{ til: "todo", dato: "2026-10-01", kilde: "bruker" }];
  const etter = [...før, { til: "sent", dato: "2026-10-09", kilde: "bruker" }];
  await lager.skriv([rad({ hendelser: før })], 0);
  await lager.skriv([rad({ status: "sent", hendelser: etter })], 1);
  /* Angre: statusen og listen settes tilbake til øyeblikksbildet. */
  const r = await lager.skriv([rad({ status: "todo", hendelser: før })], 2);
  assert.deepEqual(r.jobber[0].hendelser, før);
});

test("lageret: en klient som ikke har sett lagerets hendelse visker den ikke ut", async () => {
  const { lager } = await lagerMedKlokke();
  await lager.skriv([rad()], 0);
  await lager.skriv([rad({ status: "sent" })], 1);
  /* Klienten får ikke radene tilbake, og lagrer et notat med listen den kjenner. */
  const r = await lager.skriv([rad({ status: "sent", notat: "Ring fredag", hendelser: [] })], 2);
  assert.deepEqual(r.jobber[0].hendelser, [{ til: "sent", ...LAGERHENDELSE }]);
});

test("lageret: en eldre klient uten feltene beholder det som står i filen", async () => {
  const { lager } = await lagerMedKlokke();
  const hendelser = [{ til: "todo", dato: "2026-10-01", kilde: "bruker" }];
  const intervjuer = [{ id: "i1", dato: "2026-10-12", tid: "09:30", varighet: 60, sted: "",
                        type: "video", lenke: "", runde: "", notat: "" }];
  await lager.skriv([rad({ hendelser, intervjuer })], 0);

  const r = await lager.skriv([rad({ notat: "endret" })], 1);
  assert.deepEqual(r.jobber[0].hendelser, hendelser);
  assert.deepEqual(r.jobber[0].intervjuer, intervjuer);

  /* Og et statusskift fra den samme klienten logges oppå det som var. */
  const s = await lager.skriv([rad({ status: "sent" })], 2);
  assert.deepEqual(s.jobber[0].hendelser, [...hendelser, { til: "sent", ...LAGERHENDELSE }]);
  assert.deepEqual(s.jobber[0].intervjuer, intervjuer);
});

test("lageret: en klient som sender tomme lister med vilje får tømme dem", async () => {
  const { lager } = await lagerMedKlokke();
  const intervjuer = [{ id: "i1", dato: "2026-10-12", tid: null, varighet: null, sted: "",
                        type: "", lenke: "", runde: "", notat: "" }];
  await lager.skriv([rad({ intervjuer })], 0);
  const r = await lager.skriv([rad({ intervjuer: [] })], 1);
  assert.deepEqual(r.jobber[0].intervjuer, []);
});

test("lageret: endrede hendelser eller intervjuer flytter oppdatert, like gjør det ikke", async () => {
  let klokke = new Date(2026, 9, 9, 12, 0);
  const { lager } = await nyttLager({ nå: () => klokke });
  const h = [{ til: "todo", dato: "2026-10-01" }];
  const a = (await lager.skriv([rad({ hendelser: h })], 0)).jobber[0];

  klokke = new Date(2026, 9, 9, 12, 1);
  const b = (await lager.skriv([rad({ hendelser: [...h] })], 1)).jobber[0];
  assert.equal(b.oppdatert, a.oppdatert);

  klokke = new Date(2026, 9, 9, 12, 2);
  const c = (await lager.skriv([rad({ hendelser: [...h, { til: "sent", dato: "2026-10-09" }] })], 2)).jobber[0];
  assert.equal(c.oppdatert, klokke.toISOString());

  klokke = new Date(2026, 9, 9, 12, 3);
  const d = (await lager.skriv([rad({ hendelser: c.hendelser, status: "todo",
    intervjuer: [{ id: "i1", dato: "2026-10-12" }] })], 3)).jobber[0];
  assert.equal(d.oppdatert, klokke.toISOString());
});

test("lageret: gjenoppretting etter karantene dikter ikke opp historikk", async () => {
  const { katalog, lager } = await lagerMedKlokke();
  await fs.writeFile(path.join(katalog, "jobber.json"), "ikke json");
  const r = await lager.skriv([rad({ status: "rejected" })], undefined, { overstyrOdelagt: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.jobber[0].hendelser, []);
});
