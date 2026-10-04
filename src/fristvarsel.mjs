/* ============================================================
   Fristvarsel: når en søknadsfrist skal varsles, og med hvilke ord.

   Uten filsystem og uten klokke: den som kaller sender inn dagens
   dato, søknadene, innstillingen og loggen over det som alt er
   varslet. Serveren og front-enden deler denne modulen. Rust har sin
   egen kopi av regelen i src-tauri/src/varsel.rs, fordi bakgrunns-
   jobben kjører uten JavaScript. Endres regelen eller ordene her,
   må de endres der også; testene på begge sider holder dem like.

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

export const INNSTILLINGSFIL = "varsel.json";
export const LOGGFIL = "varslet.json";
export const VERSJON = 1;

export const MIN_DAGER = 1;
export const MAKS_DAGER = 14;
/* Valgene flaten tilbyr. Alt mellom MIN og MAKS er gyldig på disk. */
export const DAGVALG = [1, 2, 3, 5, 7, 14];

export const standardInnstilling = () => ({ versjon: VERSJON, på: true, dagerFør: 1 });

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
  if(feil.length) return { ok: false, feil };
  return { ok: true, verdi: { versjon: VERSJON, på: inn.på, dagerFør: inn.dagerFør } };
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
   loggen slik den skal skrives etterpå. */
export function runde({ jobber, iDag, innstilling, logg, nå }){
  const liste = forfalne(jobber, iDag, innstilling, logg);
  const nyLogg = ryddLogg({ ...logg }, iDag);
  for(const f of liste) nyLogg[f.nøkkel] = nå;
  return {
    varsler: liste.map(f => ({ id: f.jobb.id, dager: f.dager, ...varseltekst(f.jobb, f.dager) })),
    logg: nyLogg
  };
}
