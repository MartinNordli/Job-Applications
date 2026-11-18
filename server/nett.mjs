import dns from "node:dns/promises";
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { sjekkLenke } from "../src/felles/felles.mjs";
import { sjekkJsonAdresse, erJsonType, hodeverdi, tolkNavToken, tidsgrenseFor,
         MAKS_JSON, MAKS_TOKEN, NAV_TOKENFIL, NAV_TOKENURL } from "../src/radar/radarnett.mjs";
import { NOKKELFIL, lesEgenNokkel, miljønokkel } from "./nokkel.mjs";

const MAKS_SIDE   = 2 * 1024 * 1024;
const MAKS_HOPP   = 3;
const TIDSGRENSE  = 10_000;
const MODELL_URL  = "https://api.anthropic.com/v1/messages";

const AGENT = "Jobbsoknader/1.0 (personlig soknadsoversikt)";

export function erIntern(ip){
  const s = String(ip || "").trim().toLowerCase();
  if(!s) return true;

  const kart = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if(kart) return erIntern(kart[1]);

  const fire = s.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if(fire){
    const [a, b] = fire.slice(1).map(Number);
    if(a === 0 || a === 10 || a === 127) return true;
    if(a === 169 && b === 254) return true;
    if(a === 172 && b >= 16 && b <= 31) return true;
    if(a === 192 && b === 168) return true;
    if(a === 100 && b >= 64 && b <= 127) return true;
    if(a >= 224) return true;
    return false;
  }

  if(s === "::" || s === "::1") return true;
  if(/^f[cd]/.test(s)) return true;
  if(/^fe[89ab]/.test(s)) return true;
  return false;
}

