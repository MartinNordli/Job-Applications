#!/usr/bin/env node
/* Radar-evalen. Uten --live: tilfellene valideres, forespørslene bygges
   slik appen bygger dem, og et kostnadsanslag skrives ut. Ingen
   nettverk, ingen nøkler leses.

   Med --live kjøres én vurdering (én bolk) og ett forslag per tilfelle
   og repetisjon mot valgt leverandør. Det koster penger og gjøres bare
   når brukeren har godkjent kostnaden. Repetisjon to og tre kommer rett
   etter den første med samme CV, så de viser om hurtigbufferen treffer
   (cache_read_input_tokens i rapporten). */
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { radartilfeller } from "./radar-tilfeller.mjs";
import { sjekkVurdering, sjekkForslag, forespørslerFor } from "./radar-sjekker.mjs";
import { RADAR_PROMPTVERSJON, FORSLAG_PROMPTVERSJON } from "../src/radarprompt.mjs";
import { tolkVurdering, tolkForslag, RADARPRIS } from "../src/radarlogikk.mjs";
import { byggModellkropp, LEVERANDORER, modellFor } from "../src/brev-provider.mjs";

const args = process.argv.slice(2);
const verdi = flagg => { const i = args.indexOf(flagg); return i === -1 ? null : args[i + 1]; };

/* Grovt: Haiku 5.5 gir om lag ett token per tre tegn norsk tekst. For
   et presist tall: messages.count_tokens, som er gratis, men går ut på
   nettet med nøkkelen. */
const tokens = tekst => Math.ceil(tekst.length / 3);
const dollar = b => ((b.input_tokens ?? 0) * RADARPRIS.inn + (b.cache_creation_input_tokens ?? 0) * RADARPRIS.skriv
  + (b.cache_read_input_tokens ?? 0) * RADARPRIS.les + (b.output_tokens ?? 0) * RADARPRIS.ut) / 1e6;

if(!args.includes("--live")){
  const linjer = [];
  for(const t of radartilfeller){
    const f = forespørslerFor(t);
    const k = byggModellkropp(f.vurdering);
    const fast = tokens(f.vurdering.system) + tokens(f.vurdering.kilder), annonser = tokens(f.vurdering.innhold);
    linjer.push(`${t.id} [${t.sprak}] ${t.tema}: ${t.annonser.length} annonser, modell ${k.model}, fast del ~${fast} tokens, annonser ~${annonser} tokens`);
  }
  console.log(`${radartilfeller.length} syntetiske Radar-tilfeller (${RADAR_PROMPTVERSJON}, ${FORSLAG_PROMPTVERSJON}). Ingen API-kall.\n${linjer.join("\n")}\n\nKjør betalt evaluering eksplisitt:\nnode evals/radar-kjor.mjs --live --leverandor anthropic --repetisjoner 2 --rapport /tmp/radareval.json`);
}else{
  const leverandor = verdi("--leverandor");
  if(!Object.hasOwn(LEVERANDORER, leverandor || "")) throw new Error("Oppgi --leverandor anthropic eller openai.");
  const repetisjoner = Number(verdi("--repetisjoner") ?? 2);
  if(!Number.isInteger(repetisjoner) || repetisjoner < 1 || repetisjoner > 3) throw new Error("Repetisjoner må være 1 til 3.");
  const valgte = verdi("--tilfelle") ? radartilfeller.filter(t => t.id === verdi("--tilfelle")) : radartilfeller;
  if(!valgte.length) throw new Error("Ukjent tilfelle.");
  console.error(`Betalt Radar-evaluering: ${leverandor}, ${valgte.length} tilfeller × ${repetisjoner}. Maks ${valgte.length * repetisjoner * 2} modellkall. Ingen automatiske forsøk.`);
  const { lagBrevModell } = await import("../server/brev-modell.mjs");
  const kallModell = lagBrevModell({ katalog: path.join(tmpdir(), `radareval-ingen-profildata-${process.pid}`), tillatMiljø: true });
  const rapport = { promptversjon: RADAR_PROMPTVERSJON, forslagsversjon: FORSLAG_PROMPTVERSJON, leverandor,
    modell: modellFor(leverandor, "radar"), tidspunkt: new Date().toISOString(),
    menneskeligVurdering: "Ikke utført. Se vurderingspunktene i evals/radar-tilfeller.mjs.", resultater: [] };
  for(const t of valgte){
    const f = forespørslerFor(t, leverandor);
    for(let rep = 1; rep <= repetisjoner; rep++){
      const rad = { id: t.id, tema: t.tema, repetisjon: rep, sjekker: [] };
      try{
        const v = await kallModell(f.vurdering);
        rad.vurdering = tolkVurdering(v.data, t.annonser.map(a => a.id));
        rad.vurderingBruk = v.bruk;
        rad.sjekker.push(...sjekkVurdering(t, rad.vurdering));
        const s = await kallModell(f.forslag);
        rad.forslag = tolkForslag(s.data, { cv: t.cv });
        rad.forslagRå = s.data;
        rad.forslagBruk = s.bruk;
        rad.sjekker.push(...sjekkForslag(t, rad.forslag));
        rad.dollar = dollar(v.bruk) + dollar(s.bruk);
      }catch(e){ rad.feil = { code: e.code || e.navn || "feil", melding: e.message }; }
      rad.automatiskGodkjent = !rad.feil && !rad.sjekker.length;
      rapport.resultater.push(rad);
      console.error(`${t.id}/${rep}: ${rad.automatiskGodkjent ? "automatiske sjekker bestått" : `må undersøkes: ${rad.feil?.melding ?? rad.sjekker.join(" ")}`}`);
    }
  }
  rapport.dollar = rapport.resultater.reduce((s, r) => s + (r.dollar ?? 0), 0);
  const json = JSON.stringify(rapport, null, 2) + "\n";
  if(verdi("--rapport")) await writeFile(verdi("--rapport"), json, { flag: "wx", mode: 0o600 });
  else console.log(json);
  if(rapport.resultater.some(r => !r.automatiskGodkjent)) process.exitCode = 1;
}
