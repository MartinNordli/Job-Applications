/* ============================================================
   Samler frontenden i dist/ — det Tauri pakker inn i appen.

   Tauri vil ha én mappe å legge inn i binæret. Peker vi den rett
   på prosjektroten, følger data/, temaer/, .git og alt annet med
   inn i appen. Derfor denne: bare det siden faktisk trenger.
   ============================================================ */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROT  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROT, "dist");

const MED = ["index.html", "src"];

await fs.rm(DIST, { recursive: true, force: true });
await fs.mkdir(DIST, { recursive: true });

for(const navn of MED){
  await fs.cp(path.join(ROT, navn), path.join(DIST, navn), { recursive: true });
}

/* Testfiler og annet som bare hører hjemme i utviklingsmappa. */
for(const rusk of await fs.readdir(path.join(DIST, "src"))){
  if(rusk.endsWith(".test.mjs") || rusk.endsWith(".test.js"))
    await fs.rm(path.join(DIST, "src", rusk));
}

console.log("dist/ er klar");
