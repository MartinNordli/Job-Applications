/* ============================================================
   Radarlogikken: én kjøring fra kildene til innboksen, uten egen I/O.

   Alt som rører verden kommer inn som argumenter: nett ({ hentJson,
   hentSide } fra src/radarnett.mjs), dokumenter (profilens lager, med
   les og skriv som server/brevlager.mjs), kallModell (samme kontrakt
   som brevet og vurderingen), nå og vent. Samme kode kjører derfor i
   Node, i appen og i bakgrunnen, og testene kjører den med falske
   kilder og en falsk modell.

   Søknadslisten leses, men skrives aldri herfra. Bare grensesnittet
   skriver jobber.json; kjernen skriver bare radar.json.

   Flyten i én kjøring:

     1. Leie. Bare én prosess kjører Radar om gangen. Leien er et felt
        i radar.json, og revisjonen er låsen: lagerets 409 betyr at noen
        andre skrev først, og da leses dokumentet på nytt.
     2. Hent fra kildene som er på. Karrieresider høyst hver 6. time, og
        en side som feiler 5 ganger på rad slås av med forklaring.
     3. Forfilter: aktiv, fristen ikke passert, søkeord treffer, ingen
        ekskluderte ord, stedet passer. Billig, så det går før alt.
     4. Duplikater mot søknadslisten, mot hukommelsen i radar.json (sett,
        avvist, innboksen) og mellom kildene i samme kjøring.
     5. Detaljer for det som er igjen, innenfor kildens tak, og så
        forfilter og duplikatsjekk én gang til med hele teksten. Det er
        her NAV-kopien av en Jobbnorge-annonse kjennes igjen: først
        detaljen har Jobbnorge-lenken.
     6. Vurdering i bolker på høyst 8, innenfor tak per kjøring og per
        døgn, med svaret sjekket strengt.
     7. Lagring oppå siste versjon, i samme skriving som slipper leien.
     8. Ett varsel per kjøring, renset og kortet.

   Når modellen ikke kan nås (ingen nøkkel, nede), flyttes ikke NAV- og
   Jobbnorge-pekerne, og karrieresidene regnes ikke som hentet. Da hentes
   de samme annonsene neste gang, i stedet for at de forsvinner. Det som
   ble vurdert før feilen, huskes likevel, så det ikke betales for to
   ganger.
   ============================================================ */

import { normaliserLenke } from "./importlogikk.mjs";
import { sjekkSchema } from "./brevlogikk.mjs";
import { lokalDato, lagHendelse } from "./hendelser.mjs";
import { Brevfeil } from "./dokumentfeil.mjs";
import { RADAR, validerRadar } from "./jobbdokument.mjs";
import { KURS } from "./importlogg.mjs";
import { KILDER, GRENSER, sov, rensLinje, oppdagType, oppdagTypeFraSide, karriereadresse, tolkJsonLd } from "./radarkilder.mjs";
import { RADAR_PROMPTVERSJON, VURDERINGSSKJEMA, FORSLAGSSKJEMA, FORSLAG_GRENSER, radarForespørsel, forslagForespørsel } from "./radarprompt.mjs";

export const KARRIEREINTERVALL = 6 * 3600_000;
export const LEIETID = 15 * 60_000;
export const BOLK = 8;
export const MAKS_VURDERINGER_PER_KJORING = 40;
export const SETT_DAGER = 200;
export const AVVIST_DAGER = 365;
export const TAK_FOR_LAGRING = 3.5 * 1024 * 1024;
export const MAKS_VARSEL = 240;

const DAG = 86_400_000;
const RADARFIL = "radar.json";
const kortTekst = (t, n = RADAR.tekst) => Array.from(String(t ?? "")).slice(0, n).join("");

/* ---------- tekst som sammenliknes ---------- */
/*
   Norsk bretting: små bokstaver, æ/ø/å skrevet ut (ae/o/a), andre
   aksenter fjernet og «aa» som «a». Da treffer «Tromsø», «TROMSO» og
   «Tromso» hverandre, og «Ålesund» treffer «Aalesund». Begge sider
   brettes likt, så det som går tapt, går tapt på begge.
*/
export function brett(v){
  return String(v ?? "").normalize("NFKC").toLocaleLowerCase("nb")
    .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")
    .normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/aa/g, "a")
    .replace(/\s+/gu, " ").trim();
}

/* Et ord treffer som delstreng, fordi norske sammensetninger ellers
   faller bort: «data» skal treffe «Dataingeniør». Korte ord (tre tegn
   eller færre) må stå som egne ord: «KI» skal ikke treffe «kinesisk». */
