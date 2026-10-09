import test from "node:test";
import assert from "node:assert/strict";

import { validerSoknad } from "../src/felles.mjs";
import { medStatus, synkSendt, tidslinje, lagHendelse, lokalDato, dagerMellom,
         dagerSidenSendt, svartidDager, medianSvartid, utenSvarOver } from "../src/hendelser.mjs";

/* En fast klokke: 9. oktober 2026, kvart over midnatt lokal tid. */
const NÅ = new Date(2026, 9, 9, 0, 15);
const K = { iDag: "2026-10-09", nå: NÅ };

const jobb = (o = {}) => ({
  id: "a1", selskap: "Equinor", stilling: "Sommerjobb", lenke: "", sted: "",
  frist: null, status: "todo", sektor: "energi", jobbtype: "", notat: "",
  sendtDato: null, intervju: false, hendelser: [], intervjuer: [],
  opprettet: null, oppdatert: null, ...o
});
const h = (til, dato, o = {}) => ({ til, dato, ...o });

/* ---------- datoer ---------- */

test("lokalDato bruker lokal kalenderdag, ikke UTC", () => {
  assert.equal(lokalDato(NÅ), "2026-10-09");
});

test("dagerMellom teller hele dager, også over sommertidsskiftet", () => {
  assert.equal(dagerMellom("2026-03-28", "2026-03-30"), 2);
  assert.equal(dagerMellom("2026-10-24", "2026-10-26"), 2);
  assert.equal(dagerMellom("2026-10-09", "2026-10-01"), -8);
});

test("lagHendelse daterer med iDag og tidsstempler med nå", () => {
  assert.deepEqual(lagHendelse("sent", K),
    { til: "sent", dato: "2026-10-09", tid: NÅ.toISOString(), kilde: "bruker" });
  assert.equal(lagHendelse("sent", { nå: NÅ }).dato, "2026-10-09");
  assert.equal(lagHendelse("sent", { iDag: new Date(2026, 0, 2), nå: NÅ }).dato, "2026-01-02");
});

/* ---------- medStatus ---------- */

test("medStatus: sendt setter sendtDato i dag og logger hendelsen", () => {
  const før = jobb();
  const r = medStatus(før, "sent", K);
  assert.equal(r.status, "sent");
  assert.equal(r.sendtDato, "2026-10-09");
  assert.deepEqual(r.hendelser, [{ til: "sent", dato: "2026-10-09", tid: NÅ.toISOString(), kilde: "bruker" }]);
  /* Originalen røres ikke: den er angre-øyeblikksbildet. */
  assert.equal(før.status, "todo");
  assert.deepEqual(før.hendelser, []);
});

test("medStatus: er idempotent, to klikk gir én hendelse", () => {
  const én = medStatus(jobb(), "sent", K);
  const to = medStatus(én, "sent", { ...K, nå: new Date(2026, 9, 9, 8, 0) });
  assert.deepEqual(to, én);
});

test("medStatus: en sendtDato som finnes beholdes, og hendelsen følger den", () => {
  const r = medStatus(jobb({ status: "todo", sendtDato: "2026-10-02" }), "sent", K);
  assert.equal(r.sendtDato, "2026-10-02");
  assert.deepEqual(r.hendelser, [{ til: "sent", dato: "2026-10-02", kilde: "bruker" }]);
});

test("medStatus: tilbake til «Å søke på» tømmer sendtDato, men historikken står", () => {
  const sendt = medStatus(jobb(), "sent", K);
  const r = medStatus(sendt, "todo", K);
  assert.equal(r.sendtDato, null);
  assert.deepEqual(r.hendelser.map(x => x.til), ["sent", "todo"]);
});

test("medStatus: intervju og videre setter intervjumerket, avslag fjerner det ikke", () => {
  const i = medStatus(medStatus(jobb(), "sent", K), "interview", K);
  assert.equal(i.intervju, true);
  assert.equal(i.sendtDato, "2026-10-09");
  assert.equal(medStatus(i, "rejected", K).intervju, true);
  assert.equal(medStatus(jobb(), "accepted", K).intervju, true);
  assert.equal(medStatus(jobb(), "rejected", K).intervju, false);
});

test("medStatus: rett til intervju uten sendtdato gir sendtdato i dag", () => {
  const r = medStatus(jobb(), "interview", K);
  assert.equal(r.sendtDato, "2026-10-09");
  assert.deepEqual(r.hendelser.map(x => x.til), ["interview"]);
});

