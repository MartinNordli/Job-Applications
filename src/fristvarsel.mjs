/* ============================================================
   Fristvarsel: når en søknadsfrist skal varsles, og med hvilke ord.

   Uten filsystem og uten klokke: den som kaller sender inn dagens
   dato, søknadene, innstillingen og loggen over det som alt er
   varslet. Serveren og front-enden deler denne modulen. Rust har sin
   egen kopi av regelen i src-tauri/src/varsel.rs, fordi bakgrunns-
   jobben kjører uten JavaScript. Endres regelen eller ordene her,
   må de endres der også; testene på begge sider holder dem like.

   Intervjuvarsel (samme fil, samme loggen): ett dagen før, ved første
   sjekk etter kl. 09 lokal tid, og ett når det er mellom 0 og 180
   minutter til start. Et intervju uten klokkeslett («heldag») får bare
   det første. Loggnøkkelen ender på intervjudatoen, så ryddLogg
   fjerner den når dagen er forbi, akkurat som for frister. Klokken
   sendes inn som en Date i lokal tid, og testene deler
   testdata/varseltilfeller.json med Rust.

   Regelen: en søknad som ikke er sendt, og som har frist om mellom
   0 og `dagerFør` dager, varsles én gang. Dag 0 er med, så en Mac
   som var slått av i går likevel sier fra i dag. Loggen er nøklet
   på søknad og frist, så en flyttet frist kan varsle på nytt.

   To filer per profil, ved siden av jobber.json:
     varsel.json   innstillingen, { versjon, på, dagerFør }
     varslet.json  loggen, { "<id>|<frist>": "<tidspunkt>" }
   Innstillingen ligger på disk og ikke i nettleseren, fordi
   bakgrunnsjobben må kunne lese den når appen er lukket.
   ============================================================ */

import { ER_ARKIV, INTERVJUTYPER } from "./felles.mjs";

export const INNSTILLINGSFIL = "varsel.json";
export const LOGGFIL = "varslet.json";
/* Versjon 2 la til `intervju`. Versjon 1 leses som intervju: true. */
export const VERSJON = 2;

export const MIN_DAGER = 1;
export const MAKS_DAGER = 14;
/* Valgene flaten tilbyr. Alt mellom MIN og MAKS er gyldig på disk. */
export const DAGVALG = [1, 2, 3, 5, 7, 14];

export const standardInnstilling = () => ({ versjon: VERSJON, på: true, dagerFør: 1, intervju: true });

/* Det brukeren sender inn. Streng: en ugyldig verdi skal avvises
   med en melding, ikke stille bli noe annet. */
export function validerInnstilling(inn){
  const feil = [];
  if(!inn || typeof inn !== "object" || Array.isArray(inn))
    return { ok: false, feil: [{ felt: "innstilling", melding: "Innstillingen må være et objekt." }] };
  if(typeof inn.på !== "boolean")
    feil.push({ felt: "på", melding: "«på» må være true eller false." });
  if(!Number.isInteger(inn.dagerFør) || inn.dagerFør < MIN_DAGER || inn.dagerFør > MAKS_DAGER)
    feil.push({ felt: "dagerFør", melding: `Velg mellom ${MIN_DAGER} og ${MAKS_DAGER} dager.` });
  /* Mangler feltet (versjon 1, eldre klient), er intervjuvarsel på. */
  if(inn.intervju !== undefined && typeof inn.intervju !== "boolean")
    feil.push({ felt: "intervju", melding: "«intervju» må være true eller false." });
  if(feil.length) return { ok: false, feil };
  return { ok: true, verdi: { versjon: VERSJON, på: inn.på, dagerFør: inn.dagerFør,
                              intervju: inn.intervju ?? true } };
}

/* Det som ligger på disk. Raus: en fil som mangler eller ikke kan
   leses, gir standarden. Å slutte å varsle fordi en fil er rar, ville
   vært den verste måten å feile på. */
export function lesInnstilling(rå){
  if(rå == null || rå === "") return standardInnstilling();
  try{
    const v = validerInnstilling(JSON.parse(rå));
    return v.ok ? v.verdi : standardInnstilling();
  }catch{ return standardInnstilling(); }
}

