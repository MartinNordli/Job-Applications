import * as Lagring from "../soknader/lagring.js";
import * as Økt from "../konto/okt.js";
import { SEKTOR_FOR } from "../felles/felles.mjs";
import { LOGGFIL, lagLinje, leggTil } from "./importlogg.mjs";
import { trekkUtAnnonse } from "../stilling/annonsetekst.mjs";
import { tolkStrukturert, renskTekst, byggForespørsel,
         tolkModellsvar, slåSammen, sektorForSelskap, manglendeFelt, finnesFraFor } from "./importlogikk.mjs";

export class Importfeil extends Error {
  constructor(navn, melding, utkast = null){
    super(melding);
    this.navn = navn;
    this.utkast = utkast;
  }
}

export const TRINN = { HENTER: "henter", LESER: "leser" };

export async function importerFraLenke(url, valg = {}){
  const si = valg.påTrinn || (() => {});
  return Lagring.I_APP ? iApp(url, valg, si) : overHttp(url, si);
}

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
  try{ j = await r.json(); }catch{}

  if(r.ok && j?.ok) return { utkast: j.utkast, kilder: j.kilder, annonse: j.annonse ?? null };

  if(r.status === 401){
    Økt.meldUtlogget(j?.melding);
    throw new Importfeil("utlogget", "Du er logget ut. Logg inn på nytt og prøv igjen.");
  }

  throw new Importfeil(j?.feil || "ukjent",
                       j?.melding || `Importen feilet (${r.status}).`,
                       j?.utkast || null);
}

async function iApp(url, valg, si){
  const { tauriNett } = await import("../felles/tauri-nett.mjs");

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

  skrivLogg(lagLinje({ url, felt: bruk ? manglende : [], bruk })).catch(() => {});

  return { utkast, kilder, annonse: annonseFra(side, url) };
}

function annonseFra(side, url){
  try{
    return { tekst: trekkUtAnnonse(side.html), url: side.sluttUrl || url, hentet: new Date().toISOString() };
  }catch{ return null; }
}

const minId = () => Økt.nåværendeBruker()?.id ?? null;

async function filer(){
  const bruker = minId();
  if(!bruker) throw new Error("Ingen profil er valgt.");
  const { lagTauriFiler } = await import("../felles/tauri-filer.mjs");
  return lagTauriFiler({ bruker });
}

async function skrivLogg(linje){
  const f = await filer();
  let fra = "";
  try{ fra = (await f.lesTekst(LOGGFIL)) ?? ""; }catch{}
  await f.skrivAtomisk(LOGGFIL, leggTil(fra, linje));
}

const tekstFra = (e, reserve) =>
  typeof e === "string" ? e : String(e?.message || e || reserve);
