import fs from "node:fs/promises";
import path from "node:path";

import { NOKKELFIL, MIN_NOKKEL, MAKS_NOKKEL, MIN_FOR_HALE,
         validerNokkel, hale } from "../src/konto/brukerlogikk.mjs";
export { NOKKELFIL, MIN_NOKKEL, MAKS_NOKKEL, MIN_FOR_HALE, validerNokkel, hale };

export async function lesEgenNokkel(katalog){
  if(!katalog) return null;
  try{
    const t = (await fs.readFile(path.join(katalog, NOKKELFIL), "utf8")).trim();
    return t || null;
  }catch{ return null; }
}

export const miljønokkel = () => process.env.ANTHROPIC_API_KEY?.trim() || null;

export const deltMiljønokkel = () => process.env.DELT_NOKKEL === "1";

export async function settNokkel(filer, nokkel){
  const v = validerNokkel(nokkel);
  if(!v.ok) return v;
  await filer.skrivAtomisk(NOKKELFIL, v.verdi + "\n", { modus: 0o600 });
  return { ok: true };
}

export async function fjernNokkel(filer){
  await filer.slett(NOKKELFIL);
}

export async function nokkelStatus(filer, { tillatMiljø = false } = {}){
  const egen = await lesEgenNokkel(filer.katalog);
  if(egen){
    const svar = { finnes: true, kilde: "egen" };
    const h = hale(egen);
    if(h) svar.hale = h;
    try{
      const st = await fs.stat(path.join(filer.katalog, NOKKELFIL));
      svar.satt = st.mtime.toISOString();
    }catch{}
    return svar;
  }
  if(tillatMiljø && miljønokkel()) return { finnes: true, kilde: "miljø" };
  return { finnes: false, kilde: "ingen" };
}
