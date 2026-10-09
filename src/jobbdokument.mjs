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
export const tomRadar = () => ({ skjemaVersjon: RADAR_SKJEMA, revisjon: 0, oppdatert: null });

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

/* Radar strammer inn sin egen form når den kommer. Til da slipper
   lageret gjennom et rent JSON-objekt med revisjon og et tak, og
   ingenting annet. Nøkler som kan endre en prototype faller bort på
   alle nivåer, og dybden er begrenset så en ondsinnet fil ikke kan
   sprenge stakken. */
const FARLIGE = new Set(["__proto__", "constructor", "prototype"]);
function rentJson(v, dybde){
  if(dybde > 32) throw new Brevfeil("ugyldig", "Radar-dokumentet er for dypt nøstet.");
  if(Array.isArray(v)) return v.map(x => rentJson(x, dybde + 1));
  if(erObjekt(v)){
    const ut = {};
    for(const [k, x] of Object.entries(v)) if(!FARLIGE.has(k)) ut[k] = rentJson(x, dybde + 1);
    return ut;
  }
  return v;
}
export function validerRadar(inn){
  if(!erObjekt(inn)) throw new Brevfeil("ugyldig", "Radar-dokumentet mangler.");
  const d = { ...rentJson(inn, 0), skjemaVersjon: RADAR_SKJEMA, revisjon: revisjon(inn.revisjon), oppdatert: tid(inn.oppdatert) };
  if(bytes(d) > MAKS_RADAR) throw new Brevfeil("for-stort", "Radar-dokumentet er for stort.", 413);
  return d;
}

/* Om et dokument har noe en gjenoppretting ville skrevet over. */
export const harJobbinnhold = d => !!(d?.annonse?.tekst || d?.annonse?.url || d?.match || Object.keys(d?.forberedelser ?? {}).length);
export const harRadarinnhold = d => Object.keys(d ?? {}).some(k => !["skjemaVersjon", "revisjon", "oppdatert"].includes(k));

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
