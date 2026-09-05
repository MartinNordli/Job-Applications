/* ============================================================
   Økt — klientens «hvem er logget inn».

   Ett sted for alle kall mot auth-endepunktene, så flaten slipper
   å kjenne statuskoder, cookier eller feilnavn. Reglene for felt
   ligger i src/brukerlogikk.mjs og reeksporteres nederst, slik at
   skjemaet kan si fra om et for kort passord uten å spørre
   serveren først.

   To grener, ett grensesnitt. I nettlesermodus går alt til
   serveren, som er en ekte grense. I appmodus finnes ingen server:
   src/okt-app.mjs leser registeret over Rust og verifiserer med
   crypto.subtle mot samme hashformat. Flaten ser ingen forskjell —
   ingen av funksjonene under skiftet form da appgrenen kom inn.

   Appgrenen lastes først når den trengs, med en dynamisk import.
   Nettleseren skal ikke hente kode for et filsystem den ikke har.

   Filnavnet er ASCII med vilje. Utviklingsserveren til Tauri
   («npm run app:dev») svarer med index.html på enhver adresse den
   ikke kjenner, og den prosentkoder ikke stien: en modul som het
   «økt.js» ble hentet som HTML, og hele modulgrafen falt sammen
   uten en eneste feilmelding. Identifikatorer kan gjerne ha ø; det
   som går over en URL, kan ikke.

   Ingen sirkulær import: okt.js → brukerlogikk.mjs / okt-app.mjs.
   lagring.js og import.js importerer denne; app.js importerer den.
   Ingen vei tilbake.

   ------------------------------------------------------------
   GRENSESNITTET, for den som tegner flaten
   ------------------------------------------------------------

   Ingen av funksjonene kaster. Alle svarer med et objekt.

   hentØkt() → et av fire:
     { innlogget: true,  bruker, erFørste, harNokkel }
     { innlogget: false, harBrukere }
     { innlogget: false, harBrukere: true, ødelagt: true, melding }
     { innlogget: false, harBrukere: false, frakoblet: true, melding }
   `bruker` er alltid { id, epost, navn }. Aldri noe mer.

   registrer({epost, navn?, passord})  →
   loggInn({epost, passord})           →
     { ok: true, bruker, erFørste, migrert?, migreringsfeil? }
     { ok: false, feil, melding, detaljer?, retryEtter? }

   loggUt({allePlasser?})       → { ok: true }
   byttPassord({gammelt, nytt}) → { ok } som over
   hentNokkel()                 → { ok: true, finnes, kilde, hale?, satt? }
   settNokkel(nokkel)           → { ok } som over
   fjernNokkel()                → { ok } som over

   `feil` er en av:
     "ugyldig"        400 — `detaljer` er [{felt, melding}]
     "finnes"         409 — e-posten er tatt
     "stengt"         403 — kontotaket er nådd
     "feil-innlogging"401 — e-post eller passord er feil (samme svar
                            for begge, med vilje)
     "feil-passord"   403 — det gamle passordet stemmer ikke
     "for-mange"      429 — `retryEtter` er sekunder
     "utlogget"       401 — økten er borte
     "frakoblet"          — serveren svarte ikke
     "ødelagt-register"   — brukere.json kan ikke leses
     "ukjent"             — noe annet; `melding` er det vi vet

   påUtlogget(fn) → avmelding. Kalles når serveren har svart 401 på
   noe som krevde en økt — også fra lagring.js og import.js. Det er
   slik flaten får vite at porten må opp igjen. Den kalles én gang
   per bortfall, ikke én gang per kall.

   nåværendeBruker() → siste kjente bruker, synkront, eller null.
   ============================================================ */

import {
  validerEpost, validerNavn, validerPassord, validerRegistrering,
  normaliserEpost, MIN_PASSORD, MAKS
} from "./brukerlogikk.mjs";

/* Samme sjekk som i lagring.js, gjentatt her og ikke importert:
   lagring.js importerer denne filen, ikke omvendt. */
export const I_APP = typeof window !== "undefined" && !!window.__TAURI__;

