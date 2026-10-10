/* ============================================================
   Intervjuer på en søknad, uten I/O.

   Intervjuene ligger på selve raden (`jobb.intervjuer`), fordi de er
   små og fordi bakgrunnsjobben i Rust må lese dem for å varsle. Denne
   modulen er det eneste stedet reglene for å legge inn, endre og slette
   ett intervju står, så skjemaet og alt som kommer senere gjør det likt.

   Alle funksjonene er rene: de tar en søknad og gir en ny, og skriver
   ingenting. Flaten lagrer resultatet på vanlig måte.

   Å legge inn et intervju på en søknad som står på «todo» eller «sent»
   flytter den til «interview», via medStatus, så hendelsesloggen får
   sitt steg. Resultatet bærer med seg søknaden slik den var (`før`), så
   flaten kan tilby angre uten å regne seg tilbake. En søknad som alt er
   på «interview», eller som er avgjort, beholder statusen sin.

   Klokken sendes inn (`iDag`, `nå`) som i hendelser.mjs, så testene
   styrer den. «Kommende» regnes i lokal tid: et intervju er kommende til
   det er slutt (start pluss varighet, 60 minutter om varigheten mangler),
   og et intervju uten klokkeslett til dagen er omme.
   ============================================================ */

import { validerIntervju, validerIntervjuer, MAKS_INTERVJU, ER_ARKIV } from "./felles.mjs";
import { medStatus, lokalDato } from "./hendelser.mjs";

const STANDARD_VARIGHET = 60;
const FELT = ["dato", "tid", "varighet", "sted", "type", "lenke", "runde", "notat"];

const nyId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);
const liste = jobb => validerIntervjuer(jobb?.intervjuer);
const somDate = nå => (nå instanceof Date ? nå : new Date(nå ?? Date.now()));

/* Bare de feltene skjemaet eier. Ukjente felt og en annen id slipper
   ikke gjennom, så et intervju aldri skifter identitet. */
const skjemafelt = inn => {
  const ut = {};
  if(inn && typeof inn === "object" && !Array.isArray(inn))
    for(const f of FELT) if(Object.hasOwn(inn, f)) ut[f] = inn[f];
  return ut;
};

/* { ok: true, jobb, intervju, før, statusEndret } | { ok: false, feil } */
export function nyttIntervju(jobb, inn, valg = {}){
  const eksisterende = liste(jobb);
  if(eksisterende.length >= MAKS_INTERVJU.antall)
    return { ok: false, feil: [{ felt: null, melding: `Du kan ha opptil ${MAKS_INTERVJU.antall} intervjuer på én søknad.` }] };

  const lagId = valg.lagId ?? nyId;
  const r = validerIntervju({ ...skjemafelt(inn), id: lagId() });
  if(!r.ok) return { ok: false, feil: r.feil };

  const medIntervju = { ...jobb, intervjuer: validerIntervjuer([...eksisterende, r.verdi]) };
  const flytt = jobb.status === "todo" || jobb.status === "sent";
  const ny = flytt ? medStatus(medIntervju, "interview", valg) : medIntervju;
  return { ok: true, jobb: ny, intervju: r.verdi, før: jobb, statusEndret: flytt };
}

/* { ok: true, jobb, intervju } | { ok: false, feil }. Statusen røres ikke. */
export function endreIntervju(jobb, iid, endringer){
  const eksisterende = liste(jobb);
  const nå = eksisterende.find(i => i.id === iid);
  if(!nå) return { ok: false, feil: [{ felt: null, melding: "Fant ikke intervjuet." }] };
  const r = validerIntervju({ ...nå, ...skjemafelt(endringer), id: iid });
  if(!r.ok) return { ok: false, feil: r.feil };
  return {
    ok: true, intervju: r.verdi,
    jobb: { ...jobb, intervjuer: validerIntervjuer(eksisterende.map(i => (i.id === iid ? r.verdi : i))) }
  };
}

/* { ok: true, jobb, intervju } | { ok: false, feil }. Forberedelsen
   hører til jobbdokumentet og slettes derfra (slettForberedelse). */
export function slettIntervju(jobb, iid){
  const eksisterende = liste(jobb);
  const intervju = eksisterende.find(i => i.id === iid);
  if(!intervju) return { ok: false, feil: [{ felt: null, melding: "Fant ikke intervjuet." }] };
  return { ok: true, intervju, jobb: { ...jobb, intervjuer: eksisterende.filter(i => i.id !== iid) } };
}

/* Starttidspunktet i lokal tid; null for et intervju uten klokkeslett. */
export function starttid(intervju){
  if(!intervju?.tid) return null;
  const [å, m, d] = intervju.dato.split("-").map(Number);
  const [t, min] = intervju.tid.split(":").map(Number);
  return new Date(å, m - 1, d, t, min);
}

function erKommende(intervju, nå){
  const start = starttid(intervju);
  if(!start) return intervju.dato >= lokalDato(nå);
  return start.getTime() + (intervju.varighet ?? STANDARD_VARIGHET) * 60000 > nå.getTime();
}

/* Intervjuene som ikke er over, tidligst først. */
export function kommende(jobb, nå = new Date()){
  const t = somDate(nå);
  return liste(jobb).filter(i => erKommende(i, t));
}

/* Det nærmeste intervjuet på tvers av søknader, uten de arkiverte:
   { jobb, intervju } eller null. Gir «neste intervju» i oversikten. */
export function nesteIntervju(jobber, nå = new Date()){
  let beste = null;
  const nøkkel = i => (starttid(i) ?? new Date(+i.dato.slice(0, 4), +i.dato.slice(5, 7) - 1, +i.dato.slice(8, 10))).getTime();
  for(const jobb of Array.isArray(jobber) ? jobber : []){
    if(!jobb || ER_ARKIV(jobb.status)) continue;
    const i = kommende(jobb, nå)[0];
    if(i && (!beste || nøkkel(i) < nøkkel(beste.intervju))) beste = { jobb, intervju: i };
  }
  return beste;
}
