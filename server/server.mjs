/* ============================================================
   Server — statiske filer og et lite JSON-API mot lageret.

   Personlig verktøy på egen maskin: ingen avhengigheter og bare
   127.0.0.1, slik at listen ikke ligger åpen på nettverket. Siden
   flerbruker kom til har den også innlogging: hver bruker har sin
   egen katalog under <data>/brukere/<id>, og adskillelsen håndheves
   her — per forespørsel, på filsystemnivå — ikke i flaten.

   Katalogen er den samme som Mac-appens, så de to modiene deler
   konto og liste. Hvor den ligger avgjøres i server/katalog.mjs, og
   ingen andre steder; DATA_KATALOG overstyrer den.

   Tre lag, i denne rekkefølgen, og rekkefølgen er hele poenget:

     1. Host- og opphavssjekk, før rutingen. Uten den kan et
        nettsted du besøker peke et domenenavn på 127.0.0.1 og lese
        /api/jobber fra nettleseren din (DNS-rebinding).
     2. Øktoppslag: cookien «okt» verifiseres én gang, og resultatet
        avgjør hvilket lager forespørselen får se.
     3. Rutingen, som aldri selv slår opp en brukerkatalog.

   Statiske filer forblir åpne. Uten det får ingen se
   innloggingsskjemaet, og src/** inneholder ikke noe hemmelig —
   den koden ligger allerede offentlig i repoet.
   ============================================================ */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lagNett, ManglerNokkel } from "./nett.mjs";
import { lagBrukere, lagRatebegrenser, tolkCookies,
         byggØktcookie, byggSlettcookie, COOKIE } from "./brukere.mjs";
import { validerNokkel, settNokkel, fjernNokkel, nokkelStatus,
         deltMiljønokkel } from "./nokkel.mjs";
import { velgKatalog, sikreKatalog, beskjedOmGammelData } from "./katalog.mjs";
import { offentligBruker } from "../src/brukerlogikk.mjs";
import { SEKTOR_FOR } from "../src/felles.mjs";
import { tolkStrukturert, renskTekst, byggForespørsel,
         tolkModellsvar, slåSammen, sektorForSelskap, manglendeFelt, finnesFraFor } from "../src/importlogikk.mjs";
import { LOGGFIL, lagLinje, leggTil, sammendrag } from "../src/importlogg.mjs";

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

function svar(res, kode, data, hoder = {}){
  const kropp = JSON.stringify(data);
  res.writeHead(kode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(kropp),
    "Cache-Control": "no-cache",
    ...hoder
  });
  res.end(kropp);
}

/* 204 har ingen kropp. Den brukes der svaret ville vært tomt uansett
   — og for nøkkelen, der et svar er noe vi helst sier minst mulig i. */
function tomtSvar(res, kode, hoder = {}){
  res.writeHead(kode, { "Cache-Control": "no-store", ...hoder });
  res.end();
}

/* Auth-svar skal ikke ligge i noen mellomlagring. */
const INGEN_LAGRING = { "Cache-Control": "no-store" };

function ikkeTillatt(res, tillatte){
  res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", "Allow": tillatte });
  res.end(JSON.stringify({ feil: "metode ikke tillatt", tillatte }));
}

const utlogget = res => svar(res, 401,
  { feil: "utlogget", melding: "Du er logget ut. Logg inn på nytt." }, INGEN_LAGRING);

/* ------------------------------------------------------------
   Host og opphav.

   Én sjekk, øverst, før rutingen — også for statiske filer. En
   nettside du besøker kan la et domene den eier peke på 127.0.0.1
   og så be nettleseren din om /api/jobber; da er Host-hodet
   angriperens domene, og det er det eneste sporet vi har av
   forsøket. Porten sjekkes ikke: den varierer med PORT.

   Origin sjekkes når den er satt. Mangler den — en vanlig
   navigering gjør det — er det ingenting å sammenlikne, og
   SameSite=Strict på cookien tar CSRF-siden av saken.
   ------------------------------------------------------------ */
const LOVLIGE_VERTER = new Set(["127.0.0.1", "localhost", "::1"]);

function vertOk(hode){
  if(typeof hode !== "string" || !hode) return false;      /* fail closed */
  const v = hode.trim().toLowerCase();
  const bar = v.startsWith("[") ? v.slice(1, v.indexOf("]"))
            : v.split(":").length > 2 ? v            /* bar IPv6, uten klammer */
            : v.split(":")[0];
  return LOVLIGE_VERTER.has(bar);
}

