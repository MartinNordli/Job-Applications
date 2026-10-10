import test from "node:test";
import assert from "node:assert/strict";

import { lagIcs, brytLinje, escapeTekst, icsFilnavn } from "../src/ics.mjs";

const NÅ = new Date(Date.UTC(2026, 9, 4, 10, 30, 15));
const jobb = (o = {}) => ({ id: "a1", selskap: "Aker BP", stilling: "ML Engineer", ...o });
const iv = (o = {}) => ({ id: "iv1", dato: "2026-10-08", tid: "10:00", varighet: 45, sted: "Teams", type: "video",
                          lenke: "", runde: "1. runde", notat: "", ...o });
const linjer = ics => ics.replace(/\r\n /g, "").split("\r\n");   /* brettet ut igjen */

/* Tidssonen styres her, så testene gir det samme på alle maskiner. */
function iSone(sone, fn){
  const før = process.env.TZ;
  process.env.TZ = sone;
  try{ return fn(); }finally{ if(før === undefined) delete process.env.TZ; else process.env.TZ = før; }
}

test("en hendelse har CRLF overalt, UID, DTSTAMP og en påminnelse 2 timer før", () => {
  const ics = iSone("Europe/Oslo", () => lagIcs([{ jobb: jobb(), intervju: iv() }], { nå: NÅ }));
  assert.ok(ics.endsWith("\r\n"));
  assert.equal(ics.replace(/\r\n/g, "").includes("\n"), false, "ingen løse LF");
  const l = linjer(ics);
  assert.equal(l[0], "BEGIN:VCALENDAR");
  assert.ok(l.includes("VERSION:2.0"));
  assert.ok(l.includes("UID:iv1@hired.local"));
  assert.ok(l.includes("DTSTAMP:20261004T103015Z"));
  assert.ok(l.includes("SUMMARY:Intervju: Aker BP"));
  assert.ok(l.includes("LOCATION:Teams"));
  assert.ok(l.includes("TRIGGER:-PT2H"));
  assert.ok(l.includes("DESCRIPTION:Stilling: ML Engineer\\nRunde: 1. runde"));
  assert.equal(l.filter(x => x === "BEGIN:VEVENT").length, 1);
});

test("lokal tid blir UTC, og varigheten gir slutten (standard 60 minutter)", () => {
  iSone("Europe/Oslo", () => {
    const l = linjer(lagIcs([{ jobb: jobb(), intervju: iv() }], { nå: NÅ }));
    assert.ok(l.includes("DTSTART:20261008T080000Z"), "kl. 10 CEST er 08:00Z");
    assert.ok(l.includes("DTEND:20261008T084500Z"));
    const uten = linjer(lagIcs([{ jobb: jobb(), intervju: iv({ varighet: null }) }], { nå: NÅ }));
    assert.ok(uten.includes("DTEND:20261008T090000Z"));
  });
});

test("overgangene til sommertid og vintertid gir riktig UTC-forskjell", () => {
  iSone("Europe/Oslo", () => {
    const start = dato => linjer(lagIcs([{ jobb: jobb(), intervju: iv({ dato }) }], { nå: NÅ }))
      .find(x => x.startsWith("DTSTART:"));
    assert.equal(start("2026-03-28"), "DTSTART:20260328T090000Z", "vintertid, UTC+1");
    assert.equal(start("2026-03-29"), "DTSTART:20260329T080000Z", "sommertid, UTC+2");
    assert.equal(start("2026-10-24"), "DTSTART:20261024T080000Z", "sommertid");
    assert.equal(start("2026-10-25"), "DTSTART:20261025T090000Z", "vintertid");
  });
});

test("uten klokkeslett blir det en heldagshendelse, også over månedsskiftet", () => {
  const l = linjer(lagIcs([{ jobb: jobb(), intervju: iv({ tid: null, dato: "2026-10-31" }) }], { nå: NÅ }));
  assert.ok(l.includes("DTSTART;VALUE=DATE:20261031"));
  assert.ok(l.includes("DTEND;VALUE=DATE:20261101"));
  assert.ok(l.includes("TRIGGER:-PT15H"));
});

test("sted går foran lenke som LOCATION, og lenken er reserven", () => {
  const med = o => linjer(lagIcs([{ jobb: jobb(), intervju: iv(o) }], { nå: NÅ }));
  assert.ok(med({ sted: "", lenke: "https://teams.example/møte" }).includes("LOCATION:https://teams.example/møte"));
  assert.ok(med({ sted: "Oslo", lenke: "https://x.example" }).includes("LOCATION:Oslo"));
  assert.equal(med({ sted: "", lenke: "" }).some(x => x.startsWith("LOCATION")), false);
});

test("komma, semikolon, bakslash og linjeskift escapes, og styretegn fjernes", () => {
  assert.equal(escapeTekst("a,b;c\\d\ne\r\nf\u0007g"), "a\\,b\;c\\\\d\\ne\\nfg");
  const l = linjer(lagIcs([{ jobb: jobb({ selskap: "A; B, C" }), intervju: iv({ notat: "Ta med CV\nog; kopi" }) }], { nå: NÅ }));
  assert.ok(l.includes("SUMMARY:Intervju: A\; B\\, C"));
  assert.ok(l.some(x => x.includes("Notat: Ta med CV\\nog\; kopi")));
  /* Et notat kan ikke åpne en ny egenskap med et linjeskift. */
  const ond = lagIcs([{ jobb: jobb(), intervju: iv({ notat: "x\r\nATTENDEE:mailto:a@b.no" }) }], { nå: NÅ });
  assert.equal(linjer(ond).some(x => x.startsWith("ATTENDEE")), false);
});

test("linjer brytes ved 75 oktetter, og aldri midt i et tegn", () => {
  for(const tegn of ["a", "æ", "€", "😀"]){
    const lang = "DESCRIPTION:" + tegn.repeat(120);
    const biter = brytLinje(lang).split("\r\n");
    assert.ok(biter.length > 1);
    for(const b of biter) assert.ok(new TextEncoder().encode(b).length <= 75, `${tegn}: ${b.length}`);
    assert.ok(biter.slice(1).every(b => b.startsWith(" ")));
    assert.equal(biter.map((b, i) => (i ? b.slice(1) : b)).join(""), lang, "bitene setter seg sammen igjen");
  }
  assert.equal(brytLinje("kort"), "kort");
  assert.equal(brytLinje("a".repeat(75)).includes("\r\n"), false, "nøyaktig 75 brytes ikke");
  assert.equal(brytLinje("a".repeat(76)).split("\r\n").length, 2);
});

test("flere intervjuer gir like mange hendelser, og filnavnet er trygt", () => {
  const ics = lagIcs([{ jobb: jobb(), intervju: iv() }, { jobb: jobb(), intervju: iv({ id: "iv2" }) }], { nå: NÅ });
  assert.equal(linjer(ics).filter(x => x === "BEGIN:VEVENT").length, 2);
  assert.equal(icsFilnavn({ jobb: jobb({ selskap: "A/S: Test" }), intervju: iv() }), "Intervju - A-S- Test - 2026-10-08.ics");
});