export function ordTreffer(tekst, ord){
  const t = brett(tekst), o = brett(ord);
  if(!o) return false;
  if(o.length > 3) return t.includes(o);
  const m = new RegExp(`(^|[^\\p{L}\\p{N}])${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u");
  return m.test(t);
}
const noenTreffer = (tekst, ord) => ord.some(o => ordTreffer(tekst, o));

/* ---------- forfilter ---------- */
/*
   null betyr at kandidaten slipper gjennom, ellers grunnen.
   - Søkeord treffer tittel eller tekst. Før detaljen kjenner NAV bare
     tittelen, så en NAV-annonse må ha søkeordet i tittelen for å komme
     videre. Det er prisen for å holde seg under 60 detaljoppslag.
   - Ekskluderte ord gjelder tittel og selskap, ikke brødteksten: en
     annonse som nevner «seniorkolleger», er ikke en seniorstilling.
   - Sted: tomt sted slipper gjennom, for kilden vet det ikke, og da
     skal ikke Radar late som om den vet det.
*/
export function forfilter(k, innstillinger, iDag){
  if(k.status !== "aktiv") return "inaktiv";
  if(k.frist && k.frist < iDag) return "frist";
  const inn = innstillinger ?? {};
  if(inn.sokeord?.length && !noenTreffer(`${k.stilling}\n${k.tekst}`, inn.sokeord)) return "sokeord";
  if(inn.ekskluder?.length && noenTreffer(`${k.stilling}\n${k.selskap}`, inn.ekskluder)) return "ekskludert";
  if(inn.steder?.length && k.sted && !noenTreffer(k.sted, inn.steder)) return "sted";
  return null;
}

/* ---------- fingeravtrykk og nøkler ---------- */

const SELSKAPSFORM = new Set(["as", "asa", "ab", "gmbh", "sa", "ltd", "inc", "plc", "llc", "ans", "da", "hf", "iks", "kf"]);
const TEGN = /[\p{P}\p{S}]+/gu;

/* «Equinor ASA» og «EQUINOR» er samme selskap; «Data Scientist –
   Oslo» og «Data scientist, Oslo» er samme tittel. Selskapsform tas
   bare bort i selskapsnavnet. null når en av delene mangler: et
   avtrykk av halve annonsen ville truffet altfor mye. */
export function fingeravtrykk(selskap, stilling){
  const s = brett(selskap).replace(TEGN, " ").split(" ").filter(o => o && !SELSKAPSFORM.has(o)).join(" ");
  const t = brett(stilling).replace(TEGN, " ").replace(/\s+/g, " ").trim();
  if(!s || !t) return null;
  return `${s}|${t}`.slice(0, RADAR.fingeravtrykk);
}

/* Jobbnorge-id-en i en lenke, fra Jobbnorges egne sider eller fra
   NAVs sourceurl og applicationUrl. NAV har Jobbnorge-annonsene med,
   og id-en er det sikreste tegnet på at to kandidater er samme annonse. */
export function jobbnorgeId(url){
  let u;
  try{ u = new URL(String(url ?? "")); }catch{ return null; }
  const vert = u.hostname.toLowerCase().replace(/^www\./, "");
  const m = vert === "jobbnorge.no" ? u.pathname.match(/\/stilling\/(\d{1,12})(?:\/|$)/)
    : vert === "jobseeker.jobbnorge.no" ? u.pathname.match(/^\/apply\/(\d{1,12})(?:\/|$)/) : null;
  return m ? m[1] : null;
}

/* Nøklene en kandidat kjennes igjen på: Jobbnorge-id-en først, så
   kildens egen id, så de normaliserte lenkene. Den første blir id-en
   i innboksen, så en Jobbnorge-annonse har samme id uansett vei inn. */
export function nøklerFor(k){
  const jn = k.kilde === "jobbnorge" ? k.kildeId : (k.lenker ?? []).map(jobbnorgeId).find(Boolean);
  const ut = [];
  if(jn) ut.push(`jobbnorge:${jn}`);
  ut.push(`${k.kilde}:${k.kildeId}`);
  for(const l of k.lenker ?? []){ const n = normaliserLenke(l); if(n) ut.push(n); }
  return [...new Set(ut)];
}
const lagringsnøkler = k => nøklerFor(k).slice(0, RADAR.nokler);

/* Alt Radar allerede vet om: søknadene, hukommelsen og innboksen. */
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
  for(const r of [...(radar?.sett ?? []), ...(radar?.avvist ?? []), ...(radar?.innboks ?? [])]){
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

/* ---------- vurderingen ---------- */

function formatfeil(melding){
  const e = new Error(melding); e.code = "modellformat"; e.navn = "modellformat"; e.melding = melding; e.status = 502; return e;
}

/* En lenke eller e-postadresse i en grunn kommer fra en annonse, ikke
   fra vurderingen, og er det et injeksjonsforsøk vil ha fram i flaten. */
const LENKE = /https?:\/\/|\bwww\.|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+\.[\p{L}]{2,}/iu;

/* Modellsvaret er like fremmed som annonsene, og sjekkes strengt: bare
   feltene i skjemaet, nøyaktig én vurdering per annonse i bolken, et
   tall fra 0 til 100 og høyst tre grunner som ikke er tomme. Er noe
   galt, avvises hele svaret. Et svar som har funnet på en id eller
   hoppet over en annonse, kan ikke stoles på for de andre heller. */
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

/*
   Vurderer i bolker innenfor taket. To slags feil skilles:
   - Svaret har feil form: bolken forkastes og loggføres, og resten går
     videre. En annonse som får modellen til å svare tull, skal ikke
     stoppe alle de andre.
   - Kallet feiler (ingen nøkkel, nett, leverandøren nede): ingen flere
     kall. `feil` settes, og kjøringen lar kildepekerne stå.
   `sendt` er antallet annonser som er sendt til modellen, og det er det
   døgntaket teller, fordi det er det som koster.
*/
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

/* ---------- «Foreslå fra CV» ---------- */

/* Ett ord slik forfilter kan bruke det: renset, uten omsluttende
   anførselstegn og skilletegn, ett til tre ord, høyst 40 tegn, minst
   to tegn etter brettingen og minst én bokstav. Tegnene er de som
   står i titler («C#», «.NET», «Node.js», «HR-rådgiver»). En lenke
   eller adresse er aldri et søkeord. null når ordet ikke kan brukes. */
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

/*
   Forslaget er like fremmed som annonsene. Formen sjekkes strengt (bare
   de tre listene, bare tekst), og hvert ord filtreres så det som blir
   igjen, virker i forfilter:
   - steder som ikke står i CV-en, tas bort: et sted modellen har gjettet,
     er en påstand om personen som ikke har grunnlag
   - ekskluderte ord som treffer et av søkeordene, tas bort, ellers ville
     forslaget stengt ute de annonsene det selv ber om
   Så kuttes listene til 12, 6 og 6. Tomme lister er et gyldig svar.
*/
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

/* Den rene delen: ett kall og den strenge tolkningen. Lagrer ingenting;
   brukeren redigerer forslaget og lagrer selv med lagreInnstillinger. */
export async function foreslåFraCv({ cv, kallModell, leverandor = "anthropic", signal }){
  const tekst = String(cv ?? "").trim();
  if(!tekst) throw new Brevfeil("mangler-cv", "Legg inn CV-en din, så kan Radar foreslå søkeord.", 409);
  const svar = await kallModell({ ...forslagForespørsel({ cv: tekst, leverandor }), signal });
  return tolkForslag(svar?.data, { cv: tekst });
}

/*
   Forslaget fra profilen, med taket: høyst 10 kall i timen per profil.
   Taket henger på lagerobjektet, som «Søk nå»-grensen, så det gjelder
   både i appen og på serveren. Et kall som stopper på at nøkkelen
   mangler, har ikke kostet noe og teller ikke.
*/
export const FORSLAG_TAK = Object.freeze({ tak: 10, vindu: 3600_000 });
const forslagskall = new WeakMap();
export async function foreslåFraProfil({ dokumenter, kallModell, leverandor = "anthropic", nå = () => new Date(), signal }){
  const t = nå().getTime();
  const kall = (forslagskall.get(dokumenter) ?? []).filter(x => t - x < FORSLAG_TAK.vindu);
  if(kall.length >= FORSLAG_TAK.tak){
    const min = Math.max(1, Math.ceil((FORSLAG_TAK.vindu - (t - kall[0])) / 60_000));
    throw new Brevfeil("for-mange", `Du har bedt om mange forslag den siste timen. Prøv igjen om ${min} minutter.`, 429);
  }
  /* Telles før første await, så to klikk i samme øyeblikk ikke slipper forbi. */
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

/* ---------- innboks og hukommelse ---------- */

export function innboksrad(k, v, nå){
  const n = lagringsnøkler(k);
  return { id: n[0], kilde: k.kilde, kildeId: k.kildeId, url: k.url, lenker: k.lenker, selskap: k.selskap,
    stilling: k.stilling, sted: k.sted, frist: k.frist, publisert: k.publisert,
    tekst: kortTekst(k.tekst), prosent: v.prosent, grunner: v.grunner,
    status: "ny", funnet: new Date(nå).toISOString(), nokler: n, fingeravtrykk: fingeravtrykk(k.selskap, k.stilling) };
}

/* Nye rader først, en rad som alt finnes beholdes som den er (den kan
   være lagt til). Over taket går de eldste som er lagt til først, så
   de eldste nye. */
export function slåInnIInnboks(innboks, nye){
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

/* NAV sier INACTIVE: vilkårene krever at annonsen fjernes. */
export function fjernInaktive(innboks, nøkler){
  const n = new Set(nøkler);
  if(!n.size) return innboks;
  return innboks.filter(r => !n.has(r.id) && !(r.nokler ?? []).some(x => n.has(x)));
}

/* «Ikke interessert»: ut av innboksen, og husket både på lenke og på
   selskap og stilling i ett år. */
export function avvis(radar, id, nå){
  const rad = radar.innboks.find(r => r.id === id);
  if(!rad) return radar;
  const dato = lokalDato(new Date(nå));
  return { ...radar,
    innboks: radar.innboks.filter(r => r.id !== id),
    avvist: [{ nokler: rad.nokler.length ? rad.nokler : [rad.id], dato }, ...radar.avvist],
    avvistFingeravtrykk: rad.fingeravtrykk && !radar.avvistFingeravtrykk.some(a => a.fingeravtrykk === rad.fingeravtrykk)
      ? [{ fingeravtrykk: rad.fingeravtrykk, dato }, ...radar.avvistFingeravtrykk] : radar.avvistFingeravtrykk };
}

/* Sett i 200 dager, avvist i ett år, og antallstakene. Nyeste først. */
export function rydd(radar, nå){
  const grense = dager => lokalDato(new Date(new Date(nå).getTime() - dager * DAG));
  const sett = grense(SETT_DAGER), avvist = grense(AVVIST_DAGER);
  const nyestFørst = (a, b) => (a.dato < b.dato ? 1 : a.dato > b.dato ? -1 : 0);
  return { ...radar,
    sett: radar.sett.filter(r => r.dato >= sett).sort(nyestFørst).slice(0, RADAR.sett),
    avvist: radar.avvist.filter(r => r.dato >= avvist).sort(nyestFørst).slice(0, RADAR.avvist),
    avvistFingeravtrykk: radar.avvistFingeravtrykk.filter(r => r.dato >= avvist).sort(nyestFørst).slice(0, RADAR.avvistFingeravtrykk) };
}

/* Dokumentet har et tak på 4 MiB, og en kjøring som ikke får lagret,
   ville feilet på nytt hver time. Derfor kortes hukommelsen, eldste
   først, til det er god plass. Innboksen og innstillingene røres ikke. */
const størrelse = d => new TextEncoder().encode(JSON.stringify(d, null, 2)).byteLength;
export function holdUnderTak(radar, tak = TAK_FOR_LAGRING){
  let d = radar;
  for(const felt of ["sett", "avvist", "avvistFingeravtrykk"]){
    while(størrelse(d) > tak && d[felt].length){
      d = { ...d, [felt]: d[felt].slice(0, Math.floor(d[felt].length * 0.9)) };
    }
  }
  return d;
}

/* ---------- skriving med revisjon ---------- */
/*
   Hver endring av radar.json leser siste versjon, legger endringen
   oppå og skriver med revisjonen den leste. Ved 409 leses dokumentet
   på nytt; det kan like gjerne være brukeren som lagret en innstilling
   som en annen Radar som tok leien. endre gir null når det ikke er noe
   å skrive. Gir opp etter fem forsøk, og da med null.
*/
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

/* ---------- leien ---------- */

const leieGyldig = (leie, nå) => !!leie && Date.parse(leie.utloper) > new Date(nå).getTime();
const utloper = (nå, varighet) => new Date(new Date(nå).getTime() + varighet).toISOString();

/* Gir dokumentet med leien, eller null når en annen har en gyldig leie.
   En utløpt leie kan tas over: prosessen som hadde den, er borte eller
   har brukt for lang tid, og skriver ikke over den nye (se lagringen i
   kjørRadar). */
export function taLeie(dokumenter, { eier, nå, varighet = LEIETID }){
  return medNyeForsøk(dokumenter, d =>
    leieGyldig(d.leie, nå) && d.leie.eier !== eier ? null : { ...d, leie: { eier, utloper: utloper(nå, varighet) } });
}
export function fornyLeie(dokumenter, { eier, nå, varighet = LEIETID }){
  return medNyeForsøk(dokumenter, d =>
    d.leie?.eier !== eier ? null : { ...d, leie: { eier, utloper: utloper(nå, varighet) } });
}
export function slippLeie(dokumenter, { eier }){
  return medNyeForsøk(dokumenter, d => d.leie?.eier !== eier ? null : { ...d, leie: null });
}

/* ---------- varselet ---------- */

/* Ett varsel per kjøring, med de beste treffene først. Teksten kommer
   fra fremmede sider og går til systemvarselet, så kontrolltegn og
   retningsmerker fjernes, og den kortes på kodepunkter. */
export function varseltekst(treff, maks = MAKS_VARSEL){
  if(!treff?.length) return null;
  const sortert = [...treff].sort((a, b) => b.prosent - a.prosent);
  const hode = sortert.length === 1 ? "1 ny stilling passer" : `${sortert.length} nye stillinger passer`;
  const deler = sortert.map(t => `${[rensLinje(t.selskap, 80), rensLinje(t.stilling, 120)].filter(Boolean).join(", ")} (${t.prosent} %)`);
  const tekst = [hode, ...deler].join(" · ");
  const tegn = Array.from(tekst);
  return tegn.length > maks ? tegn.slice(0, maks - 1).join("").trimEnd() + "…" : tekst;
}

/* ---------- én kjøring ---------- */

const melding = e => rensLinje(e?.melding || e?.message || String(e ?? "Ukjent feil."), RADAR.melding);
const skalHentes = (side, nå) => side.pa && (!side.sist || new Date(nå).getTime() - Date.parse(side.sist) >= KARRIEREINTERVALL);
const nyEier = () => `radar:${globalThis.crypto.randomUUID()}`;
const avbrutt = signal => { if(signal?.aborted) throw new Error("Kjøringen ble avbrutt."); };

/* Kildene som skal hentes nå, med det kjøringen trenger om hver. */
function kildejobber(radar, kilder, nå){
  const inn = radar.innstillinger, ut = [];
  if(inn.kilder.nav.pa) ut.push({ nøkkel: "nav", kilde: kilder.nav, navn: "NAV", tilstand: radar.kildetilstand.nav });
  if(inn.kilder.jobbnorge.pa) ut.push({ nøkkel: "jobbnorge", kilde: kilder.jobbnorge, navn: "Jobbnorge", tilstand: radar.kildetilstand.jobbnorge });
  for(const side of inn.karrieresider)
    if(skalHentes(side, nå) && kilder[side.type]) ut.push({ nøkkel: side.id, kilde: kilder[side.type], navn: side.navn || side.url, side });
  return ut;
}

/* Hva kjøringen lærte om én kilde, lagt oppå det som står i dokumentet.
   En feil telles alltid, og en karriereside som feilet, venter seks
   timer som en som lyktes. Pekerne og «hentet» flyttes bare når
   kjøringen kom gjennom vurderingen (pekereGjelder). */
function nyKildetilstand(gammel, utfall, pekereGjelder, stempel){
  if(!utfall) return gammel;
  if(utfall.feil) return { ...gammel, sist: stempel, feil: utfall.feil };
  return pekereGjelder ? { ...gammel, ...utfall.tilstand, sist: stempel, feil: null } : gammel;
}
function nySide(side, utfall, pekereGjelder, stempel){
  if(!utfall) return side;
  if(!utfall.feil) return pekereGjelder ? { ...side, sist: stempel, feilRad: 0, grunn: null } : side;
  const feilRad = side.feilRad + 1;
  return feilRad >= RADAR.feilRad
    ? { ...side, sist: stempel, feilRad, pa: false, grunn: rensLinje(`Slått av etter ${RADAR.feilRad} feil på rad: ${utfall.feil}`, RADAR.melding) }
    : { ...side, sist: stempel, feilRad, grunn: utfall.feil };
}

/*
   Én kjøring fra start til slutt. Gir { kjort, grunn?, lagret, kjoring,
   nye, varsel }: kjort er false når Radar er av («av») eller en annen
   kjøring har leien («opptatt»); nye er innboksradene kjøringen la til,
   og varsel teksten til systemvarselet, eller null.

   jobber er søknadslisten, som bare leses. kilder kan byttes ut i
   tester. Kaster bare når lageret ikke kan leses i det hele tatt; alt
   annet havner i kjøringsloggen.
*/
export async function kjørRadar({ dokumenter, jobber = [], nett, kallModell, leverandor = "anthropic",
  nå = () => new Date(), signal, vent = ms => sov(ms, signal), eier = nyEier(), kilder = KILDER, varighet = LEIETID } = {}){
  const start = nå(), stempel = start.toISOString(), iDag = lokalDato(start);

  const første = await dokumenter.les(RADARFIL);
  if(!første.innstillinger.pa) return { kjort: false, grunn: "av" };
  const leid = await taLeie(dokumenter, { eier, nå: start, varighet });
  if(!leid) return { kjort: false, grunn: "opptatt" };

  /* Leien fornyes mellom kallene når halve tiden er gått, så en treg
     kilde ikke gjør at en annen kjøring tar over midt i. */
  let fornyet = start.getTime();
  const hold = async () => {
    if(nå().getTime() - fornyet < varighet / 2) return;
    if(!await fornyLeie(dokumenter, { eier, nå: nå(), varighet })) throw new Error("En annen kjøring tok over.");
    fornyet = nå().getTime();
  };

  const inn = leid.innstillinger;
  const logg = { start: stempel, slutt: null, promptversjon: RADAR_PROMPTVERSJON, kandidater: 0, nye: 0, vurdert: 0, treff: 0, utenVurdering: 0,
    kilder: [], bruk: null, feil: [] };
  const feil = new Set(), utfall = new Map(), inaktive = new Set();
  let vurdert = [], sendt = 0, pekereGjelder = true;

  try{
    const cv = String((await dokumenter.les("cv.json"))?.tekst ?? "").trim();
    if(!cv) throw new Error("Legg inn CV-en din, så kan Radar vurdere stillingene.");

    /* 2. Hent. Én kilde som feiler, stopper ikke de andre. */
    const hentet = [];
    for(const [i, j] of kildejobber(leid, kilder, start).entries()){
      avbrutt(signal);
      if(i) await vent(GRENSER.pause);
      await hold();
      try{
        const r = await j.kilde.hent({ nett, tilstand: j.tilstand, side: j.side, innstillinger: inn, nå: start, vent, signal });
        hentet.push(...r.kandidater.map(k => ({ k, j })));
        logg.kilder.push({ kilde: j.kilde.id, navn: j.navn, hentet: r.kandidater.length, feil: null });
        utfall.set(j.nøkkel, { tilstand: r.tilstand, feil: null });
      }catch(e){
        avbrutt(signal);
        logg.kilder.push({ kilde: j.kilde.id, navn: j.navn, hentet: 0, feil: melding(e) });
        utfall.set(j.nøkkel, { feil: melding(e) });
      }
    }
    logg.kandidater = hentet.length;

    /* 3 og 4. Forfilter og duplikater med det listene ga. */
    const før = hukommelse(leid, jobber), runde1 = [];
    for(const h of hentet){
      if(h.k.status === "inaktiv"){ for(const n of nøklerFor(h.k)) inaktive.add(n); continue; }
      if(forfilter(h.k, inn, iDag) || før.kjenner(h.k)) continue;
      før.husk(h.k);
      runde1.push(h);
    }

    /* 5. Detaljer innenfor kildens tak, så samme sjekk med hele teksten.
       En kandidat over taket vurderes ikke på bare tittelen. */
    const brukt = new Map(), etter = hukommelse(leid, jobber), klar = [];
    for(const h of runde1){
      let k = h.k;
      if(!k.detaljert && h.j.kilde.detalj){
        const n = brukt.get(h.j.nøkkel) ?? 0;
        if(n >= h.j.kilde.maksDetaljer){ logg.utenVurdering++; continue; }
        brukt.set(h.j.nøkkel, n + 1);
        avbrutt(signal);
        await vent(GRENSER.pause);
        await hold();
        try{ k = await h.j.kilde.detalj(k, { nett, side: h.j.side, signal }); }
        catch(e){ avbrutt(signal); feil.add(`${h.j.navn}: ${melding(e)}`); continue; }
        if(k.status === "inaktiv"){ for(const x of nøklerFor(k)) inaktive.add(x); continue; }
        if(forfilter(k, inn, iDag)) continue;
      }
      if(etter.kjenner(k)) continue;
      etter.husk(k);
      klar.push(k);
    }
    logg.nye = klar.length;

    /* 6. Vurdering innenfor takene. */
    if(klar.length){
      const igjenIDag = Math.max(0, inn.maksVurderingerPerDogn - (leid.forbruk.dato === iDag ? leid.forbruk.vurderinger : 0));
      await hold();
      const v = await vurderAlle({ kandidater: klar, cv, kallModell, leverandor, signal,
        tak: Math.min(MAKS_VURDERINGER_PER_KJORING, igjenIDag) });
      vurdert = v.vurdert;
      sendt = v.sendt;
      logg.utenVurdering += v.utenVurdering + v.forkastet.reduce((s, f) => s + f.antall, 0);
      logg.bruk = v.bruk;
      for(const f of v.forkastet) feil.add(`Vurderingen: ${rensLinje(f.melding, 200)} ${f.antall} annonser ble hoppet over.`);
      if(v.feil){ pekereGjelder = false; feil.add(`Vurderingen: ${melding(v.feil)}`); }
    }
  }catch(e){
    pekereGjelder = false;
    feil.add(melding(e));
  }

  logg.vurdert = vurdert.length;
  logg.feil = [...feil].slice(0, RADAR.kjoringsfeil);
  const over = vurdert.filter(x => x.v.prosent >= inn.terskel);
  let nye = [];

  /* 7. Legg kjøringen oppå siste versjon og slipp leien i samme skriving.
     Har en annen kjøring tatt leien imens, skrives ingenting: da er det
     den som eier dokumentet nå. */
  const lagret = await medNyeForsøk(dokumenter, d => {
    if(d.leie?.eier !== eier && leieGyldig(d.leie, nå())) return null;
    /* Brukeren kan ha avvist eller lagt til noe mens kjøringen pågikk. */
    const sistKjent = hukommelse({ avvist: d.avvist, avvistFingeravtrykk: d.avvistFingeravtrykk, innboks: d.innboks }, jobber);
    nye = over.filter(x => !sistKjent.kjenner(x.k)).map(x => innboksrad(x.k, x.v, start));
    const kildetilstand = { ...d.kildetilstand };
    for(const id of ["nav", "jobbnorge"]) kildetilstand[id] = nyKildetilstand(d.kildetilstand[id], utfall.get(id), pekereGjelder, stempel);
    const neste = {
      ...d, leie: null, kildetilstand,
      innstillinger: { ...d.innstillinger,
        karrieresider: d.innstillinger.karrieresider.map(s => nySide(s, utfall.get(s.id), pekereGjelder, stempel)) },
      sett: [...vurdert.map(x => ({ nokler: lagringsnøkler(x.k), fingeravtrykk: fingeravtrykk(x.k.selskap, x.k.stilling), dato: iDag })), ...d.sett],
      innboks: slåInnIInnboks(fjernInaktive(d.innboks, inaktive), nye),
      forbruk: d.forbruk.dato === iDag ? { dato: iDag, vurderinger: d.forbruk.vurderinger + sendt } : { dato: iDag, vurderinger: sendt },
      kjoringer: [{ ...logg, treff: nye.length, slutt: nå().toISOString() }, ...d.kjoringer].slice(0, RADAR.kjoringer)
    };
    return holdUnderTak(rydd(neste, start));
  }).catch(e => { logg.feil.push(`Lagringen: ${melding(e)}`); return null; });
  if(!lagret) await slippLeie(dokumenter, { eier }).catch(() => {});

  logg.treff = lagret ? nye.length : 0;
  logg.slutt = nå().toISOString();
  return { kjort: true, lagret: !!lagret, kjoring: logg, nye: lagret ? nye : [], varsel: lagret ? varseltekst(nye) : null };
}

/* ---------- det brukeren gjør i innboksen ---------- */

/* «Ikke interessert». Gir dokumentet etter endringen. */
export async function ikkeInteressert(dokumenter, id, { nå = () => new Date() } = {}){
  const d = await medNyeForsøk(dokumenter, r => r.innboks.some(x => x.id === id) ? avvis(r, id, nå()) : null);
  if(!d) throw new Brevfeil("finnes-ikke", "Stillingen er ikke i innboksen lenger.", 404);
  return d;
}

/* Søknaden «Legg til» skal lagre, før validerSoknad og uten id.
   Grensesnittet lagrer den i jobber.json og kaller så markerLagtTil.
   I den rekkefølgen: går det galt mellom de to, ligger søknaden i
   listen, og neste kjøring kjenner den igjen på lenken. */
export function soknadFraRad(rad, { nå = new Date() } = {}){
  return { selskap: rad.selskap, stilling: rad.stilling, sted: rad.sted, lenke: rad.url, frist: rad.frist ?? null,
    status: "todo", notat: "", hendelser: [lagHendelse("todo", { nå: new Date(nå), kilde: "radar" })] };
}
export async function markerLagtTil(dokumenter, id){
  const d = await medNyeForsøk(dokumenter, r => {
    const rad = r.innboks.find(x => x.id === id);
    if(!rad || rad.status === "lagtTil") return null;
    return { ...r, innboks: r.innboks.map(x => x.id === id ? { ...x, status: "lagtTil" } : x) };
  });
  return d ?? await dokumenter.les(RADARFIL);
}

/* ---------- karrieresidene ---------- */

/* Id-en avledes av adressen, så samme side ikke kan legges inn to
   ganger og id-en er stabil uten tilfeldighet. FNV-1a er nok: den
   skiller sider, den beskytter ingenting. */
function sideId(url){
  let h = 0x811c9dc5;
  for(const b of new TextEncoder().encode(url)){ h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return `side-${h.toString(16).padStart(8, "0")}`;
}

/*
   Legger til en karriereside. Typen gjenkjennes fra adressen, og ellers
   fra selve siden, som da hentes én gang gjennom hentSide med samme
   vern som importen. En side Radar ikke kan lese, avvises her med
   grunnen, i stedet for å bli slått av etter fem stille feil.
   Gir dokumentet etter endringen.
*/
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

/* ---------- det grensesnittet ser og gjør ---------- */

export const SOK_NA_PAUSE = 60_000;
export const ANTALL_KJORINGER_I_TILSTAND = 5;

/* Claude Haiku 5.5, dollar per million tokens, for prompter opp til
   100 000 tokens (en bolk er langt under). Et øyeblikksbilde fra
   prissiden i oktober 2026; endrer prisen seg, er det denne linjen som
   skal rettes. Bufrede tokens koster en tidel, og bufring en og en
   kvart gang så mye som vanlige. */
export const RADARPRIS = Object.freeze({ inn: 0.10, ut: 0.50, skriv: 0.125, les: 0.01 });

/* Omtrentlig kostnad i kroner for én kjøring, regnet fra tokenene.
   Radar bruker Haiku 5.5 hos Anthropic; hos OpenAI er tallet bare en
   pekepinn. */
export function kjoringskostnad(bruk){
  if(!bruk) return 0;
  const P = RADARPRIS;
  const dollar = ((bruk.input_tokens ?? 0) * P.inn + (bruk.cache_creation_input_tokens ?? 0) * P.skriv
    + (bruk.cache_read_input_tokens ?? 0) * P.les + (bruk.output_tokens ?? 0) * P.ut) / 1e6;
  const kr = dollar * KURS;
  return Math.round(kr * 10000) / 10000;
}

/*
   Alt flaten trenger i ett svar, uten hukommelsen (sett, avvist) og
   uten teksten til hver kjøring. Nye først i innboksen, så de som er
   lagt til. Leien sier om en kjøring pågår nå.
*/
export function tilstandFra(radar, nå = new Date()){
  const innboks = [...radar.innboks.filter(r => r.status === "ny"), ...radar.innboks.filter(r => r.status !== "ny")];
  const iDag = lokalDato(new Date(nå));
  const k = radar.kildetilstand;
  return {
    revisjon: radar.revisjon,
    innstillinger: radar.innstillinger,
    innboks,
    antallNye: radar.innboks.filter(r => r.status === "ny").length,
    karrieresider: radar.innstillinger.karrieresider,
    kilder: { nav: { sist: k.nav.sist, feil: k.nav.feil }, jobbnorge: { sist: k.jobbnorge.sist, feil: k.jobbnorge.feil } },
    kjoringer: radar.kjoringer.slice(0, ANTALL_KJORINGER_I_TILSTAND).map(x => ({ ...x, kostnad: kjoringskostnad(x.bruk) })),
    forbruk: { dato: iDag, vurderinger: radar.forbruk.dato === iDag ? radar.forbruk.vurderinger : 0,
      tak: radar.innstillinger.maksVurderingerPerDogn },
    kjorerNa: leieGyldig(radar.leie, nå)
  };
}

/* Innstillingene brukeren kan sette. Karrieresidene har egne veier inn,
   med status som bare kjøringene skal røre, så de tas fra dokumentet.
   Alt går gjennom samme normalisering som ved lesing, så en verdi som
   ikke passer, blir standardverdien i stedet for å havne i filen. */
const INNSTILLINGSFELT = ["pa", "terskel", "maksVurderingerPerDogn", "sokeord", "ekskluder", "steder", "kilder"];
export async function lagreInnstillinger(dokumenter, inn){
  if(!inn || typeof inn !== "object" || Array.isArray(inn)) throw new Brevfeil("ugyldig", "Innstillingene har feil form.");
  const feltene = Object.fromEntries(INNSTILLINGSFELT.filter(f => inn[f] !== undefined).map(f => [f, inn[f]]));
  const d = await medNyeForsøk(dokumenter, r => {
    const ny = validerRadar({ ...r, innstillinger: { ...r.innstillinger, ...feltene, karrieresider: r.innstillinger.karrieresider } });
    return { ...r, innstillinger: ny.innstillinger };
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

/* En side som er slått av etter fem feil på rad, slås på igjen av
   brukeren. Telleren nullstilles, og «sist» tømmes, så den hentes i
   neste kjøring i stedet for om seks timer. */
export async function slåPåKarriereside(dokumenter, id){
  const d = await medNyeForsøk(dokumenter, r => r.innstillinger.karrieresider.some(s => s.id === id)
    ? { ...r, innstillinger: { ...r.innstillinger, karrieresider: r.innstillinger.karrieresider.map(s => s.id === id
      ? { ...s, pa: true, feilRad: 0, grunn: null, sist: null } : s) } } : null);
  if(!d) throw new Brevfeil("finnes-ikke", "Karrieresiden er ikke i listen lenger.", 404);
  return d;
}

/*
   «Søk nå»: en vanlig kjøring, men høyst én i minuttet. Grensen er
   både i minnet (to klikk i samme øyeblikk) og i kjøringsloggen i
   radar.json (to prosesser, og en omlasting av siden). Den som venter
   for kort, får vite hvor lenge.
*/
const sisteSøk = new WeakMap();
export async function søkNå(args){
  const { dokumenter } = args, nå = (args.nå ?? (() => new Date()))().getTime();
  const for_mange = sist => new Brevfeil("for-mange",
    `Radar har nettopp kjørt. Prøv igjen om ${Math.ceil((SOK_NA_PAUSE - (nå - sist)) / 1000)} sekunder.`, 429);
  /* Minnet sjekkes og settes før første await, ellers slipper to klikk gjennom. */
  const iMinnet = sisteSøk.get(dokumenter) ?? 0;
  if(nå - iMinnet < SOK_NA_PAUSE) throw for_mange(iMinnet);
  sisteSøk.set(dokumenter, nå);
  /* Bare kjøringer som nådde kildene, teller. En som stoppet før, for
     eksempel fordi CV-en manglet, har ikke spurt noen og skal ikke
     sperre «Søk nå» når CV-en er lagt inn. */
  const sist = Date.parse((await dokumenter.les(RADARFIL)).kjoringer.find(k => k.kilder.length)?.start) || 0;
  if(nå - sist < SOK_NA_PAUSE) throw for_mange(sist);
  return kjørRadar(args);
}

/*
   «Legg til»: søknaden er lagret av grensesnittet. Her kommer annonsen
   på dokumentet til søknaden, raden merkes, og så vurderes den på
   vanlig måte, som for enhver annonse som lagres. Annonsen først: går
   noe galt, står raden som ny og kan legges til igjen uten tap.
   lagreAnnonse og vurder kommer utenfra (jobbdokumenttjenesten, og
   matchen, som aldri skal stoppe resten eller holde tilbake svaret). marker er markerLagtTil over
   den veien klienten har til radar.json.
*/
export async function leggTilFraRad({ rad, jobbId, lagreAnnonse, marker, vurder }){
  await lagreAnnonse(jobbId, { tekst: rad.tekst, url: rad.url, kilde: "radar" });
  const d = await marker(rad.id);
  /* Ikke avventet: vurderingen tar noen sekunder, og «Vurder» i panelet prøver igjen om den feiler. */
  try{ Promise.resolve(vurder?.(jobbId)).catch(() => {}); }catch{ /* som over */ }
  return d;
}
