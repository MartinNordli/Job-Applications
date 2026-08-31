/* ============================================================
   Server — statiske filer og et lite JSON-API mot lageret.

   Personlig verktøy på egen maskin: ingen avhengigheter, ingen
   innlogging, og bare 127.0.0.1 slik at listen ikke ligger åpen
   på nettverket.
   ============================================================ */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lagLager } from "./lager.mjs";
import { hentSide, spørModell, ManglerNokkel } from "./nett.mjs";
import { SEKTOR_FOR } from "../src/felles.mjs";
import { tolkStrukturert, renskTekst, byggForespørsel,
         tolkModellsvar, slåSammen, sektorForSelskap, FELT } from "../src/importlogikk.mjs";

const HER = path.dirname(fileURLToPath(import.meta.url));
const ROT = path.resolve(HER, "..");

const MAKS_KROPP = 5 * 1024 * 1024;

const TYPER = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".svg":  "image/svg+xml; charset=utf-8",
  ".woff2":"font/woff2"
};

function svar(res, kode, data){
  const kropp = JSON.stringify(data);
  res.writeHead(kode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(kropp),
    "Cache-Control": "no-cache"
  });
  res.end(kropp);
}

function ikkeTillatt(res, tillatte){
  res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", "Allow": tillatte });
  res.end(JSON.stringify({ feil: "metode ikke tillatt", tillatte }));
}

/* Leser kroppen med tak. Vi slutter å samle opp ved taket, men tømmer
   strømmen ferdig — ellers rekker ikke svaret fram før koblingen dør. */
function lesKropp(req){
  return new Promise((ok, feil) => {
    const biter = [];
    let n = 0, forStor = false;
    req.on("data", b => {
      n += b.length;
      if(n > MAKS_KROPP){ forStor = true; biter.length = 0; return; }
      biter.push(b);
    });
    req.on("end", () => ok(forStor ? { forStor: true }
                                   : { tekst: Buffer.concat(biter).toString("utf8") }));
    req.on("error", feil);
  });
}

/* ------------------------------------------------------------
   Import fra lenke.

   Rekkefølgen er hele poenget: strukturerte data først, modellen
   bare på det som fortsatt mangler, og ingenting lagres — svaret
   er et utkast klienten fyller skjemaet med. `kilder` sier per
   felt hvor verdien kom fra, både til nytte i flaten og til
   feilsøking den dagen en side leses feil.
   ------------------------------------------------------------ */
async function apiImporter(req, res, nett, lager){
  if(req.method !== "POST") return ikkeTillatt(res, "POST");

  const kropp = await lesKropp(req);
  if(kropp.forStor) return svar(res, 413, { feil: "for stor kropp" });

  let inn;
  try{ inn = JSON.parse(kropp.tekst); }
  catch{ return svar(res, 400, { feil: "ugyldig json" }); }

  const url = typeof inn?.url === "string" ? inn.url.trim() : "";
  if(!url) return svar(res, 400, { feil: "mangler url", melding: "Lim inn adressen til utlysningen." });

  let side;
  try{ side = await nett.hentSide(url); }
  catch(e){ return svar(res, 502, { feil: "henting", melding: String(e?.message || e) }); }

  const strukturert = tolkStrukturert(side.html);
  const tekst       = renskTekst(side.html);

  /* Et selskap brukeren har søkt på før har allerede en sektor, og skal
     ikke klassifiseres på nytt. Oppslaget gjøres to ganger med vilje:
     nå, for å slippe å spørre modellen i det hele tatt når selskapet
     står i de strukturerte dataene — og etterpå, når vi vet navnet.
     På sider uten JSON-LD er det først da selskapet finnes. */
  let jobber = [];
  try{ const r = await lager.les(); if(Array.isArray(r?.jobber)) jobber = r.jobber; }
  catch{ /* listen er en bekvemmelighet her, ikke et krav */ }
  const kjent = navn => sektorForSelskap(navn, SEKTOR_FOR, jobber);
  strukturert.sektor = kjent(strukturert.selskap);

  const manglende = FELT.filter(f => !strukturert[f]);

  let modell = null;
  if(manglende.length && tekst.length > 40){
    const be = byggForespørsel(tekst, manglende);
    try{ modell = tolkModellsvar(await nett.spørModell(be)); }
    catch(e){
      if(e instanceof ManglerNokkel || e?.navn === "mangler-nokkel")
        return svar(res, 503, { feil: "mangler-nokkel",
          melding: "Ingen API-nøkkel. Sett ANTHROPIC_API_KEY og start serveren på nytt." });
      return svar(res, 502, { feil: "modell", melding: String(e?.message || e) });
    }
  }

  /* Sektoren fra selskapet skal ikke tape mot modellens gjetning. */
  if(strukturert.sektor && modell) modell.sektor = null;

  const { utkast, kilder } = slåSammen(strukturert, modell, url);

  const fraSelskap = kjent(utkast.selskap);
  if(fraSelskap){ utkast.sektor = fraSelskap; kilder.sektor = "selskap"; }
  if(!utkast.selskap && !utkast.stilling)
    return svar(res, 422, { feil: "tomt", utkast, kilder,
      melding: "Fant ingenting å lese på den siden. Den er kanskje bygget med JavaScript." });

  return svar(res, 200, { ok: true, utkast, kilder, sluttUrl: side.sluttUrl });
}

