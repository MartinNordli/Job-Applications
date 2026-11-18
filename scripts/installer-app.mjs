import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BYGGET = path.join(ROT, "src-tauri/target/release/bundle/macos/Hired.app");
const MÅL = "/Applications/Hired.app";
const BINÆR = path.join(MÅL, "Contents/MacOS/");
const tving = process.argv.includes("--tving");

const PATH = ["/opt/homebrew/opt/rustup/bin", path.join(os.homedir(), ".cargo/bin"), process.env.PATH].join(":");

function kjør(cmd, args, { stille = false } = {}){
  const r = spawnSync(cmd, args, { cwd: ROT, env: { ...process.env, PATH }, stdio: stille ? "pipe" : "inherit", encoding: "utf8" });
  return { ok: r.status === 0, ut: (r.stdout ?? "").trim() };
}
function stopp(melding){
  console.error(melding);
  process.exit(1);
}
const kjører = () => kjør("pgrep", ["-f", BINÆR], { stille: true }).ok;
const vent = ms => new Promise(r => setTimeout(r, ms));

const gren = kjør("git", ["branch", "--show-current"], { stille: true }).ut;
const endret = kjør("git", ["status", "--porcelain"], { stille: true }).ut;
if(!tving && gren !== "main") stopp(`Står på ${gren || "en løs commit"}, ikke main. Appen installeres bare fra main (--tving overstyrer).`);
if(!tving && endret) stopp("Arbeidstreet har endringer som ikke er committet. Appen installeres bare fra det som er flettet inn (--tving overstyrer).");
const commit = kjør("git", ["log", "-1", "--format=%h %s"], { stille: true }).ut;

console.log(`Bygger Hired fra ${commit}`);
if(!kjør("npm", ["run", "app:bygg"]).ok) stopp("Bygget feilet. Appen i /Applications er ikke endret.");

const ny = MÅL + ".ny";
const gammel = MÅL + ".forrige";
await fs.rm(ny, { recursive: true, force: true });
await fs.rm(gammel, { recursive: true, force: true });
if(!kjør("ditto", [BYGGET, ny]).ok) stopp("Fikk ikke kopiert den nye appen til /Applications.");

const kjørteFør = kjører();
if(kjørteFør){
  console.log("Avslutter Hired, så den rekker å lagre.");
  kjør("osascript", ["-e", 'quit app "Hired"'], { stille: true });
  for(let i = 0; i < 40 && kjører(); i++) await vent(500);
  if(kjører()){
    await fs.rm(ny, { recursive: true, force: true });
    stopp("Hired avsluttet ikke innen 20 sekunder. Lukk den selv og kjør på nytt. Den nye er bygget, men ikke installert.");
  }
}

let hadde = true;
try{ await fs.rename(MÅL, gammel); }catch(e){ if(e.code === "ENOENT") hadde = false; else throw e; }
try{
  await fs.rename(ny, MÅL);
}catch(e){
  if(hadde) await fs.rename(gammel, MÅL);
  throw e;
}
if(hadde) await fs.rm(gammel, { recursive: true, force: true });

if(kjørteFør) kjør("open", [MÅL]);
console.log(`Hired i /Applications er nå ${commit}${kjørteFør ? ", og den er startet igjen" : ""}.`);
