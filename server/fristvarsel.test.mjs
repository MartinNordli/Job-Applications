import test from "node:test";
import assert from "node:assert/strict";

import { forfalne, runde, ryddLogg, varseltekst, validerInnstilling, lesInnstilling,
         lesLogg, standardInnstilling, dagerMellom, isoDato, loggnøkkel } from "../src/fristvarsel.mjs";

/* Reglene for når en frist varsles. Rust har sin egen kopi i
   src-tauri/src/varsel.rs, med de samme tilfellene som tester. */

const I_DAG = "2026-10-04";            /* en søndag */
const PÅ = { versjon: 2, på: true, dagerFør: 1, intervju: true };
const jobb = (o = {}) => ({ id: "a1", selskap: "Aker BP", stilling: "ML Engineer",
                            frist: "2026-10-05", status: "todo", ...o });
const ider = l => l.map(f => f.jobb.id);

test("en frist i morgen varsles med standardinnstillingen", () => {
  assert.deepEqual(ider(forfalne([jobb()], I_DAG, standardInnstilling())), ["a1"]);
});

test("grensene: dag 0 og dagerFør er med, dagen etter og en passert frist er ikke", () => {
  const jobber = [
    jobb({ id: "i-dag", frist: "2026-10-04" }),
    jobb({ id: "om-3", frist: "2026-10-07" }),
    jobb({ id: "om-4", frist: "2026-10-08" }),
    jobb({ id: "i-går", frist: "2026-10-03" })
  ];
  assert.deepEqual(ider(forfalne(jobber, I_DAG, { ...PÅ, dagerFør: 3 })), ["i-dag", "om-3"]);
  assert.deepEqual(ider(forfalne(jobber, I_DAG, PÅ)), ["i-dag"]);
});

test("sendte søknader, løpende opptak og avslått varsel gir ingenting", () => {
  assert.deepEqual(forfalne([jobb({ status: "sent" })], I_DAG, PÅ), []);
  assert.deepEqual(forfalne([jobb({ frist: null })], I_DAG, PÅ), []);
  assert.deepEqual(forfalne([jobb()], I_DAG, { ...PÅ, på: false }), []);
});

test("det som står i loggen varsles ikke igjen, men en flyttet frist gjør det", () => {
  const logg = { [loggnøkkel(jobb())]: "2026-10-04T07:00:00.000Z" };
  assert.deepEqual(forfalne([jobb()], I_DAG, PÅ, logg), []);
  assert.deepEqual(ider(forfalne([jobb({ frist: "2026-10-04" })], I_DAG, PÅ, logg)), ["a1"]);
});

test("nærmeste frist kommer først", () => {
  const l = forfalne([jobb({ id: "b", frist: "2026-10-06" }), jobb({ id: "a", frist: "2026-10-05" })],
                     I_DAG, { ...PÅ, dagerFør: 3 });
  assert.deepEqual(ider(l), ["a", "b"]);
});

test("runden fører varslene i loggen og rydder passerte frister", () => {
  const r = runde({ jobber: [jobb()], iDag: I_DAG, innstilling: PÅ, nå: "T",
                    logg: { "gammel|2026-09-01": "x", "senere|2026-12-01": "y" } });
  assert.equal(r.varsler.length, 1);
  assert.deepEqual(r.logg, { "senere|2026-12-01": "y", "a1|2026-10-05": "T" });
  assert.deepEqual(ryddLogg({ "x|2026-10-04": "z" }, I_DAG), { "x|2026-10-04": "z" });
});

test("ordene i varselet", () => {
  assert.deepEqual(varseltekst(jobb(), 1),
    { tittel: "Frist i morgen: Aker BP", tekst: "ML Engineer · søknadsfristen er mandag 5. oktober." });
  assert.equal(varseltekst(jobb({ frist: "2026-10-04" }), 0).tittel, "Frist i dag: Aker BP");
  assert.equal(varseltekst(jobb({ frist: "2026-10-07" }), 3).tittel, "Frist om 3 dager: Aker BP");
  assert.equal(varseltekst(jobb({ stilling: "" }), 1).tekst, "Søknadsfristen er mandag 5. oktober.");
});