export function lesLogg(rå){
  if(rå == null || rå === "") return {};
  try{
    const l = JSON.parse(rå);
    if(!l || typeof l !== "object" || Array.isArray(l)) return {};
    return Object.fromEntries(Object.entries(l).filter(([, v]) => typeof v === "string"));
  }catch{ return {}; }
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const dagnummer = iso => {
  const m = ISO.exec(iso);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null;
};

/* Lokal dato som ÅÅÅÅ-MM-DD. «I dag» er brukerens dag, ikke UTC sin. */
export function isoDato(d){
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0")
    + "-" + String(d.getDate()).padStart(2, "0");
}

export function dagerMellom(fraIso, tilIso){
  const a = dagnummer(fraIso), b = dagnummer(tilIso);
  return a == null || b == null ? null : b - a;
}

export const loggnøkkel = j => j.id + "|" + j.frist;

/* Søknadene som skal varsles nå, nærmeste frist først. */
export function forfalne(jobber, iDag, innstilling, logg = {}){
  if(!innstilling?.på || !Array.isArray(jobber)) return [];
  return jobber
    .filter(j => j && j.status === "todo" && typeof j.frist === "string" && typeof j.id === "string")
    .map(j => ({ jobb: j, dager: dagerMellom(iDag, j.frist), nøkkel: loggnøkkel(j) }))
    .filter(f => f.dager != null && f.dager >= 0 && f.dager <= innstilling.dagerFør
                 && !Object.hasOwn(logg, f.nøkkel))
    .sort((a, b) => a.dager - b.dager || String(a.jobb.selskap).localeCompare(String(b.jobb.selskap), "no"));
}

/* ---------- intervjuer ---------- */

const MIN_FØR_TIMER = 180;
const FØRSTE_TIME = 9;
const MIN_TID = /^(\d{2}):(\d{2})$/;

const intervjuTekst = (jobb, iv, når) => {
  const sted = String(iv.sted || "").trim() || INTERVJUTYPER[iv.type] || "";
  return [String(jobb.stilling || "").trim(), når, sted].filter(Boolean).join(" · ");
};

function omTid(min){
  if(min < 60) return `om ${min} min`;
  const t = Math.floor(min / 60), r = min % 60;
  return r ? `om ${t} t ${r} min` : t === 1 ? "om 1 time" : `om ${t} timer`;
}

/* Intervjuene som skal varsles nå, tidligst først. `nå` er en Date;
   dag og klokkeslett leses i lokal tid, fordi «kl. 09» og «i morgen»
   er det brukeren ser på klokken. Et intervju på en arkivert søknad
   varsles ikke, men status ellers er likegyldig: et intervju er et
   intervju også om søknaden står på «sendt». */
export function intervjuvarsler(jobber, nå, innstilling, logg = {}){
  if(!innstilling?.på || innstilling.intervju === false || !Array.isArray(jobber)) return [];
  const iDag = isoDato(nå);
  const ut = [];
  for(const j of jobber){
    if(!j || typeof j.id !== "string" || ER_ARKIV(j.status) || !Array.isArray(j.intervjuer)) continue;
    for(const iv of j.intervjuer){
      if(!iv || typeof iv.id !== "string" || !ISO.test(iv.dato)) continue;
      const tid = MIN_TID.exec(iv.tid ?? "");
      const hhmm = tid ? tid[1] + tid[2] : "heldag";
      const start = tid ? new Date(+iv.dato.slice(0, 4), +iv.dato.slice(5, 7) - 1, +iv.dato.slice(8, 10), +tid[1], +tid[2]) : null;
      const rad = (type, tittel, når) => ({
        nøkkel: `intervju:${j.id}:${iv.id}:${hhmm}:${type}|${iv.dato}`,
        id: j.id, iid: iv.id, art: "intervju", type,
        tittel: tittel + ": " + String(j.selskap || "").trim(),
        tekst: intervjuTekst(j, iv, når),
        start: start ? start.getTime() : Date.parse(iv.dato + "T00:00:00Z")
      });
      const når = tid ? "kl. " + iv.tid : "hele dagen";
      if(dagerMellom(iDag, iv.dato) === 1 && nå.getHours() >= FØRSTE_TIME)
        ut.push(rad("dag", "Intervju i morgen", når));
      if(start){
        const sek = (start.getTime() - nå.getTime()) / 1000;
        if(sek > 0 && sek <= MIN_FØR_TIMER * 60)
          ut.push(rad("timer", "Intervju " + omTid(Math.ceil(sek / 60)), når));
      }
    }
  }
  return ut.filter(v => !Object.hasOwn(logg, v.nøkkel))
           .sort((a, b) => a.start - b.start || a.tittel.localeCompare(b.tittel, "no"))
           .map(({ start, ...v }) => v);
}

/* Rader for frister som er passert, trengs ikke lenger. */
export function ryddLogg(logg, iDag){
  return Object.fromEntries(Object.entries(logg).filter(([n]) => {
    const d = dagerMellom(iDag, n.slice(n.lastIndexOf("|") + 1));
    return d != null && d >= 0;
  }));
}

const UKEDAGER = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
const MÅNEDER = ["januar", "februar", "mars", "april", "mai", "juni", "juli",
                 "august", "september", "oktober", "november", "desember"];

export function varseltekst(jobb, dager){
  const når = dager === 0 ? "Frist i dag" : dager === 1 ? "Frist i morgen" : `Frist om ${dager} dager`;
  const m = ISO.exec(jobb.frist);
  const dato = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const lang = UKEDAGER[dato.getUTCDay()] + " " + dato.getUTCDate() + ". " + MÅNEDER[dato.getUTCMonth()];
  const stilling = String(jobb.stilling || "").trim();
  return {
    tittel: når + ": " + String(jobb.selskap || "").trim(),
    tekst: (stilling ? stilling + " · s" : "S") + "øknadsfristen er " + lang + "."
  };
}

/* Hele runden for én profil, uten I/O: hva som skal varsles, og
   loggen slik den skal skrives etterpå. `nå` er en Date (lokal tid
   avgjør dag og klokkeslett) eller et ISO-tidspunkt; `iDag` utledes
   av den hvis den ikke er gitt. */
export function runde({ jobber, iDag, innstilling, logg, nå }){
  const tid = nå instanceof Date ? nå : new Date(nå ?? Date.now());
  const dag = iDag ?? isoDato(tid);
  const stempel = typeof nå === "string" ? nå : tid.toISOString();
  const frister = forfalne(jobber, dag, innstilling, logg);
  const intervjuer = intervjuvarsler(jobber, tid, innstilling, logg);
  const nyLogg = ryddLogg({ ...logg }, dag);
  for(const f of frister) nyLogg[f.nøkkel] = stempel;
  for(const v of intervjuer) nyLogg[v.nøkkel] = stempel;
  return {
    varsler: [
      ...frister.map(f => ({ id: f.jobb.id, art: "frist", dager: f.dager, ...varseltekst(f.jobb, f.dager) })),
      ...intervjuer.map(({ nøkkel, ...v }) => v)
    ],
    logg: nyLogg
  };
}
