/* ============================================================
   Lager (Node) — filsystemet under lagerlogikken.

   Reglene for datafilen ligger i src/lagerlogikk.mjs, delt med
   Tauri-appen. Her er bare de fire filoperasjonene, gjort med
   node:fs — og de gjøres nøye: uten fsync kan et strømbrudd gi
   en tom fil, og uten rename kan en leser treffe en halvskrevet.
   ============================================================ */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { lagLager as lagLogikk, FILNAVN, FORRIGE } from "../src/lagerlogikk.mjs";

const tmpNavn = navn => "." + navn + ".tmp";

export function lagFiler(katalog){
  const stiTil = navn => path.join(katalog, navn);

  return {
    katalog,
    stiTil,

    async lesTekst(navn){
      try{ return await fs.readFile(stiTil(navn), "utf8"); }
      catch(e){
        if(e.code === "ENOENT") return null;
        throw e;
      }
    },

    flytt(fra, til){ return fs.rename(stiTil(fra), stiTil(til)); },

    async skrivAtomisk(navn, tekst, valg = {}){
      await fs.mkdir(katalog, { recursive: true });

      /* Kopi av forrige gode fil før vi bytter den ut. */
      if(valg.kopiTil){
        try{ await fs.copyFile(stiTil(navn), stiTil(valg.kopiTil)); }
        catch(e){ if(e.code !== "ENOENT") throw e; }
      }

      const tmpSti = stiTil(tmpNavn(navn));
      let fh = null;
      try{
        fh = await fs.open(tmpSti, "w");
        await fh.writeFile(tekst, "utf8");
        await fh.sync();          /* uten fsync kan et strømbrudd gi en tom fil */
        await fh.close();
        fh = null;
        await fs.rename(tmpSti, stiTil(navn));
        /* Innholdet er synket, men selve navnebyttet ligger i katalogen. */
        const kh = await fs.open(katalog, "r");
        await kh.sync().catch(() => {});     /* ikke støttet overalt */
        await kh.close();
      }catch(e){
        if(fh) await fh.close().catch(() => {});
        await fs.rm(tmpSti, { force: true });
        throw e;
      }
    }
  };
}

export function lagLager(valg = {}){
  const katalog = valg.katalog ?? path.join(process.cwd(), "data");
  const lager   = lagLogikk({ filer: lagFiler(katalog), lagId: randomUUID });
  return { ...lager, tmpSti: path.join(katalog, tmpNavn(FILNAVN)) };
}

export { FILNAVN, FORRIGE };
export default lagLager;
