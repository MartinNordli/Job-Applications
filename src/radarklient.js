/* ============================================================
   Frontendens vei til Radar. Samme regler i begge modi: i appen
   kjører kjernen (src/radarlogikk.mjs) her i webviewet, over de samme
   Tauri-kommandoene som jobbdokumentene (dokumentene) og hent_json og
   hent_side (nettet); i nettleseren kjører den på serveren, og denne
   modulen kaller rutene i server/radar-api.mjs. Ingen DOM.

   Tilstanden alle funksjonene gir tilbake (tilstandFra i kjernen):

     { revisjon,
       innstillinger: { pa, terskel, maksVurderingerPerDogn, sokeord: [],
         ekskluder: [], steder: [], kilder: { nav: { pa },
         jobbnorge: { pa, fylker: [nummer] } }, karrieresider: [...] },
       innboks: [ { id, kilde, kildeId, url, lenker, selskap, stilling,
         sted, frist, publisert, tekst, prosent, grunner: [tekst],
         status: "ny" | "lagtTil", funnet } ],     nye først
       antallNye,
       karrieresider: [ { id, url, type, navn, pa, feilRad, sist, grunn } ],
         pa false og grunn satt: slått av etter fem feil på rad
       kilder: { nav: { sist, feil }, jobbnorge: { sist, feil } },
       kjoringer: [ { start, slutt, kandidater, nye, vurdert, treff,
         utenVurdering, kilder: [{ kilde, navn, hentet, feil }], bruk,
         feil: [tekst], kostnad } ],               de fem siste, kostnad i kr
       forbruk: { dato, vurderinger, tak },       vurderinger i dag
       kjorerNa }

   hentTilstand()                 tilstanden
   lagreInnstillinger(inn)        pa, terskel, maksVurderingerPerDogn,
                                  sokeord, ekskluder, steder, kilder (ikke
                                  karrieresider); gir tilstanden
   sokNa({ leverandor? })         én kjøring, høyst én i minuttet (feilkode
                                  "for-mange" med sekunder igjen). Gir
                                  { kjort, grunn?: "av"|"opptatt", lagret,
                                  kjoring, antallNye, varsel, tilstand }
                                  og viser varselet når det er ett
   foreslaFraCv({ leverandor? })  ett modellkall som gir { sokeord: [≤12],
                                  steder: [≤6], ekskluder: [≤6] } fra CV-en,
                                  allerede filtrert til ord forfilter kan
                                  bruke. Lagrer ingenting: brukeren retter
                                  forslaget og lagrer med lagreInnstillinger.
                                  Feilkoder "mangler-cv", "mangler-nokkel",
                                  "for-mange" (10 i timen), "modellformat"
   ikkeInteressert(id)            gir tilstanden; feilkode "finnes-ikke"
   leggTilKarriereside({url, navn?})  gir tilstanden; feilkode "ugyldig"
                                  med grunnen når siden ikke kan leses
   fjernKarriereside(id)          gir tilstanden
   slaPaKarriereside(id)          slår på igjen en side som er slått av; gir tilstanden
   soknadFraRad(rad)              søknaden uten id, klar for validerSoknad
                                  og listen: sett kilde: "radar"
   lagtTil(radId, jobbId)         etter at søknaden er lagret i listen under
                                  jobbId: skriver annonsen, merker raden og
                                  starter vanlig match i bakgrunnen. Gir
                                  tilstanden. Feiler annonsen, står raden som ny.
   startTimeplan({ intervall?, påResultat?, påFeil? })
                                  kjører ved start hvis siste kjøring er
                                  eldre enn intervallet (en time), og så hver
                                  time mens siden er åpen. Gir stopp().
                                  påResultat får samme svar som sokNa.
   påEndring(fn)                  kalles med ny tilstand etter hver kjøring
                                  og hver endring herfra; gir en funksjon som
                                  avmelder
   ============================================================ */
import { I_APP, bruker, http, lokaltLager } from "./dokumentklient.js";
import { lokalKallModell } from "./brev.js";
import { lagRadarnett } from "./radarnett.mjs";
import { Brevfeil } from "./dokumentfeil.mjs";
import * as Jobbdokumenter from "./jobbdokumenter.js";
import { visRadarvarsel } from "./varsling.js";
import { søkNå, tilstandFra, lagreInnstillinger as lagreInnstillingerLokalt, ikkeInteressert as ikkeInteressertLokalt,
         markerLagtTil, leggTilKarriereside as leggTilKarrieresideLokalt, fjernKarriereside as fjernKarrieresideLokalt, slåPåKarriereside as slaPaKarrieresideLokalt,
         leggTilFraRad, soknadFraRad, foreslåFraProfil } from "./radarlogikk.mjs";

export { soknadFraRad };
export const TIME = 3600_000;
const RADARFIL = "radar.json";

/* ---------- veien i appen ---------- */

const lokale = new Map();
/* Én instans per profil: grensen på «Søk nå» henger på lagerobjektet. */
function lokal(){
  const id = bruker();
  if(!lokale.has(id)){
    const { lager, hentJobber, sjekk } = lokaltLager(id);
    const rå = window.__TAURI__.core.invoke;
    /* Rust gir feil som tekst. Kjernen leser meldingen fra hvilken som helst feil. */
    const invoke = async (navn, valg) => { try{ return await rå(navn, valg); }catch(e){ throw typeof e === "string" ? Object.assign(new Error(e), { melding: e }) : e; } };
    lokale.set(id, { lager, hentJobber, sjekk, nett: lagRadarnett({ invoke, bruker: id }), kallModell: lokalKallModell(id, sjekk) });
  }
  return lokale.get(id);
}
const lesLokalt = async () => tilstandFra(await lokal().lager.les(RADARFIL));

