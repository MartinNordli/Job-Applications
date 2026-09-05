/* ============================================================
   Nøkkelen — én fil, fordi den er den eneste hemmeligheten som
   kommer inn over HTTP og går ut i et HTTP-hode.

   Kravene denne modulen holder, og som hver har en test i
   server/nokkel.test.mjs:

   1. validerNokkel er en sikkerhetsregel, ikke høflighet.
      Nøkkelen havner rett i x-api-key. Derfor: 20–500 tegn etter
      trimming, og bare tegn i 0x21–0x7E. Det avviser CR, LF, tab,
      mellomrom og alle kontrolltegn, og lukker hodeinjeksjon før
      verdien når fetch. Formatet forøvrig valideres IKKE —
      «sk-ant-»-prefikset kan endre seg, og vi skal ikke være
      grunnen til at en gyldig nøkkel avvises.

   2. Modus 0o600 settes når tempfilen åpnes, ikke med en chmod
      etterpå: ellers ligger nøkkelen 0644 i vinduet mellom
      skriving og navnebytte.

   3. Sletting går gjennom filer.slett, ikke en fs.rm på egen hånd,
      så all filbehandling for en brukerkatalog har ett sted.

   4. Presedens: brukerens egen nokkel.txt vinner alltid. Mangler
      den, gjelder ANTHROPIC_API_KEY — men bare for første bruker,
      med mindre DELT_NOKKEL=1 er satt. Åpen registrering ville
      ellers gitt bort operatørens kreditt til hvem som helst.

   5. Nøkkelen leses aldri tilbake. Svaret bærer «hale», de fire
      siste tegnene, og bare når nøkkelen er minst 12 tegn — fire
      tegn av en kort nøkkel er en for stor andel å gi bort. Hale
      settes aldri når kilden er miljøvariabelen: det er
      operatørens nøkkel, og under DELT_NOKKEL=1 ville samme svar
      gått til alle.

   6. Aldri i en feilmelding, aldri i en logglinje, aldri i
      importlogg.jsonl.
   ============================================================ */

import fs from "node:fs/promises";
import path from "node:path";

/* Filnavnet, formregelen og halen ligger i src/brukerlogikk.mjs:
   appmodus skriver den samme filen selv, uten en server foran, og
   må holde nøyaktig samme krav. De reeksporteres herfra, der resten
   av nøkkelhåndteringen bor, så kallstedene slipper å vite det. */
import { NOKKELFIL, MIN_NOKKEL, MAKS_NOKKEL, MIN_FOR_HALE,
         validerNokkel, hale } from "../src/brukerlogikk.mjs";
export { NOKKELFIL, MIN_NOKKEL, MAKS_NOKKEL, MIN_FOR_HALE, validerNokkel, hale };

/* Filen leses ved hvert kall. Én liten lesing per import, og til
   gjengjeld virker en ny nøkkel uten at serveren startes på nytt. */
export async function lesEgenNokkel(katalog){
  if(!katalog) return null;
  try{
    const t = (await fs.readFile(path.join(katalog, NOKKELFIL), "utf8")).trim();
    return t || null;
  }catch{ return null; }        /* finnes ikke, eller kan ikke leses — samme svar */
}

export const miljønokkel = () => process.env.ANTHROPIC_API_KEY?.trim() || null;

/* Miljøvariabelen tilhører den som startet serveren. Første bruker er
   den personen; alle andre må ha sin egen — med mindre operatøren
   uttrykkelig deler den med DELT_NOKKEL=1. */
export const deltMiljønokkel = () => process.env.DELT_NOKKEL === "1";

export async function settNokkel(filer, nokkel){
  const v = validerNokkel(nokkel);
  if(!v.ok) return v;
  await filer.skrivAtomisk(NOKKELFIL, v.verdi + "\n", { modus: 0o600 });
  return { ok: true };
}

/* Idempotent: å fjerne en nøkkel som ikke finnes er ikke en feil. */
export async function fjernNokkel(filer){
  await filer.slett(NOKKELFIL);
}

/* Svaret til GET /api/nokkel. Bærer aldri nøkkelen, bare halen. */
export async function nokkelStatus(filer, { tillatMiljø = false } = {}){
  const egen = await lesEgenNokkel(filer.katalog);
  if(egen){
    const svar = { finnes: true, kilde: "egen" };
    const h = hale(egen);
    if(h) svar.hale = h;
    try{
      const st = await fs.stat(path.join(filer.katalog, NOKKELFIL));
      svar.satt = st.mtime.toISOString();
    }catch{ /* tidspunktet er en bekvemmelighet, ikke et krav */ }
    return svar;
  }
  if(tillatMiljø && miljønokkel()) return { finnes: true, kilde: "miljø" };
  return { finnes: false, kilde: "ingen" };
}
