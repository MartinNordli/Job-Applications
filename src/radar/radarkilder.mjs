import { avkod, renskTekst } from "../import/importlogikk.mjs";
import { normaliserIsoDato } from "../felles/felles.mjs";
import { RADAR } from "../stilling/jobbdokument.mjs";

export const NAV_BASE = "https://pam-stilling-feed.nav.no";
const JOBBNORGE_BASE = "https://publicapi.jobbnorge.no";
const GREENHOUSE_BASE = "https://boards-api.greenhouse.io";
const LEVER_BASE = "https://api.lever.co";

export const GRENSER = Object.freeze({
  navSider: 20, navSidestorrelse: 200, navDetaljer: 60,
  navSokDager: 90, navSokSider: 60, navSokSidestorrelse: 4000,
  jobbnorgeSider: 3, jobbnorgeResultater: 50, jobbnorgeDetaljer: 20,
  jobbnorgeSokSider: 5, jobbnorgeSokResultater: 1000,
  karriereDetaljer: 10, pause: 1000, tekst: 12_000
});

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
const fraHtml = html => rensTekst(renskTekst(String(html ?? "")));

function lenke(v){
  if(typeof v !== "string" || !v.trim() || v.length > 2000) return null;
  try{ const u = new URL(v.trim()); return ["http:", "https:"].includes(u.protocol) ? u.href : null; }
  catch{ return null; }
}
const ISO_MED_SONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const tidspunkt = v => {
  if(typeof v === "string" && v.length <= 40 && ISO_MED_SONE.test(v.trim()) && !Number.isNaN(Date.parse(v))) return v.trim();
  const ms = typeof v === "number" ? v : Date.parse(String(v ?? ""));
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
};
const frist = v => normaliserIsoDato(typeof v === "string" ? v.trim() : "");