/* Feil fra nettet som ikke er våre egne (en tekst fra Rust) blir en Brevfeil
   med meldingen, så flaten ser samme form begge steder. */
const oversett = e => e instanceof Error || e?.code ? e : new Brevfeil("nett", String(e?.melding || e || "Noe gikk galt."));

/* ---------- påmelding ---------- */

const lyttere = new Set();
export function påEndring(fn){ lyttere.add(fn); return () => lyttere.delete(fn); }
function meld(tilstand){
  for(const fn of lyttere){ try{ fn(tilstand); }catch{ /* en lytter som feiler, skal ikke stoppe de andre */ } }
  return tilstand;
}
const tilstandAv = svar => meld(svar.tilstand);

/* ---------- funksjonene ---------- */

export async function hentTilstand(){
  return I_APP ? lesLokalt() : (await http("/api/radar")).tilstand;
}

export async function lagreInnstillinger(inn){
  if(I_APP){
    const l = lokal();
    await lagreInnstillingerLokalt(l.lager, inn);
    return meld(await lesLokalt());
  }
  return tilstandAv(await http("/api/radar/innstillinger", { method: "PUT", body: inn }));
}

export async function sokNa({ leverandor = Jobbdokumenter.valgtLeverandør() } = {}){
  let svar;
  if(I_APP){
    const l = lokal();
    const u = await søkNå({ dokumenter: l.lager, jobber: await l.hentJobber(), nett: l.nett, kallModell: l.kallModell, leverandor })
      .catch(e => { throw oversett(e); });
    const { nye, ...rest } = u;
    svar = { ...rest, antallNye: nye?.length ?? 0, tilstand: await lesLokalt() };
  }else{
    svar = await http("/api/radar/kjor", { method: "POST", body: { leverandor } });
  }
  meld(svar.tilstand);
  if(svar.varsel) visRadarvarsel(svar.varsel);
  return svar;
}

export async function foreslaFraCv({ leverandor = Jobbdokumenter.valgtLeverandør() } = {}){
  if(I_APP){
    const l = lokal();
    return foreslåFraProfil({ dokumenter: l.lager, kallModell: l.kallModell, leverandor }).catch(e => { throw oversett(e); });
  }
  return (await http("/api/radar/forslag", { method: "POST", body: { leverandor } })).forslag;
}

export async function ikkeInteressert(id){
  if(I_APP){
    await ikkeInteressertLokalt(lokal().lager, id);
    return meld(await lesLokalt());
  }
  return tilstandAv(await http("/api/radar/ikke-interessert", { method: "POST", body: { id } }));
}

export async function leggTilKarriereside({ url, navn = "" }){
  if(I_APP){
    const l = lokal();
    await leggTilKarrieresideLokalt(l.lager, { url, navn, nett: l.nett }).catch(e => { throw oversett(e); });
    return meld(await lesLokalt());
  }
  return tilstandAv(await http("/api/radar/karrieresider", { method: "POST", body: { url, navn } }));
}

export async function slaPaKarriereside(id){
  if(I_APP){
    await slaPaKarrieresideLokalt(lokal().lager, id).catch(e => { throw oversett(e); });
    return meld(await lesLokalt());
  }
  return tilstandAv(await http(`/api/radar/karrieresider/${encodeURIComponent(id)}`, { method: "PUT" }));
}

export async function fjernKarriereside(id){
  if(I_APP){
    await fjernKarrieresideLokalt(lokal().lager, id);
    return meld(await lesLokalt());
  }
  return tilstandAv(await http(`/api/radar/karrieresider/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

/* Søknaden er lagret i listen av flaten (bare flaten skriver jobber.json).
   Her: annonsen på jobbdokumentet, så raden, så vanlig match i bakgrunnen. */
export async function lagtTil(radId, jobbId){
  const tilstand = await hentTilstand();
  const rad = tilstand.innboks.find(r => r.id === radId) ?? tilstand.under.find(r => r.id === radId);
  if(!rad) throw new Brevfeil("finnes-ikke", "Stillingen er ikke i innboksen lenger.", 404);
  const marker = async id => I_APP ? markerLagtTil(lokal().lager, id)
    : http("/api/radar/lagt-til", { method: "POST", body: { id } });
  await leggTilFraRad({ rad, jobbId, marker,
    lagreAnnonse: Jobbdokumenter.lagreAnnonse, vurder: Jobbdokumenter.vurderIBakgrunnen });
  return meld(await hentTilstand());
}

/* ---------- timeplanen ---------- */

/* Mens siden er åpen: ved start hvis siste kjøring er eldre enn
   intervallet, og så hvert intervall. Leien i radar.json hindrer
   dobbeltkjøring mot serverens egen time, og «Søk nå»-grensen gjør at
   en kjøring like etter en annen bare hoppes over. Feil melder fra til
   påFeil og stopper ikke timeplanen. */
export function startTimeplan({ intervall = TIME, påResultat, påFeil } = {}){
  let stoppet = false, pågår = false;
  const kjør = async bareGamle => {
    if(stoppet || pågår) return;
    pågår = true;
    try{
      const t = await hentTilstand();
      if(!t.innstillinger.pa) return;
      const sist = Date.parse(t.kjoringer[0]?.start) || 0;
      if(bareGamle && Date.now() - sist < intervall) return;
      const svar = await sokNa();
      if(!stoppet) påResultat?.(svar);
    }catch(e){
      if(e?.code !== "for-mange" && e?.code !== "utlogget" && !stoppet) påFeil?.(e);
    }finally{ pågår = false; }
  };
  const timer = setInterval(() => kjør(false), intervall);
  kjør(true);
  return () => { stoppet = true; clearInterval(timer); };
}