let bruker = null;
let varslet = false;            /* så ett bortfall gir én beskjed */
const lyttere = new Set();

/* ---------- appgrenen ---------- */
/*
   Lastes ved første kall og bare i appmodus. lagAppØkt får inn alt
   som rører verden: en filer-fabrikk over Rust og localStorage.
   Svarene har nøyaktig samme form som svarene fra serveren, så
   funksjonene under kan dele all etterbehandlingen.
*/
let appLøfte = null;
function app(){
  if(!appLøfte){
    appLøfte = Promise.all([
      import("./okt-app.mjs"),
      import("./tauri-filer.mjs")
    ]).then(([{ lagAppØkt }, { lagTauriFiler }]) => lagAppØkt({
      filerFor: b => lagTauriFiler({ bruker: b }),
      minne: window.localStorage
    }));
    appLøfte.catch(() => { appLøfte = null; });   /* la neste kall få prøve igjen */
  }
  return appLøfte;
}

export function nåværendeBruker(){ return bruker; }

export function påUtlogget(fn){
  lyttere.add(fn);
  return () => lyttere.delete(fn);
}

/* Kalles av lagring.js og import.js når serveren svarer 401 på noe
   som krevde en økt. Idempotent innenfor ett bortfall: fem kall som
   alle får 401 skal gi én port, ikke fem. */
export function meldUtlogget(melding){
  bruker = null;
  if(varslet) return;
  varslet = true;
  const m = melding || "Du er logget ut. Logg inn på nytt.";
  lyttere.forEach(fn => { try{ fn(m); }catch{ /* en lytter skal ikke stoppe de andre */ } });
}

function husk(b){ bruker = b || null; varslet = false; }

/* ---------- transporten ---------- */

/* Ett sted for alle kall. Skiller på tre ting flaten bryr seg om:
   nådde vi serveren, sa den ja, og hva het feilen. */
async function kall(sti, valg = {}){
  let svar;
  try{
    svar = await fetch(sti, {
      ...valg,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(valg.headers || {}) }
    });
  }catch{
    return { ok: false, feil: "frakoblet", melding: "Ingen kontakt med serveren." };
  }

  let kropp = null;
  if(svar.status !== 204){
    try{ kropp = await svar.json(); }catch{ /* håndteres under */ }
  }

  if(svar.ok) return { ok: true, status: svar.status, kropp: kropp || {} };

  if(svar.status === 401 && kropp?.feil === "utlogget"){
    meldUtlogget(kropp.melding);
    return { ok: false, feil: "utlogget", melding: kropp.melding || "Du er logget ut." };
  }

  return {
    ok: false,
    feil: kropp?.feil || "ukjent",
    melding: kropp?.melding || `Serveren svarte ${svar.status}.`,
    ...(kropp?.detaljer ? { detaljer: kropp.detaljer } : {}),
    ...(typeof kropp?.retryEtter === "number" ? { retryEtter: kropp.retryEtter } : {})
  };
}

/* Appgrenen skal aldri kaste — som resten av modulen. En feil fra
   Rust eller fra crypto.subtle blir «frakoblet», fordi det er
   maskinen som svikter, ikke det brukeren skrev. */
async function iApp(fn){
  try{ return await fn(await app()); }
  catch(e){
    return { ok: false, feil: "frakoblet",
             melding: "Noe gikk galt lokalt. " + String(e?.message || e) };
  }
}

/* Én bruker husket ett sted, uansett gren. */
function husket(r){
  if(r.ok && r.bruker) husk(r.bruker);
  return r;
}

const somJson = (metode, data) => ({
  method: metode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(data ?? {})
});

/* ---------- de utadvendte ---------- */

