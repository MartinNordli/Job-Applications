import { settBakgrunnsbruker } from "../konto/okt.js";
import * as Radar from "./radarklient.js";

const invoke = (navn, arg) => window.__TAURI__.core.invoke(navn, arg);
const logg = melding => invoke("radar_logg", { melding: String(melding) }).catch(() => {});

const MIN_AVSTAND = 30 * 60_000;

function bør_hoppes_over(tilstand, nå = Date.now()){
  const sist = Date.parse(tilstand.kjoringer[0]?.start) || 0;
  return nå - sist < MIN_AVSTAND;
}

async function kjørProfil(id){
  settBakgrunnsbruker(id);
  const tilstand = await Radar.hentTilstand();
  if(!tilstand.innstillinger.pa){ await logg(`${id}: Radar er av`); return; }
  if(bør_hoppes_over(tilstand)){ await logg(`${id}: forrige kjøring er nylig`); return; }
  const svar = await Radar.sokNa();
  const k = svar.kjoring;
  await logg(`${id}: kjort=${svar.kjort}${svar.grunn ? ` grunn=${svar.grunn}` : ""}${k ? ` kandidater=${k.kandidater} nye=${k.nye} vurdert=${k.vurdert} treff=${k.treff} feil=${k.feil.length}` : ""}`);
}

async function main(){
  let kode = 0;
  try{
    const profiler = await invoke("radar_profiler");
    for(const id of profiler){
      try{ await kjørProfil(id); }
      catch(e){ await logg(`${id}: ${e?.code ?? ""} ${e?.message ?? e}`); }
    }
  }catch(e){
    kode = 1;
    await logg(`feilet: ${e?.message ?? e}`);
  }finally{
    await invoke("radar_ferdig", { kode });
  }
}

if(typeof window !== "undefined" && window.__TAURI__) main();