function opphavOk(hode, vertshode){
  if(hode == null) return true;
  if(typeof hode !== "string") return false;
  const o = hode.trim();
  if(!o || o === "null") return false;              /* sandkasse eller file:// */
  let u;
  try{ u = new URL(o); }catch{ return false; }
  if(u.protocol !== "http:" && u.protocol !== "https:") return false;
  if(!LOVLIGE_VERTER.has(u.hostname.replace(/^\[|\]$/g, "").toLowerCase())) return false;

  /* Porten sjekkes ikke på Host — den har ingenting å måles mot. Her
     har den det: Origin og Host kommer fra samme adresselinje, så de
     skal være like. Uten denne sammenlikningen ville en side på en
     annen port på localhost regnes som samme «site» av SameSite, og
     dermed fått sende cookien hit. */
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const vert = String(vertshode || "").trim().toLowerCase();
  const vertsport = vert.startsWith("[") ? vert.slice(vert.indexOf("]") + 2)
                  : vert.split(":").length === 2 ? vert.split(":")[1]
                  : "80";
  return port === (vertsport || "80");
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
async function apiImporter(req, res, nett, ktx){
  const { lager, filer } = ktx;
  if(req.method !== "POST") return ikkeTillatt(res, "POST");

  const kropp = await lesKropp(req);
  if(kropp.forStor) return svar(res, 413, { feil: "for stor kropp" });

  let inn;
  try{ inn = JSON.parse(kropp.tekst); }
  catch{ return svar(res, 400, { feil: "ugyldig json" }); }

  const url = typeof inn?.url === "string" ? inn.url.trim() : "";
  if(!url) return svar(res, 400, { feil: "mangler url", melding: "Lim inn adressen til utlysningen." });

  /* Listen leses først, ikke sist: står annonsen der fra før, er det
     ingenting å hente og ingenting å spørre modellen om. Det er den
     billigste importen som finnes. */
  let jobber = [];
  try{ const r = await lager.les(); if(Array.isArray(r?.jobber)) jobber = r.jobber; }
  catch{ /* listen er en bekvemmelighet her, ikke et krav */ }

  const fra_for = finnesFraFor(url, jobber);
  if(fra_for) return svar(res, 409, { feil: "finnes",
    id: fra_for.id, selskap: fra_for.selskap, stilling: fra_for.stilling,
    melding: `Du har allerede «${fra_for.stilling}» hos ${fra_for.selskap} i listen.` });

  /* Egen begrensning per bruker. Registreringen er åpen, og uten den
     kan hvem som helst som får en konto bruke opp en annens kreditt —
     eller operatørens, hvis DELT_NOKKEL er satt. Telles først her, når
     vi faktisk er i ferd med å bruke nettet og eventuelt modellen. */
  const plass = ktx.grense.sjekk(ktx.brukerId);
  if(!plass.ok) return svar(res, 429, { feil: "for-mange", retryEtter: plass.retryEtter,
    melding: "Du har importert mange utlysninger den siste timen. Vent litt." });
  ktx.grense.tell(ktx.brukerId);

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
  const kjent = navn => sektorForSelskap(navn, SEKTOR_FOR, jobber);
  strukturert.sektor = kjent(strukturert.selskap);

  const manglende = manglendeFelt(strukturert);

  let modell = null, bruk = null;
  if(manglende.length && tekst.length > 40){
    const be = byggForespørsel(tekst, manglende);
    try{
      /* Nøkkelen slås opp per kall, i brukerens egen katalog. Serveren
         har ingen delt nøkkel i minnet, og miljøvariabelen gjelder bare
         den den tilhører — se server/nokkel.mjs. */
      const raa = await nett.spørModell(be, { katalog: ktx.katalog,
                                              tillatMiljø: ktx.tillatMiljø });
      bruk   = raa?.usage ?? null;      /* de ekte tokentallene, ikke et anslag */
      modell = tolkModellsvar(raa);
    }
    catch(e){
      if(e instanceof ManglerNokkel || e?.navn === "mangler-nokkel")
        return svar(res, 503, { feil: "mangler-nokkel",
          melding: String(e?.message || e) });
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

  /* Loggen er en bekvemmelighet: en import som lyktes skal ikke feile
     fordi en linje ikke lot seg skrive. */
  skrivLogg(filer, lagLinje({ url, felt: bruk ? manglende : [], bruk }))
    .catch(() => {});

  return svar(res, 200, { ok: true, utkast, kilder, sluttUrl: side.sluttUrl });
}

async function skrivLogg(filer, linje){
  let fra = "";
  try{ fra = (await filer.lesTekst(LOGGFIL)) ?? ""; }catch{ /* første gang */ }
  await filer.skrivAtomisk(LOGGFIL, leggTil(fra, linje));
}

async function apiImportlogg(req, res, filer){
  if(req.method !== "GET") return ikkeTillatt(res, "GET");
  let tekst = "";
  try{ tekst = (await filer.lesTekst(LOGGFIL)) ?? ""; }catch{ /* ingen logg ennå */ }
  return svar(res, 200, { sammendrag: sammendrag(tekst) });
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

/* ------------------------------------------------------------
   Kontoene.

   Ingen av disse svarene bærer noe mer om en bruker enn
   {id, epost, navn}. Hash, salt og generasjon blir igjen på
   serveren; generasjonen er halve tilbakekallingen, og en klient
   som kjenner den vet mer enn den har bruk for.
   ------------------------------------------------------------ */

async function lesJson(req, res){
  const kropp = await lesKropp(req);
  if(kropp.forStor){ svar(res, 413, { feil: "for stor kropp" }); return null; }
  /* Tom kropp er et tomt objekt, ikke en feil: POST /api/logg-ut har
     ingenting å si, og skal kunne sendes uten noe å si. */
  if(!kropp.tekst.trim()) return {};
  try{ return JSON.parse(kropp.tekst); }
  catch{ svar(res, 400, { feil: "ugyldig json" }, INGEN_LAGRING); return null; }
}

/* Svarer alltid 200. Dette er endepunktet porten spør først, og en
   401 her ville vært et svar på et spørsmål ingen stilte. */
async function apiØkt(req, res, brukere, økt){
  if(req.method !== "GET") return ikkeTillatt(res, "GET");

  if(økt){
    const n = await nokkelStatus(brukere.lagerFor(økt.bruker.id).filer,
                                 { tillatMiljø: økt.erFørste || deltMiljønokkel() });
    return svar(res, 200, { innlogget: true, bruker: offentligBruker(økt.bruker),
                            erFørste: økt.erFørste, harNokkel: n.finnes }, INGEN_LAGRING);
  }

  const st = await brukere.status();
  if(st.ødelagt)
    /* Fail closed, men ikke stumt: flaten skal vise «logg inn» og en
       forklaring, ikke «opprett den første kontoen» over et register
       som allerede finnes. */
    return svar(res, 200, { innlogget: false, harBrukere: true, ødelagt: true,
      melding: "Brukerregisteret kan ikke leses. Rett opp brukere.json før du logger inn." },
      INGEN_LAGRING);

  return svar(res, 200, { innlogget: false, harBrukere: st.harBrukere }, INGEN_LAGRING);
}

async function apiRegistrer(req, res, brukere, grense, ip){
  if(req.method !== "POST") return ikkeTillatt(res, "POST");

  /* Kroppen leses først, så forespørselen blir tømt selv når vi sier
     nei — ellers ville en avvist klient møtt en brutt kobling i
     stedet for et svar den kan lese. Taket i lesKropp gjelder uansett. */
  const inn = await lesJson(req, res);
  if(inn === null) return;

  const plass = grense.sjekk(ip);
  if(!plass.ok) return svar(res, 429, { feil: "for-mange", retryEtter: plass.retryEtter,
    melding: "For mange forsøk. Vent litt før du prøver igjen." }, INGEN_LAGRING);
  grense.tell(ip);

  const r = await brukere.registrer(inn);
  if(r.feil === "ugyldig")  return svar(res, 400, { feil: "ugyldig", detaljer: r.detaljer }, INGEN_LAGRING);
  if(r.feil === "stengt")   return svar(res, 403, { feil: "stengt",
    melding: "Det er ikke plass til flere kontoer." }, INGEN_LAGRING);
  if(r.feil === "finnes")   return svar(res, 409, { feil: "finnes",
    melding: "Det finnes allerede en konto med den adressen." }, INGEN_LAGRING);
  if(!r.ok)                 return svar(res, 503, { feil: r.feil,
    melding: "Brukerregisteret kan ikke leses." }, INGEN_LAGRING);

  return svar(res, 201, { bruker: offentligBruker(r.bruker), erFørste: r.erFørste,
                          ...(r.migrert ? { migrert: r.migrert } : {}),
                          ...(r.migreringsfeil ? { migreringsfeil: r.migreringsfeil } : {}) },
              { ...INGEN_LAGRING, "Set-Cookie": byggØktcookie(r.token) });
}

async function apiLoggInn(req, res, brukere, grense, grovGrense, ip){
  if(req.method !== "POST") return ikkeTillatt(res, "POST");

  const inn = await lesJson(req, res);
  if(inn === null) return;

  /* Begrenseren teller på e-post og ikke bare på avsender: uten den
     er 600 000 iterasjoner et forsvar mot gjetting, men også en måte
     å legge beslag på libuvs trådpulje — som fs deler med oss. */
  const nøkkel = ip + "|" + String(inn?.epost ?? "").trim().toLowerCase().slice(0, 254);
  /* To tellere. Den på e-post er den brukeren merker; den på avsender
     alene er der fordi en angriper ellers kunne bytte e-post for hvert
     forsøk og få ubegrenset PBKDF2-arbeid ut av oss — 600 000
     iterasjoner om gangen, på trådpulja fs deler med oss. */
  for(const [n, g] of [[nøkkel, grense], [ip, grovGrense]]){
    const plass = g.sjekk(n);
    if(!plass.ok) return svar(res, 429, { feil: "for-mange", retryEtter: plass.retryEtter,
      melding: "For mange forsøk. Vent litt før du prøver igjen." }, INGEN_LAGRING);
  }

  const r = await brukere.loggInn(inn);
  if(!r.ok){
    grense.tell(nøkkel);
    grovGrense.tell(ip);
    if(r.feil === "ødelagt-register") return svar(res, 503, { feil: r.feil,
      melding: "Brukerregisteret kan ikke leses." }, INGEN_LAGRING);
    /* Ett svar for ukjent e-post og feil passord. Tidsbruken er gjort
       lik i brukere.mjs; her gjøres teksten lik. */
    return svar(res, 401, { feil: "feil-innlogging",
      melding: "Feil e-postadresse eller passord." }, INGEN_LAGRING);
  }

  grense.nullstill(nøkkel);
  return svar(res, 200, { bruker: offentligBruker(r.bruker), erFørste: r.erFørste },
              { ...INGEN_LAGRING, "Set-Cookie": byggØktcookie(r.token) });
}

/* Idempotent: uten cookie er svaret det samme, for utfallet er det
   samme. En utlogging som feiler fordi du allerede var logget ut er
   en feilmelding uten et problem bak seg. */
async function apiLoggUt(req, res, brukere, økt){
  if(req.method !== "POST") return ikkeTillatt(res, "POST");

  const inn = await lesJson(req, res);
  if(inn === null) return;

  if(økt && inn?.allePlasser === true) await brukere.loggUtAlle(økt.bruker.id);
  return svar(res, 200, { ok: true }, { ...INGEN_LAGRING, "Set-Cookie": byggSlettcookie() });
}

/* Passordbytte hever generasjonen, så alle andre økter faller. Den
   som byttet får en ny cookie i samme svar — ellers hadde den logget
   seg selv ut. */
async function apiPassord(req, res, brukere, økt){
  if(req.method !== "POST") return ikkeTillatt(res, "POST");

  const inn = await lesJson(req, res);
  if(inn === null) return;

  const r = await brukere.byttPassord(økt.bruker.id, inn?.gammelt, inn?.nytt);
  if(r.feil === "feil-passord") return svar(res, 403, { feil: "feil-passord",
    melding: "Det gamle passordet stemmer ikke." }, INGEN_LAGRING);
  if(r.feil === "ugyldig")      return svar(res, 400, { feil: "ugyldig", detaljer: r.detaljer }, INGEN_LAGRING);
  if(!r.ok)                     return svar(res, 503, { feil: r.feil }, INGEN_LAGRING);

  return svar(res, 200, { ok: true },
              { ...INGEN_LAGRING, "Set-Cookie": byggØktcookie(r.token) });
}

/* Nøkkelen går inn, aldri ut. Reglene står i server/nokkel.mjs. */
async function apiNokkel(req, res, ktx){
  if(req.method === "GET")
    return svar(res, 200, await nokkelStatus(ktx.filer, { tillatMiljø: ktx.tillatMiljø }),
                INGEN_LAGRING);

  if(req.method === "PUT"){
    const inn = await lesJson(req, res);
    if(inn === null) return;
    const r = await settNokkel(ktx.filer, inn?.nokkel);
    /* Meldingen sier hva som er galt med formen, aldri hva som ble sendt. */
    if(!r.ok) return svar(res, 400, { feil: "ugyldig", melding: r.melding }, INGEN_LAGRING);
    return tomtSvar(res, 204);
  }

  if(req.method === "DELETE"){
    await fjernNokkel(ktx.filer);
    return tomtSvar(res, 204);
  }

  return ikkeTillatt(res, "GET, PUT, DELETE");
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

/* Rutingen for /api/**. Skilt ut fordi den har én ting å si som
   ingen skal måtte lete etter: over streken er endepunktene åpne,
   under den finnes ingen vei videre uten en gyldig økt. */
async function apiRuter(req, res, bane, ktx){
  const { brukere, økt, nett, grenser, ip } = ktx;

  if(bane === "/api/okt")       return await apiØkt(req, res, brukere, økt);
  if(bane === "/api/registrer") return await apiRegistrer(req, res, brukere, grenser.registrering, ip);
  if(bane === "/api/logg-inn")  return await apiLoggInn(req, res, brukere, grenser.innlogging, grenser.avsender, ip);
  if(bane === "/api/logg-ut")   return await apiLoggUt(req, res, brukere, økt);

  /* ---- herfra og ned kreves økt ---- */
  if(!økt) return utlogget(res);

  if(bane === "/api/passord")   return await apiPassord(req, res, brukere, økt);

  /* Én lagerinstans per bruker, hentet fra cachen. Skrivekøen ligger i
     closuren i lagerlogikk.mjs: lagde vi en ny instans per forespørsel,
     ville to samtidige lagringer fått hver sin kø og kunnet tape
     hverandre. Stien settes sammen ett sted — her — av en id som
     allerede har passert verifiserToken. */
  const { lager, filer, katalog } = brukere.lagerFor(økt.bruker.id);
  const tillatMiljø = økt.erFørste || deltMiljønokkel();

  if(bane === "/api/nokkel")     return await apiNokkel(req, res, { filer, tillatMiljø });
  if(bane === "/api/jobber")     return await apiJobber(req, res, lager);
  if(bane === "/api/importlogg") return await apiImportlogg(req, res, filer);
  if(bane === "/api/importer")   return await apiImporter(req, res, nett,
    { lager, filer, katalog, tillatMiljø, grense: grenser.import, brukerId: økt.bruker.id });

  return svar(res, 404, { feil: "ukjent endepunkt" });
}

export function lagServer(valg = {}){
  /* Hvor dataene ligger avgjøres i server/katalog.mjs, som også er
     stedet DATA_KATALOG leses. Serveren skriver ikke sammen en sti
     på egen hånd. */
  const katalog = sikreKatalog(velgKatalog(valg));
  const nett    = valg.nett    ?? lagNett();
  const brukere = valg.brukere ?? lagBrukere({ katalog });

  /* Tre vinduer, tre grunner. Innlogging: 600 000 iterasjoner er
     dyrt for oss også, og pbkdf2 deler trådpulje med fs. Registrering:
     den er åpen. Import: den koster penger. */
  const grenser = {
    innlogging:   lagRatebegrenser({ tak: 10, vindu: 15 * 60_000 }),
    avsender:     lagRatebegrenser({ tak: 60, vindu: 15 * 60_000 }),
    registrering: lagRatebegrenser({ tak: 10, vindu: 60 * 60_000 }),
    import:       lagRatebegrenser({ tak: 30, vindu: 60 * 60_000 })
  };

  return http.createServer(async (req, res) => {
    try{
      if(!vertOk(req.headers.host) || !opphavOk(req.headers.origin, req.headers.host))
        return svar(res, 403, { feil: "feil-opphav",
          melding: "Åpne appen på http://127.0.0.1 og prøv igjen." }, INGEN_LAGRING);

      /* Rå sti, ikke via URL: URL-klassen normaliserer bort «..» og
         ville skjult nettopp det forsøket vi vil avvise. */
      let bane;
      try{ bane = decodeURIComponent(req.url.split(/[?#]/)[0]); }
      catch{ return svar(res, 400, { feil: "ugyldig sti" }); }

      if(bane.startsWith("/api/")){
        /* Slås opp én gang, før rutingen. Verifiseringen leser
           registeret, så den gjøres ikke for statiske filer. */
        const økt = await brukere.verifiserToken(tolkCookies(req.headers.cookie)[COOKIE]);
        const ip  = req.socket.remoteAddress || "ukjent";
        return await apiRuter(req, res, bane, { brukere, økt, nett, grenser, ip });
      }

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

  let katalog;
  try{ katalog = sikreKatalog(velgKatalog()); }
  catch(e){ console.error(e.message); process.exit(1); }

  /* Sies før serveren lytter, så den ikke drukner i det som kommer
     etter. Den som nettopp flyttet fra data/ skal se dette først. */
  const beskjed = beskjedOmGammelData({ katalog });
  if(beskjed) console.warn(beskjed);

  lagServer({ katalog }).listen(port, "127.0.0.1", () => {
    console.log(`Jobbsøknader kjører på http://127.0.0.1:${port}`);
    console.log(`Dataene ligger i ${katalog}`);
  });
}
