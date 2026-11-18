import * as Økt from "../konto/okt.js";

const API = "/api/jobber";
const NYTT_FORSOK = 4000;

export const I_APP = typeof window !== "undefined" && !!window.__TAURI__;

const FORSINKELSE = I_APP ? 0 : 250;

let appLager = null, appLagerFor = null;
async function lokaltLager(){
  const id = Økt.nåværendeBruker()?.id ?? null;
  if(!id) throw new Error("Ingen profil er valgt.");

  if(!appLager || appLagerFor !== id){
    const [{ lagLager }, { lagTauriFiler }] = await Promise.all([
      import("./lagerlogikk.mjs"),
      import("../felles/tauri-filer.mjs")
    ]);
    appLager = lagLager({ filer: await lagTauriFiler({ bruker: id }),
                          lagId: () => crypto.randomUUID() });
    appLagerFor = id;
  }
  return appLager;
}

export async function datakatalog(){
  if(!I_APP) return null;
  try{ return (await lokaltLager()).katalog; }catch{ return null; }
}

let versjon = 0;
let ventende = null;
let sender = false;
let timer = null, forsok = null;

let blokkert = false;
let overstyrOdelagt = false;
let vilPrøveIgjen = false;

const lyttere = new Set();
let tilstand = { navn: "lagret", tid: null, melding: null };

export function påTilstand(fn){ lyttere.add(fn); fn(tilstand); return () => lyttere.delete(fn); }

function meld(navn, melding){
  tilstand = { navn, melding: melding || null, tid: navn === "lagret" ? new Date() : tilstand.tid };
  lyttere.forEach(fn => fn(tilstand));
}

export const harUlagret = () => ventende !== null || sender;
export const erBlokkert   = () => blokkert;

export function blokker(grunn){ blokkert = true; if(grunn) meld("blokkert", grunn); }

export function frigi(overstyr){
  blokkert = false;
  overstyrOdelagt = !!overstyr;
  if(ventende !== null) kjør();
}
export const gjeldendeVersjon = () => versjon;

async function hentOverHttp(){
  let svar;
  try{ svar = await fetch(API, { headers: { accept: "application/json" } }); }
  catch{ const e = new Error("Ingen kontakt med lagringen."); e.frakoblet = true; throw e; }

  let kropp = null;
  try{ kropp = await svar.json(); }catch{}

  if(svar.status === 401){
    Økt.meldUtlogget(kropp && kropp.melding);
    const e = new Error("Du er logget ut."); e.utlogget = true; throw e;
  }
  if(svar.status === 503 && kropp && kropp.feil){
    const e = new Error(kropp.feil); e.ødelagt = true; e.sti = kropp.sti;
    e.sikkerhetskopi = kropp.sikkerhetskopi || null; throw e;
  }
  if(!svar.ok || !kropp){
    const e = new Error("Lagringen svarte uventet (" + svar.status + ")."); e.frakoblet = true; throw e;
  }
  return kropp;
}

async function hentLokalt(){
  let r;
  try{ r = await (await lokaltLager()).les(); }
  catch(årsak){
    const e = new Error("Fikk ikke lest datafilen. " + (årsak && årsak.message || årsak));
    e.frakoblet = true; throw e;
  }
  if(r.ødelagt){
    const e = new Error(r.grunn || "ødelagt"); e.ødelagt = true; e.sti = r.sti;
    e.sikkerhetskopi = r.sikkerhetskopi || null; throw e;
  }
  return r;
}

export async function hent(valg = {}){
  let kropp;
  try{ kropp = I_APP ? await hentLokalt() : await hentOverHttp(); }
  catch(e){
    if(e.ødelagt) blokkert = true;
    if(e.utlogget) blokkert = true;
    throw e;
  }

  if(!valg.beholdVentende){ versjon = kropp.versjon || 0; ventende = null; }
  blokkert = false;
  overstyrOdelagt = false;
  avbrytNyttForsok();
  meld(ventende === null ? "lagret" : "lagrer");
  return kropp;
}

export function lagre(jobber){
  ventende = jobber;
  if(blokkert) return;
  meld("lagrer");
  if(!timer) timer = setTimeout(() => { timer = null; kjør(); }, FORSINKELSE);
}