export async function hentØkt(){
  if(I_APP){
    let r;
    try{ r = await (await app()).hentØkt(); }
    catch(e){
      bruker = null;
      return { innlogget: false, harBrukere: false, frakoblet: true,
               melding: "Fikk ikke lest profilene. " + String(e?.message || e) };
    }
    if(r.innlogget) husk(r.bruker); else bruker = null;
    return r;
  }

  const r = await kall("/api/okt");
  if(!r.ok){
    bruker = null;
    return { innlogget: false, harBrukere: false, frakoblet: true,
             melding: "Ingen kontakt med serveren. Kjører den? Start den med «npm start»." };
  }

  const k = r.kropp;
  if(k.innlogget){
    husk(k.bruker);
    return { innlogget: true, bruker: k.bruker, erFørste: !!k.erFørste, harNokkel: !!k.harNokkel };
  }

  bruker = null;
  return { innlogget: false, harBrukere: !!k.harBrukere,
           ...(k.ødelagt ? { ødelagt: true, melding: k.melding } : {}) };
}

export async function registrer({ epost, navn, passord } = {}){
  /* Valideres her også, slik at et åpenbart feil skjema ikke bruker
     opp et av de fem registreringsforsøkene i timen. */
  const v = validerRegistrering({ epost, navn, passord });
  if(!v.ok) return { ok: false, feil: "ugyldig", detaljer: v.feil,
                     melding: "Se over feltene." };

  if(I_APP) return husket(await iApp(a => a.registrer({ epost, navn, passord })));

  const r = await kall("/api/registrer", somJson("POST", { epost, navn, passord }));
  if(!r.ok) return r;
  husk(r.kropp.bruker);
  return { ok: true, bruker: r.kropp.bruker, erFørste: !!r.kropp.erFørste,
           ...(r.kropp.migrert ? { migrert: r.kropp.migrert } : {}),
           ...(r.kropp.migreringsfeil ? { migreringsfeil: r.kropp.migreringsfeil } : {}) };
}

export async function loggInn({ epost, passord } = {}){
  if(I_APP) return husket(await iApp(a => a.loggInn({ epost, passord })));

  const r = await kall("/api/logg-inn", somJson("POST", { epost, passord }));
  if(!r.ok) return r;
  husk(r.kropp.bruker);
  return { ok: true, bruker: r.kropp.bruker, erFørste: !!r.kropp.erFørste };
}

/* Idempotent: uten økt er svaret det samme. `allePlasser` feller
   også økter i andre faner og på andre maskiner. */
export async function loggUt({ allePlasser = false } = {}){
  const r = I_APP ? await iApp(a => a.loggUt({ allePlasser }))
                  : await kall("/api/logg-ut", somJson("POST", { allePlasser }));
  bruker = null;
  varslet = false;
  return r.ok ? { ok: true } : r;
}

export async function byttPassord({ gammelt, nytt } = {}){
  const p = validerPassord(nytt);
  if(!p.ok) return { ok: false, feil: "ugyldig",
                     detaljer: [{ felt: "nytt", melding: p.melding }], melding: p.melding };
  if(I_APP) return iApp(a => a.byttPassord({ gammelt, nytt }));

  const r = await kall("/api/passord", somJson("POST", { gammelt, nytt }));
  return r.ok ? { ok: true } : r;
}

/* ---------- nøkkelen ---------- */
/*
   Nøkkelen går inn og aldri ut. Svaret bærer `kilde` og eventuelt
   `hale` — de fire siste tegnene, og bare når nøkkelen er lang nok
   til at det ikke er en for stor andel av den. Flaten skal aldri
   forsøke å vise mer; det finnes ikke mer å vise.
*/
export async function hentNokkel(){
  if(I_APP) return iApp(a => a.hentNokkel());
  const r = await kall("/api/nokkel");
  return r.ok ? { ok: true, ...r.kropp } : r;
}

export async function settNokkel(nokkel){
  if(I_APP) return iApp(a => a.settNokkel(nokkel));
  const r = await kall("/api/nokkel", somJson("PUT", { nokkel }));
  return r.ok ? { ok: true } : r;
}

export async function fjernNokkel(){
  if(I_APP) return iApp(a => a.fjernNokkel());
  const r = await kall("/api/nokkel", { method: "DELETE" });
  return r.ok ? { ok: true } : r;
}

/* ---------- reglene, til feltvalidering i flaten ---------- */

export { validerEpost, validerNavn, validerPassord, validerRegistrering,
         normaliserEpost, MIN_PASSORD, MAKS };