test("innstillingen valideres strengt inn og leses raust fra disk", () => {
  assert.deepEqual(validerInnstilling({ på: false, dagerFør: 7 }),
                   { ok: true, verdi: { versjon: 2, på: false, dagerFør: 7, intervju: true } });
  for(const ugyldig of [{ på: "ja", dagerFør: 1 }, { på: true, dagerFør: 0 },
                        { på: true, dagerFør: 15 }, { på: true, dagerFør: 1.5 }, null, []])
    assert.equal(validerInnstilling(ugyldig).ok, false, JSON.stringify(ugyldig));

  assert.deepEqual(lesInnstilling(null), standardInnstilling());
  assert.deepEqual(lesInnstilling("{ikke json"), standardInnstilling());
  assert.deepEqual(lesInnstilling('{"på":true,"dagerFør":99}'), standardInnstilling());
  assert.deepEqual(lesInnstilling('{"versjon":1,"på":false,"dagerFør":3}'),
                   { versjon: 2, på: false, dagerFør: 3, intervju: true });
  assert.deepEqual(lesLogg("[1,2]"), {});
  assert.deepEqual(lesLogg('{"a|2026-10-05":"t","rar":5}'), { "a|2026-10-05": "t" });
});

test("datoregningen bryr seg ikke om sommertid eller klokkeslett", () => {
  assert.equal(dagerMellom("2026-10-24", "2026-10-26"), 2);   /* over overgangen til vintertid */
  assert.equal(dagerMellom("2026-03-28", "2026-03-30"), 2);   /* og til sommertid */
  assert.equal(isoDato(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(dagerMellom("2026-10-04", "ikke en dato"), null);
});

/* ---------- felles tilfeller (leses også av Rust) ---------- */

import { readFileSync } from "node:fs";
import { intervjuvarsler, VERSJON } from "../src/fristvarsel.mjs";

const TILFELLER = JSON.parse(readFileSync(new URL("../testdata/varseltilfeller.json", import.meta.url), "utf8"));
const lokal = s => { const [d, t] = s.split("T"); const [å, m, dd] = d.split("-").map(Number);
                     const [h, mi] = t.split(":").map(Number); return new Date(å, m - 1, dd, h, mi); };

for(const t of TILFELLER.intervju){
  test("intervjuvarsel: " + t.navn, () => {
    const ut = intervjuvarsler(t.jobber, lokal(t.nå), t.innstilling, t.logg)
      .map(v => ({ nøkkel: v.nøkkel, tittel: v.tittel, tekst: v.tekst }));
    assert.deepEqual(ut, t.forventet);
  });
}

for(const t of TILFELLER.frist){
  test("fristvarsel: " + t.navn, () => {
    const ut = forfalne(t.jobber, t.iDag, t.innstilling, t.logg)
      .map(f => ({ nøkkel: f.nøkkel, ...varseltekst(f.jobb, f.dager) }))
      .map(v => ({ nøkkel: v.nøkkel, tittel: v.tittel, tekst: v.tekst }));
    assert.deepEqual(ut, t.forventet);
  });
}

test("runde fører intervjuvarsler i loggen og rydder intervjuer som er forbi", () => {
  const t = TILFELLER.intervju[0];
  const gammel = { "intervju:a1:i0:1000:dag|2026-09-01": "x" };
  const r = runde({ jobber: t.jobber, innstilling: t.innstilling, logg: gammel, nå: lokal(t.nå) });
  assert.deepEqual(Object.keys(r.logg), [t.forventet[0].nøkkel]);
  assert.equal(r.varsler.length, 1);
  assert.deepEqual([r.varsler[0].art, r.varsler[0].type, r.varsler[0].iid], ["intervju", "dag", "i1"]);
  assert.equal(runde({ jobber: t.jobber, innstilling: t.innstilling, logg: r.logg, nå: lokal(t.nå) }).varsler.length, 0);
});

test("innstillingen: versjon 2 med intervju, versjon 1 leses som på", () => {
  assert.equal(VERSJON, 2);
  assert.equal(standardInnstilling().intervju, true);
  assert.equal(lesInnstilling('{"versjon":1,"på":true,"dagerFør":2}').intervju, true);
  assert.equal(lesInnstilling('{"versjon":2,"på":true,"dagerFør":2,"intervju":false}').intervju, false);
  assert.equal(validerInnstilling({ på: true, dagerFør: 1, intervju: "ja" }).ok, false);
});