const tittelform = v => rensLinje(v).toLocaleLowerCase("nb").replace(/(^|[\s\-/(])(\p{L})/gu, (_, f, b) => f + b.toLocaleUpperCase("nb"));

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

class Kildefeil extends Error {}
const ukjentFormat = navn => new Kildefeil(`${navn} svarte i et format Radar ikke kjenner.`);
const erObjekt = v => !!v && typeof v === "object" && !Array.isArray(v);
const ID = /^[A-Za-z0-9_-]{1,80}$/;

function sjekkAvbrudd(signal){
  if(signal?.aborted) throw new Kildefeil("Kjøringen ble avbrutt.");
}

function plussEttSekund(sistEndret){
  const ms = Date.parse(String(sistEndret ?? ""));
  return Number.isFinite(ms) ? new Date(ms + 1000).toUTCString() : null;
}

function navSide(rel, størrelse = GRENSER.navSidestorrelse){
  let u;
  try{ u = new URL(String(rel ?? ""), NAV_BASE); }catch{ throw ukjentFormat("NAV"); }
  if(u.origin !== NAV_BASE || !u.pathname.startsWith("/api/v1/feed/")) throw new Kildefeil("NAV pekte videre til en ukjent adresse.");
  u.searchParams.set("pageSize", String(størrelse));
  return u.href;
}
const gyldigSide = side => erObjekt(side) && Array.isArray(side.items) && typeof side.id === "string" && ID.test(side.id);
const harNeste = side => typeof side.next_id === "string" && ID.test(side.next_id) && !!side.next_url;

function navSokStart(nå, dager = GRENSER.navSokDager){
  return new Date(new Date(nå).getTime() - dager * 86_400_000).toUTCString();
}

export function navLinjer(items){
  const per = new Map();
  for(const it of Array.isArray(items) ? items : []){
    const fe = erObjekt(it?._feed_entry) ? it._feed_entry : {};
    const id = typeof it?.id === "string" && ID.test(it.id) ? it.id : null;
    if(!id) continue;
    const status = fe.status === "ACTIVE" ? "aktiv" : fe.status === "INACTIVE" ? "inaktiv" : null;
    if(!status) continue;
    per.delete(id);
    per.set(id, { id, status,
      tittel: fe.title ?? it.title, selskap: fe.businessName, sted: fe.municipal, endret: fe.sistEndret ?? it.date_modified });
  }
  return [...per.values()];
}

const navLenke = id => `https://arbeidsplassen.nav.no/stillinger/stilling/${id}`;
const navKandidater = items => navLinjer(items).map(l => kandidat({
  kilde: "nav", kildeId: l.id, url: navLenke(l.id), selskap: l.selskap,
  stilling: l.status === "aktiv" ? l.tittel : "", sted: l.status === "aktiv" ? tittelform(l.sted) : "",
  status: l.status
})).filter(Boolean);

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
      if(!gyldigSide(side)) throw ukjentFormat("NAV");
      items.push(...side.items);
      if(harNeste(side)){
        url = navSide(side.next_url);
        ny = { side: side.next_id, etag: null, sistEndret: null };
        etag = sistEndret = null;
      }else{
        ny = { side: side.id, etag: svar.etag ?? null, sistEndret: svar.sistEndret ?? null };
        url = null;
      }
    }
    return { kandidater: navKandidater(items), tilstand: ny, kall };
  },

  async søk({ nett, tilstand = {}, avtrykk = null, nå = new Date(), vent = sov, signal } = {}){
    const start = () => ({ url: `${NAV_BASE}/api/v1/feed?pageSize=2`, sistEndret: navSokStart(nå) });
    const fortsett = tilstand?.sokAvtrykk === avtrykk && !tilstand?.sokFerdig && ID.test(tilstand?.sokSide ?? "");
    let { url, sistEndret } = fortsett
      ? { url: `${NAV_BASE}/api/v1/feed/${tilstand.sokSide}?pageSize=${GRENSER.navSokSidestorrelse}`, sistEndret: null }
      : start();
    let fraLagret = fortsett, kall = 0, sider = 0, feil = null;
    let ny = { sokAvtrykk: avtrykk, sokSide: fortsett ? tilstand.sokSide : null, sokFerdig: null };
    const items = [];
    while(url && sider < GRENSER.navSokSider){
      sjekkAvbrudd(signal);
      if(kall) await vent(GRENSER.pause);
      let svar;
      try{
        svar = await nett.hentJson(url, { kilde: "nav", sistEndret });
      }catch(e){
        if(signal?.aborted) throw e;
        if(fraLagret && !sider){ fraLagret = false; ({ url, sistEndret } = start()); ny.sokSide = null; kall++; continue; }
        if(!sider) throw e;
        feil = e;
        break;
      }
      kall++;
      const side = svar?.json;
      if(svar?.status === 304 || !gyldigSide(side)){
        if(!sider) throw ukjentFormat("NAV");
        feil = ukjentFormat("NAV");
        break;
      }
      sider++;
      sistEndret = null;
      items.push(...side.items);
      if(harNeste(side)){
        url = navSide(side.next_url, GRENSER.navSokSidestorrelse);
        ny = { ...ny, sokSide: side.next_id };
      }else{
        ny = { sokAvtrykk: avtrykk, sokSide: null, sokFerdig: new Date(nå).toISOString(),
          side: side.id, etag: svar.etag ?? null, sistEndret: svar.sistEndret ?? null };
        url = null;
      }
    }
    return { kandidater: navKandidater(items), tilstand: ny, kall, ...(feil ? { feil } : {}) };
  },

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

