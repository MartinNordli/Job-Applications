/* ============================================================
   jobb-<id>.json: det som hører til én søknad, men ikke til listen.

   Annonsen, vurderingen av hvor godt stillingen passer og
   intervjuforberedelsene er store eller lages i bakgrunnen. Listen
   PUT-es hel ved hver lagring, og bare grensesnittet skriver den, så
   slikt får eget dokument med brevlagerets mekanikk: revisjon,
   mkdir-lås og .forrige.json. Det er ikke brev-<id>.json, for
   brevdokumentet kan vokse mot 32 MiB, og «Slett brevet» skal ikke
   ta annonsen med seg.

   Valideringen er delt i to med vilje:

     - Annonsen er brukerens egen tekst. Er den for lang eller har
       feil form, avvises lagringen, for et stille kutt ville endret
       det brukeren limte inn.
     - match og forberedelser er modellsvar, og de koster penger.
       De normaliseres tilgivende: ukjente felt faller bort, for lang
       tekst kortes, ugyldige oppføringer droppes, og en vurdering
       uten gyldig prosent blir null. Et skadet modellsvar skal ikke
       låse dokumentet så annonsen ikke kan lagres.

   Hele dokumentet har et tak på 4 MiB. Sjekksummen på annonsen
   regnes alltid ut her, aldri tatt imot, så den kan ikke gli fra
   teksten den beskriver.

   «Utdatert» lagres ikke. Det utledes ved å sammenlikne det en
   vurdering bygde på (CV-revisjon, annonsens sjekksum, promptversjon,
   brevversjon) med det som gjelder nå.
   ============================================================ */

import { Brevfeil, revisjon } from "./dokumentfeil.mjs";
import { erId } from "./dokumentnavn.mjs";

export const SKJEMA = 1;
export const RADAR_SKJEMA = 1;
export const MAKS_JOBBDOKUMENT = 4 * 1024 * 1024;
export const MAKS_RADAR = 4 * 1024 * 1024;
export const MAKS_ANNONSE = 100000;

export const KILDER = ["import", "hentet", "limt", "radar", "brev"];
export const ALVOR = ["hoy", "middels", "lav"];
export const SITATKILDER = ["cv", "annonse", "brev"];
export const LEVERANDORER = ["anthropic", "openai"];
const BRUKSFELT = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];

/* Grensene for modellsvarene. Romslige nok til at et godt svar aldri
   kortes, stramme nok til at tjue forberedelser ikke sprenger taket. */
const G = { oppsummering: 1200, krav: 400, bevis: 800, sitat: 600, kilder: 6, sprak: 80,
  sammendrag: 2000, sporsmal: 600, hvorfor: 800, svarskisse: 2000, situasjon: 2000, punkt: 400,
  versjon: 60, modell: 120, forberedelser: 40 };

/* ---------- sjekksum ---------- */

/* FNV-1a, 32 bit, over UTF-8-bytene i normalisert tekst. Formålet er å
   merke at annonsen er en annen enn den en vurdering bygde på, ikke å
   stå imot noen som prøver: én kollisjon i fire milliarder endringer
   gir én vurdering som ikke merkes utdatert. NFKC og sammenslått
   mellomrom gjør at en annonse som limes inn på nytt med andre
   linjeskift eller harde mellomrom regnes som den samme. Synkron og
   uten avhengigheter, så Node og webviewet regner likt. */
