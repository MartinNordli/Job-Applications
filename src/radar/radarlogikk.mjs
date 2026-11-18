import { normaliserLenke } from "../import/importlogikk.mjs";
import { sjekkSchema } from "../brev/brevlogikk.mjs";
import { lokalDato, lagHendelse } from "../soknader/hendelser.mjs";
import { Brevfeil } from "../dokumenter/dokumentfeil.mjs";
import { RADAR, validerRadar } from "../stilling/jobbdokument.mjs";
import { KURS } from "../import/importlogg.mjs";
import { KILDER, GRENSER, sov, rensLinje, oppdagType, oppdagTypeFraSide, karriereadresse, tolkJsonLd } from "./radarkilder.mjs";
import { RADAR_PROMPTVERSJON, VURDERINGSSKJEMA, FORSLAGSSKJEMA, FORSLAG_GRENSER, radarForespørsel, forslagForespørsel } from "./radarprompt.mjs";

const KARRIEREINTERVALL = 6 * 3600_000;
const LEIETID = 15 * 60_000;
export const BOLK = 8;
const MAKS_VURDERINGER_PER_KJORING = 40;
const SETT_DAGER = 200;
const AVVIST_DAGER = 365;
const UNDER_DAGER = 30;
const KO_DAGER = 30;
const KO_FORSOK = 3;
const TAK_FOR_LAGRING = 3.5 * 1024 * 1024;
export const MAKS_VARSEL = 240;

const DAG = 86_400_000;
const RADARFIL = "radar.json";
const kortTekst = (t, n = RADAR.tekst) => Array.from(String(t ?? "")).slice(0, n).join("");

function brett(v){
  return String(v ?? "").normalize("NFKC").toLocaleLowerCase("nb")
    .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")
    .normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/aa/g, "a")
    .replace(/\s+/gu, " ").trim();
}

