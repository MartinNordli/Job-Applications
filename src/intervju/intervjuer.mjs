import { validerIntervju, validerIntervjuer, MAKS_INTERVJU } from "../felles/felles.mjs";
import { medStatus, lokalDato } from "../soknader/hendelser.mjs";

const STANDARD_VARIGHET = 60;
const FELT = ["dato", "tid", "varighet", "sted", "type", "lenke", "runde", "notat"];

const nyId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);
const liste = jobb => validerIntervjuer(jobb?.intervjuer);
const somDate = nå => (nå instanceof Date ? nå : new Date(nå ?? Date.now()));

const skjemafelt = inn => {
  const ut = {};
  if(inn && typeof inn === "object" && !Array.isArray(inn))
    for(const f of FELT) if(Object.hasOwn(inn, f)) ut[f] = inn[f];
  return ut;
};

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

export function slettIntervju(jobb, iid){
  const eksisterende = liste(jobb);
  const intervju = eksisterende.find(i => i.id === iid);
  if(!intervju) return { ok: false, feil: [{ felt: null, melding: "Fant ikke intervjuet." }] };
  return { ok: true, intervju, jobb: { ...jobb, intervjuer: eksisterende.filter(i => i.id !== iid) } };
}

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

export function kommende(jobb, nå = new Date()){
  const t = somDate(nå);
  return liste(jobb).filter(i => erKommende(i, t));
}