export function normaliserAnnonse(tekst){
  return String(tekst ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}
export function sjekksum(tekst){
  let h = 0x811c9dc5;
  for(const b of new TextEncoder().encode(normaliserAnnonse(tekst))){
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
const erSjekksum = v => typeof v === "string" && /^[0-9a-f]{8}$/.test(v);

/* ---------- små byggeklosser ---------- */

const erObjekt = v => !!v && typeof v === "object" && !Array.isArray(v);
const bytes = d => new TextEncoder().encode(JSON.stringify(d, null, 2)).byteLength;

/* Kortes på kodepunkter, så et tegn utenfor BMP aldri deles i to. */
function kort(v, maks){
  if(typeof v !== "string") return "";
  const t = v.replaceAll("\0", "");
  if(t.length <= maks) return t;
  return Array.from(t).slice(0, maks).join("");
}
const valgfriTekst = (v, maks) => typeof v === "string" && v.length && v.length <= maks && !v.includes("\0") ? v : null;
const tid = v => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null;
const heltall = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
const blantt = (v, lov, ellers = null) => lov.includes(v) ? v : ellers;
const tekstliste = (v, antall, maks) => (Array.isArray(v) ? v : [])
  .map(t => kort(t, maks).trim()).filter(Boolean).slice(0, antall);

function bruk(v){
  if(!erObjekt(v)) return null;
  const ut = {};
  for(const k of BRUKSFELT) if(heltall(v[k]) !== null) ut[k] = v[k];
  return Object.keys(ut).length ? ut : null;
}
function kilder(v){
  return (Array.isArray(v) ? v : []).filter(erObjekt)
    .map(k => ({ kilde: blantt(k.kilde, SITATKILDER), sitat: kort(k.sitat, G.sitat).trim() }))
    .filter(k => k.kilde && k.sitat).slice(0, G.kilder);
}

/* Det en vurdering bygde på. Felles for match og forberedelse, så
   utdatert() kan sammenlikne begge på samme måte. */
function grunnlag(v){
  return {
    cvRevisjon: heltall(v.cvRevisjon),
    annonseSjekksum: erSjekksum(v.annonseSjekksum) ? v.annonseSjekksum : null,
    promptversjon: valgfriTekst(v.promptversjon, G.versjon),
    leverandor: blantt(v.leverandor, LEVERANDORER),
    modell: valgfriTekst(v.modell, G.modell),
    bruk: bruk(v.bruk)
  };
}

/* ---------- tomme dokumenter ---------- */

export const tomAnnonse = () => ({ tekst: "", url: "", kilde: null, hentet: null, sjekksum: null });
export function tomtJobbdokument(id){
  if(!erId(id)) throw new Brevfeil("ugyldig", "Ugyldig jobb.");
  return { skjemaVersjon: SKJEMA, revisjon: 0, jobbId: id, annonse: tomAnnonse(), match: null, forberedelser: {}, oppdatert: null };
}

/* ---------- annonsen: streng ---------- */

export function validerAnnonse(inn){
  if(inn == null) return tomAnnonse();
  if(!erObjekt(inn)) throw new Brevfeil("ugyldig", "Annonsen har feil form.");
  const tekst = inn.tekst ?? "";
  if(typeof tekst !== "string" || tekst.length > MAKS_ANNONSE || tekst.includes("\0"))
    throw new Brevfeil("ugyldig", `Annonsen må være tekst på høyst ${MAKS_ANNONSE.toLocaleString("nb-NO")} tegn.`);
  const url = inn.url ?? "";
  if(typeof url !== "string" || url.length > 2000) throw new Brevfeil("ugyldig", "Annonselenken er for lang.");
  if(url){
    let u; try{ u = new URL(url); }catch{}
    if(!u || !["http:", "https:"].includes(u.protocol)) throw new Brevfeil("ugyldig", "Annonselenken må begynne med http eller https.");
  }
  const kilde = inn.kilde ?? null;
  if(kilde !== null && !KILDER.includes(kilde)) throw new Brevfeil("ugyldig", "Ukjent kilde for annonsen.");
  const har = !!normaliserAnnonse(tekst);
  return { tekst, url, kilde, hentet: tid(inn.hentet), sjekksum: har ? sjekksum(tekst) : null };
}

/* ---------- match og forberedelser: tilgivende ---------- */

/* null når det ikke finnes noen brukbar vurdering. */
export function normaliserMatch(inn){
  if(!erObjekt(inn)) return null;
  const p = inn.prosent;
  if(typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 100) return null;
  return {
    prosent: Math.round(p),
    oppsummering: kort(inn.oppsummering, G.oppsummering).trim(),
    styrker: (Array.isArray(inn.styrker) ? inn.styrker : []).filter(erObjekt)
      .map(s => ({ krav: kort(s.krav, G.krav).trim(), bevis: kort(s.bevis, G.bevis).trim(), kilder: kilder(s.kilder) }))
      .filter(s => s.krav).slice(0, 4),
    mangler: (Array.isArray(inn.mangler) ? inn.mangler : []).filter(erObjekt)
      .map(m => ({ krav: kort(m.krav, G.krav).trim(), alvor: blantt(m.alvor, ALVOR, "middels") }))
      .filter(m => m.krav).slice(0, 4),
    sprak: kort(inn.sprak, G.sprak).trim(),
    ...grunnlag(inn),
    vurdert: tid(inn.vurdert)
  };
}

export function normaliserForberedelse(inn){
  if(!erObjekt(inn)) return null;
  return {
    sammendrag: kort(inn.sammendrag, G.sammendrag).trim(),
    sporsmal: (Array.isArray(inn.sporsmal) ? inn.sporsmal : []).filter(erObjekt)
      .map(s => ({ sporsmal: kort(s.sporsmal, G.sporsmal).trim(), hvorfor: kort(s.hvorfor, G.hvorfor).trim(),
        svarskisse: kort(s.svarskisse, G.svarskisse).trim(), kilder: kilder(s.kilder) }))
      .filter(s => s.sporsmal).slice(0, 8),
    eksempler: (Array.isArray(inn.eksempler) ? inn.eksempler : []).filter(erObjekt)
      .map(e => ({ krav: kort(e.krav, G.krav).trim(), situasjon: kort(e.situasjon, G.situasjon).trim(), kilder: kilder(e.kilder) }))
      .filter(e => e.krav || e.situasjon).slice(0, 5),
    sporsmalTilDem: tekstliste(inn.sporsmalTilDem, 5, G.punkt),
    sjekkliste: tekstliste(inn.sjekkliste, 6, G.punkt),
    ...grunnlag(inn),
    brevVersjonId: erId(inn.brevVersjonId) ? inn.brevVersjonId : null,
    laget: tid(inn.laget)
  };
}

/* Nøklene er intervju-id-er. «__proto__» passerer id-regelen, men skal
   aldri bli en nøkkel i et objekt noen senere slår opp i. */
function forberedelser(inn){
  const ut = {};
  if(!erObjekt(inn)) return ut;
  for(const [iid, f] of Object.entries(inn)){
    if(!erId(iid) || iid === "__proto__" || Object.keys(ut).length >= G.forberedelser) continue;
    const n = normaliserForberedelse(f);
    if(n) ut[iid] = n;
  }
  return ut;
}

/* ---------- hele dokumentet ---------- */

export function validerJobbdokument(id, inn){
  if(!erObjekt(inn)) throw new Brevfeil("ugyldig", "Jobbdokumentet mangler.");
  const d = {
    ...tomtJobbdokument(id),
    revisjon: revisjon(inn.revisjon),
    annonse: validerAnnonse(inn.annonse),
    match: normaliserMatch(inn.match),
    forberedelser: forberedelser(inn.forberedelser),
    oppdatert: tid(inn.oppdatert)
  };
  if(bytes(d) > MAKS_JOBBDOKUMENT)
    throw new Brevfeil("for-stort", "Dokumentet for søknaden er for stort. Fjern noen intervjuforberedelser først.", 413);
  return d;
}

/* ---------- radar.json ---------- */
/*
   Radar skriver dette dokumentet selv, også fra bakgrunnen, og det
   meste i det er maskinlaget: innboksen, hukommelsen og kjøringsloggen.
   Derfor normaliseres alt tilgivende, som modellsvarene over: ukjente
   felt faller bort, ugyldige oppføringer droppes, lister kortes til
   taket, og det som mangler får standardverdien. Et eldre radar.json
   med en annen form blir dermed et gyldig dokument med
   standardinnstillinger, uten ny skjemaversjon. Prototypenøkler kan
   ikke slippe gjennom, fordi bare kjente felt kopieres.

   Nøklene er ASCII som i resten av dataformatet (sporsmal, sprak,
   leverandor), så Rust-jobben kan lese dem uten omveier.

   Hukommelsen har tak i både tid og antall: «sett» i 200 dager og
   «avvist» i ett år. Antallstakene her er det siste vernet; selve
   rydderegelen står i src/radarlogikk.mjs, som også holder dokumentet
   under 4 MiB før det skrives.
*/
export const RADAR = Object.freeze({
  terskel: 60, maksVurderingerPerDogn: 150,
  innboks: 200, sett: 4000, avvist: 5000, avvistFingeravtrykk: 5000, kjoringer: 20,
  karrieresider: 40, ord: 40, ordlengde: 80, fylker: 30, navn: 200,
  tekst: 6000, grunner: 3, grunn: 300, lenker: 5, nokler: 4, nokkel: 2000, fingeravtrykk: 420,
  feilRad: 5, kjoringsfeil: 10, kildelogg: 60, melding: 300
});
export const RADARKILDER = ["nav", "jobbnorge", "greenhouse", "lever", "teamtailor", "jsonld"];
export const KARRIERETYPER = ["greenhouse", "lever", "teamtailor", "jsonld"];
export const INNBOKSSTATUS = ["ny", "lagtTil"];

const DATO = /^\d{4}-\d{2}-\d{2}$/;
const dato = v => typeof v === "string" && DATO.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
/* Brukerens egne ord. Et for langt ord droppes i stedet for å kortes:
   et kuttet søkeord treffer noe annet enn det brukeren skrev. */
const ord = v => [...new Set((Array.isArray(v) ? v : [])
  .map(t => typeof t === "string" ? t.replaceAll("\0", "").replace(/\s+/gu, " ").trim() : "")
  .filter(t => t && t.length <= RADAR.ordlengde))].slice(0, RADAR.ord);
function lenke(v){
  if(typeof v !== "string" || !v || v.length > 2000) return null;
  try{ const u = new URL(v); return ["http:", "https:"].includes(u.protocol) ? v : null; }
  catch{ return null; }
}
const lenker = v => [...new Set((Array.isArray(v) ? v : []).map(lenke).filter(Boolean))].slice(0, RADAR.lenker);
const nokler = v => [...new Set((Array.isArray(v) ? v : []).map(k => valgfriTekst(k, RADAR.nokkel)).filter(Boolean))].slice(0, RADAR.nokler);
const prosent = v => Number.isInteger(v) && v >= 0 && v <= 100 ? v : null;
const bool = (v, ellers) => typeof v === "boolean" ? v : ellers;
const navn = v => kort(v, RADAR.navn).trim();

/* Bare objekter i lister, og hver nøkkel bare én gang. Den første
   vinner, så rekkefølgen dokumentet ble skrevet i, avgjør. */
function unike(v, maks, lag, nøkkel){
  const sett = new Set(), ut = [];
  for(const x of Array.isArray(v) ? v : []){
    if(ut.length >= maks) break;
    const n = erObjekt(x) ? lag(x) : null;
    if(!n) continue;
    if(nøkkel){
      const k = nøkkel(n);
      if(sett.has(k)) continue;
      sett.add(k);
    }
    ut.push(n);
  }
  return ut;
}

export const tomeRadarinnstillinger = () => ({
  pa: false, terskel: RADAR.terskel, maksVurderingerPerDogn: RADAR.maksVurderingerPerDogn,
  sokeord: [], ekskluder: [], steder: [],
  kilder: { nav: { pa: true }, jobbnorge: { pa: true, fylker: [] } },
  karrieresider: []
});

function karriereside(k){
  const url = lenke(k.url), type = blantt(k.type, KARRIERETYPER);
  if(!erId(k.id) || !url || !type) return null;
  return { id: k.id, url, type, navn: navn(k.navn), pa: bool(k.pa, true),
    feilRad: Math.min(heltall(k.feilRad) ?? 0, 1000), sist: tid(k.sist), grunn: valgfriTekst(k.grunn, RADAR.melding) };
}

function innstillinger(v){
  const t = tomeRadarinnstillinger();
  if(!erObjekt(v)) return t;
  const k = erObjekt(v.kilder) ? v.kilder : {};
  const nav = erObjekt(k.nav) ? k.nav : {}, jn = erObjekt(k.jobbnorge) ? k.jobbnorge : {};
  const terskel = prosent(v.terskel), tak = heltall(v.maksVurderingerPerDogn);
  return {
    pa: bool(v.pa, t.pa),
    terskel: terskel ?? t.terskel,
    maksVurderingerPerDogn: tak !== null && tak <= 1000 ? tak : t.maksVurderingerPerDogn,
    sokeord: ord(v.sokeord), ekskluder: ord(v.ekskluder), steder: ord(v.steder),
    kilder: {
      nav: { pa: bool(nav.pa, true) },
      jobbnorge: { pa: bool(jn.pa, true),
        fylker: [...new Set((Array.isArray(jn.fylker) ? jn.fylker : [])
          .filter(n => Number.isInteger(n) && n > 0 && n < 1000))].slice(0, RADAR.fylker) }
    },
    karrieresider: unike(v.karrieresider, RADAR.karrieresider, karriereside, s => s.id)
  };
}

export const tomKildetilstand = () => ({
  nav: { side: null, etag: null, sistEndret: null, sist: null, feil: null },
  jobbnorge: { sisteId: null, sist: null, feil: null }
});
function kildetilstand(v){
  if(!erObjekt(v)) return tomKildetilstand();
  const n = erObjekt(v.nav) ? v.nav : {}, j = erObjekt(v.jobbnorge) ? v.jobbnorge : {};
  return {
    nav: { side: erId(n.side) ? n.side : null, etag: valgfriTekst(n.etag, 200), sistEndret: valgfriTekst(n.sistEndret, 64),
      sist: tid(n.sist), feil: valgfriTekst(n.feil, RADAR.melding) },
    jobbnorge: { sisteId: heltall(j.sisteId), sist: tid(j.sist), feil: valgfriTekst(j.feil, RADAR.melding) }
  };
}

function innboksrad(r){
  const id = valgfriTekst(r.id, 200), kilde = blantt(r.kilde, RADARKILDER), url = lenke(r.url), p = prosent(r.prosent);
  if(!id || !kilde || !url || p === null) return null;
  return {
    id, kilde, kildeId: navn(r.kildeId), url, lenker: lenker(r.lenker),
    selskap: navn(r.selskap), stilling: navn(r.stilling), sted: navn(r.sted),
    frist: dato(r.frist), publisert: tid(r.publisert), tekst: kort(r.tekst, RADAR.tekst),
    prosent: p, grunner: tekstliste(r.grunner, RADAR.grunner, RADAR.grunn),
    status: blantt(r.status, INNBOKSSTATUS, "ny"), funnet: tid(r.funnet),
    nokler: nokler(r.nokler), fingeravtrykk: valgfriTekst(r.fingeravtrykk, RADAR.fingeravtrykk)
  };
}

function minne(r){
  const d = dato(r.dato), n = nokler(r.nokler);
  if(!d || !n.length) return null;
  return { nokler: n, fingeravtrykk: valgfriTekst(r.fingeravtrykk, RADAR.fingeravtrykk), dato: d };
}
function avvistRad(r){
  const d = dato(r.dato), n = nokler(r.nokler);
  return d && n.length ? { nokler: n, dato: d } : null;
}
function avvistFingeravtrykk(r){
  const d = dato(r.dato), f = valgfriTekst(r.fingeravtrykk, RADAR.fingeravtrykk);
  return d && f ? { fingeravtrykk: f, dato: d } : null;
}

export const KJORINGSTELLERE = ["kandidater", "nye", "vurdert", "treff", "utenVurdering"];
function kjoring(r){
  const start = tid(r.start);
  if(!start) return null;
  const ut = { start, slutt: tid(r.slutt) };
  for(const k of KJORINGSTELLERE) ut[k] = heltall(r[k]) ?? 0;
  ut.kilder = unike(r.kilder, RADAR.kildelogg, k => {
    const kilde = blantt(k.kilde, RADARKILDER);
    return kilde ? { kilde, navn: navn(k.navn), hentet: heltall(k.hentet) ?? 0, feil: valgfriTekst(k.feil, RADAR.melding) } : null;
  });
  ut.bruk = bruk(r.bruk);
  ut.feil = tekstliste(r.feil, RADAR.kjoringsfeil, RADAR.melding);
  return ut;
}

function leie(v){
  if(!erObjekt(v)) return null;
  const eier = valgfriTekst(v.eier, 80), utloper = tid(v.utloper);
  return eier && utloper ? { eier, utloper } : null;
}
function forbruk(v){
  const d = erObjekt(v) ? dato(v.dato) : null;
  return { dato: d, vurderinger: d ? heltall(v.vurderinger) ?? 0 : 0 };
}

export function validerRadar(inn){
  if(!erObjekt(inn)) throw new Brevfeil("ugyldig", "Radar-dokumentet mangler.");
  const d = {
    skjemaVersjon: RADAR_SKJEMA, revisjon: revisjon(inn.revisjon),
    innstillinger: innstillinger(inn.innstillinger),
    kildetilstand: kildetilstand(inn.kildetilstand),
    innboks: unike(inn.innboks, RADAR.innboks, innboksrad, r => r.id),
    sett: unike(inn.sett, RADAR.sett, minne),
    avvist: unike(inn.avvist, RADAR.avvist, avvistRad),
    avvistFingeravtrykk: unike(inn.avvistFingeravtrykk, RADAR.avvistFingeravtrykk, avvistFingeravtrykk, r => r.fingeravtrykk),
    kjoringer: unike(inn.kjoringer, RADAR.kjoringer, kjoring),
    forbruk: forbruk(inn.forbruk),
    leie: leie(inn.leie),
    oppdatert: tid(inn.oppdatert)
  };
  if(bytes(d) > MAKS_RADAR) throw new Brevfeil("for-stort", "Radar-dokumentet er for stort.", 413);
  return d;
}
export const tomRadar = () => validerRadar({ revisjon: 0 });

/* Om et dokument har noe en gjenoppretting ville skrevet over. */
export const harJobbinnhold = d => !!(d?.annonse?.tekst || d?.annonse?.url || d?.match || Object.keys(d?.forberedelser ?? {}).length);
/* Et radar.json med bare standardverdier er tomt, selv om alle feltene
   står der. Leien og forbruket teller ikke: de beskriver kjøringer,
   ikke noe brukeren har laget eller valgt. */
export function harRadarinnhold(d){
  if(!erObjekt(d)) return false;
  const tom = tomRadar();
  return ["innstillinger", "kildetilstand", "innboks", "sett", "avvist", "avvistFingeravtrykk", "kjoringer"]
    .some(k => d[k] !== undefined && JSON.stringify(d[k]) !== JSON.stringify(tom[k]));
}

/* ---------- utdatert ---------- */

const SPOR = ["cvRevisjon", "annonseSjekksum", "promptversjon", "brevVersjonId"];

/* Feltene i `nå` som ikke stemmer med det vurderingen bygde på. Bare
   felt som er oppgitt sammenliknes: den som ikke vet CV-revisjonen,
   kan ikke si at den har endret seg. Tom liste betyr oppdatert, og en
   vurdering som ikke finnes er heller ikke utdatert. */
export function utdatert(vurdering, nå = {}){
  if(!vurdering) return [];
  return SPOR.filter(k => nå[k] !== undefined && (vurdering[k] ?? null) !== (nå[k] ?? null));
}

/* Annonsens sjekksum tas fra dokumentet selv, så den som spør bare
   trenger det dokumentet ikke vet: CV-revisjonen og promptversjonen. */
export function matchUtdatert(dok, { cvRevisjon, promptversjon } = {}){
  return utdatert(dok?.match, { cvRevisjon, promptversjon, annonseSjekksum: dok?.annonse?.sjekksum ?? null });
}
export function forberedelseUtdatert(dok, iid, { cvRevisjon, promptversjon, brevVersjonId } = {}){
  const f = erId(iid) && Object.hasOwn(dok?.forberedelser ?? {}, iid) ? dok.forberedelser[iid] : null;
  return utdatert(f, { cvRevisjon, promptversjon, brevVersjonId, annonseSjekksum: dok?.annonse?.sjekksum ?? null });
}
