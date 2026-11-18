import * as Økt from "../konto/okt.js";
import { INNSTILLINGSFIL, VERSJON, validerInnstilling, lesInnstilling } from "./fristvarsel.mjs";

const I_APP = typeof window !== "undefined" && !!window.__TAURI__;
const minId = () => Økt.nåværendeBruker()?.id ?? null;
const invoke = (navn, arg) => window.__TAURI__.core.invoke(navn, arg);

async function appFiler(){
  const bruker = minId();
  if(!bruker) throw new Error("Ingen profil er valgt.");
  const { lagTauriFiler } = await import("../felles/tauri-filer.mjs");
  return lagTauriFiler({ bruker });
}

const utenVersjon = ({ på, dagerFør, intervju }) => ({ ok: true, på, dagerFør, intervju: intervju !== false });
const feil = (melding) => ({ ok: false, melding });

async function http(sti, valg){
  const svar = await fetch(sti, valg);
  let kropp = null;
  try{ kropp = await svar.json(); }catch{}
  if(svar.status === 401 && kropp?.feil === "utlogget"){ Økt.meldUtlogget(); throw new Error("Du er logget ut."); }
  if(!svar.ok) throw new Error(kropp?.detaljer?.[0]?.melding || kropp?.melding || "Serveren svarte " + svar.status + ".");
  return kropp;
}

export async function hentInnstilling(){
  try{
    if(I_APP) return utenVersjon(lesInnstilling(await (await appFiler()).lesTekst(INNSTILLINGSFIL)));
    return utenVersjon(await http("/api/varsel"));
  }catch(e){ return feil("Fikk ikke lest varselinnstillingen. " + (e?.message || e)); }
}

export async function settInnstilling({ på, dagerFør, intervju = true }){
  const v = validerInnstilling({ versjon: VERSJON, på, dagerFør, intervju });
  if(!v.ok) return feil(v.feil[0].melding);
  try{
    if(I_APP){
      await (await appFiler()).skrivAtomisk(INNSTILLINGSFIL, JSON.stringify(v.verdi, null, 2) + "\n");
      return utenVersjon(v.verdi);
    }
    return utenVersjon(await http("/api/varsel", { method: "PUT",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ på, dagerFør, intervju }) }));
  }catch(e){ return feil("Innstillingen ble ikke lagret. " + (e?.message || e)); }
}

export function tillatelse(){
  if(I_APP) return "app";
  return typeof Notification === "undefined" ? "ustøttet" : Notification.permission;
}

export async function beOmTillatelse(){
  if(tillatelse() !== "default") return tillatelse();
  try{ await Notification.requestPermission(); }catch{}
  return tillatelse();
}

let pågår = null;
export function sjekk(){
  if(!pågår) pågår = sjekkNå().finally(() => { pågår = null; });
  return pågår;
}

async function sjekkNå(){
  const bruker = minId();
  if(!bruker) return 0;
  try{
    if(I_APP) return await invoke("sjekk_frister", { bruker });
    if(tillatelse() !== "granted") return 0;
    const { varsler = [] } = await http("/api/varsel/sjekk", { method: "POST" });
    for(const v of varsler)
      new Notification(v.tittel, { body: v.tekst, icon: "src/felles/ikon.png", lang: "no",
        tag: v.art === "intervju" ? `intervju-${v.id}-${v.iid}-${v.type}` : "frist-" + v.id });
    return varsler.length;
  }catch{ return 0; }
}

export async function visRadarvarsel(tekst){
  if(typeof tekst !== "string" || !tekst.trim()) return false;
  try{
    if(I_APP) return await invoke("radar_varsel", { tekst });
    if(tillatelse() !== "granted") return false;
    new Notification("Radar", { body: tekst, tag: "radar", icon: "src/felles/ikon.png", lang: "no" });
    return true;
  }catch{ return false; }
}
