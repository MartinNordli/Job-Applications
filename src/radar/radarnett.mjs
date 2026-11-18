const JSON_VERTER = Object.freeze({
  nav: "pam-stilling-feed.nav.no",
  jobbnorge: "publicapi.jobbnorge.no",
  greenhouse: "boards-api.greenhouse.io",
  lever: "api.lever.co"
});

export const MAKS_JSON = 5 * 1024 * 1024;
export const MAKS_TOKEN = 8 * 1024;
export const NAV_TOKENFIL = "nav-token.txt";
export const NAV_TOKENURL = "https://pam-stilling-feed.nav.no/api/publicToken";
export const tidsgrenseFor = kilde => kilde === "nav" ? 30_000 : 15_000;

export function sjekkJsonAdresse(url, kilde){
  if(!Object.hasOwn(JSON_VERTER, kilde)) throw new Error("Ukjent kilde.");
  let u;
  try{ u = new URL(String(url ?? "")); }catch{ throw new Error("Ugyldig adresse til kilden."); }
  if(u.protocol !== "https:") throw new Error("Kilden må hentes over https.");
  if(u.username || u.password || u.port) throw new Error("Ugyldig adresse til kilden.");
  if(u.hostname.toLowerCase() !== JSON_VERTER[kilde]) throw new Error("Adressen hører ikke til kilden.");
  return u;
}

export function erJsonType(type){
  return /^application\/json\s*(?:;|$)/i.test(String(type ?? "").trim());
}

export function hodeverdi(v, maks = 200){
  return typeof v === "string" && v.length && v.length <= maks && /^[\x20-\x7e]+$/.test(v) ? v : null;
}

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export function tolkNavToken(tekst){
  const linjer = String(tekst ?? "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const siste = linjer.at(-1) ?? "";
  return siste.length <= 4096 && JWT.test(siste) ? siste : null;
}

export function lagRadarnett({ invoke, node, bruker = null, katalog = null } = {}){
  if(node) return {
    hentJson: (url, valg = {}) => node.hentJson(url, { ...rene(valg), katalog }),
    hentSide: url => node.hentSide(url)
  };
  if(invoke) return {
    hentJson: (url, valg = {}) => invoke("hent_json", { url, ...rene(valg), bruker }),
    hentSide: url => invoke("hent_side", { url })
  };
  throw new Error("Radar mangler en vei ut på nettet.");
}
function rene({ kilde, etag = null, sistEndret = null }){
  return { kilde, etag: hodeverdi(etag), sistEndret: hodeverdi(sistEndret, 64) };
}
