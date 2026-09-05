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

    /* En fil som ikke finnes er allerede slettet. Sletting går gjennom
       filer-sømmen og ikke en fs.rm på egen hånd, slik at all
       filbehandling for en brukerkatalog har ett sted å stå. */
    async slett(navn){ await fs.rm(stiTil(navn), { force: true }); },

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
        /* Rettighetene settes på tempfilen, ikke på den ferdige filen:
           rename beholder modusen, mens en chmod etterpå ville latt
           en hemmelighet ligge lesbar for alle i vinduet imellom.
           chmod på håndtaket i tillegg, i tilfelle tempfilen lå igjen
           fra en avbrutt skriving og allerede hadde feil modus. */
        fh = await fs.open(tmpSti, "w", valg.modus ?? 0o666);
        if(valg.modus) await fh.chmod(valg.modus);
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

/* Katalogen må oppgis. Standarden lå her før — «data/ under det du
   nå står i» — og den kunne lagt søknadene et annet sted enn
   serveren leser dem fra, avhengig av hvor npm start ble kjørt.
   Hvor dataene ligger avgjøres i server/katalog.mjs, ett sted. */
export function lagLager(valg = {}){
  const katalog = valg.katalog;
  if(!katalog) throw new Error("lagLager krever en katalog.");
  const lager   = lagLogikk({ filer: lagFiler(katalog), lagId: randomUUID });
  return { ...lager, tmpSti: path.join(katalog, tmpNavn(FILNAVN)) };
}

export { FILNAVN, FORRIGE };
export default lagLager;
