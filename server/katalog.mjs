/* ============================================================
   Datakatalogen — ett sted som bestemmer hvor dataene ligger.

   Appen og nettleserversjonen delte tidligere ingenting: appen
   skrev i ~/Library/Application Support/<identifikator>/, mens
   npm start skrev i data/ i prosjektmappa. Nå deler de konto og
   søknadsliste, og da må de peke på samme katalog.

   Serveren flytter seg til appens katalog, ikke omvendt. En pakket
   app i /Applications har ingen måte å finne prosjektmappa på,
   mens appkatalogen finnes uansett hvor appen startes fra.

   Stien settes sammen her og ingen andre steder. Identifikatoren
   leses ut av src-tauri/tauri.conf.json — den samme filen Tauri
   selv bruker — slik at «no.nordli.jobbsoknader» står skrevet ett
   sted. Endres den der, følger Node etter av seg selv.

   Regnestykket er Tauris eget: app_data_dir() er
   dirs::data_dir()/<identifikator>, og dirs::data_dir() er
   $HOME/Library/Application Support på macOS.

   DATA_KATALOG overstyrer alt. Hele testpakken hviler på den.
   ============================================================ */

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FILNAVN } from "../src/lagerlogikk.mjs";
import { REGISTERFIL } from "../src/brukerlogikk.mjs";

const HER = path.dirname(fileURLToPath(import.meta.url));
const ROT = path.resolve(HER, "..");

/* Der dataene lå før flyttingen. Brukes bare til å oppdage at noen
   har data igjen der, aldri til å lese dem. */
export const PROSJEKTDATA = path.join(ROT, "data");
export const TAURI_KONFIG = path.join(ROT, "src-tauri", "tauri.conf.json");

/* ------------------------------------------------------------
   Identifikatoren.

   Den blir et katalognavn, så den valideres som alt annet som
   kommer utenfra: bare tegnene Tauri selv tillater i en
   identifikator, ingen skilletegn, ingen «..». Er filen borte
   eller verdien uforståelig, gjettes det ikke — da vet vi ikke
   hvor dataene skal, og å gjette ville laget en tom installasjon
   ved siden av den ekte.
   ------------------------------------------------------------ */
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

/* ------------------------------------------------------------
   Plattformene.

   Appen bygges bare for macOS, så det er bare den ene linjen som
   må stemme overens med Tauri i dag. De andre er der for at
   serveren skal kunne kjøres andre steder uten å krasje, og de
   følger samme oppskrift som dirs::data_dir() ville gitt på den
   plattformen — da stemmer de av seg selv den dagen appen bygges
   for Linux eller Windows, og ingen trenger å ta valget en gang
   til. Hjemmekatalogen er felles for alle: den finnes for en
   innlogget bruker, og prosjektmappa gjør ikke det.

   Uten hjemmekatalog nekter vi. Å falle tilbake på cwd ville
   lagt søknadene et sted som flytter seg med terminalen.
   ------------------------------------------------------------ */
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

  /* Linux og resten: XDG. */
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

/* Rekkefølgen: det kallstedet ber om, så DATA_KATALOG, så
   standarden. DATA_KATALOG virker nøyaktig som før. */
export function velgKatalog(valg = {}){
  if(valg.katalog) return valg.katalog;
  const fra = (valg.miljø ?? process.env).DATA_KATALOG;
  if(fra) return fra;
  return standardKatalog(valg);
}

/* Katalogen opprettes hvis den mangler. skrivAtomisk gjør det
   samme ved første skriving, men da er den fortsatt borte for alt
   som bare leser — og for den som vil se etter den i Finder. */
export function sikreKatalog(katalog){
  try{ mkdirSync(katalog, { recursive: true }); }
  catch(e){
    throw new Error(`Fikk ikke opprettet datakatalogen ${katalog}: ${e.code || e.message}. `
      + "Sett DATA_KATALOG til en katalog du kan skrive i.");
  }
  return katalog;
}

/* ------------------------------------------------------------
   Beskjeden om data som ble liggende igjen.

   Den som hadde en konto i data/ før flyttingen møter ellers
   «Opprett konto» over sine egne 58 søknader, uten et ord om hvor
   de tok veien. Beskjeden kommer bare når begge deler er sanne:
   den nye katalogen har intet register, og prosjektets data/ har
   noe i seg. Ingenting flyttes automatisk — det er brukerens egne
   data, og en flytting vi gjorde på eget initiativ ville vært den
   ene operasjonen ingen kan angre.

   Den kommer også når DATA_KATALOG er satt. Da er den som regel
   støy, men den er sann, og alternativet — taushet — er den ene
   feilen som koster noe.
   ------------------------------------------------------------ */
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
