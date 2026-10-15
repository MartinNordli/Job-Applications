/* ============================================================
   Varsling: fristvarselet sett fra flaten.

   To grener, ett grensesnitt, som src/okt.js:

   I appmodus leses og skrives varsel.json i profilens katalog over
   Rust, og selve sjekken gjøres av Rust (src-tauri/src/varsel.rs),
   som viser varselet i macOS sitt varselsenter. Det er den samme
   koden bakgrunnsjobben kjører når appen er lukket.

   I nettlesermodus går innstillingen og sjekken til serveren, og
   varselet vises av nettleseren. Sjekken spørres bare når siden har
   lov til å vise varsler: serveren fører alt den svarer med i loggen,
   og et varsel som ikke kunne vises skal ikke regnes som sendt.

   Ingen av funksjonene kaster.

   hentInnstilling()  → { ok: true, på, dagerFør, intervju } | { ok: false, melding }
   settInnstilling(i) → samme form
   sjekk()            → antall varsler som ble vist (0 ved feil)
   tillatelse()       → "app" | "granted" | "denied" | "default" | "ustøttet"
   beOmTillatelse()   → det samme, etter at nettleseren har spurt
   visRadarvarsel(t)  → true når et varsel ble vist (se nederst)
   ============================================================ */

import * as Økt from "./okt.js";
import { INNSTILLINGSFIL, VERSJON, validerInnstilling, lesInnstilling } from "./fristvarsel.mjs";

const I_APP = typeof window !== "undefined" && !!window.__TAURI__;
const minId = () => Økt.nåværendeBruker()?.id ?? null;
const invoke = (navn, arg) => window.__TAURI__.core.invoke(navn, arg);

async function appFiler(){
  const bruker = minId();
  if(!bruker) throw new Error("Ingen profil er valgt.");
  const { lagTauriFiler } = await import("./tauri-filer.mjs");
  return lagTauriFiler({ bruker });
}

const utenVersjon = ({ på, dagerFør, intervju }) => ({ ok: true, på, dagerFør, intervju: intervju !== false });
const feil = (melding) => ({ ok: false, melding });

async function http(sti, valg){
  const svar = await fetch(sti, valg);
  let kropp = null;
  try{ kropp = await svar.json(); }catch{ /* tomt svar */ }
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
  try{ await Notification.requestPermission(); }catch{ /* eldre nettlesere: tilbakekall */ }
  return tillatelse();
}

/* Én sjekk om gangen. Lagring, døgnskifte og timeren kan treffe
   samtidig, og to sjekker på rad gir bare den andre ingenting å gjøre. */
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
      new Notification(v.tittel, { body: v.tekst, icon: "src/ikon.png", lang: "no",
        tag: v.art === "intervju" ? `intervju-${v.id}-${v.iid}-${v.type}` : "frist-" + v.id });
    return varsler.length;
  }catch{ return 0; }   /* et varsel som uteblir er ikke verdt å forstyrre flaten for */
}

/* Radar-varselet: teksten er laget av kjernen (varseltekst i
   src/radarlogikk.mjs). I appen viser Rust det i varselsenteret; i
   nettleseren vises det bare når siden har lov, og et varsel som ikke
   kunne vises, regnes ikke som vist. Kaster aldri. */
export async function visRadarvarsel(tekst){
  if(typeof tekst !== "string" || !tekst.trim()) return false;
  try{
    if(I_APP) return await invoke("radar_varsel", { tekst });
    if(tillatelse() !== "granted") return false;
    new Notification("Radar", { body: tekst, tag: "radar", icon: "src/ikon.png", lang: "no" });
    return true;
  }catch{ return false; }
}
