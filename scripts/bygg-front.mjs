import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./bygg-dokumenter.mjs";

const ROT  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROT, "dist");

const MED = ["index.html", "src"];

await fs.rm(DIST, { recursive: true, force: true });
await fs.mkdir(DIST, { recursive: true });

for(const navn of MED){
  await fs.cp(path.join(ROT, navn), path.join(DIST, navn), { recursive: true });
}

for(const rusk of await fs.readdir(path.join(DIST, "src"), { recursive: true })){
  if(rusk.endsWith(".test.mjs") || rusk.endsWith(".test.js") || path.basename(rusk) === "brev-dokumentmotor.mjs")
    await fs.rm(path.join(DIST, "src", rusk), { force: true });
}

console.log("dist/ er klar");