test("medStatus: kilde følger med, og ukjent status er en programmeringsfeil", () => {
  assert.equal(medStatus(jobb(), "todo", { ...K, kilde: "radar" }).hendelser[0].kilde, "radar");
  assert.throws(() => medStatus(jobb(), "tullball", K), /Ukjent status/);
});

test("medStatus: en ny søknad får sin første hendelse selv om statusen er den samme", () => {
  const r = medStatus(jobb(), "todo", K);
  assert.deepEqual(r.hendelser.map(x => x.til), ["todo"]);
  assert.deepEqual(medStatus(r, "todo", K), r);
});

test("medStatus: resultatet består validatoren uendret", () => {
  const r = medStatus(medStatus(jobb(), "sent", K), "interview", K);
  const v = validerSoknad(r);
  assert.equal(v.ok, true);
  assert.deepEqual(v.verdi.hendelser, r.hendelser);
});

/* ---------- synkSendt ---------- */

test("synkSendt: rettet sendtDato flytter den siste sendt-hendelsen og fjerner tiden", () => {
  const sendt = medStatus(jobb(), "sent", K);
  const r = synkSendt({ ...sendt, sendtDato: "2026-10-01" }, K);
  assert.deepEqual(r.hendelser, [{ til: "sent", dato: "2026-10-01", kilde: "bruker" }]);
});

test("synkSendt: rører ikke en sendt-hendelse fra før en gjenåpning", () => {
  const r = synkSendt(jobb({ status: "interview", sendtDato: "2026-10-09", hendelser: [
    h("sent", "2026-09-01"), h("todo", "2026-09-05"), h("interview", "2026-10-09")
  ] }), K);
  assert.deepEqual(r.hendelser.map(x => x.dato), ["2026-09-01", "2026-09-05", "2026-10-09"]);
});

test("synkSendt: mangler sendtDato, hentes den fra sendt-hendelsen i stedet for i dag", () => {
  const r = synkSendt(jobb({ status: "sent", hendelser: [h("sent", "2026-09-20")] }), K);
  assert.equal(r.sendtDato, "2026-09-20");
  assert.equal(synkSendt(jobb({ status: "sent" }), K).sendtDato, "2026-10-09");
  assert.equal(synkSendt(jobb({ status: "todo", sendtDato: "2026-09-20" }), K).sendtDato, null);
  assert.equal(synkSendt(jobb({ status: "rejected", sendtDato: null }), K).sendtDato, null);
});

/* ---------- tidslinje ---------- */

test("tidslinje: gamle data uten hendelser anslås fra opprettet og sendtDato", () => {
  const t = tidslinje(jobb({ status: "rejected", sendtDato: "2026-09-10",
                             opprettet: "2026-09-01T08:00:00.000Z" }), "2026-10-09");
  assert.deepEqual(t, [
    { til: "todo",     dato: "2026-09-01", anslått: true, dagerSiden: 38 },
    { til: "sent",     dato: "2026-09-10", anslått: true, dagerSiden: 29 },
    { til: "rejected", dato: null,         anslått: true, dagerSiden: null }
  ]);
});

test("tidslinje: bare opprettet gir bare «lagt til»", () => {
  const t = tidslinje(jobb({ opprettet: "2026-09-01T08:00:00.000Z" }), "2026-10-09");
  assert.deepEqual(t, [{ til: "todo", dato: "2026-09-01", anslått: true, dagerSiden: 38 }]);
});

test("tidslinje: sendt uten sendtDato og uten opprettet viser statusen med ukjent dato", () => {
  assert.deepEqual(tidslinje(jobb({ status: "sent" }), "2026-10-09"),
    [{ til: "sent", dato: null, anslått: true, dagerSiden: null }]);
  assert.deepEqual(tidslinje(jobb(), "2026-10-09"), []);
});

test("tidslinje: «lagt til» etter sendtdatoen er umulig og tas ikke med", () => {
  /* Eldre rader fikk opprettet ved første lagring i filen, ofte senere enn de ble sendt. */
  const t = tidslinje(jobb({ status: "sent", sendtDato: "2026-08-01",
                             opprettet: "2026-09-01T08:00:00.000Z" }), "2026-10-09");
  assert.deepEqual(t.map(x => x.til), ["sent"]);
});

test("tidslinje: med ekte hendelser legges bare stegene før den første til", () => {
  const t = tidslinje(jobb({ status: "rejected", sendtDato: "2026-09-10",
    opprettet: "2026-09-01T08:00:00.000Z",
    hendelser: [h("interview", "2026-09-20", { kilde: "bruker" }), h("rejected", "2026-10-01")] }),
    "2026-10-09");
  assert.deepEqual(t.map(x => [x.til, x.dato, !!x.anslått]), [
    ["todo", "2026-09-01", true],
    ["sent", "2026-09-10", true],
    ["interview", "2026-09-20", false],
    ["rejected", "2026-10-01", false]
  ]);
});

