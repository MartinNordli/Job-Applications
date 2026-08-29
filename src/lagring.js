/* ============================================================
   Lagring — klientsiden av datafilen.

   Appen kaller lagre() etter hver endring, akkurat som den gjorde
   mot localStorage. Forskjellen er at skrivingene samles opp et
   lite øyeblikk og sendes som ett PUT av hele dokumentet.

   Ingenting forsvinner stille: mislykkes en skriving, blir dataene
   liggende og tilstanden sier «ikke lagret» til den går gjennom.
   ============================================================ */

const API = "/api/jobber";
const FORSINKELSE = 250;      /* samler raske endringer i én skriving */
const NYTT_FORSOK = 4000;     /* prøver igjen selv når serveren er borte */

let versjon = 0;
let ventende = null;          /* siste tilstand som skal skrives */
let sender = false;
let timer = null, forsok = null;

const lyttere = new Set();
let tilstand = { navn: "lagret", tid: null, melding: null };

export function påTilstand(fn){ lyttere.add(fn); fn(tilstand); return () => lyttere.delete(fn); }

function meld(navn, melding){
  tilstand = { navn, melding: melding || null, tid: navn === "lagret" ? new Date() : tilstand.tid };
  lyttere.forEach(fn => fn(tilstand));
}

export const harUlagret = () => ventende !== null || sender;
export const gjeldendeVersjon = () => versjon;

/* ---------- hente ---------- */

export async function hent(){
  let svar;
  try{ svar = await fetch(API, { headers: { accept: "application/json" } }); }
  catch{ const e = new Error("Ingen kontakt med lagringen."); e.frakoblet = true; throw e; }

  let kropp = null;
  try{ kropp = await svar.json(); }catch{ /* håndteres under */ }

  if(svar.status === 503 && kropp && kropp.feil){
    const e = new Error(kropp.feil); e.ødelagt = true; e.sti = kropp.sti;
    e.sikkerhetskopi = kropp.sikkerhetskopi || null; throw e;
  }
  if(!svar.ok || !kropp){
    const e = new Error("Lagringen svarte uventet (" + svar.status + ")."); e.frakoblet = true; throw e;
  }

  /* Etter en vellykket henting er skjermen lik filen. Eventuell
     konflikt- eller frakoblet-tilstand hører fortiden til, og en
     avvist endring er nå bevisst forkastet av brukeren. */
  versjon  = kropp.versjon || 0;
  ventende = null;
  avbrytNyttForsok();
  meld("lagret");
  return kropp;                 /* { versjon, jobber, tom?, advarsel?, forkastet? } */
}

/* ---------- lagre ---------- */

export function lagre(jobber){
  ventende = jobber;
  meld("lagrer");
  if(!timer) timer = setTimeout(() => { timer = null; kjør(); }, FORSINKELSE);
}

/* Skriver det som ligger og venter. Kalles på nytt av seg selv hvis
   det kom inn en ny endring mens forrige skriving var underveis. */
async function kjør(){
  if(sender || ventende === null) return;
  sender = true;
  const nå = ventende;
  ventende = null;
  meld("lagrer");

  try{
    const svar = await fetch(API, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versjon, jobber: nå }),
      keepalive: true                       /* overlever at fanen lukkes */
    });
    let kropp = null;
    try{ kropp = await svar.json(); }catch{ /* håndteres under */ }

    if(svar.ok && kropp){
      versjon = kropp.versjon;
      avbrytNyttForsok();
      if(ventende === null) meld("lagret");
    }else if(svar.status === 409 && kropp){
      /* En annen fane har skrevet. Vi kaster ikke noe — appen får
         beskjed og bestemmer selv hva som skal skje. */
      versjon = kropp.versjon;
      meld("konflikt", "Dataene ble endret et annet sted.");
      lyttere.forEach(fn => fn(tilstand, kropp));
    }else{
      const detalj = kropp && kropp.detaljer ? kropp.detaljer : null;
      behold(nå);
      meld("ulagret", kropp && kropp.feil ? kropp.feil : "Lagringen avviste endringen.");
      if(detalj) console.warn("Avvist av serveren:", detalj);
    }
  }catch{
    behold(nå);
    meld("frakoblet", "Ingen kontakt med lagringen.");
    planleggNyttForsok();
  }finally{
    sender = false;
  }

  if(ventende !== null && tilstand.navn !== "ulagret" && tilstand.navn !== "frakoblet") kjør();
}

/* Legger tilbake det som ikke kom fram — men aldri oppå noe nyere. */
function behold(nå){ if(ventende === null) ventende = nå; }

function planleggNyttForsok(){
  if(forsok) return;
  forsok = setTimeout(() => { forsok = null; kjør(); }, NYTT_FORSOK);
}
function avbrytNyttForsok(){ if(forsok){ clearTimeout(forsok); forsok = null; } }

/* Manuelt «prøv igjen» fra stripa eller varselet. */
export function prøvIgjen(){ avbrytNyttForsok(); if(timer){ clearTimeout(timer); timer = null; } kjør(); }

/* Tømmer køen nå i stedet for å vente på debouncen. */
export function nåMedEnGang(){ if(timer){ clearTimeout(timer); timer = null; } return kjør(); }

/* Første skriving etter migrering: setter versjonen fra svaret. */
export function settVersjon(v){ versjon = v || 0; }

/* Fanen lukkes eller skjules — få ut det som ligger og venter.
   keepalive på fetchen gjør at skrivingen overlever unload. */
addEventListener("visibilitychange", () => { if(document.visibilityState === "hidden") nåMedEnGang(); });
addEventListener("pagehide", () => { nåMedEnGang(); });
addEventListener("beforeunload", e => {
  if(!harUlagret()) return;
  e.preventDefault();
  e.returnValue = "";
});