function jobbnorgeSøk({ side = 0, periode = "Day", fylker = [], resultater = GRENSER.jobbnorgeResultater } = {}){
  const p = new URLSearchParams({ orderby: "Published", period: periode, results: String(resultater), page: String(side) });
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

  async søk({ nett, tilstand = {}, innstillinger, avtrykk = null, nå = new Date(), vent = sov, signal } = {}){
    const fylker = innstillinger?.kilder?.jobbnorge?.fylker ?? [];
    const R = GRENSER.jobbnorgeSokResultater;
    const kandidater = [];
    let høyeste = Number.isSafeInteger(tilstand?.sisteId) ? tilstand.sisteId : null, kall = 0;
    for(let side = 0; side < GRENSER.jobbnorgeSokSider; side++){
      sjekkAvbrudd(signal);
      if(kall) await vent(GRENSER.pause);
      const svar = await nett.hentJson(jobbnorgeSøk({ side, periode: "All", fylker, resultater: R }), { kilde: "jobbnorge" });
      kall++;
      const jobs = svar?.json?.jobs;
      if(!Array.isArray(jobs)) throw ukjentFormat("Jobbnorge");
      for(const j of jobs){
        const k = jobbnorgeKandidat(j);
        if(!k) continue;
        kandidater.push(k);
        høyeste = Math.max(høyeste ?? 0, Number(k.kildeId));
      }
      if(jobs.length < R) break;
    }
    return { kandidater, tilstand: { sisteId: høyeste, sokAvtrykk: avtrykk, sokFerdig: new Date(nå).toISOString() }, kall };
  },

  async detalj(k, { nett } = {}){
    const svar = await nett.hentJson(`${JOBBNORGE_BASE}/v2/joblisting?jobId=${encodeURIComponent(k.kildeId)}&languageId=1`, { kilde: "jobbnorge" });
    return { ...k, tekst: jobbnorgeTekst(svar?.json) || k.tekst, detaljert: true };
  }
};

function jobbnorgeTekst(d){
  const deler = (Array.isArray(d?.components) ? d.components : []).filter(erObjekt)
    .filter(c => c.type !== "Image")
    .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0))
    .flatMap(c => [c.heading ? `<h2>${c.heading}</h2>` : "", c.text_1, c.text_2]
      .filter(t => typeof t === "string" && t && !/^(?:Image|Source):/i.test(t)));
  return fraHtml(deler.join("\n"));
}

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

export function oppdagTypeFraSide(html, url){
  const fra = oppdagType(url);
  if(fra.type !== "jsonld") return fra;
  const h = String(html ?? "");
  for(const m of h.matchAll(/https?:\/\/(?:job-boards(?:\.eu)?|boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([A-Za-z0-9_-]{1,80})/g))
    if(m[1] !== "embed") return { type: "greenhouse", nokkel: m[1] };
  const lever = h.match(/https?:\/\/jobs\.lever\.co\/([A-Za-z0-9_-]{1,80})/);
  if(lever) return { type: "lever", nokkel: lever[1] };
  if(/teamtailor-cdn\.com|teamtailor\.com\/(?:assets|careersite)/i.test(h)){
    try{ return { type: "teamtailor", nokkel: new URL(url).origin }; }catch{}
  }
  return fra;
}

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

function xmlFelt(blokk, navn){
  const m = blokk.match(new RegExp(`<${navn}(?:\\s[^>]*)?>([\\s\\S]*?)</${navn}>`, "i"));
  if(!m) return "";
  const cdata = m[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : avkod(m[1]);
}
function tolkTeamtailorRss(xml, side = {}){
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

function jobPostinger(node, ut = [], dybde = 0){
  if(!node || typeof node !== "object" || dybde > 8 || ut.length >= 200) return ut;
  if(Array.isArray(node)){ for(const n of node) jobPostinger(n, ut, dybde + 1); return ut; }
  const type = [].concat(node["@type"] ?? []).map(t => String(t).toLowerCase());
  if(type.includes("jobposting")) ut.push(node);
  for(const k of ["@graph", "mainEntity", "itemListElement", "item"]) jobPostinger(node[k], ut, dybde + 1);
  return ut;
}
const plukk = v => Array.isArray(v) ? plukk(v[0]) : erObjekt(v) ? (v.name ?? v.value ?? v["@value"] ?? "") : (v ?? "");
const plukkId = v => Array.isArray(v) ? plukkId(v[0]) : erObjekt(v) ? (v.value ?? v["@value"] ?? v.name ?? "") : (v ?? "");
export function tolkJsonLd(html, side = {}){
  const noder = [];
  for(const m of String(html ?? "").matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)){
    try{ jobPostinger(JSON.parse(m[1].trim()), noder); }catch{}
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
