/* ============================================================
   Nett — de to utgående operasjonene importen trenger, i Node.

   Speiles av src-tauri/src/lib.rs for appmodus. Alt over dette
   laget er rene regler i src/importlogikk.mjs; her nede finnes
   bare henting, og vernet som må følge med den.
   ============================================================ */

import dns from "node:dns/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { sjekkLenke } from "../src/felles.mjs";

const MAKS_SIDE   = 2 * 1024 * 1024;
const MAKS_HOPP   = 3;
const TIDSGRENSE  = 10_000;
const MODELL_URL  = "https://api.anthropic.com/v1/messages";
const NOKKELFIL   = "nokkel.txt";

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
  constructor(melding){ super(melding); this.navn = "mangler-nokkel"; }
}

/* Nøkkelen ligger helst i en fil ved siden av datafilen: den kan settes
   chmod 600, den er allerede i .gitignore, og den slipper å stå i klartekst
   i ~/.zshrc der hvert eneste program på maskinen ser den. Miljøvariabelen
   virker fortsatt og går foran, for den som vil ha den.

   Filen leses ved hvert kall. Det er én liten lesing per import, og til
   gjengjeld virker en ny nøkkel uten at serveren må startes på nytt. */
export async function lesNokkel(katalog){
  const fra = process.env.ANTHROPIC_API_KEY?.trim();
  if(fra) return fra;

  if(katalog){
    try{
      const t = (await fs.readFile(path.join(katalog, NOKKELFIL), "utf8")).trim();
      if(t) return t;
    }catch{ /* finnes ikke, eller kan ikke leses — samme svar som ingen nøkkel */ }
  }

  throw new ManglerNokkel(
    `Ingen API-nøkkel. Legg den i ${NOKKELFIL} i datakatalogen, eller sett ANTHROPIC_API_KEY.`);
}

/* Samler de to operasjonene slik lagLager samler filoperasjonene, og
   av samme grunn: katalogen er noe serveren vet, ikke noe modulen gjør. */
export function lagNett({ katalog } = {}){
  return { hentSide, spørModell: kropp => spørModell(kropp, katalog) };
}

/* Verdt ett nytt forsøk: køen er full, eller noe er nede et øyeblikk.
   Uten dette må brukeren trykke selv — og da betales hentingen på nytt. */
const PRØV_IGJEN = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const PAUSE = 1_500;

const sov = ms => new Promise(r => setTimeout(r, ms));

export async function spørModell(kropp, katalog){
  const nokkel = await lesNokkel(katalog);

  const send = () => fetch(MODELL_URL, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "x-api-key": nokkel,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify(kropp)
  });

  let r;
  try{
    r = await send();
    if(PRØV_IGJEN.has(r.status)){
      /* Retry-After er serverens eget råd; den vet bedre enn vi gjør. */
      const raad = Number(r.headers.get("retry-after"));
      await sov(Number.isFinite(raad) && raad > 0 ? Math.min(raad * 1000, 10_000) : PAUSE);
      r = await send();
    }
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
