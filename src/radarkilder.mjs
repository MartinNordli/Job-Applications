/* ============================================================
   Radarkildene: én adapter per kilde, alle med samme form.

     { id, maksDetaljer, hent(ktx) → { kandidater, tilstand, kall },
       detalj?(kandidat, ktx) → kandidat }

   ktx er { nett, tilstand, side, innstillinger, nå, vent, signal }.
   nett er { hentJson, hentSide } fra src/radarnett.mjs, så samme kode
   kjører i Node og i appen. vent(ms) er pausen mellom kall, injisert
   så testene går uten å vente. Ingen adapter skriver noe: tilstanden
   de gir tilbake, lagres av src/radarlogikk.mjs.

   Alle kildene gir kandidater med samme form:

     { kilde, kildeId, url, lenker[], selskap, stilling, sted,
       frist, publisert, tekst, status: "aktiv"|"inaktiv", detaljert }

   `detaljert` sier om teksten er hele annonsen. Er den ikke det, og
   kandidaten passer forfilteret, henter kjernen detaljen, innenfor
   kildens tak. Det er listene som er billige; detaljene koster.

   Alt som kommer herfra er data fra fremmede sider. Det kortes, renses
   for kontrolltegn og går gjennom samme tekstrensing som en hentet
   side. Kontaktpersonene i NAVs detaljer leses aldri ut: de er ekte
   personer og skal verken lagres eller til modellen.

   Endepunktene, takene og særhetene (NAVs overlappende sider, 304 som
   bare kommer med ett sekund ekstra, Greenhouse-innhold som er
   entitetskodet) er målt i spiken på branchen spike/radar-bakgrunn, og
   står forklart ved hver kilde under.
   ============================================================ */

import { avkod, renskTekst } from "./importlogikk.mjs";
import { normaliserIsoDato } from "./felles.mjs";
import { RADAR } from "./jobbdokument.mjs";

export const NAV_BASE = "https://pam-stilling-feed.nav.no";
export const JOBBNORGE_BASE = "https://publicapi.jobbnorge.no";
export const GREENHOUSE_BASE = "https://boards-api.greenhouse.io";
export const LEVER_BASE = "https://api.lever.co";

/* Takene per kjøring, fra målingene i spiken. */
export const GRENSER = Object.freeze({
  navSider: 20, navSidestorrelse: 200, navDetaljer: 60,
  jobbnorgeSider: 3, jobbnorgeResultater: 50, jobbnorgeDetaljer: 20,
  karriereDetaljer: 10, pause: 1000, tekst: 12_000
});

/* ---------- felles byggeklosser ---------- */

/* Kontrolltegn og retningsmerker ut, mellomrom samlet, kortet på
   kodepunkter. Linjeskift beholdes bare i brødteksten. */
