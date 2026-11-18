import { readFileSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FILNAVN } from "../src/soknader/lagerlogikk.mjs";
import { REGISTERFIL } from "../src/konto/brukerlogikk.mjs";

const HER = path.dirname(fileURLToPath(import.meta.url));
const ROT = path.resolve(HER, "..");

export const PROSJEKTDATA = path.join(ROT, "data");
export const TAURI_KONFIG = path.join(ROT, "src-tauri", "tauri.conf.json");

const LOVLIG_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

export function lesIdentifikator(sti = TAURI_KONFIG){
  let rå;
  try{ rå = readFileSync(sti, "utf8"); }
  catch{
    throw new Error(`Fant ikke ${path.relative(ROT, sti)}, så datakatalogen kan ikke bestemmes. `
      + "Sett DATA_KATALOG til katalogen du vil bruke.");
  }

  let dok;
  try{ dok = JSON.parse(rå); }
  catch{ throw new Error(`${path.relative(ROT, sti)} er ikke gyldig JSON. Rett den, eller sett DATA_KATALOG.`); }

  const id = dok && typeof dok === "object" ? dok.identifier : null;
  if(typeof id !== "string" || id.length === 0 || id.length > 100
     || !LOVLIG_ID.test(id) || id === "." || id === ".."){
    throw new Error(`«identifier» i ${path.relative(ROT, sti)} er ikke et brukbart katalognavn. `
      + "Rett den, eller sett DATA_KATALOG.");
  }
  return id;
}

export function appdatakatalog({ identifikator, plattform = process.platform,
                                 miljø = process.env, hjem = os.homedir() } = {}){
  if(typeof identifikator !== "string" || !LOVLIG_ID.test(identifikator))
    throw new Error("Ugyldig identifikator for datakatalogen.");

  if(plattform === "win32"){
    const roaming = miljø.APPDATA;
    if(roaming) return path.join(roaming, identifikator);
    if(!hjem) throw new Error(manglerHjem());
    return path.join(hjem, "AppData", "Roaming", identifikator);
  }

  if(plattform === "darwin"){
    if(!hjem) throw new Error(manglerHjem());
    return path.join(hjem, "Library", "Application Support", identifikator);
  }

  const xdg = miljø.XDG_DATA_HOME;
  if(xdg && path.isAbsolute(xdg)) return path.join(xdg, identifikator);
  if(!hjem) throw new Error(manglerHjem());
  return path.join(hjem, ".local", "share", identifikator);
}

const manglerHjem = () =>
  "Fant ingen hjemmekatalog, så datakatalogen kan ikke bestemmes. Sett DATA_KATALOG.";

export function standardKatalog(valg = {}){
  return appdatakatalog({ identifikator: lesIdentifikator(valg.konfig), ...valg });
}

export function velgKatalog(valg = {}){
  if(valg.katalog) return valg.katalog;
  const fra = (valg.miljø ?? process.env).DATA_KATALOG;
  if(fra) return fra;
  return standardKatalog(valg);
}

export function sikreKatalog(katalog){
  try{ mkdirSync(katalog, { recursive: true }); }
  catch(e){
    throw new Error(`Fikk ikke opprettet datakatalogen ${katalog}: ${e.code || e.message}. `
      + "Sett DATA_KATALOG til en katalog du kan skrive i.");
  }
  return katalog;
}

export function beskjedOmGammelData({ katalog, prosjektdata = PROSJEKTDATA,
                                      finnes = existsSync } = {}){
  if(!katalog) return null;
  if(path.resolve(katalog) === path.resolve(prosjektdata)) return null;
  if(finnes(path.join(katalog, REGISTERFIL))) return null;

  const gammelt = [REGISTERFIL, FILNAVN].some(n => finnes(path.join(prosjektdata, n)));
  if(!gammelt) return null;

  return `Advarsel: det ligger data i ${prosjektdata}, men serveren leser nå ${katalog}. `
    + "Flytt innholdet dit selv — ingenting flyttes automatisk.";
}