function trefferBrettet(t, o){
  if(!o) return false;
  if(o.length > 3) return t.includes(o);
  const m = new RegExp(`(^|[^\\p{L}\\p{N}])${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u");
  return m.test(t);
}
export const ordTreffer = (tekst, ord) => trefferBrettet(brett(tekst), brett(ord));
const noenTreffer = (tekst, ord) => { const t = brett(tekst); return ord.some(o => trefferBrettet(t, brett(o))); };

export function forfilter(k, innstillinger, iDag){
  if(k.status !== "aktiv") return "inaktiv";
  if(k.frist && k.frist < iDag) return "frist";
  const inn = innstillinger ?? {};
  if(inn.sokeord?.length && !noenTreffer(`${k.stilling}\n${k.tekst}`, inn.sokeord)) return "sokeord";
  if(inn.ekskluder?.length && noenTreffer(`${k.stilling}\n${k.selskap}`, inn.ekskluder)) return "ekskludert";
  if(inn.steder?.length && k.sted && !noenTreffer(k.sted, inn.steder)) return "sted";
  return null;
}

const SELSKAPSFORM = new Set(["as", "asa", "ab", "gmbh", "sa", "ltd", "inc", "plc", "llc", "ans", "da", "hf", "iks", "kf"]);
const TEGN = /[\p{P}\p{S}]+/gu;

export function fingeravtrykk(selskap, stilling){
  const s = brett(selskap).replace(TEGN, " ").split(" ").filter(o => o && !SELSKAPSFORM.has(o)).join(" ");
  const t = brett(stilling).replace(TEGN, " ").replace(/\s+/g, " ").trim();
  if(!s || !t) return null;
  return `${s}|${t}`.slice(0, RADAR.fingeravtrykk);
}

function jobbnorgeId(url){
  let u;
  try{ u = new URL(String(url ?? "")); }catch{ return null; }
  const vert = u.hostname.toLowerCase().replace(/^www\./, "");
  const m = vert === "jobbnorge.no" ? u.pathname.match(/\/stilling\/(\d{1,12})(?:\/|$)/)
    : vert === "jobseeker.jobbnorge.no" ? u.pathname.match(/^\/apply\/(\d{1,12})(?:\/|$)/) : null;
  return m ? m[1] : null;
}

export function nøklerFor(k){
  const jn = k.kilde === "jobbnorge" ? k.kildeId : (k.lenker ?? []).map(jobbnorgeId).find(Boolean);
  const ut = [];
  if(jn) ut.push(`jobbnorge:${jn}`);
  ut.push(`${k.kilde}:${k.kildeId}`);
  for(const l of k.lenker ?? []){ const n = normaliserLenke(l); if(n) ut.push(n); }
  return [...new Set(ut)];
}
const lagringsnøkler = k => nøklerFor(k).slice(0, RADAR.nokler);

export function hukommelse(radar, jobber = []){
  const nøkler = new Set(), avtrykk = new Set();
  for(const j of Array.isArray(jobber) ? jobber : []){
    const n = normaliserLenke(j?.lenke);
    if(n) nøkler.add(n);
    const jn = jobbnorgeId(j?.lenke);
    if(jn) nøkler.add(`jobbnorge:${jn}`);
    const f = fingeravtrykk(j?.selskap, j?.stilling);
    if(f) avtrykk.add(f);
  }
  const nåværende = r => r.promptversjon === RADAR_PROMPTVERSJON;
  for(const r of [...(radar?.sett ?? []).filter(nåværende), ...(radar?.under ?? []).filter(nåværende),
    ...(radar?.avvist ?? []), ...(radar?.innboks ?? [])]){
    for(const n of r.nokler ?? []) nøkler.add(n);
    if(r.id) nøkler.add(r.id);
    if(r.fingeravtrykk) avtrykk.add(r.fingeravtrykk);
  }
  for(const r of radar?.avvistFingeravtrykk ?? []) avtrykk.add(r.fingeravtrykk);
  return {
    kjenner(k){
      if(nøklerFor(k).some(n => nøkler.has(n))) return true;
      const f = fingeravtrykk(k.selskap, k.stilling);
      return !!f && avtrykk.has(f);
    },
    husk(k){
      for(const n of nøklerFor(k)) nøkler.add(n);
      const f = fingeravtrykk(k.selskap, k.stilling);
      if(f) avtrykk.add(f);
    }
  };
}

function formatfeil(melding){
  const e = new Error(melding); e.code = "modellformat"; e.navn = "modellformat"; e.melding = melding; e.status = 502; return e;
}

const LENKE = /https?:\/\/|\bwww\.|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+\.[\p{L}]{2,}/iu;

export function tolkVurdering(data, ids){
  sjekkSchema(data, VURDERINGSSKJEMA, "vurderingen");
  const lov = new Set(ids), per = new Map();
  for(const v of data.vurderinger){
    if(!lov.has(v.id) || per.has(v.id)) throw formatfeil("Modellen svarte for en annonse den ikke fikk.");
    if(!Number.isFinite(v.prosent) || v.prosent < 0 || v.prosent > 100) throw formatfeil("Modellen ga en prosent utenfor 0 til 100.");
    if(v.grunner.length > RADAR.grunner) throw formatfeil("Modellen ga flere enn tre grunner.");
    const grunner = v.grunner.map(g => rensLinje(g, RADAR.grunn + 1));
    if(grunner.some(g => !g || Array.from(g).length > RADAR.grunn)) throw formatfeil("Modellen ga en tom eller for lang grunn.");
    if(grunner.some(g => LENKE.test(g))) throw formatfeil("Modellen gjentok en lenke eller en adresse fra en annonse.");
    per.set(v.id, { id: v.id, prosent: Math.round(v.prosent), grunner });
  }
  if(per.size !== lov.size) throw formatfeil("Modellen hoppet over en annonse.");
  return ids.map(id => per.get(id));
}

const BRUKSFELT = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
function leggTilBruk(sum, bruk){
  if(!bruk || typeof bruk !== "object") return sum;
  const ut = { ...(sum ?? {}) };
  for(const k of BRUKSFELT) if(Number.isSafeInteger(bruk[k]) && bruk[k] >= 0) ut[k] = (ut[k] ?? 0) + bruk[k];
  return Object.keys(ut).length ? ut : sum;
}

export async function vurderAlle({ kandidater, cv, kallModell, leverandor = "anthropic", tak, signal }){
  const valgt = kandidater.slice(0, Math.max(0, tak));
  const vurdert = [], forkastet = [];
  let bruk = null, sendt = 0, feil = null;
  for(let i = 0; i < valgt.length; i += BOLK){
    const bolk = valgt.slice(i, i + BOLK);
    const ids = bolk.map((_, j) => `a${j + 1}`);
    const annonser = bolk.map((k, j) => ({ id: ids[j], stilling: k.stilling, selskap: k.selskap, sted: k.sted,
      frist: k.frist, tekst: kortTekst(k.tekst) }));
    let svar;
    try{
      if(signal?.aborted) throw new Error("Kjøringen ble avbrutt.");
      svar = await kallModell({ ...radarForespørsel({ cv, annonser, leverandor }), signal });
    }catch(e){ feil = e; break; }
    sendt += bolk.length;
    bruk = leggTilBruk(bruk, svar?.bruk);
    try{
      tolkVurdering(svar?.data, ids).forEach((v, j) => vurdert.push({ k: bolk[j], v }));
    }catch(e){
      forkastet.push({ antall: bolk.length, melding: e?.melding || e?.message });
    }
  }
  return { vurdert, forkastet, sendt, utenVurdering: kandidater.length - valgt.length, bruk, feil };
}

const FORSLAGSTEGN = /^[\p{L}\p{N}.][\p{L}\p{N} .+#&/-]*$/u;
const STEDSTEGN = /^\p{L}[\p{L} -]*$/u;
function forslagsord(v, tegn = FORSLAGSTEGN){
  if(typeof v !== "string") return null;
  const t = rensLinje(v, 200).replace(/^["'«»“”‘’]+|["'«»“”‘’,;:!?]+$/gu, "").replace(/\.+$/u, "").trim();
  if(!t || Array.from(t).length > FORSLAG_GRENSER.tegn || t.split(" ").length > FORSLAG_GRENSER.ord) return null;
  if(!tegn.test(t) || !/\p{L}/u.test(t) || brett(t).length < 2) return null;
  if(/(^|\s)www\.|[\p{L}\p{N}]\.(no|com|org|se|dk)$/iu.test(t)) return null;
  return t;
}
function unikeOrd(liste, tegn, maks){
  const sett = new Set(), ut = [];
  for(const v of liste.slice(0, 40)){
    const t = forslagsord(v, tegn);
    if(!t || sett.has(brett(t))) continue;
    sett.add(brett(t)); ut.push(t);
  }
  return ut.slice(0, maks);
}

export function tolkForslag(data, { cv }){
  try{ sjekkSchema(data, FORSLAGSSKJEMA, "forslaget"); }
  catch(e){ throw formatfeil(e?.melding || "Modellen svarte i feil format. Prøv igjen."); }
  const G = FORSLAG_GRENSER;
  const sokeord = unikeOrd(data.sokeord, FORSLAGSTEGN, G.sokeord);
  const steder = unikeOrd(data.steder, STEDSTEGN, Infinity).filter(s => ordTreffer(cv, s)).slice(0, G.steder);
  const ekskluder = unikeOrd(data.ekskluder, FORSLAGSTEGN, Infinity)
    .filter(e => !sokeord.some(s => ordTreffer(s, e) || brett(s) === brett(e))).slice(0, G.ekskluder);
  return { sokeord, steder, ekskluder };
}

export async function foreslåFraCv({ cv, kallModell, leverandor = "anthropic", signal }){
  const tekst = String(cv ?? "").trim();
  if(!tekst) throw new Brevfeil("mangler-cv", "Legg inn CV-en din, så kan Radar foreslå søkeord.", 409);
  const svar = await kallModell({ ...forslagForespørsel({ cv: tekst, leverandor }), signal });
  return tolkForslag(svar?.data, { cv: tekst });
}

export const FORSLAG_TAK = Object.freeze({ tak: 10, vindu: 3600_000 });
const forslagskall = new WeakMap();
export async function foreslåFraProfil({ dokumenter, kallModell, leverandor = "anthropic", nå = () => new Date(), signal }){
  const t = nå().getTime();
  const kall = (forslagskall.get(dokumenter) ?? []).filter(x => t - x < FORSLAG_TAK.vindu);
  if(kall.length >= FORSLAG_TAK.tak){
    const min = Math.max(1, Math.ceil((FORSLAG_TAK.vindu - (t - kall[0])) / 60_000));
    throw new Brevfeil("for-mange", `Du har bedt om mange forslag den siste timen. Prøv igjen om ${min} minutter.`, 429);
  }
  kall.push(t);
  forslagskall.set(dokumenter, kall);
  try{
    const cv = (await dokumenter.les("cv.json"))?.tekst;
    return await foreslåFraCv({ cv, kallModell, leverandor, signal });
  }catch(e){
    const kode = e?.code ?? e?.navn;
    if(kode === "mangler-cv" || kode === "mangler-nokkel"){ const i = kall.indexOf(t); if(i >= 0) kall.splice(i, 1); }
    throw e;
  }
}

export function innboksrad(k, v, nå){
  const n = lagringsnøkler(k);
  return { id: n[0], kilde: k.kilde, kildeId: k.kildeId, url: k.url, lenker: k.lenker, selskap: k.selskap,
    stilling: k.stilling, sted: k.sted, frist: k.frist, publisert: k.publisert,
    tekst: kortTekst(k.tekst), prosent: v.prosent, grunner: v.grunner,
    status: "ny", funnet: new Date(nå).toISOString(), nokler: n, fingeravtrykk: fingeravtrykk(k.selskap, k.stilling),
    promptversjon: RADAR_PROMPTVERSJON };
}

function slåInnIUnder(under, nye){
  const ny = new Set(nye.map(r => r.id));
  return [...nye, ...under.filter(r => !ny.has(r.id))]
    .sort((a, b) => (a.funnet < b.funnet ? 1 : a.funnet > b.funnet ? -1 : 0)).slice(0, RADAR.under);
}

function flyttVedTerskel(radar, terskel){
  const opp = radar.under.filter(r => r.prosent >= terskel);
  const ned = radar.innboks.filter(r => r.status === "ny" && r.prosent < terskel);
  if(!opp.length && !ned.length) return radar;
  const nedId = new Set(ned.map(r => r.id)), oppId = new Set(opp.map(r => r.id));
  return { ...radar,
    innboks: slåInnIInnboks(radar.innboks.filter(r => !nedId.has(r.id)), opp.map(r => ({ ...r, status: "ny" }))),
    under: slåInnIUnder(radar.under.filter(r => !oppId.has(r.id)), ned.map(r => ({ ...r, status: "ny" }))) };
}

function slåInnIInnboks(innboks, nye){
  const finnes = new Set(innboks.map(r => r.id));
  let ut = [...nye.filter(r => !finnes.has(r.id)), ...innboks];
  ut = [...new Map(ut.map(r => [r.id, r])).values()];
  while(ut.length > RADAR.innboks){
    let i = ut.findLastIndex(r => r.status === "lagtTil");
    if(i < 0) i = ut.length - 1;
    ut.splice(i, 1);
  }
  return ut;
}

function fjernInaktive(innboks, nøkler){
  const n = new Set(nøkler);
  if(!n.size) return innboks;
  return innboks.filter(r => !n.has(r.id) && !(r.nokler ?? []).some(x => n.has(x)));
}

function avvis(radar, id, nå){
  const rad = radar.innboks.find(r => r.id === id) ?? radar.under.find(r => r.id === id);
  if(!rad) return radar;
  const dato = lokalDato(new Date(nå));
  return { ...radar,
    innboks: radar.innboks.filter(r => r.id !== id),
    under: radar.under.filter(r => r.id !== id),
    avvist: [{ nokler: rad.nokler.length ? rad.nokler : [rad.id], dato }, ...radar.avvist],
    avvistFingeravtrykk: rad.fingeravtrykk && !radar.avvistFingeravtrykk.some(a => a.fingeravtrykk === rad.fingeravtrykk)
      ? [{ fingeravtrykk: rad.fingeravtrykk, dato }, ...radar.avvistFingeravtrykk] : radar.avvistFingeravtrykk };
}

export function rydd(radar, nå){
  const grense = dager => lokalDato(new Date(new Date(nå).getTime() - dager * DAG));
  const sett = grense(SETT_DAGER), avvist = grense(AVVIST_DAGER);
  const underFra = new Date(new Date(nå).getTime() - UNDER_DAGER * DAG).toISOString();
  const nyestFørst = (a, b) => (a.dato < b.dato ? 1 : a.dato > b.dato ? -1 : 0);
  return { ...radar,
    under: radar.under.filter(r => (r.funnet ?? "") >= underFra).slice(0, RADAR.under),
    sett: radar.sett.filter(r => r.dato >= sett).sort(nyestFørst).slice(0, RADAR.sett),
    avvist: radar.avvist.filter(r => r.dato >= avvist).sort(nyestFørst).slice(0, RADAR.avvist),
    avvistFingeravtrykk: radar.avvistFingeravtrykk.filter(r => r.dato >= avvist).sort(nyestFørst).slice(0, RADAR.avvistFingeravtrykk) };
}

const størrelse = d => new TextEncoder().encode(JSON.stringify(d, null, 2)).byteLength;
export function holdUnderTak(radar, tak = TAK_FOR_LAGRING){
  let d = radar;
  for(const felt of ["under", "sett", "avvist", "avvistFingeravtrykk"]){
    while(størrelse(d) > tak && d[felt].length){
      d = { ...d, [felt]: d[felt].slice(0, Math.floor(d[felt].length * 0.9)) };
    }
  }
  return d;
}

const erKonflikt = e => e?.code === "konflikt" || e?.status === 409;

async function medNyeForsøk(dokumenter, endre, forsøk = 5){
  for(let i = 0; i < forsøk; i++){
    const før = await dokumenter.les(RADARFIL);
    const neste = endre(før);
    if(neste === null) return null;
    try{ return await dokumenter.skriv(RADARFIL, neste, før.revisjon); }
    catch(e){ if(!erKonflikt(e)) throw e; }
  }
  return null;
}

const leieGyldig = (leie, nå) => !!leie && Date.parse(leie.utloper) > new Date(nå).getTime();
const utloper = (nå, varighet) => new Date(new Date(nå).getTime() + varighet).toISOString();

function taLeie(dokumenter, { eier, nå, varighet = LEIETID }){
  return medNyeForsøk(dokumenter, d =>
    leieGyldig(d.leie, nå) && d.leie.eier !== eier ? null : { ...d, leie: { eier, utloper: utloper(nå, varighet) } });
}
function fornyLeie(dokumenter, { eier, nå, varighet = LEIETID }){
  return medNyeForsøk(dokumenter, d =>
    d.leie?.eier !== eier ? null : { ...d, leie: { eier, utloper: utloper(nå, varighet) } });
}
function slippLeie(dokumenter, { eier }){
  return medNyeForsøk(dokumenter, d => d.leie?.eier !== eier ? null : { ...d, leie: null });
}

export function varseltekst(treff, maks = MAKS_VARSEL){
  if(!treff?.length) return null;
  const sortert = [...treff].sort((a, b) => b.prosent - a.prosent);
  const hode = sortert.length === 1 ? "1 ny stilling passer" : `${sortert.length} nye stillinger passer`;
  const deler = sortert.map(t => `${[rensLinje(t.selskap, 80), rensLinje(t.stilling, 120)].filter(Boolean).join(", ")} (${t.prosent} %)`);
  const tekst = [hode, ...deler].join(" · ");
  const tegn = Array.from(tekst);
  return tegn.length > maks ? tegn.slice(0, maks - 1).join("").trimEnd() + "…" : tekst;
}

const SOK = Object.freeze({ versjon: 1, jobbnorgeIntervall: DAG, navForeldet: 3 * DAG });

function fnv(tekst){
  let h = 0x811c9dc5;
  for(const b of new TextEncoder().encode(tekst)){ h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

export function søkeavtrykk(kilde, inn){
  const liste = v => [...new Set((Array.isArray(v) ? v : []).map(brett).filter(Boolean))].sort();
  const del = { v: SOK.versjon, p: RADAR_PROMPTVERSJON, sokeord: liste(inn?.sokeord), ekskluder: liste(inn?.ekskluder), steder: liste(inn?.steder) };
  if(kilde === "jobbnorge") del.fylker = [...new Set(inn?.kilder?.jobbnorge?.fylker ?? [])].sort((a, b) => a - b);
  return `${kilde}-${fnv(JSON.stringify(del))}`;
}

export function skalSøke(kilde, tilstand, inn, nå){
  if(!inn?.sokeord?.length) return false;
  const t = tilstand ?? {}, n = new Date(nå).getTime();
  if(t.sokAvtrykk !== søkeavtrykk(kilde, inn) || !t.sokFerdig) return true;
  if(kilde === "jobbnorge") return n - Date.parse(t.sokFerdig) >= SOK.jobbnorgeIntervall;
  return !t.sist || n - Date.parse(t.sist) >= SOK.navForeldet;
}

const KOKILDER = new Set(["nav", "jobbnorge"]);
const koId = k => `${k.kilde}:${k.kildeId}`;

function korad(k, { dato, forsok = 0 }){
  return { kilde: k.kilde, kildeId: k.kildeId, url: k.url, lenker: k.lenker, selskap: k.selskap, stilling: k.stilling,
    sted: k.sted, frist: k.frist, publisert: k.publisert, tekst: kortTekst(k.tekst, RADAR.koTekst), dato, forsok };
}
const fraKo = r => ({ kilde: r.kilde, kildeId: r.kildeId, url: r.url, lenker: r.lenker, selskap: r.selskap, stilling: r.stilling,
  sted: r.sted, frist: r.frist, publisert: r.publisert, tekst: r.tekst, status: "aktiv", detaljert: false });

const melding = e => rensLinje(e?.melding || e?.message || String(e ?? "Ukjent feil."), RADAR.melding);
const skalHentes = (side, nå) => side.pa && (!side.sist || new Date(nå).getTime() - Date.parse(side.sist) >= KARRIEREINTERVALL);
const nyEier = () => `radar:${globalThis.crypto.randomUUID()}`;
const avbrutt = signal => { if(signal?.aborted) throw new Error("Kjøringen ble avbrutt."); };

const KILDENAVN = { nav: "NAV", jobbnorge: "Jobbnorge" };
const kildejobb = (nøkkel, kilder) => ({ nøkkel, kilde: kilder[nøkkel], navn: KILDENAVN[nøkkel] });
function kildejobber(radar, kilder, nå){
  const inn = radar.innstillinger, ut = [];
  for(const nøkkel of ["nav", "jobbnorge"]){
    if(!inn.kilder[nøkkel].pa) continue;
    const tilstand = radar.kildetilstand[nøkkel], j = kildejobb(nøkkel, kilder);
    ut.push({ ...j, tilstand, søk: !!j.kilde.søk && skalSøke(nøkkel, tilstand, inn, nå), avtrykk: søkeavtrykk(nøkkel, inn) });
  }
  for(const side of inn.karrieresider)
    if(skalHentes(side, nå) && kilder[side.type]) ut.push({ nøkkel: side.id, kilde: kilder[side.type], navn: side.navn || side.url, side });
  return ut;
}

function nyKildetilstand(gammel, utfall, gjelder, stempel){
  if(!utfall) return gammel;
  if(!gjelder || !utfall.tilstand) return utfall.feil ? { ...gammel, sist: stempel, feil: utfall.feil } : gammel;
  return { ...gammel, ...utfall.tilstand, sist: stempel, feil: utfall.feil ?? null };
}
function nySide(side, utfall, pekereGjelder, stempel){
  if(!utfall) return side;
  if(!utfall.feil) return pekereGjelder ? { ...side, sist: stempel, feilRad: 0, grunn: null } : side;
  const feilRad = side.feilRad + 1;
  return feilRad >= RADAR.feilRad
    ? { ...side, sist: stempel, feilRad, pa: false, grunn: rensLinje(`Slått av etter ${RADAR.feilRad} feil på rad: ${utfall.feil}`, RADAR.melding) }
    : { ...side, sist: stempel, feilRad, grunn: utfall.feil };
}

export async function kjørRadar({ dokumenter, jobber = [], nett, kallModell, leverandor = "anthropic",
  nå = () => new Date(), signal, vent = ms => sov(ms, signal), eier = nyEier(), kilder = KILDER, varighet = LEIETID } = {}){
  const start = nå(), stempel = start.toISOString(), iDag = lokalDato(start);

  const første = await dokumenter.les(RADARFIL);
  if(!første.innstillinger.pa) return { kjort: false, grunn: "av" };
  const leid = await taLeie(dokumenter, { eier, nå: start, varighet });
  if(!leid) return { kjort: false, grunn: "opptatt" };

  let fornyet = start.getTime();
  const hold = async () => {
    if(nå().getTime() - fornyet < varighet / 2) return;
    if(!await fornyLeie(dokumenter, { eier, nå: nå(), varighet })) throw new Error("En annen kjøring tok over.");
    fornyet = nå().getTime();
  };

  const inn = leid.innstillinger;
  const logg = { start: stempel, slutt: null, promptversjon: RADAR_PROMPTVERSJON, kandidater: 0, passet: 0, nye: 0, vurdert: 0, treff: 0, under: 0,
    utenVurdering: 0, venter: 0, kilder: [], bruk: null, feil: [] };
  const feil = new Set(), utfall = new Map(), inaktive = new Set();
  const tilKo = [], igjen = new Set();
  let vurdert = [], sendt = 0, pekereGjelder = true, modellFeil = false;
  const leggIgjen = (h, forsok = h.forsok ?? 0) => {
    if(KOKILDER.has(h.k.kilde)) tilKo.push({ ...h, forsok });
    else igjen.add(h.j.nøkkel);
  };

  try{
    const cv = String((await dokumenter.les("cv.json"))?.tekst ?? "").trim();
    if(!cv) throw new Error("Legg inn CV-en din, så kan Radar vurdere stillingene.");

    const hentet = [];
    for(const [i, j] of kildejobber(leid, kilder, start).entries()){
      avbrutt(signal);
      if(i) await vent(GRENSER.pause);
      await hold();
      try{
        const ktx = { nett, tilstand: j.tilstand, side: j.side, innstillinger: inn, avtrykk: j.avtrykk, nå: start, vent, signal };
        const r = j.søk ? await j.kilde.søk(ktx) : await j.kilde.hent(ktx);
        const f = r.feil ? melding(r.feil) : null;
        hentet.push(...r.kandidater.map(k => ({ k, j })));
        logg.kilder.push({ kilde: j.kilde.id, navn: j.navn, hentet: r.kandidater.filter(k => k.status === "aktiv").length, sok: !!j.søk, feil: f });
        utfall.set(j.nøkkel, { tilstand: r.tilstand, feil: f });
      }catch(e){
        avbrutt(signal);
        logg.kilder.push({ kilde: j.kilde.id, navn: j.navn, hentet: 0, sok: !!j.søk, feil: melding(e) });
        utfall.set(j.nøkkel, { feil: melding(e) });
      }
    }
    logg.kandidater = hentet.filter(h => h.k.status === "aktiv").length;

    for(const h of hentet) if(h.k.status === "inaktiv") for(const n of nøklerFor(h.k)) inaktive.add(n);
    const eldst = lokalDato(new Date(start.getTime() - KO_DAGER * DAG));
    const fraKøen = leid.ko.filter(r => inn.kilder[r.kilde]?.pa && r.dato >= eldst)
      .map(r => ({ k: fraKo(r), j: kildejobb(r.kilde, kilder), dato: r.dato, forsok: r.forsok }));

    const før = hukommelse(leid, jobber), runde1 = [];
    for(const h of [...fraKøen, ...hentet]){
      if(h.k.status === "inaktiv" || nøklerFor(h.k).some(n => inaktive.has(n))) continue;
      if(forfilter(h.k, inn, iDag)) continue;
      if(!h.dato) logg.passet++;
      if(før.kjenner(h.k)) continue;
      før.husk(h.k);
      runde1.push(h);
    }

    const brukt = new Map(), etter = hukommelse(leid, jobber), klar = [];
    for(const h of runde1){
      let k = h.k;
      if(!k.detaljert && h.j.kilde.detalj){
        const n = brukt.get(h.j.nøkkel) ?? 0;
        if(n >= h.j.kilde.maksDetaljer){ logg.utenVurdering++; leggIgjen(h); continue; }
        brukt.set(h.j.nøkkel, n + 1);
        avbrutt(signal);
        await vent(GRENSER.pause);
        await hold();
        try{ k = await h.j.kilde.detalj(k, { nett, side: h.j.side, signal }); }
        catch(e){
          avbrutt(signal);
          feil.add(`${h.j.navn}: ${melding(e)}`);
          if(KOKILDER.has(h.k.kilde) && (h.forsok ?? 0) + 1 < KO_FORSOK) leggIgjen(h, (h.forsok ?? 0) + 1);
          continue;
        }
        if(k.status === "inaktiv"){ for(const x of nøklerFor(k)) inaktive.add(x); continue; }
        if(forfilter(k, inn, iDag)) continue;
      }
      if(etter.kjenner(k)) continue;
      etter.husk(k);
      klar.push({ k, h });
    }
    logg.nye = klar.length;

    if(klar.length){
      const igjenIDag = Math.max(0, inn.maksVurderingerPerDogn - (leid.forbruk.dato === iDag ? leid.forbruk.vurderinger : 0));
      await hold();
      const v = await vurderAlle({ kandidater: klar.map(x => x.k), cv, kallModell, leverandor, signal,
        tak: Math.min(MAKS_VURDERINGER_PER_KJORING, igjenIDag) });
      vurdert = v.vurdert;
      sendt = v.sendt;
      for(const x of klar.slice(v.sendt)) leggIgjen(x.h);
      logg.utenVurdering += v.utenVurdering + v.forkastet.reduce((s, f) => s + f.antall, 0);
      logg.bruk = v.bruk;
      for(const f of v.forkastet) feil.add(`Vurderingen: ${rensLinje(f.melding, 200)} ${f.antall} annonser ble hoppet over.`);
      if(v.feil){ modellFeil = true; feil.add(`Vurderingen: ${melding(v.feil)}`); }
    }
  }catch(e){
    pekereGjelder = false;
    feil.add(melding(e));
  }

  const kø = [...new Map(tilKo.map(h => [koId(h.k), korad(h.k, { dato: h.dato ?? iDag, forsok: h.forsok ?? 0 })])).values()]
    .sort((a, b) => (a.dato < b.dato ? -1 : a.dato > b.dato ? 1 : 0));
  if(kø.length > RADAR.ko) feil.add(`${kø.length - RADAR.ko} stillinger fikk ikke plass i køen og blir ikke vurdert.`);
  const nyKø = kø.slice(0, RADAR.ko);

  logg.vurdert = vurdert.length;
  logg.venter = pekereGjelder ? nyKø.length : leid.ko.length;
  logg.feil = [...feil].slice(0, RADAR.kjoringsfeil);
  let nye = [], gjemt = [];

  const lagret = await medNyeForsøk(dokumenter, d => {
    if(d.leie?.eier !== eier && leieGyldig(d.leie, nå())) return null;
    const sistKjent = hukommelse({ avvist: d.avvist, avvistFingeravtrykk: d.avvistFingeravtrykk, innboks: d.innboks }, jobber);
    const terskel = d.innstillinger.terskel;
    const ukjente = vurdert.filter(x => !sistKjent.kjenner(x.k));
    nye = ukjente.filter(x => x.v.prosent >= terskel).map(x => innboksrad(x.k, x.v, start));
    gjemt = ukjente.filter(x => x.v.prosent < terskel && x.v.prosent >= RADAR.underMin).map(x => innboksrad(x.k, x.v, start));
    const iInnboksen = new Set(nye.map(r => r.id));
    const underFør = d.under.filter(r => !iInnboksen.has(r.id));
    const kildetilstand = { ...d.kildetilstand };
    for(const id of ["nav", "jobbnorge"]) kildetilstand[id] = nyKildetilstand(d.kildetilstand[id], utfall.get(id), pekereGjelder, stempel);
    const sideGjelder = s => pekereGjelder && !modellFeil && !igjen.has(s.id);
    const neste = {
      ...d, leie: null, kildetilstand, ko: pekereGjelder ? nyKø : d.ko,
      innstillinger: { ...d.innstillinger,
        karrieresider: d.innstillinger.karrieresider.map(s => nySide(s, utfall.get(s.id), sideGjelder(s), stempel)) },
      sett: [...vurdert.map(x => ({ nokler: lagringsnøkler(x.k), fingeravtrykk: fingeravtrykk(x.k.selskap, x.k.stilling), dato: iDag,
        promptversjon: RADAR_PROMPTVERSJON })), ...d.sett],
      innboks: slåInnIInnboks(fjernInaktive(d.innboks, inaktive), nye),
      under: slåInnIUnder(fjernInaktive(underFør, inaktive), gjemt),
      forbruk: d.forbruk.dato === iDag ? { dato: iDag, vurderinger: d.forbruk.vurderinger + sendt } : { dato: iDag, vurderinger: sendt },
      kjoringer: [{ ...logg, treff: nye.length, under: gjemt.length, slutt: nå().toISOString() }, ...d.kjoringer].slice(0, RADAR.kjoringer)
    };
    return holdUnderTak(rydd(neste, start));
  }).catch(e => { logg.feil.push(`Lagringen: ${melding(e)}`); return null; });
  if(!lagret) await slippLeie(dokumenter, { eier }).catch(() => {});

  logg.treff = lagret ? nye.length : 0;
  logg.under = lagret ? gjemt.length : 0;
  logg.slutt = nå().toISOString();
  return { kjort: true, lagret: !!lagret, kjoring: logg, nye: lagret ? nye : [], varsel: lagret ? varseltekst(nye) : null };
}

export async function ikkeInteressert(dokumenter, id, { nå = () => new Date() } = {}){
  const d = await medNyeForsøk(dokumenter, r => r.innboks.some(x => x.id === id) || r.under.some(x => x.id === id) ? avvis(r, id, nå()) : null);
  if(!d) throw new Brevfeil("finnes-ikke", "Stillingen er ikke i innboksen lenger.", 404);
  return d;
}

export function soknadFraRad(rad, { nå = new Date() } = {}){
  return { selskap: rad.selskap, stilling: rad.stilling, sted: rad.sted, lenke: rad.url, frist: rad.frist ?? null,
    status: "todo", notat: "", hendelser: [lagHendelse("todo", { nå: new Date(nå), kilde: "radar" })] };
}
export async function markerLagtTil(dokumenter, id){
  const d = await medNyeForsøk(dokumenter, r => {
    const rad = r.innboks.find(x => x.id === id);
    if(rad?.status === "lagtTil") return null;
    if(rad) return { ...r, innboks: r.innboks.map(x => x.id === id ? { ...x, status: "lagtTil" } : x) };
    const under = r.under.find(x => x.id === id);
    if(!under) return null;
    return { ...r, under: r.under.filter(x => x.id !== id),
      innboks: slåInnIInnboks(r.innboks, [{ ...under, status: "lagtTil" }]) };
  });
  return d ?? await dokumenter.les(RADARFIL);
}

const sideId = url => `side-${fnv(url)}`;

export async function leggTilKarriereside(dokumenter, { url, navn = "", nett }){
  let funn = oppdagType(url);
  if(!funn.type) throw new Brevfeil("ugyldig", funn.grunn);
  if(funn.type === "jsonld"){
    const side = await nett.hentSide(String(url).trim());
    const her = side?.sluttUrl || url;
    funn = oppdagTypeFraSide(side?.html, her);
    if(!funn.type) throw new Brevfeil("ugyldig", funn.grunn);
    if(funn.type === "jsonld" && !tolkJsonLd(side?.html, { url: her }).length)
      throw new Brevfeil("ugyldig", "Fant ingen stillinger med strukturerte data på siden. Radar kan ikke lese den.");
  }
  const adresse = karriereadresse(funn, url);
  const ny = { id: sideId(normaliserLenke(adresse) ?? adresse), url: adresse, type: funn.type,
    navn: rensLinje(navn), pa: true, feilRad: 0, sist: null, grunn: null };

  let grunn = null;
  const d = await medNyeForsøk(dokumenter, r => {
    const sider = r.innstillinger.karrieresider;
    if(sider.some(s => s.id === ny.id)){ grunn = "Siden er alt lagt til."; return null; }
    if(sider.length >= RADAR.karrieresider){ grunn = `Radar kan følge høyst ${RADAR.karrieresider} karrieresider.`; return null; }
    return { ...r, innstillinger: { ...r.innstillinger, karrieresider: [...sider, ny] } };
  });
  if(grunn) throw new Brevfeil("ugyldig", grunn, 409);
  if(!d) throw new Brevfeil("opptatt", "Radar-dokumentet ble endret samtidig. Prøv igjen.", 409);
  return d;
}

const SOK_NA_PAUSE = 60_000;
const ANTALL_KJORINGER_I_TILSTAND = 5;

export const RADARPRIS = Object.freeze({ inn: 0.10, ut: 0.50, skriv: 0.125, les: 0.01 });

export function kjoringskostnad(bruk){
  if(!bruk) return 0;
  const P = RADARPRIS;
  const dollar = ((bruk.input_tokens ?? 0) * P.inn + (bruk.cache_creation_input_tokens ?? 0) * P.skriv
    + (bruk.cache_read_input_tokens ?? 0) * P.les + (bruk.output_tokens ?? 0) * P.ut) / 1e6;
  const kr = dollar * KURS;
  return Math.round(kr * 10000) / 10000;
}

export function tilstandFra(radar, nå = new Date()){
  const innboks = [...radar.innboks.filter(r => r.status === "ny"), ...radar.innboks.filter(r => r.status !== "ny")];
  const iDag = lokalDato(new Date(nå));
  const k = radar.kildetilstand;
  return {
    revisjon: radar.revisjon,
    innstillinger: radar.innstillinger,
    innboks,
    under: [...radar.under].sort((a, b) => b.prosent - a.prosent),
    antallNye: radar.innboks.filter(r => r.status === "ny").length,
    karrieresider: radar.innstillinger.karrieresider,
    kilder: {
      nav: { sist: k.nav.sist, feil: k.nav.feil, sokFerdig: k.nav.sokFerdig, sokPagar: !!k.nav.sokSide },
      jobbnorge: { sist: k.jobbnorge.sist, feil: k.jobbnorge.feil, sokFerdig: k.jobbnorge.sokFerdig }
    },
    venter: radar.ko.length,
    kjoringer: radar.kjoringer.slice(0, ANTALL_KJORINGER_I_TILSTAND).map(x => ({ ...x, kostnad: kjoringskostnad(x.bruk) })),
    forbruk: { dato: iDag, vurderinger: radar.forbruk.dato === iDag ? radar.forbruk.vurderinger : 0,
      tak: radar.innstillinger.maksVurderingerPerDogn },
    kjorerNa: leieGyldig(radar.leie, nå)
  };
}

const INNSTILLINGSFELT = ["pa", "terskel", "maksVurderingerPerDogn", "sokeord", "ekskluder", "steder", "kilder"];
export async function lagreInnstillinger(dokumenter, inn){
  if(!inn || typeof inn !== "object" || Array.isArray(inn)) throw new Brevfeil("ugyldig", "Innstillingene har feil form.");
  const feltene = Object.fromEntries(INNSTILLINGSFELT.filter(f => inn[f] !== undefined).map(f => [f, inn[f]]));
  const d = await medNyeForsøk(dokumenter, r => {
    const ny = validerRadar({ ...r, innstillinger: { ...r.innstillinger, ...feltene, karrieresider: r.innstillinger.karrieresider } });
    const endret = { ...r, innstillinger: ny.innstillinger };
    return ny.innstillinger.terskel === r.innstillinger.terskel ? endret : flyttVedTerskel(endret, ny.innstillinger.terskel);
  });
  if(!d) throw new Brevfeil("opptatt", "Radar-dokumentet ble endret samtidig. Prøv igjen.", 409);
  return d;
}

export async function fjernKarriereside(dokumenter, id){
  const d = await medNyeForsøk(dokumenter, r => r.innstillinger.karrieresider.some(s => s.id === id)
    ? { ...r, innstillinger: { ...r.innstillinger, karrieresider: r.innstillinger.karrieresider.filter(s => s.id !== id) } } : null);
  if(!d) throw new Brevfeil("finnes-ikke", "Karrieresiden er ikke i listen lenger.", 404);
  return d;
}

export async function slåPåKarriereside(dokumenter, id){
  const d = await medNyeForsøk(dokumenter, r => r.innstillinger.karrieresider.some(s => s.id === id)
    ? { ...r, innstillinger: { ...r.innstillinger, karrieresider: r.innstillinger.karrieresider.map(s => s.id === id
      ? { ...s, pa: true, feilRad: 0, grunn: null, sist: null } : s) } } : null);
  if(!d) throw new Brevfeil("finnes-ikke", "Karrieresiden er ikke i listen lenger.", 404);
  return d;
}

const sisteSøk = new WeakMap();
export async function søkNå(args){
  const { dokumenter } = args, nå = (args.nå ?? (() => new Date()))().getTime();
  const for_mange = sist => new Brevfeil("for-mange",
    `Radar har nettopp kjørt. Prøv igjen om ${Math.ceil((SOK_NA_PAUSE - (nå - sist)) / 1000)} sekunder.`, 429);
  const iMinnet = sisteSøk.get(dokumenter) ?? 0;
  if(nå - iMinnet < SOK_NA_PAUSE) throw for_mange(iMinnet);
  sisteSøk.set(dokumenter, nå);
  const sist = Date.parse((await dokumenter.les(RADARFIL)).kjoringer.find(k => k.kilder.length)?.start) || 0;
  if(nå - sist < SOK_NA_PAUSE) throw for_mange(sist);
  return kjørRadar(args);
}

export async function leggTilFraRad({ rad, jobbId, lagreAnnonse, marker, vurder }){
  await lagreAnnonse(jobbId, { tekst: rad.tekst, url: rad.url, kilde: "radar" });
  const d = await marker(rad.id);
  try{ Promise.resolve(vurder?.(jobbId)).catch(() => {}); }catch{}
  return d;
}