async function sjekkVert(vert){
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

export class ManglerNokkel extends Error {
  constructor(melding){ super(melding); this.navn = "mangler-nokkel"; }
}

export async function lesNokkel({ katalog, tillatMiljø = false } = {}){
  const egen = await lesEgenNokkel(katalog);
  if(egen) return egen;

  if(tillatMiljø){
    const fra = miljønokkel();
    if(fra) return fra;
  }

  throw new ManglerNokkel(
    `Ingen API-nøkkel. Legg inn din egen under «Dataene dine», eller legg den i ${NOKKELFIL} i din egen katalog.`);
}

async function standardOppslag(vert){
  return dns.lookup(vert, { all: true });
}

async function låsAdresse(vert, slåOpp){
  let treff;
  try{ treff = await slåOpp(vert); }
  catch{ throw new Error("Fant ikke serveren for den adressen."); }
  if(!Array.isArray(treff) || !treff.length) throw new Error("Fant ikke serveren for den adressen.");
  if(treff.some(t => erIntern(t?.address))) throw new Error("Adressen peker til et internt nett.");
  return { address: treff[0].address, family: treff[0].family === 6 ? 6 : 4 };
}

function httpsForespørsel({ url, hoder, adresse, signal }){
  return new Promise((ok, feil) => {
    const req = https.request(url, {
      method: "GET", headers: hoder, signal,
      lookup: (_vert, valg, svar) => valg?.all
        ? svar(null, [adresse])
        : svar(null, adresse.address, adresse.family)
    }, res => ok({ status: res.statusCode, hoder: res.headers, kropp: res }));
    req.on("error", feil);
    req.end();
  });
}

class Takfeil extends Error {}
async function lesMedHardtTak(kropp, tak, melding){
  const biter = [];
  let n = 0;
  for await (const bit of kropp ?? []){
    n += bit.length;
    if(n > tak){ kast(kropp); throw new Takfeil(melding); }
    biter.push(Buffer.from(bit));
  }
  return Buffer.concat(biter).toString("utf8");
}
function kast(kropp){ try{ kropp?.destroy?.(); }catch{} }

export function lagHentJson({ slåOpp = standardOppslag, forespør = httpsForespørsel } = {}){
  let offentligToken = null;
  const forSent = kilde => `Kilden svarte ikke innen ${tidsgrenseFor(kilde) / 1000} sekunder.`;

  async function send(u, kilde, hoder){
    const adresse = await låsAdresse(u.hostname, slåOpp);
    const signal = AbortSignal.timeout(tidsgrenseFor(kilde));
    try{
      const svar = await forespør({ url: u, hoder: { "Accept": "application/json", "User-Agent": AGENT, ...hoder }, adresse, signal });
      return { ...svar, signal };
    }catch(e){
      throw new Error(signal.aborted || e?.name === "TimeoutError" ? forSent(kilde) : "Fikk ikke kontakt med kilden.");
    }
  }

  async function lesKropp(svar, tak, melding, kilde){
    try{ return await lesMedHardtTak(svar.kropp, tak, melding); }
    catch(e){
      if(e instanceof Takfeil) throw new Error(e.message);
      throw new Error(svar.signal?.aborted ? forSent(kilde) : "Mistet forbindelsen mens svaret ble lest.");
    }
  }

  async function nyttOffentligToken(){
    offentligToken = null;
    const svar = await send(sjekkJsonAdresse(NAV_TOKENURL, "nav"), "nav", { "Accept": "text/plain" });
    if(svar.status === 404){ kast(svar.kropp); throw new Error("NAV har ikke et offentlig token akkurat nå. Radar prøver igjen senere."); }
    if(svar.status !== 200){ kast(svar.kropp); throw new Error(`NAV svarte ${svar.status} på tokenet.`); }
    const token = tolkNavToken(await lesKropp(svar, MAKS_TOKEN, "Tokenet fra NAV var for langt.", "nav"));
    if(!token) throw new Error("NAV svarte ikke med et gyldig token.");
    return (offentligToken = token);
  }

  async function privatToken(katalog){
    if(!katalog) return null;
    let tekst;
    try{ tekst = await fs.readFile(path.join(katalog, NAV_TOKENFIL), "utf8"); }
    catch(e){ if(e?.code === "ENOENT") return null; throw new Error(`Kunne ikke lese ${NAV_TOKENFIL}.`); }
    if(!tekst.trim()) return null;
    const token = tekst.length <= MAKS_TOKEN ? tolkNavToken(tekst) : null;
    if(!token) throw new Error(`${NAV_TOKENFIL} har ikke et gyldig token.`);
    return token;
  }

  return async function hentJson(url, { kilde, etag = null, sistEndret = null, katalog = null } = {}){
    const u = sjekkJsonAdresse(url, kilde);
    const hoder = {};
    const e = hodeverdi(etag), s = hodeverdi(sistEndret, 64);
    if(e) hoder["If-None-Match"] = e;
    if(s) hoder["If-Modified-Since"] = s;

    let svar;
    if(kilde === "nav"){
      const privat = await privatToken(katalog);
      const token = privat ?? offentligToken ?? await nyttOffentligToken();
      svar = await send(u, kilde, { ...hoder, "Authorization": `Bearer ${token}` });
      if(svar.status === 401){
        kast(svar.kropp);
        if(privat) throw new Error(`NAV avviste tokenet i ${NAV_TOKENFIL}.`);
        svar = await send(u, kilde, { ...hoder, "Authorization": `Bearer ${await nyttOffentligToken()}` });
        if(svar.status === 401){
          kast(svar.kropp); offentligToken = null;
          throw new Error("NAV avviste tokenet. Radar prøver igjen senere.");
        }
      }
    }else{
      svar = await send(u, kilde, hoder);
    }

    const h = svar.hoder ?? {};
    const nyEtag = hodeverdi(h.etag), nySist = hodeverdi(h["last-modified"], 64);
    if(svar.status === 304){
      kast(svar.kropp);
      return { status: 304, json: null, etag: nyEtag ?? e, sistEndret: nySist ?? s };
    }
    if(svar.status >= 300 && svar.status < 400){ kast(svar.kropp); throw new Error("Kilden sendte oss videre. Det følger ikke Radar."); }
    if(svar.status !== 200){ kast(svar.kropp); throw new Error(`Kilden svarte ${svar.status}.`); }
    if(!erJsonType(h["content-type"])){ kast(svar.kropp); throw new Error("Kilden svarte ikke med JSON."); }

    const tekst = await lesKropp(svar, MAKS_JSON, "Svaret fra kilden er større enn 5 MiB.", kilde);
    let json;
    try{ json = JSON.parse(tekst); }catch{ throw new Error("Kilden svarte med ugyldig JSON."); }
    return { status: 200, json, etag: nyEtag, sistEndret: nySist };
  };
}

export function lagNett(){
  const hentJson = lagHentJson();
  return { hentSide, hentJson, spørModell: (kropp, valg) => spørModell(kropp, valg) };
}

const PRØV_IGJEN = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const PAUSE = 1_500;

const sov = ms => new Promise(r => setTimeout(r, ms));

export async function spørModell(kropp, valg = {}){
  const nokkel = await lesNokkel(valg);

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
    let melding = `Modellen svarte ${r.status}.`;
    try{
      const j = JSON.parse(tekst);
      if(j?.error?.message) melding = `Modellen svarte ${r.status}: ${j.error.message}`;
    }catch{}
    if(melding.includes(nokkel)) melding = melding.replaceAll(nokkel, "«…»");
    throw new Error(melding);
  }

  try{ return JSON.parse(tekst); }
  catch{ throw new Error("Modellen svarte noe annet enn JSON."); }
}
