/* ============================================================
   Radar i bakgrunnen: den skjulte siden appen åpner når launchd starter
   den med --radar (src-tauri/src/radar_bakgrunn.rs).

   Samme kjerne og samme klient som i den åpne appen, så en kjøring her er
   ikke noe annet enn «Søk nå» uten at noen trykket. Rust har alt avgjort
   hvilke profiler som har Radar på. Siden kjører dem én etter én og ber til
   slutt Rust avslutte appen, hva som enn skjedde: en kjøring som ikke
   avslutter, står til vakthunden tar den.
   ============================================================ */
import { settBakgrunnsbruker } from "./okt.js";
import * as Radar from "./radarklient.js";

const invoke = (navn, arg) => window.__TAURI__.core.invoke(navn, arg);
const logg = melding => invoke("radar_logg", { melding: String(melding) }).catch(() => {});

/* Åpen app og bakgrunn kjører hver sin time. Er forrige kjøring nylig, hoppes
   profilen over, så en forsinket launchd-kjøring ikke gir to rett etter hverandre. */
export const MIN_AVSTAND = 30 * 60_000;

export function bør_hoppes_over(tilstand, nå = Date.now()){
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
      /* En profil som feiler, stopper ikke de andre. Feilene som hører til
         kjøringen står i kjøringsloggen i radar.json; dette er resten. */
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

/* Importeres siden fra en test, skal den ikke starte. */
if(typeof window !== "undefined" && window.__TAURI__) main();