test("tidslinje: første hendelse samme dag som opprettet er selve tillegget", () => {
  const t = tidslinje(jobb({ status: "sent", sendtDato: "2026-09-01",
    opprettet: "2026-09-01T08:00:00.000Z", hendelser: [h("sent", "2026-09-01")] }), "2026-10-09");
  assert.deepEqual(t.map(x => x.til), ["sent"]);
});

test("tidslinje: starter loggen på «Å søke på», anslås ingenting", () => {
  const t = tidslinje(jobb({ status: "sent", sendtDato: "2026-09-05",
    opprettet: "2026-08-01T08:00:00.000Z",
    hendelser: [h("todo", "2026-09-01"), h("sent", "2026-09-05")] }), "2026-10-09");
  assert.deepEqual(t.map(x => [x.til, !!x.anslått]), [["todo", false], ["sent", false]]);
});

test("tidslinje: tåler rusk i hendelsene og godtar iDag som Date", () => {
  const t = tidslinje(jobb({ hendelser: [h("todo", "2026-10-01"), "rusk", h("tull", "2026-10-02")] }),
                      new Date(2026, 9, 9));
  assert.deepEqual(t, [{ til: "todo", dato: "2026-10-01", dagerSiden: 8 }]);
});

/* ---------- tall ---------- */

test("dagerSidenSendt: fra sendtDato til i dag, null uten", () => {
  assert.equal(dagerSidenSendt(jobb({ status: "sent", sendtDato: "2026-09-09" }), "2026-10-09"), 30);
  assert.equal(dagerSidenSendt(jobb({ status: "sent", sendtDato: "2026-09-09" }), new Date(2026, 9, 9)), 30);
  assert.equal(dagerSidenSendt(jobb(), "2026-10-09"), null);
});

test("svartidDager: fra sendt til første svar, bare ekte hendelser", () => {
  assert.equal(svartidDager(jobb({ hendelser: [
    h("todo", "2026-09-01"), h("sent", "2026-09-05"), h("interview", "2026-09-19"), h("rejected", "2026-10-01")
  ] })), 14);
  assert.equal(svartidDager(jobb({ hendelser: [h("sent", "2026-09-05"), h("rejected", "2026-09-06")] })), 1);
  /* Trukket og utløpt er ikke svar. */
  assert.equal(svartidDager(jobb({ hendelser: [h("sent", "2026-09-05"), h("trukket", "2026-09-06")] })), null);
  /* Gamle data har bare sendtDato: ikke noe tall, ikke et anslag. */
  assert.equal(svartidDager(jobb({ status: "rejected", sendtDato: "2026-09-01" })), null);
  assert.equal(svartidDager(jobb({ hendelser: [h("interview", "2026-09-19")] })), null);
});

test("svartidDager: en gjenåpning nullstiller, og den nye sendingen teller", () => {
  assert.equal(svartidDager(jobb({ hendelser: [
    h("sent", "2026-08-01"), h("todo", "2026-08-02"), h("sent", "2026-09-01"), h("rejected", "2026-09-11")
  ] })), 10);
  assert.equal(svartidDager(jobb({ hendelser: [
    h("sent", "2026-08-01"), h("todo", "2026-08-02"), h("rejected", "2026-09-11")
  ] })), null);
});

test("medianSvartid: midterste verdi, snitt av de to midterste ved partall, null uten data", () => {
  const med = d => jobb({ hendelser: [h("sent", "2026-09-01"), h("rejected", d)] });
  assert.equal(medianSvartid([med("2026-09-04"), med("2026-09-21"), med("2026-09-11"), jobb()]), 10);
  assert.equal(medianSvartid([med("2026-09-04"), med("2026-09-11")]), 6.5);
  assert.equal(medianSvartid([jobb()]), null);
  assert.equal(medianSvartid([]), null);
});

test("utenSvarOver: bare «Sendt», og strengt over grensen", () => {
  const liste = [
    jobb({ id: "a", status: "sent", sendtDato: "2026-09-09" }),      /* 30 dager */
    jobb({ id: "b", status: "sent", sendtDato: "2026-09-08" }),      /* 31 dager */
    jobb({ id: "c", status: "interview", sendtDato: "2026-08-01" }),
    jobb({ id: "d", status: "sent", sendtDato: null })
  ];
  assert.deepEqual(utenSvarOver(liste, 30, "2026-10-09").map(j => j.id), ["b"]);
});
