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

/* Sperre. Så lenge den står, skrives ingenting til disk.
   Settes når vi ikke vet hva som ligger der fra før — ødelagt fil,
   konflikt med en annen fane, eller et valg brukeren ikke har tatt
   ennå. Uten den ville neste lagring blitt godtatt mot en tom
   katalog og skrevet over sikkerhetskopien. */
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

/* Ingenting skrives før brukeren har bestemt seg. */
export function blokker(grunn){ blokkert = true; if(grunn) meld("blokkert", grunn); }

/* Brukeren har valgt. `overstyr` betyr «rydd bort den ødelagte filen». */
export function frigi(overstyr){
  blokkert = false;
  overstyrOdelagt = !!overstyr;
  if(ventende !== null) kjør();
}
export const gjeldendeVersjon = () => versjon;

/* ---------- hente ---------- */

export async function hent(){
  let svar;
  try{ svar = await fetch(API, { headers: { accept: "application/json" } }); }
  catch{ const e = new Error("Ingen kontakt med lagringen."); e.frakoblet = true; throw e; }

  let kropp = null;
  try{ kropp = await svar.json(); }catch{ /* håndteres under */ }

  if(svar.status === 503 && kropp && kropp.feil){
    blokkert = true;            /* filen er uleselig — ikke rør den */
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
  blokkert = false;
  overstyrOdelagt = false;
  avbrytNyttForsok();
  meld("lagret");
  return kropp;                 /* { versjon, jobber, tom?, advarsel?, forkastet? } */
}

/* ---------- lagre ---------- */

export function lagre(jobber){
  ventende = jobber;                  /* holdes uansett, så ingenting går tapt */
  if(blokkert) return;                /* tilstanden er allerede forklart i stripa */
  meld("lagrer");
  if(!timer) timer = setTimeout(() => { timer = null; kjør(); }, FORSINKELSE);
}

/* Skriver det som ligger og venter. Kalles på nytt av seg selv hvis
   det kom inn en ny endring mens forrige skriving var underveis. */
async function kjør(flukt){
  if(sender || blokkert || ventende === null) return;
  sender = true;
  const nå = ventende;
  ventende = null;
  meld("lagrer");

  try{
    /* keepalive lar skrivingen overleve at fanen lukkes, men fetch
       begrenser slike kropper til 64 KiB. Derfor bare når vi faktisk
       er på vei ut — ellers ville lista sluttet å lagre rundt 140
       søknader, uten annen forklaring enn «ingen kontakt». */
    const svar = await fetch(API, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versjon, jobber: nå,
                             ...(overstyrOdelagt ? { overstyrOdelagt: true } : {}) }),
      ...(flukt ? { keepalive: true } : {})
    });
    let kropp = null;
    try{ kropp = await svar.json(); }catch{ /* håndteres under */ }

    if(svar.ok && kropp){
      versjon = kropp.versjon;
      overstyrOdelagt = false;
      avbrytNyttForsok();
      if(ventende === null) meld("lagret");
    }else if(svar.status === 409 && kropp){
      /* En annen fane har skrevet. Vi overtar bevisst IKKE versjonen
         herfra — da ville neste tastetrykk blitt godtatt og skrevet
         over den andre fanen. Sperren står til brukeren henter på nytt. */
      behold(nå);
      blokkert = true;
      meld("konflikt", "Dataene ble endret et annet sted.");
      lyttere.forEach(fn => fn(tilstand, kropp));
    }else if(svar.status === 503){
      behold(nå);
      blokkert = true;
      meld("ulagret", (kropp && kropp.melding) || "Datafilen kan ikke leses.");
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

  if(vilPrøveIgjen){ vilPrøveIgjen = false; avbrytNyttForsok(); kjør(); return; }
  if(ventende !== null && !blokkert
     && tilstand.navn !== "ulagret" && tilstand.navn !== "frakoblet") kjør();
}

/* Legger tilbake det som ikke kom fram — men aldri oppå noe nyere. */
function behold(nå){ if(ventende === null) ventende = nå; }

function planleggNyttForsok(){
  if(forsok) return;
  forsok = setTimeout(() => { forsok = null; kjør(); }, NYTT_FORSOK);
}
function avbrytNyttForsok(){ if(forsok){ clearTimeout(forsok); forsok = null; } }

/* Manuelt «prøv igjen» fra stripa eller varselet. */
export function prøvIgjen(){
  /* Er en skriving allerede i lufta, skal vi vente på den i stedet for
     å slukke timerne og gå tomhendt ut. */
  if(sender){ vilPrøveIgjen = true; return; }
  avbrytNyttForsok();
  if(timer){ clearTimeout(timer); timer = null; }
  kjør();
}

/* Tømmer køen nå i stedet for å vente på debouncen. */
export function nåMedEnGang(flukt){ if(timer){ clearTimeout(timer); timer = null; } return kjør(flukt); }

/* Første skriving etter migrering: setter versjonen fra svaret. */
export function settVersjon(v){ versjon = v || 0; }

/* Fanen lukkes eller skjules — få ut det som ligger og venter.
   keepalive på fetchen gjør at skrivingen overlever unload. */
addEventListener("visibilitychange", () => { if(document.visibilityState === "hidden") nåMedEnGang(true); });
addEventListener("pagehide", () => { nåMedEnGang(true); });
/* Ingen «vil du forlate siden?»-dialog her. Den kan bare stille et
   spørsmål brukeren ikke kan svare på, den dukker opp igjen ved hver
   eneste navigering så lenge noe står ulagret, og stripa sier allerede
   det samme uten å blokkere siden. pagehide-flushen over er det som
   faktisk redder skrivingen. */
