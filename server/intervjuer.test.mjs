import test from "node:test";
import assert from "node:assert/strict";

import { nyttIntervju, endreIntervju, slettIntervju, kommende, nesteIntervju, starttid } from "../src/intervjuer.mjs";

const NÅ = new Date(2026, 9, 4, 12, 0);          /* søndag 4. oktober 2026, kl. 12 lokal tid */
const VALG = { iDag: "2026-10-04", nå: NÅ, lagId: () => "iv1" };
const jobb = (o = {}) => ({ id: "a1", selskap: "Aker BP", stilling: "ML Engineer", status: "todo",
                            hendelser: [], intervjuer: [], ...o });
const skjema = (o = {}) => ({ dato: "2026-10-08", tid: "10:00", varighet: 45, type: "video",
                              sted: "Teams", runde: "1", ...o });

test("et nytt intervju får id og flytter todo og sent til interview med en hendelse", () => {
  for(const status of ["todo", "sent"]){
    const j = jobb({ status });
    const r = nyttIntervju(j, skjema(), VALG);
    assert.equal(r.ok, true);
    assert.equal(r.intervju.id, "iv1");
    assert.equal(r.jobb.status, "interview");
    assert.equal(r.statusEndret, true);
    assert.equal(r.jobb.hendelser.at(-1).til, "interview");
    assert.equal(r.før, j, "den gamle raden følger med, til angre");
    assert.equal(j.intervjuer.length, 0, "inndata er urørt");
  }
});

test("status som alt er interview, accepted eller rejected beholdes", () => {
  for(const status of ["interview", "accepted", "rejected"]){
    const r = nyttIntervju(jobb({ status }), skjema(), VALG);
    assert.equal(r.jobb.status, status);
    assert.equal(r.statusEndret, false);
    assert.equal(r.jobb.hendelser.length, 0);
  }
});

test("ugyldig inndata gir meldinger og ingen endring; id fra utsiden ignoreres", () => {
  const r = nyttIntervju(jobb(), skjema({ dato: "i morgen", tid: "25:00" }), VALG);
  assert.equal(r.ok, false);
  assert.deepEqual(r.feil.map(f => f.felt).sort(), ["dato", "tid"]);
  assert.equal(nyttIntervju(jobb(), null, VALG).ok, false);
  assert.equal(nyttIntervju(jobb(), skjema({ id: "kapret", __proto__: { x: 1 } }), VALG).intervju.id, "iv1");
});

test("standard-id er gyldig og unik, og taket på 20 gir en melding", () => {
  const a = nyttIntervju(jobb(), skjema()).intervju.id, b = nyttIntervju(jobb(), skjema()).intervju.id;
  assert.match(a, /^[A-Za-z0-9_-]{1,32}$/);
  assert.notEqual(a, b);
  let j = jobb({ status: "interview" });
  for(let n = 0; n < 20; n++) j = nyttIntervju(j, skjema({ dato: "2026-11-" + String(n + 1).padStart(2, "0") })).jobb;
  assert.equal(j.intervjuer.length, 20);
  const r = nyttIntervju(j, skjema(), VALG);
  assert.equal(r.ok, false);
  assert.match(r.feil[0].melding, /20/);
});

test("intervjuene holdes sortert etter dato og tid", () => {
  let j = jobb();
  j = nyttIntervju(j, skjema({ dato: "2026-10-09" }), { ...VALG, lagId: () => "sent" }).jobb;
  j = nyttIntervju(j, skjema({ dato: "2026-10-06" }), { ...VALG, lagId: () => "tidlig" }).jobb;
  assert.deepEqual(j.intervjuer.map(i => i.id), ["tidlig", "sent"]);
});

test("endreIntervju bytter bare skjemafeltene og rører ikke status eller id", () => {
  const j = nyttIntervju(jobb(), skjema(), VALG).jobb;
  const r = endreIntervju(j, "iv1", { tid: "13:30", id: "annen", sted: "Oslo", ukjent: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual([r.intervju.id, r.intervju.tid, r.intervju.sted, r.intervju.varighet], ["iv1", "13:30", "Oslo", 45]);
  assert.equal(r.jobb.status, "interview");
  assert.equal("ukjent" in r.intervju, false);
  assert.equal(endreIntervju(j, "iv1", { tid: "kl 1" }).ok, false);
  assert.equal(endreIntervju(j, "finnes-ikke", {}).ok, false);
});

test("slettIntervju fjerner ett og gir feil på et ukjent", () => {
  let j = nyttIntervju(jobb(), skjema(), VALG).jobb;
  const r = slettIntervju(j, "iv1");
  assert.equal(r.ok, true);
  assert.deepEqual(r.jobb.intervjuer, []);
  assert.equal(r.jobb.status, "interview", "statusen flyttes ikke tilbake");
  assert.equal(slettIntervju(j, "nei").ok, false);
});

test("kommende: pågående, senere og dagens heldagsintervju er med, avsluttede er ikke", () => {
  const iv = (id, dato, tid, varighet = null) => ({ id, dato, tid, varighet, sted: "", type: "", lenke: "", runde: "", notat: "" });
  const j = jobb({ intervjuer: [
    iv("ferdig", "2026-10-04", "10:00", 60),     /* sluttet 11:00 */
    iv("pagar", "2026-10-04", "11:30", 60),      /* slutter 12:30 */
    iv("uten-varighet", "2026-10-04", "10:30"),  /* 60 min som standard, slutter 11:30 */
    iv("heldag-i-dag", "2026-10-04", null),
    iv("heldag-i-går", "2026-10-03", null),
    iv("senere", "2026-10-09", "09:00")
  ] });
  assert.deepEqual(kommende(j, NÅ).map(i => i.id), ["heldag-i-dag", "pagar", "senere"]);
  assert.equal(starttid({ dato: "2026-10-04", tid: null }), null);
});

test("nesteIntervju velger det nærmeste på tvers av søknader og hopper over arkiverte", () => {
  const med = (id, status, dato, tid) => jobb({ id, status, intervjuer: [{ id: "i", dato, tid, varighet: null, sted: "", type: "", lenke: "", runde: "", notat: "" }] });
  const liste = [med("a", "interview", "2026-10-09", "10:00"), med("b", "sent", "2026-10-06", "14:00"),
                 med("c", "rejected", "2026-10-05", "09:00"), med("d", "todo", "2026-10-06", null)];
  assert.equal(nesteIntervju(liste, NÅ).jobb.id, "d", "heldag 6. oktober er før kl. 14 samme dag");
  assert.equal(nesteIntervju([liste[2]], NÅ), null);
  assert.equal(nesteIntervju(null, NÅ), null);
});