const KONTROLL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
export function rensLinje(v, maks = RADAR.navn){
  if(typeof v !== "string" && typeof v !== "number") return "";
  const t = String(v).replace(KONTROLL, " ").replace(/\s+/gu, " ").trim();
  return Array.from(t).slice(0, maks).join("");
}
function rensTekst(v, maks = GRENSER.tekst){
  const t = String(v ?? "").replace(/\r\n?/g, "\n").replace(/[^\S\n]+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, c => c === "\n" ? "\n" : " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return Array.from(t).slice(0, maks).join("");
}
/* HTML fra en kilde blir lesbar tekst, med samme rensing som en hentet side. */
const fraHtml = html => rensTekst(renskTekst(String(html ?? "")));

function lenke(v){
  if(typeof v !== "string" || !v.trim() || v.length > 2000) return null;
  try{ const u = new URL(v.trim()); return ["http:", "https:"].includes(u.protocol) ? u.href : null; }
  catch{ return null; }
}
/* Et ISO-tidspunkt med sone beholdes som kilden skrev det, så
   «2026-10-09T00:00:00+02:00» ikke blir 8. oktober i UTC. Alt annet
   (RFC 822 fra RSS, millisekunder fra Lever) blir ISO i UTC. */
const ISO_MED_SONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const tidspunkt = v => {
  if(typeof v === "string" && v.length <= 40 && ISO_MED_SONE.test(v.trim()) && !Number.isNaN(Date.parse(v))) return v.trim();
  const ms = typeof v === "number" ? v : Date.parse(String(v ?? ""));
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
};
const frist = v => normaliserIsoDato(typeof v === "string" ? v.trim() : "");

/* «VESTVÅGØY» → «Vestvågøy», «NORD-AURDAL» → «Nord-Aurdal». */
const tittelform = v => rensLinje(v).toLocaleLowerCase("nb").replace(/(^|[\s\-/(])(\p{L})/gu, (_, f, b) => f + b.toLocaleUpperCase("nb"));

/* Én kandidat i fellesformen, eller null hvis den mangler det som må
   til: en id og en lenke man kan åpne. */
export function kandidat(k){
  const url = lenke(k.url);
  const kildeId = rensLinje(k.kildeId, 160);
  if(!url || !kildeId) return null;
  return {
    kilde: k.kilde, kildeId, url,
    lenker: [...new Set([url, ...(k.lenker ?? []).map(lenke).filter(Boolean)])].slice(0, RADAR.lenker),
    selskap: rensLinje(k.selskap), stilling: rensLinje(k.stilling), sted: rensLinje(k.sted),
    frist: k.frist ?? null, publisert: k.publisert ?? null,
    tekst: rensTekst(k.tekst), status: k.status === "inaktiv" ? "inaktiv" : "aktiv",
    detaljert: !!k.detaljert
  };
}

export class Kildefeil extends Error {}
const ukjentFormat = navn => new Kildefeil(`${navn} svarte i et format Radar ikke kjenner.`);
const erObjekt = v => !!v && typeof v === "object" && !Array.isArray(v);
const ID = /^[A-Za-z0-9_-]{1,80}$/;

function sjekkAvbrudd(signal){
  if(signal?.aborted) throw new Kildefeil("Kjøringen ble avbrutt.");
}

/* ---------- NAV ---------- */
/*
   Første kjøring henter ?last, den nyeste siden, og lagrer side-id-en.
   Å gå dager tilbake med If-Modified-Since er så tregt hos NAV at det
   ga 504; Jobbnorge dekker de siste dagene i stedet.

   Senere kjøringer følger next_url fra den lagrede siden. Sidene
   overlapper med ett innslag, og samme annonse står der én gang per
   endring, så bare den siste linjen per id beholdes.

   På den siste siden (next_id er null) lagres ETag og Last-Modified.
   304 kommer bare når If-Modified-Since er etter sidens siste endring,
   og tjeneren sammenlikner med millisekunder mens hodet er rundet ned
   til hele sekunder. Derfor ett sekund til.
*/
export function plussEttSekund(sistEndret){
  const ms = Date.parse(String(sistEndret ?? ""));
  return Number.isFinite(ms) ? new Date(ms + 1000).toUTCString() : null;
}

/* next_url er relativ. Den settes sammen med NAVs vert og må bli
   værende der; hentJson ville avvist en annen vert uansett, men her
   blir feilen forståelig. */
function navSide(rel){
  let u;
  try{ u = new URL(String(rel ?? ""), NAV_BASE); }catch{ throw ukjentFormat("NAV"); }
  if(u.origin !== NAV_BASE || !u.pathname.startsWith("/api/v1/feed/")) throw new Kildefeil("NAV pekte videre til en ukjent adresse.");
  if(!u.searchParams.has("pageSize")) u.searchParams.set("pageSize", String(GRENSER.navSidestorrelse));
  return u.href;
}

/* Linjene fra feeden, én per annonse, den siste vinner. */
export function navLinjer(items){
  const per = new Map();
  for(const it of Array.isArray(items) ? items : []){
    const fe = erObjekt(it?._feed_entry) ? it._feed_entry : {};
    const id = typeof it?.id === "string" && ID.test(it.id) ? it.id : null;
    if(!id) continue;
    /* En ukjent status hoppes over: INACTIVE fjerner annonsen fra
       innboksen, og det skal bare skje når NAV faktisk sier det. */
    const status = fe.status === "ACTIVE" ? "aktiv" : fe.status === "INACTIVE" ? "inaktiv" : null;
    if(!status) continue;
    per.delete(id);
    per.set(id, { id, status,
      tittel: fe.title ?? it.title, selskap: fe.businessName, sted: fe.municipal, endret: fe.sistEndret ?? it.date_modified });
  }
  return [...per.values()];
}

const navLenke = id => `https://arbeidsplassen.nav.no/stillinger/stilling/${id}`;

export const nav = {
  id: "nav",
  maksDetaljer: GRENSER.navDetaljer,
  async hent({ nett, tilstand = {}, vent = sov, signal } = {}){
    let url, etag = null, sistEndret = null;
    if(tilstand?.side && ID.test(tilstand.side)){
      url = `${NAV_BASE}/api/v1/feed/${tilstand.side}?pageSize=${GRENSER.navSidestorrelse}`;
      etag = tilstand.etag ?? null;
      sistEndret = plussEttSekund(tilstand.sistEndret);
    }else{
      url = `${NAV_BASE}/api/v1/feed?last`;
    }
    let ny = { side: tilstand?.side ?? null, etag: tilstand?.etag ?? null, sistEndret: tilstand?.sistEndret ?? null };
    const items = [];
    let kall = 0;
    let fraLagret = url !== `${NAV_BASE}/api/v1/feed?last`;
    while(url && kall < GRENSER.navSider){
      sjekkAvbrudd(signal);
      if(kall) await vent(GRENSER.pause);
      let svar;
      try{
        svar = await nett.hentJson(url, { kilde: "nav", etag, sistEndret });
      }catch(feil){
        /* En lagret side NAV ikke lenger svarer på, ville stått fast for
           alltid. Feiler den første siden, begynner vi på nytt fra den
           nyeste, én gang. Er det nettet som er nede, feiler den også,
           og den lagrede siden står urørt til neste kjøring. */
        if(!fraLagret || kall || signal?.aborted) throw feil;
        fraLagret = false;
        url = `${NAV_BASE}/api/v1/feed?last`;
        etag = sistEndret = null;
        kall++;
        continue;
      }
      kall++;
      if(svar?.status === 304) break;
      const side = svar?.json;
      if(!erObjekt(side) || !Array.isArray(side.items) || typeof side.id !== "string" || !ID.test(side.id)) throw ukjentFormat("NAV");
      items.push(...side.items);
      if(typeof side.next_id === "string" && ID.test(side.next_id) && side.next_url){
        url = navSide(side.next_url);
        ny = { side: side.next_id, etag: null, sistEndret: null };
        etag = sistEndret = null;
      }else{
        ny = { side: side.id, etag: svar.etag ?? null, sistEndret: svar.sistEndret ?? null };
        url = null;
      }
    }
    const kandidater = navLinjer(items).map(l => kandidat({
      kilde: "nav", kildeId: l.id, url: navLenke(l.id), selskap: l.selskap,
      stilling: l.status === "aktiv" ? l.tittel : "", sted: l.status === "aktiv" ? tittelform(l.sted) : "",
      status: l.status
    })).filter(Boolean);
    return { kandidater, tilstand: ny, kall };
  },

  /* Detaljen har hele teksten, frist og lenkene. Kontaktlisten leses
     ikke ut. En inaktiv annonse har ingen ad_content i det hele tatt. */
  async detalj(k, { nett } = {}){
    const svar = await nett.hentJson(`${NAV_BASE}/api/v1/feedentry/${encodeURIComponent(k.kildeId)}`, { kilde: "nav" });
    const d = svar?.json;
    if(!erObjekt(d)) throw ukjentFormat("NAV");
    const a = d.ad_content;
    if(d.status === "INACTIVE") return { ...k, status: "inaktiv", detaljert: true };
    if(d.status !== "ACTIVE" || !erObjekt(a)) throw ukjentFormat("NAV");
    const steder = [...new Set((Array.isArray(a.workLocations) ? a.workLocations : [])
      .map(s => tittelform(s?.city || s?.municipal || s?.county || "")).filter(Boolean))].slice(0, 3);
    return kandidat({
      kilde: "nav", kildeId: k.kildeId,
      url: lenke(a.link) ?? k.url,
      lenker: [a.link, a.sourceurl, a.applicationUrl, k.url],
      selskap: a.employer?.name || k.selskap, stilling: a.title || k.stilling,
      sted: steder.join(" / ") || k.sted,
      frist: frist(a.applicationDue), publisert: tidspunkt(a.published),
      tekst: fraHtml(a.description), status: "aktiv", detaljert: true
    }) ?? { ...k, detaljert: true };
  }
};

/* ---------- Jobbnorge ---------- */
/*
   Det åpne API-et nettsiden selv bruker, med Swagger på
   publicapi.jobbnorge.no. Nyeste først, 0-basert sidevisning, uten
   søkeord: «term» treffer bare hele ord, og norske sammensetninger
   («dataingeniør») ville falt bort. Forfilteret gjør jobben i stedet.

   Første gang en uke tilbake, deretter ett døgn. Neste side hentes
   bare når hele siden var nyere enn den høyeste id-en vi har sett.
*/
export function jobbnorgeSøk({ side = 0, periode = "Day", fylker = [] } = {}){
  const p = new URLSearchParams({ orderby: "Published", period: periode, results: String(GRENSER.jobbnorgeResultater), page: String(side) });
  for(const f of fylker) if(Number.isInteger(f) && f > 0) p.append("county", String(f));
  return `${JOBBNORGE_BASE}/v3/jobs?${p}`;
}

function jobbnorgeKandidat(j){
  if(!erObjekt(j) || !Number.isSafeInteger(j.id) || j.id <= 0) return null;
  const steder = [...new Set((Array.isArray(j.locations) ? j.locations : [])
    .map(s => rensLinje(s?.area || s?.municipality || s?.county || "")).filter(Boolean))].slice(0, 3);
  return kandidat({
    kilde: "jobbnorge", kildeId: String(j.id),
    url: lenke(j.link) ?? `https://www.jobbnorge.no/ledige-stillinger/stilling/${j.id}`,
    selskap: j.employer, stilling: j.title, sted: steder.join(" / "),
    frist: frist(j.deadline), publisert: normaliserIsoDato(String(j.publicationDate ?? "")),
    tekst: rensTekst(j.summary), status: "aktiv"
  });
}

export const jobbnorge = {
  id: "jobbnorge",
  maksDetaljer: GRENSER.jobbnorgeDetaljer,
  async hent({ nett, tilstand = {}, innstillinger, vent = sov, signal } = {}){
    const sisteId = Number.isSafeInteger(tilstand?.sisteId) ? tilstand.sisteId : null;
    const fylker = innstillinger?.kilder?.jobbnorge?.fylker ?? [];
    const periode = sisteId === null ? "Week" : "Day";
    const kandidater = [];
    let høyeste = sisteId, kall = 0;
    for(let side = 0; side < GRENSER.jobbnorgeSider; side++){
      sjekkAvbrudd(signal);
      if(kall) await vent(GRENSER.pause);
      const svar = await nett.hentJson(jobbnorgeSøk({ side, periode, fylker }), { kilde: "jobbnorge" });
      kall++;
      const jobs = svar?.json?.jobs;
      if(!Array.isArray(jobs)) throw ukjentFormat("Jobbnorge");
      for(const j of jobs){
        const k = jobbnorgeKandidat(j);
        if(!k) continue;
        kandidater.push(k);
        høyeste = Math.max(høyeste ?? 0, Number(k.kildeId));
      }
      const alleNye = sisteId === null || jobs.every(j => Number(j?.id) > sisteId);
      if(jobs.length < GRENSER.jobbnorgeResultater || !alleNye) break;
    }
    return { kandidater, tilstand: { sisteId: høyeste }, kall };
  },

  /* Annonseteksten er overskriftene og tekstene i komponentene, i
     sortOrder-rekkefølge og uten bildene. Frist, arbeidsgiver og sted
     står ikke her; de kom fra søket. */
  async detalj(k, { nett } = {}){
    const svar = await nett.hentJson(`${JOBBNORGE_BASE}/v2/joblisting?jobId=${encodeURIComponent(k.kildeId)}&languageId=1`, { kilde: "jobbnorge" });
    return { ...k, tekst: jobbnorgeTekst(svar?.json) || k.tekst, detaljert: true };
  }
};

export function jobbnorgeTekst(d){
  const deler = (Array.isArray(d?.components) ? d.components : []).filter(erObjekt)
    .filter(c => c.type !== "Image")
    .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0))
    .flatMap(c => [c.heading ? `<h2>${c.heading}</h2>` : "", c.text_1, c.text_2]
      .filter(t => typeof t === "string" && t && !/^(?:Image|Source):/i.test(t)));
  return fraHtml(deler.join("\n"));
}

