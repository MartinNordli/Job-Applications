/* ============================================================
   Import — å fylle skjemaet fra en utlysningslenke.

   Én kjede, to transporter. I nettlesermodus gjør serveren hele
   jobben bak /api/importer; i appmodus kjøres de samme reglene fra
   src/importlogikk.mjs her, over Rust. Reglene er de samme filene
   i begge tilfeller — det er bare hentingen som skifter.

   Ingenting herfra lagres. Svaret er et utkast skjemaet fylles med,
   og brukeren trykker selv.
   ============================================================ */

import * as Lagring from "./lagring.js";
import * as Økt from "./okt.js";
import { SEKTOR_FOR } from "./felles.mjs";
import { LOGGFIL, lagLinje, leggTil, sammendrag } from "./importlogg.mjs";
import { tolkStrukturert, renskTekst, byggForespørsel,
         tolkModellsvar, slåSammen, sektorForSelskap, manglendeFelt, finnesFraFor } from "./importlogikk.mjs";

/* Feilene flaten skiller på. `navn` er til kode, `message` til folk. */
export class Importfeil extends Error {
  constructor(navn, melding, utkast = null){
    super(melding);
    this.navn = navn;
    this.utkast = utkast;
  }
}

/* Så flaten kan si «Henter utlysningen…» og «Leser annonsen…»
   uten å vite noe om hvordan kjeden er satt sammen. */
export const TRINN = { HENTER: "henter", LESER: "leser" };

export async function importerFraLenke(url, valg = {}){
  const si = valg.påTrinn || (() => {});
  return Lagring.I_APP ? iApp(url, valg, si) : overHttp(url, si);
}

/* ---------- nettlesermodus: serveren gjør jobben ---------- */

async function overHttp(url, si){
  si(TRINN.HENTER);
  let r;
  try{
    r = await fetch("/api/importer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
  }catch{
    throw new Importfeil("frakoblet", "Fikk ikke kontakt med serveren.");
  }

  let j = null;
  try{ j = await r.json(); }catch{ /* faller gjennom til feilen under */ }

  if(r.ok && j?.ok) return { utkast: j.utkast, kilder: j.kilder };

  /* Økten er borte. Flaten skal vise porten, ikke «importen feilet» —
     og adressen brukeren limte inn står fortsatt i feltet. */
  if(r.status === 401){
    Økt.meldUtlogget(j?.melding);
    throw new Importfeil("utlogget", "Du er logget ut. Logg inn på nytt og prøv igjen.");
  }

  throw new Importfeil(j?.feil || "ukjent",
                       j?.melding || `Importen feilet (${r.status}).`,
                       j?.utkast || null);
}

/* ---------- appmodus: samme kjede, over Rust ---------- */

async function iApp(url, valg, si){
  const { tauriNett } = await import("./tauri-nett.mjs");

  const fraFor = finnesFraFor(url, valg.jobber || []);
  if(fraFor) throw new Importfeil("finnes",
    `Du har allerede «${fraFor.stilling}» hos ${fraFor.selskap} i listen.`);

  si(TRINN.HENTER);
  let side;
  try{ side = await tauriNett.hentSide(url); }
  catch(e){ throw new Importfeil("henting", tekstFra(e, "Fikk ikke hentet siden.")); }

  const strukturert = tolkStrukturert(side.html);
  const tekst       = renskTekst(side.html);

  const jobber = valg.jobber || [];
  const kjent  = navn => sektorForSelskap(navn, SEKTOR_FOR, jobber);
  strukturert.sektor = kjent(strukturert.selskap);

  const manglende = manglendeFelt(strukturert);

  let modell = null, bruk = null;
  if(manglende.length && tekst.length > 40){
    si(TRINN.LESER);
    try{
      /* Nøkkelen hentes av Rust fra profilens egen katalog. Uten
         `bruker` ville den blitt lett etter i rota, som ingen
         profil eier. */
      const raa = await tauriNett.spørModell(byggForespørsel(tekst, manglende),
                                             { bruker: minId() });
      bruk   = raa?.usage ?? null;
      modell = tolkModellsvar(raa);
    }
    catch(e){
      const m = tekstFra(e, "Fikk ikke kontakt med modellen.");
      throw new Importfeil(/nøkkel/i.test(m) ? "mangler-nokkel" : "modell", m);
    }
  }
  if(strukturert.sektor && modell) modell.sektor = null;

  const { utkast, kilder } = slåSammen(strukturert, modell, url);

  const fraSelskap = kjent(utkast.selskap);
  if(fraSelskap){ utkast.sektor = fraSelskap; kilder.sektor = "selskap"; }

  if(!utkast.selskap && !utkast.stilling)
    throw new Importfeil("tomt",
      "Fant ingenting å lese på den siden. Den er kanskje bygget med JavaScript.", utkast);

  /* Loggen er en bekvemmelighet — en import som lyktes skal ikke feile
     fordi en linje ikke lot seg skrive. */
  skrivLogg(lagLinje({ url, felt: bruk ? manglende : [], bruk })).catch(() => {});

  return { utkast, kilder };
}

/* ---------- importloggen ---------- */

/* Samme fire filoperasjoner som lagringen bruker, i profilens katalog.
   Loggen er liten nok til at les-endre-skriv er greit; alternativet er
   en ny Rust-kommando for én linje tekst.

   Uten en innlogget profil skrives ingen logg. Loggen sier hva
   importen har kostet, og det er et spørsmål som bare gir mening per
   profil — rotas katalog er ingens. */
const minId = () => Økt.nåværendeBruker()?.id ?? null;

async function filer(){
  const bruker = minId();
  if(!bruker) throw new Error("Ingen profil er valgt.");
  const { lagTauriFiler } = await import("./tauri-filer.mjs");
  return lagTauriFiler({ bruker });
}

async function skrivLogg(linje){
  const f = await filer();
  let fra = "";
  try{ fra = (await f.lesTekst(LOGGFIL)) ?? ""; }catch{ /* første gang */ }
  await f.skrivAtomisk(LOGGFIL, leggTil(fra, linje));
}

/* Tre tall om hva importen har kostet. `null` når ingenting er importert. */
export async function importtall(){
  if(!Lagring.I_APP){
    try{
      const r = await fetch("/api/importlogg");
      /* En 401 her sier ingenting brukeren har bedt om å få vite —
         tallene er en opplysning i skuffen, ikke en handling. Porten
         kommer opp av det neste kallet som faktisk betyr noe. */
      return r.ok ? (await r.json()).sammendrag : null;
    }catch{ return null; }
  }
  try{
    const f = await filer();
    return sammendrag((await f.lesTekst(LOGGFIL)) ?? "");
  }catch{ return null; }
}

/* Rust sender feil som strenger over invoke. */
const tekstFra = (e, reserve) =>
  typeof e === "string" ? e : String(e?.message || e || reserve);
