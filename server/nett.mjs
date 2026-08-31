/* ============================================================
   Nett — de to utgående operasjonene importen trenger, i Node.

   Speiles av src-tauri/src/lib.rs for appmodus. Alt over dette
   laget er rene regler i src/importlogikk.mjs; her nede finnes
   bare henting, og vernet som må følge med den.
   ============================================================ */

import dns from "node:dns/promises";
import { sjekkLenke } from "../src/felles.mjs";

const MAKS_SIDE   = 2 * 1024 * 1024;
const MAKS_HOPP   = 3;
const TIDSGRENSE  = 10_000;
const MODELL_URL  = "https://api.anthropic.com/v1/messages";

const AGENT = "Jobbsoknader/1.0 (personlig soknadsoversikt)";

/* ---------- vern mot interne adresser ---------- */
/*
   Serveren henter en adresse brukeren limer inn, og står på samme
   maskin som datafilen. Uten denne sjekken er «importer denne
   utlysningen» en invitasjon til å lese http://127.0.0.1:4173/api/jobber,
   eller skymetadata på 169.254.169.254.

   Sjekken må gjøres på den oppslåtte IP-en, ikke på vertsnavnet:
   et navn i DNS kan peke hvor som helst. Og den må gjøres om igjen
   for hvert eneste hopp, ellers slipper en 302 forbi hele greia.
*/
export function erIntern(ip){
  const s = String(ip || "").trim().toLowerCase();
  if(!s) return true;

  /* IPv4-i-IPv6, «::ffff:10.0.0.1», gjelder som IPv4-en den bærer. */
  const kart = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if(kart) return erIntern(kart[1]);

  const fire = s.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if(fire){
    const [a, b] = fire.slice(1).map(Number);
    if(a === 0 || a === 10 || a === 127) return true;          /* denne verten, privat, loopback */
    if(a === 169 && b === 254) return true;                     /* link-local og skymetadata */
    if(a === 172 && b >= 16 && b <= 31) return true;            /* privat */
    if(a === 192 && b === 168) return true;                     /* privat */
    if(a === 100 && b >= 64 && b <= 127) return true;           /* operatør-NAT */
    if(a >= 224) return true;                                   /* multicast og oppover */
    return false;
  }

  if(s === "::" || s === "::1") return true;                    /* uspesifisert, loopback */
  if(/^f[cd]/.test(s)) return true;                             /* unike lokale adresser */
  if(/^fe[89ab]/.test(s)) return true;                          /* link-local */
  return false;
}

async function sjekkVert(vert){
  /* Rå IP i adressen slipper ikke unna oppslaget — den er allerede svaret. */
  const bar = vert.replace(/^\[|\]$/g, "");
  if(/^[\d.]+$/.test(bar) || bar.includes(":")){
    if(erIntern(bar)) throw new Error("Adressen peker til et internt nett.");
    return;
  }
  let treff;
  try{ treff = await dns.lookup(bar, { all: true }); }
  catch{ throw new Error("Fant ikke serveren for den adressen."); }
  if(!treff.length || treff.some(t => erIntern(t.address)))
    throw new Error("Adressen peker til et internt nett.");
}

/* ---------- hent siden ---------- */
/*
   Redirects følges for hånd. `redirect: "follow"` ville gjort hoppene
   usynlige for sjekken over, og det er nettopp hoppene som er hullet.
*/
export async function hentSide(url){
  let na = url;

  for(let hopp = 0; hopp <= MAKS_HOPP; hopp++){
    const lenke = sjekkLenke(na);
    if(!lenke.ok) throw new Error(lenke.melding);

    const u = new URL(lenke.verdi);
    await sjekkVert(u.hostname);

    let r;
    try{
      r = await fetch(u, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIDSGRENSE),
        headers: {
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "nb,no,en;q=0.8",
          "User-Agent": AGENT
        }
      });
    }catch(e){
      throw new Error(e?.name === "TimeoutError"
        ? "Siden svarte ikke innen ti sekunder."
        : "Fikk ikke kontakt med siden.");
    }

    if(r.status >= 300 && r.status < 400 && r.headers.get("location")){
      na = new URL(r.headers.get("location"), u).href;
      continue;
    }

    if(!r.ok) throw new Error(`Siden svarte ${r.status}.`);

    const type = (r.headers.get("content-type") || "").toLowerCase();
    if(type && !type.includes("html") && !type.includes("xml") && !type.includes("text/plain"))
      throw new Error("Adressen peker ikke til en nettside.");

    return { status: r.status, sluttUrl: u.href, html: await lesMedTak(r) };
  }

  throw new Error("Siden sendte oss videre for mange ganger.");
}

/* Content-Length kan lyve; taket må gjelde det som faktisk kommer inn. */
async function lesMedTak(r){
  if(!r.body) return "";
  const leser = r.body.getReader();
  const biter = [];
  let n = 0;
  for(;;){
    const { done, value } = await leser.read();
    if(done) break;
    n += value.length;
    if(n > MAKS_SIDE){ await leser.cancel(); break; }
    biter.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(biter.map(Buffer.from)));
}

/* ---------- spør modellen ---------- */

export class ManglerNokkel extends Error {
  constructor(){ super("Ingen API-nøkkel."); this.navn = "mangler-nokkel"; }
}

export async function spørModell(kropp){
  const nokkel = process.env.ANTHROPIC_API_KEY;
  if(!nokkel) throw new ManglerNokkel();

  let r;
  try{
    r = await fetch(MODELL_URL, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "x-api-key": nokkel,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify(kropp)
    });
  }catch(e){
    throw new Error(e?.name === "TimeoutError"
      ? "Modellen svarte ikke i tide."
      : "Fikk ikke kontakt med modellen.");
  }

  const tekst = await r.text();
  if(!r.ok){
    /* Nøkkelen skal aldri kunne havne i en feilmelding brukeren ser. */
    let melding = `Modellen svarte ${r.status}.`;
    try{
      const j = JSON.parse(tekst);
      if(j?.error?.message) melding = `Modellen svarte ${r.status}: ${j.error.message}`;
    }catch{ /* behold den enkle meldingen */ }
    throw new Error(melding);
  }

  try{ return JSON.parse(tekst); }
  catch{ throw new Error("Modellen svarte noe annet enn JSON."); }
}