/* ---------- karrieresider ---------- */
/*
   Typen gjenkjennes fra adressen når siden legges til, og ellers fra
   siden selv (oppdagTypeFraSide). Greenhouse og Lever har åpne
   JSON-API-er, Teamtailor har jobs.rss, og ellers leses JobPosting i
   JSON-LD på siden. Workday krever POST og Webcruiter forbyr alt annet
   enn Googlebot i robots.txt; de støttes ikke, og brukeren får vite
   hvorfor.
*/
const IKKE_STØTTET = [
  [/(^|\.)myworkdayjobs\.com$/i, "Workday-sider krever POST og støttes ikke av Radar."],
  [/(^|\.)webcruiter\.(com|no)$/i, "Webcruiter tillater ikke automatisk henting (robots.txt) og støttes ikke av Radar."]
];

export function oppdagType(url){
  let u;
  try{ u = new URL(String(url ?? "").trim()); }catch{ return { type: null, grunn: "Lim inn hele adressen til karrieresiden." }; }
  if(u.protocol !== "https:" && u.protocol !== "http:") return { type: null, grunn: "Bare http- og https-adresser kan brukes." };
  const vert = u.hostname.toLowerCase(), deler = u.pathname.split("/").filter(Boolean);
  for(const [m, grunn] of IKKE_STØTTET) if(m.test(vert)) return { type: null, grunn };
  if(/^(job-boards|boards)(\.eu)?\.greenhouse\.io$/.test(vert)){
    const token = deler[0] === "embed" ? u.searchParams.get("for") : deler[0];
    if(token && ID.test(token)) return { type: "greenhouse", nokkel: token };
  }
  if(vert === "boards-api.greenhouse.io" && deler[0] === "v1" && deler[1] === "boards" && ID.test(deler[2] ?? ""))
    return { type: "greenhouse", nokkel: deler[2] };
  if(vert === "jobs.lever.co" && ID.test(deler[0] ?? "")) return { type: "lever", nokkel: deler[0] };
  if(vert === "api.lever.co" && deler[0] === "v0" && deler[1] === "postings" && ID.test(deler[2] ?? ""))
    return { type: "lever", nokkel: deler[2] };
  if(vert.endsWith(".lever.co")) return { type: null, grunn: "Lever-sider på EU-instansen støttes ikke ennå." };
  if(/^[a-z0-9-]+\.teamtailor\.com$/.test(vert)) return { type: "teamtailor", nokkel: u.origin };
  return { type: "jsonld" };
}

