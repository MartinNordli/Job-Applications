/* ============================================================
   Radarnett: reglene for hentJson, og hvilken vei kallet går.

   Radar henter JSON fra fire kjente API-er. Det er en annen
   operasjon enn hentSide, som henter en side brukeren limer inn:

     - Bare https, og bare vertene i listen under, én per kilde.
       Adressene bygges av kildekoden, men vertslisten gjør at en
       feil der, eller en next_url fra NAV som peker et annet sted,
       stopper her og ikke på andre siden av en tilkobling.
     - Ingen videresendinger. Ingen av API-ene videresender, og et
       API som plutselig gjør det, er heller en feil enn noe å følge.
     - Typen må være application/json. Tom type avvises, motsatt av
       hentSide, som godtar den.
     - 304 er et svar («ingenting nytt»), ikke en feil.
     - Over 5 MiB er en feil, ikke et stille kutt: en kuttet JSON er
       ubrukelig, og en kuttet side som parses likevel er verre.
     - 30 s for NAV, som er treg på tjenersiden, og 15 s ellers.

   NAV-tokenet hentes og legges på bare av Node (server/nett.mjs) og
   Rust (src-tauri/src/nett.rs), og bare for NAV-verten. Det går aldri
   til webviewet. tolkNavToken står her fordi regelen er ren tekst;
   kallene står der.

   Reglene finnes også i Rust. testdata/hentjson.json leses av begge
   testene, så de ikke glir fra hverandre.

   Nederst: lagRadarnett velger transport. I appen går kallene til
   Rust (hent_json, hent_side), på serveren til Node-nettet. Kjernen
   i src/radarlogikk.mjs ser bare { hentJson, hentSide }.
   ============================================================ */

export const JSON_VERTER = Object.freeze({
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

/* Adressen som URL, eller en feil med en melding brukeren kan lese.
   Brukernavn, passord og annen port enn 443 avvises: ingen av API-ene
   trenger dem, og alle tre er måter å få samme vertsnavn til å bety
   noe annet. */
export function sjekkJsonAdresse(url, kilde){
  if(!Object.hasOwn(JSON_VERTER, kilde)) throw new Error("Ukjent kilde.");
  let u;
  try{ u = new URL(String(url ?? "")); }catch{ throw new Error("Ugyldig adresse til kilden."); }
  if(u.protocol !== "https:") throw new Error("Kilden må hentes over https.");
  if(u.username || u.password || u.port) throw new Error("Ugyldig adresse til kilden.");
  if(u.hostname.toLowerCase() !== JSON_VERTER[kilde]) throw new Error("Adressen hører ikke til kilden.");
  return u;
}

/* «application/json», med eller uten parametre som charset. Ikke
   «application/json-seq», ikke «text/json», ikke tom. */
export function erJsonType(type){
  return /^application\/json\s*(?:;|$)/i.test(String(type ?? "").trim());
}

/* ETag og Last-Modified går rett i et hode på neste kall. De kommer
   fra kilden selv, men lagres i radar.json og leses tilbake, så de
   sjekkes som all annen inndata: synlige ASCII-tegn og mellomrom,
   ingen linjeskift, kort. Ellers null, som betyr «spør uten». */
export function hodeverdi(v, maks = 200){
  return typeof v === "string" && v.length && v.length <= maks && /^[\x20-\x7e]+$/.test(v) ? v : null;
}

/* /api/publicToken svarer med to linjer: en fast tekst, så tokenet.
   Siste ikke-tomme linje, og bare hvis den har formen til en JWT.
   Formen er også vernet mot hodeinjeksjon, siden verdien havner i
   Authorization. Tokenet sjekkes ikke ut over det: exp kan ikke
   brukes (NAV roterer lenge før), og signaturen er NAVs sak. */
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export function tolkNavToken(tekst){
  const linjer = String(tekst ?? "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const siste = linjer.at(-1) ?? "";
  return siste.length <= 4096 && JWT.test(siste) ? siste : null;
}

/* ---------- transport ---------- */

/* Samme form uansett vei: hentJson(url, { kilde, etag, sistEndret })
   gir { status: 200|304, json, etag, sistEndret }, og hentSide(url)
   gir { status, sluttUrl, html }. `bruker` sier hvilken profil som
   spør, så Rust og Node kan lese et privat NAV-token fra riktig
   katalog. `invoke` er Tauri sin; `node` er lagNett() på serveren og
   `katalog` profilens katalog der. */
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
/* Bare de tre feltene går videre, så en kilde ikke kan sende med noe
   transporten ikke har bedt om. */
function rene({ kilde, etag = null, sistEndret = null }){
  return { kilde, etag: hodeverdi(etag), sistEndret: hodeverdi(sistEndret, 64) };
}
