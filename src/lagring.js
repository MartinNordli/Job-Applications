/* ============================================================
   Lagring — klientsiden av datafilen.

   Appen kaller lagre() etter hver endring, akkurat som den gjorde
   mot localStorage. Forskjellen er at hele dokumentet skrives om
   igjen hver gang — som ett PUT i nettleseren, som ett filbytte i
   Mac-appen.

   Ingenting forsvinner stille: mislykkes en skriving, blir dataene
   liggende og tilstanden sier «ikke lagret» til den går gjennom.
   ============================================================ */

import * as Økt from "./okt.js";

const API = "/api/jobber";
const NYTT_FORSOK = 4000;     /* prøver igjen selv når serveren er borte */

/* To transportlag, samme regler. I nettleseren går alt gjennom serveren;
   i appen kalles lagerlogikken rett, med Rust som filsystem. Alt annet i
   denne filen er felles: sperren, nye forsøk og tilstanden i stripa. */
export const I_APP = typeof window !== "undefined" && !!window.__TAURI__;

/* Ventetiden finnes for å slippe å sende hele lista over nettet for hvert
   tastetrykk. I appen er skrivingen et lokalt filbytte, og hver lagring
   kommer uansett fra en bevisst handling — da er det bedre å ha det på
   disk med én gang, i tilfelle appen lukkes i samme øyeblikk. */
const FORSINKELSE = I_APP ? 0 : 250;

/* Ett lager per profil, og aldri to for samme profil: skrivekøen
   ligger i closuren i lagerlogikk.mjs, så to instanser ville gitt to
   køer og dermed en tapt skriving. Cachen nullstilles av seg selv når
   den innloggede skifter — det er nok å sammenlikne id-en her, i
   stedet for at hver innlogging må huske å rydde etter seg.

   Uten en innlogget profil skrives ingenting. Rota er migreringskilden
   og skal ikke få nye rader stille lagt i seg. */
let appLager = null, appLagerFor = null;
async function lokaltLager(){
  const id = Økt.nåværendeBruker()?.id ?? null;
  if(!id) throw new Error("Ingen profil er valgt.");

  if(!appLager || appLagerFor !== id){
    const [{ lagLager }, { lagTauriFiler }] = await Promise.all([
      import("./lagerlogikk.mjs"),
      import("./tauri-filer.mjs")
    ]);
    appLager = lagLager({ filer: await lagTauriFiler({ bruker: id }),
                          lagId: () => crypto.randomUUID() });
    appLagerFor = id;
  }
  return appLager;
}

/* Hvor datafilen ligger — bare til det appen sier på skjermen. */
export async function datakatalog(){
  if(!I_APP) return null;
  try{ return (await lokaltLager()).katalog; }catch{ return null; }
}

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

