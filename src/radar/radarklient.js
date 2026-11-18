import { I_APP, bruker, http, lokaltLager } from "../dokumenter/dokumentklient.js";
import { lokalKallModell } from "../brev/brev.js";
import { lagRadarnett } from "./radarnett.mjs";
import { Brevfeil } from "../dokumenter/dokumentfeil.mjs";
import * as Jobbdokumenter from "../stilling/jobbdokumenter.js";
import { visRadarvarsel } from "../soknader/varsling.js";
import { søkNå, tilstandFra, lagreInnstillinger as lagreInnstillingerLokalt, ikkeInteressert as ikkeInteressertLokalt,
         markerLagtTil, leggTilKarriereside as leggTilKarrieresideLokalt, fjernKarriereside as fjernKarrieresideLokalt, slåPåKarriereside as slaPaKarrieresideLokalt,
         leggTilFraRad, soknadFraRad, foreslåFraProfil } from "./radarlogikk.mjs";

export { soknadFraRad };
export const TIME = 3600_000;
const RADARFIL = "radar.json";

const lokale = new Map();
function lokal(){
  const id = bruker();
  if(!lokale.has(id)){
    const { lager, hentJobber, sjekk } = lokaltLager(id);
    const rå = window.__TAURI__.core.invoke;
    const invoke = async (navn, valg) => { try{ return await rå(navn, valg); }catch(e){ throw typeof e === "string" ? Object.assign(new Error(e), { melding: e }) : e; } };
    lokale.set(id, { lager, hentJobber, sjekk, nett: lagRadarnett({ invoke, bruker: id }), kallModell: lokalKallModell(id, sjekk) });
  }
  return lokale.get(id);
}
const lesLokalt = async () => tilstandFra(await lokal().lager.les(RADARFIL));

const oversett = e => e instanceof Error || e?.code ? e : new Brevfeil("nett", String(e?.melding || e || "Noe gikk galt."));

const lyttere = new Set();
export function påEndring(fn){ lyttere.add(fn); return () => lyttere.delete(fn); }
function meld(tilstand){
  for(const fn of lyttere){ try{ fn(tilstand); }catch{} }
  return tilstand;
}
const tilstandAv = svar => meld(svar.tilstand);

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