async function skrivOverHttp(jobber, flukt){
  const svar = await fetch(API, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ versjon, jobber,
                           ...(overstyrOdelagt ? { overstyrOdelagt: true } : {}) }),
    ...(flukt ? { keepalive: true } : {})
  });
  let kropp = null;
  try{ kropp = await svar.json(); }catch{}

  if(svar.ok && kropp)              return { utfall: "ok", kropp };
  if(svar.status === 409 && kropp)  return { utfall: "konflikt", kropp };
  if(svar.status === 401)           return { utfall: "utlogget",
                                             melding: (kropp && kropp.melding) || null };
  if(svar.status === 503)           return { utfall: "ødelagt",
                                             melding: (kropp && kropp.melding) || null };
  return { utfall: "avvist",
           melding:  kropp && kropp.feil ? kropp.feil : null,
           detaljer: kropp && kropp.detaljer ? kropp.detaljer : null };
}

async function skrivLokalt(jobber){
  const r = await (await lokaltLager()).skriv(jobber, versjon, { overstyrOdelagt });
  if(r.ok)                   return { utfall: "ok", kropp: r };
  if(r.feil === "konflikt")  return { utfall: "konflikt", kropp: r };
  if(r.feil === "ødelagt")   return { utfall: "ødelagt",
                                      melding: "Datafilen kan ikke leses. Den ligger urørt som "
                                               + r.sti + "." };
  return { utfall: "avvist", melding: r.feil, detaljer: r.detaljer || null };
}

async function kjør(flukt){
  if(sender || blokkert || ventende === null) return;
  sender = true;
  const nå = ventende;
  ventende = null;
  meld("lagrer");
  let lagret = false;

  try{
    const r = I_APP ? await skrivLokalt(nå) : await skrivOverHttp(nå, flukt);

    if(r.utfall === "ok"){
      versjon = r.kropp.versjon;
      overstyrOdelagt = false;
      avbrytNyttForsok();
      lagret = true;
    }else if(r.utfall === "konflikt"){
      behold(nå);
      blokkert = true;
      meld("konflikt", "Dataene ble endret et annet sted.");
      lyttere.forEach(fn => fn(tilstand, r.kropp));
    }else if(r.utfall === "ødelagt"){
      behold(nå);
      blokkert = true;
      meld("ulagret", r.melding || "Datafilen kan ikke leses.");
    }else if(r.utfall === "utlogget"){
      behold(nå);
      blokkert = true;
      avbrytNyttForsok();
      meld("utlogget", r.melding || "Du er logget ut. Endringen ligger her til du er inne igjen.");
      Økt.meldUtlogget(r.melding);
    }else{
      behold(nå);
      meld("ulagret", r.melding || "Lagringen avviste endringen.");
      if(r.detaljer) console.warn("Avvist av lagringen:", r.detaljer);
    }
  }catch{
    behold(nå);
    meld("frakoblet", I_APP ? "Fikk ikke skrevet til datafilen."
                            : "Ingen kontakt med lagringen.");
    planleggNyttForsok();
  }finally{
    sender = false;
  }
  if(lagret && ventende === null) meld("lagret");

  if(vilPrøveIgjen){ vilPrøveIgjen = false; avbrytNyttForsok(); kjør(); return; }
  if(ventende !== null && !blokkert
     && tilstand.navn !== "ulagret" && tilstand.navn !== "frakoblet") kjør();
}

function behold(nå){ if(ventende === null) ventende = nå; }

function planleggNyttForsok(){
  if(forsok) return;
  forsok = setTimeout(() => { forsok = null; kjør(); }, NYTT_FORSOK);
}
function avbrytNyttForsok(){ if(forsok){ clearTimeout(forsok); forsok = null; } }

export function prøvIgjen(){
  if(sender){ vilPrøveIgjen = true; return; }
  avbrytNyttForsok();
  if(timer){ clearTimeout(timer); timer = null; }
  kjør();
}

export function nåMedEnGang(flukt){ if(timer){ clearTimeout(timer); timer = null; } return kjør(flukt); }

export function settVersjon(v){ versjon = v || 0; }

addEventListener("visibilitychange", () => { if(document.visibilityState === "hidden") nåMedEnGang(true); });
addEventListener("pagehide", () => { nåMedEnGang(true); });