async function apiJobber(req, res, lager){
  if(req.method === "GET"){
    const r = await lager.les();
    if(r.ødelagt)
      return svar(res, 503, { feil: "ødelagt", sti: r.sti, sikkerhetskopi: r.sikkerhetskopi,
        melding: "Datafilen kunne ikke leses og ble satt i karantene. Rett den opp før du fortsetter." });
    if(r.tom) return svar(res, 200, { versjon: 0, jobber: null, tom: true, sikkerhetskopi: r.sikkerhetskopi });
    return svar(res, 200, { versjon: r.versjon, jobber: r.jobber,
                            ...(r.advarsel ? { advarsel: r.advarsel, forkastet: r.forkastet } : {}) });
  }

  if(req.method === "PUT"){
    const kropp = await lesKropp(req);
    if(kropp.forStor) return svar(res, 413, { feil: "for stor kropp" });

    let inn;
    try{ inn = JSON.parse(kropp.tekst); }
    catch{ return svar(res, 400, { feil: "ugyldig json" }); }

    if(!inn || typeof inn !== "object" || !Array.isArray(inn.jobber))
      return svar(res, 400, { feil: "ugyldig", detaljer: [
        { indeks: null, feil: [{ felt: null, melding: "Forventet {versjon, jobber}." }] }] });

    const r = await lager.skriv(inn.jobber,
                                typeof inn.versjon === "number" ? inn.versjon : undefined,
                                { overstyrOdelagt: inn.overstyrOdelagt === true });
    if(r.ok)                  return svar(res, 200, { versjon: r.versjon, jobber: r.jobber,
                                                      ...(r.karantene ? { karantene: r.karantene } : {}) });
    if(r.feil === "konflikt") return svar(res, 409, { feil: "konflikt", versjon: r.versjon, jobber: r.jobber });
    if(r.feil === "ugyldig")  return svar(res, 400, { feil: "ugyldig", detaljer: r.detaljer });
    return svar(res, 503, { feil: r.feil, sti: r.sti });
  }

  ikkeTillatt(res, "GET, PUT");
}

/* Bare index.html og de to mappene serveres. Sammenlikningen skjer på
   den oppløste stien, så «/src/../..» ikke kan skjule seg bak prefikset. */
function lovligFil(full){
  return full === path.join(ROT, "index.html")
      || full === path.join(ROT, "hent-gamle-data.html")
      || full.startsWith(path.join(ROT, "src") + path.sep)
      || full.startsWith(path.join(ROT, "temaer") + path.sep);
}

async function statisk(req, res, bane){
  if(req.method !== "GET" && req.method !== "HEAD") return ikkeTillatt(res, "GET, HEAD");

  const relativ = bane === "/" ? "/index.html" : bane;
  const full    = path.resolve(ROT, "." + relativ);

  if(full !== ROT && !full.startsWith(ROT + path.sep))
    return svar(res, 403, { feil: "stien peker utenfor prosjektet" });

  if(!lovligFil(full) || full.includes("\0")) return svar(res, 404, { feil: "ikke funnet" });

  let innhold;
  try{ innhold = await fs.readFile(full); }
  catch(e){
    if(e.code === "ENOENT" || e.code === "EISDIR" || e.code === "ENOTDIR")
      return svar(res, 404, { feil: "ikke funnet" });
    throw e;
  }

  res.writeHead(200, {
    "Content-Type": TYPER[path.extname(full).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": innhold.length,
    "Cache-Control": "no-cache"            /* filene redigeres mens appen kjører */
  });
  res.end(req.method === "HEAD" ? undefined : innhold);
}

export function lagServer(valg = {}){
  const nett  = valg.nett ?? { hentSide, spørModell };
  const lager = valg.lager ?? lagLager({
    katalog: valg.katalog ?? process.env.DATA_KATALOG ?? path.join(ROT, "data")
  });

  return http.createServer(async (req, res) => {
    try{
      /* Rå sti, ikke via URL: URL-klassen normaliserer bort «..» og
         ville skjult nettopp det forsøket vi vil avvise. */
      let bane;
      try{ bane = decodeURIComponent(req.url.split(/[?#]/)[0]); }
      catch{ return svar(res, 400, { feil: "ugyldig sti" }); }

      if(bane === "/api/jobber")   return await apiJobber(req, res, lager);
      if(bane === "/api/importer") return await apiImporter(req, res, nett, lager);
      if(bane.startsWith("/api/")) return svar(res, 404, { feil: "ukjent endepunkt" });
      await statisk(req, res, bane);
    }catch(e){
      if(res.headersSent) return res.destroy();
      svar(res, 500, { feil: "serverfeil", melding: String(e && e.message || e) });
    }
  });
}

/* Lytter bare når filen kjøres direkte — tester importerer den. */
if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href){
  const port = Number(process.env.PORT) || 4173;
  lagServer().listen(port, "127.0.0.1", () => {
    console.log(`Jobbsøknader kjører på http://127.0.0.1:${port}`);
  });
}
