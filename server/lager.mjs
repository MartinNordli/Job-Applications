import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { lagLager as lagLogikk, FILNAVN, FORRIGE } from "../src/soknader/lagerlogikk.mjs";

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

    async slett(navn){ await fs.rm(stiTil(navn), { force: true }); },

    async skrivAtomisk(navn, tekst, valg = {}){
      await fs.mkdir(katalog, { recursive: true });

      if(valg.kopiTil){
        try{ await fs.copyFile(stiTil(navn), stiTil(valg.kopiTil)); }
        catch(e){ if(e.code !== "ENOENT") throw e; }
      }

      const tmpSti = stiTil(tmpNavn(navn));
      let fh = null;
      try{
        fh = await fs.open(tmpSti, "w", valg.modus ?? 0o666);
        if(valg.modus) await fh.chmod(valg.modus);
        await fh.writeFile(tekst, "utf8");
        await fh.sync();
        await fh.close();
        fh = null;
        await fs.rename(tmpSti, stiTil(navn));
        const kh = await fs.open(katalog, "r");
        await kh.sync().catch(() => {});
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
  const katalog = valg.katalog;
  if(!katalog) throw new Error("lagLager krever en katalog.");
  const lager   = lagLogikk({ filer: lagFiler(katalog), lagId: randomUUID,
                              ...(valg.nå ? { nå: valg.nå } : {}) });
  return { ...lager, tmpSti: path.join(katalog, tmpNavn(FILNAVN)) };
}

export { FILNAVN, FORRIGE };
export default lagLager;