async function hentOverHttp(){
  let svar;
  try{ svar = await fetch(API, { headers: { accept: "application/json" } }); }
  catch{ const e = new Error("Ingen kontakt med lagringen."); e.frakoblet = true; throw e; }

  let kropp = null;
  try{ kropp = await svar.json(); }catch{ /* håndteres under */ }

  /* Økten er borte. Det er ikke «ingen kontakt» og ikke «ødelagt fil»
     — det er en tredje ting, og flaten må vise porten, ikke stripa. */
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

/* `valg.beholdVentende` finnes for ett tilfelle: brukeren ble logget
   ut med noe ulagret, og logger inn igjen som SAMME bruker. Da skal de
   ulagrede endringene overleve hentingen. Den som henter slik må selv
   kalle frigi() og deretter prøvIgjen(); da skrives de mot den ferske
   versjonen. Har en annen fane skrevet i mellomtiden, gir det 409 —
   nøyaktig riktig, og den veien finnes allerede.

   Ved bytte til en ANNEN bruker skal ingenting beholdes. Da er
   location.reload() svaret, ikke dette flagget. */
export async function hent(valg = {}){
  let kropp;
  try{ kropp = I_APP ? await hentLokalt() : await hentOverHttp(); }
  catch(e){
    if(e.ødelagt) blokkert = true;     /* filen er uleselig — ikke rør den */
    if(e.utlogget) blokkert = true;    /* vi vet ikke lenger hvem lista tilhører */
    throw e;
  }

  /* Etter en vellykket henting er skjermen lik filen. Eventuell
     konflikt- eller frakoblet-tilstand hører fortiden til, og en
     avvist endring er nå bevisst forkastet av brukeren. */
  /* Versjonen overtas bare når vi faktisk forkaster det som lå og ventet.
     Beholder vi en ulagret endring, må den skrives mot versjonen den ble
     laget mot — ellers bærer den et tall den aldri er blitt prøvd mot, og
     en skriving fra en annen fane blir borte uten at noen får vite det. */
  if(!valg.beholdVentende){ versjon = kropp.versjon || 0; ventende = null; }
  blokkert = false;
  overstyrOdelagt = false;
  avbrytNyttForsok();
  meld(ventende === null ? "lagret" : "lagrer");
  return kropp;                 /* { versjon, jobber, tom?, advarsel?, forkastet? } */
}

/* ---------- lagre ---------- */

export function lagre(jobber){
  ventende = jobber;                  /* holdes uansett, så ingenting går tapt */
  if(blokkert) return;                /* tilstanden er allerede forklart i stripa */
  meld("lagrer");
  if(!timer) timer = setTimeout(() => { timer = null; kjør(); }, FORSINKELSE);
}

/* De to transportlagene svarer med samme fire utfall, så kjør() slipper
   å vite om den snakker med en server eller med filsystemet. */

async function skrivOverHttp(jobber, flukt){
  /* keepalive lar skrivingen overleve at fanen lukkes, men fetch
     begrenser slike kropper til 64 KiB. Derfor bare når vi faktisk
     er på vei ut — ellers ville lista sluttet å lagre rundt 140
     søknader, uten annen forklaring enn «ingen kontakt». */
  const svar = await fetch(API, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ versjon, jobber,
                           ...(overstyrOdelagt ? { overstyrOdelagt: true } : {}) }),
    ...(flukt ? { keepalive: true } : {})
  });
  let kropp = null;
  try{ kropp = await svar.json(); }catch{ /* håndteres under */ }

  if(svar.ok && kropp)              return { utfall: "ok", kropp };
  if(svar.status === 409 && kropp)  return { utfall: "konflikt", kropp };
  /* Må stå foran den generiske avvist-grenen. Ellers får brukeren
     «Lagringen avviste endringen» — feil forklaring — og en «Prøv
     igjen»-knapp som vil feile for alltid. */
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

/* Skriver det som ligger og venter. Kalles på nytt av seg selv hvis
   det kom inn en ny endring mens forrige skriving var underveis. */
async function kjør(flukt){
  if(sender || blokkert || ventende === null) return;
  sender = true;
  const nå = ventende;
  ventende = null;
  meld("lagrer");

  try{
    const r = I_APP ? await skrivLokalt(nå) : await skrivOverHttp(nå, flukt);

    if(r.utfall === "ok"){
      versjon = r.kropp.versjon;
      overstyrOdelagt = false;
      avbrytNyttForsok();
      if(ventende === null) meld("lagret");
    }else if(r.utfall === "konflikt"){
      /* Noen andre har skrevet. Vi overtar bevisst IKKE versjonen
         herfra — da ville neste tastetrykk blitt godtatt og skrevet
         over den andre. Sperren står til brukeren henter på nytt. */
      behold(nå);
      blokkert = true;
      meld("konflikt", "Dataene ble endret et annet sted.");
      lyttere.forEach(fn => fn(tilstand, r.kropp));
    }else if(r.utfall === "ødelagt"){
      behold(nå);
      blokkert = true;
      meld("ulagret", r.melding || "Datafilen kan ikke leses.");
    }else if(r.utfall === "utlogget"){
      /* Endringen ligger i behold, sperren står, og ingen ny timer
         planlegges: et nytt forsøk ville feilet like sikkert og bare
         fylt nettverksfanen. Porten kommer opp via Økt.påUtlogget. */
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