/* En karriereside på eget domene kan likevel være Greenhouse, Lever
   eller Teamtailor under. Lenkene og ressursene på siden sier det. */
export function oppdagTypeFraSide(html, url){
  const fra = oppdagType(url);
  if(fra.type !== "jsonld") return fra;
  const h = String(html ?? "");
  for(const m of h.matchAll(/https?:\/\/(?:job-boards(?:\.eu)?|boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([A-Za-z0-9_-]{1,80})/g))
    if(m[1] !== "embed") return { type: "greenhouse", nokkel: m[1] };
  const lever = h.match(/https?:\/\/jobs\.lever\.co\/([A-Za-z0-9_-]{1,80})/);
  if(lever) return { type: "lever", nokkel: lever[1] };
  if(/teamtailor-cdn\.com|teamtailor\.com\/(?:assets|careersite)/i.test(h)){
    try{ return { type: "teamtailor", nokkel: new URL(url).origin }; }catch{ /* faller til jsonld */ }
  }
  return fra;
}

/* Adressen som lagres for siden. Er typen funnet på selve siden (et
   eget domene med Greenhouse eller Lever under), lagres den kjente
   adressen til tavlen i stedet, så nøkkelen kan leses ut av adressen
   hver gang uten at siden hentes på nytt. Teamtailor kan ligge på eget
   domene, og der er det domenet som er nøkkelen. */
export function karriereadresse({ type, nokkel }, url){
  if(type === "greenhouse") return `https://job-boards.greenhouse.io/${nokkel}`;
  if(type === "lever") return `https://jobs.lever.co/${nokkel}`;
  if(type === "teamtailor") return nokkel;
  return new URL(String(url).trim()).href;
}

function nøkkelFor(side, type){
  if(type === "teamtailor"){
    try{ return new URL(side.url).origin; }catch{ return null; }
  }
  const o = oppdagType(side?.url);
  return o.type === type ? o.nokkel : null;
}
const manglerNøkkel = type => new Kildefeil(`Fant ikke ${type}-navnet i adressen til karrieresiden.`);

/* Greenhouse: listen uten content (den kan gå over 5 MiB), og detaljen
   bare for nye stillinger som passer forfilteret. content er HTML som
   er entitetskodet én gang ekstra. */
export const greenhouse = {
  id: "greenhouse",
  maksDetaljer: GRENSER.karriereDetaljer,
  async hent({ nett, side } = {}){
    const token = nøkkelFor(side, "greenhouse");
    if(!token) throw manglerNøkkel("Greenhouse");
    const svar = await nett.hentJson(`${GREENHOUSE_BASE}/v1/boards/${token}/jobs`, { kilde: "greenhouse" });
    const jobs = svar?.json?.jobs;
    if(!Array.isArray(jobs)) throw ukjentFormat("Greenhouse");
    const kandidater = jobs.filter(erObjekt).map(j => {
      const tekst = typeof j.content === "string" ? fraHtml(avkod(j.content)) : "";
      return kandidat({ kilde: "greenhouse", kildeId: String(j.id ?? ""), url: j.absolute_url,
        selskap: side?.navn || j.company_name, stilling: j.title, sted: j.location?.name,
        frist: frist(j.application_deadline), publisert: tidspunkt(j.first_published ?? j.updated_at),
        tekst, detaljert: !!tekst });
    }).filter(Boolean);
    return { kandidater, tilstand: null, kall: 1 };
  },
  async detalj(k, { nett, side } = {}){
    const token = nøkkelFor(side, "greenhouse");
    if(!token || !/^\d{1,20}$/.test(k.kildeId)) return { ...k, detaljert: true };
    const svar = await nett.hentJson(`${GREENHOUSE_BASE}/v1/boards/${token}/jobs/${k.kildeId}`, { kilde: "greenhouse" });
    const c = svar?.json?.content;
    return { ...k, tekst: typeof c === "string" ? fraHtml(avkod(c)) : k.tekst, detaljert: true };
  }
};

/* Lever: én liste med hele teksten, uten omslag. Tomme beskrivelser
   finnes («Åpen søknad») og må tåles. */
export const lever = {
  id: "lever",
  maksDetaljer: 0,
  async hent({ nett, side } = {}){
    const firma = nøkkelFor(side, "lever");
    if(!firma) throw manglerNøkkel("Lever");
    const svar = await nett.hentJson(`${LEVER_BASE}/v0/postings/${firma}?mode=json`, { kilde: "lever" });
    if(!Array.isArray(svar?.json)) throw ukjentFormat("Lever");
    const kandidater = svar.json.filter(erObjekt).map(p => {
      const lister = (Array.isArray(p.lists) ? p.lists : []).filter(erObjekt)
        .map(l => `<h3>${l.text ?? ""}</h3><ul>${l.content ?? ""}</ul>`).join("\n");
      const tekst = [p.descriptionPlain ? rensTekst(p.descriptionPlain) : fraHtml(p.description), fraHtml(lister),
        p.additionalPlain ? rensTekst(p.additionalPlain) : fraHtml(p.additional)].filter(Boolean).join("\n\n");
      const steder = Array.isArray(p.categories?.allLocations) && p.categories.allLocations.length
        ? p.categories.allLocations : [p.categories?.location];
      return kandidat({ kilde: "lever", kildeId: String(p.id ?? ""), url: p.hostedUrl, lenker: [p.applyUrl],
        selskap: side?.navn || firma, stilling: p.text, sted: steder.filter(Boolean).slice(0, 3).join(" / "),
        publisert: tidspunkt(p.createdAt), tekst, detaljert: true });
    }).filter(Boolean);
    return { kandidater, tilstand: null, kall: 1 };
  }
};

/* Teamtailor: jobs.rss på sidens eget domene, gjennom hentSide som
   godtar xml. Beskrivelsen er HTML entitetskodet i XML-en. */
function xmlFelt(blokk, navn){
  const m = blokk.match(new RegExp(`<${navn}(?:\\s[^>]*)?>([\\s\\S]*?)</${navn}>`, "i"));
  if(!m) return "";
  const cdata = m[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : avkod(m[1]);
}
export function tolkTeamtailorRss(xml, side = {}){
  const s = String(xml ?? "");
  const kanal = s.replace(/<item\b[\s\S]*$/i, "");
  const selskap = side.navn || rensLinje(xmlFelt(kanal, "title"));
  return [...s.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(([, b]) => {
    const byer = [...b.matchAll(/<tt:city>([\s\S]*?)<\/tt:city>/gi)].map(m => rensLinje(avkod(m[1]))).filter(Boolean);
    const link = rensLinje(xmlFelt(b, "link"), 2000);
    return kandidat({ kilde: "teamtailor", kildeId: rensLinje(xmlFelt(b, "guid"), 160) || link, url: link,
      selskap, stilling: xmlFelt(b, "title"), sted: [...new Set(byer)].slice(0, 3).join(" / "),
      publisert: tidspunkt(xmlFelt(b, "pubDate")), tekst: fraHtml(xmlFelt(b, "description")), detaljert: true });
  }).filter(Boolean);
}
export const teamtailor = {
  id: "teamtailor",
  maksDetaljer: 0,
  async hent({ nett, side } = {}){
    const opphav = nøkkelFor(side, "teamtailor");
    if(!opphav) throw manglerNøkkel("Teamtailor");
    const svar = await nett.hentSide(`${opphav}/jobs.rss`);
    if(!/<rss\b/i.test(String(svar?.html ?? ""))) throw ukjentFormat("Teamtailor");
    return { kandidater: tolkTeamtailorRss(svar.html, side), tilstand: null, kall: 1 };
  }
};

/* JSON-LD: alle JobPosting på siden, også i @graph og ItemList. En
   side uten noen er en feil, ikke en tom liste: da har brukeren lagt
   inn en side Radar ikke kan lese, og etter fem forsøk slås den av med
   den forklaringen. */
function jobPostinger(node, ut = [], dybde = 0){
  if(!node || typeof node !== "object" || dybde > 8 || ut.length >= 200) return ut;
  if(Array.isArray(node)){ for(const n of node) jobPostinger(n, ut, dybde + 1); return ut; }
  const type = [].concat(node["@type"] ?? []).map(t => String(t).toLowerCase());
  if(type.includes("jobposting")) ut.push(node);
  for(const k of ["@graph", "mainEntity", "itemListElement", "item"]) jobPostinger(node[k], ut, dybde + 1);
  return ut;
}
const plukk = v => Array.isArray(v) ? plukk(v[0]) : erObjekt(v) ? (v.name ?? v.value ?? v["@value"] ?? "") : (v ?? "");
/* identifier er ofte en PropertyValue der name er arbeidsgiveren og
   value er id-en. */
const plukkId = v => Array.isArray(v) ? plukkId(v[0]) : erObjekt(v) ? (v.value ?? v["@value"] ?? v.name ?? "") : (v ?? "");
export function tolkJsonLd(html, side = {}){
  const noder = [];
  for(const m of String(html ?? "").matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)){
    try{ jobPostinger(JSON.parse(m[1].trim()), noder); }catch{ /* én ødelagt blokk velter ikke de andre */ }
  }
  return noder.map(jp => {
    const steder = [].concat(jp.jobLocation ?? []).map(l => rensLinje(plukk(l?.address?.addressLocality) || plukk(l?.address?.addressRegion) || plukk(l?.name)))
      .filter(Boolean);
    const url = lenke(plukk(jp.url)) ?? lenke(side.url);
    const id = rensLinje(plukkId(jp.identifier), 160) || rensLinje(plukk(jp.url), 160) || rensLinje(plukk(jp.title), 160);
    return kandidat({ kilde: "jsonld", kildeId: id, url, selskap: side.navn || plukk(jp.hiringOrganization),
      stilling: plukk(jp.title), sted: [...new Set(steder)].slice(0, 3).join(" / "),
      frist: frist(plukk(jp.validThrough)), publisert: tidspunkt(plukk(jp.datePosted)),
      tekst: fraHtml(avkod(plukk(jp.description))), detaljert: true });
  }).filter(Boolean);
}
export const jsonld = {
  id: "jsonld",
  maksDetaljer: 0,
  async hent({ nett, side } = {}){
    const svar = await nett.hentSide(side.url);
    const kandidater = tolkJsonLd(svar?.html, { ...side, url: svar?.sluttUrl || side.url });
    if(!kandidater.length) throw new Kildefeil("Fant ingen stillinger med strukturerte data (JobPosting) på siden.");
    return { kandidater, tilstand: null, kall: 1 };
  }
};

export const KILDER = Object.freeze({ nav, jobbnorge, greenhouse, lever, teamtailor, jsonld });

export function sov(ms, signal){
  return new Promise(ok => {
    if(signal?.aborted) return ok();
    const t = setTimeout(ok, ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(t); ok(); }, { once: true });
  });
}
