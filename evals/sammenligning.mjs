/* ============================================================
   Hjelpere for den betalte evalueringen: modellsammenligning,
   kostnad og den blinde vurderingsfilen. Rene funksjoner, så de
   kan prøves i den vanlige testpakken uten nett.

   Sammenligningen kjører hele kjeden (analyse, skriving, kontroll)
   to ganger per tilfelle: én gang med forespørselen appen sender i
   dag, og én gang med en annen modell og innsats, typisk den appen
   brukte før et modellbytte. Bare modell og innsats byttes. Prompt,
   skjema, kilder og hurtigbuffermerker er byte for byte de samme,
   så forskjellen i brevene kommer fra modellen.
   ============================================================ */

/* Dollar per million tokens hos Anthropic, fra claude-api-skillen
   (oktober 2026). skriv er 5-minutters hurtigbufferskriving, les er
   lesing fra bufferen. Endrer prisene seg, er det her de rettes. */
export const PRISER = Object.freeze({
  "claude-opus-5-5": Object.freeze({ inn: 4, ut: 20, skriv: 5, les: 0.2 }),
  "claude-opus-5": Object.freeze({ inn: 5, ut: 25, skriv: 6.25, les: 0.5 }),
  "claude-sonnet-5-5": Object.freeze({ inn: 2, ut: 10, skriv: 2.5, les: 0.2 })
});
/* Samme omtrentlige valutakurs som importloggen. */
export { KURS } from "../src/importlogg.mjs";
export const INNSATSER = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

/* Hos Anthropic er input_tokens bare det som ikke kom fra bufferen, så de
   fire tellingene kan legges sammen uten å telle noe to ganger. null når
   prisen for modellen ikke er kjent. */
export function dollar(bruk, modell){
  const p = PRISER[modell];
  if(!p) return null;
  return [bruk].flat().filter(Boolean).reduce((s, b) => s
    + (Number(b.input_tokens) || 0) * p.inn
    + (Number(b.output_tokens) || 0) * p.ut
    + (Number(b.cache_creation_input_tokens) || 0) * p.skriv
    + (Number(b.cache_read_input_tokens) || 0) * p.les, 0) / 1e6;
}

/* En fetch som sender samme forespørsel med en annen modell og innsats.
   Alt annet i kroppen står urørt. */
export function medModell(modell, innsats, hent = globalThis.fetch){
  if(!/^claude-[a-z0-9-]{1,40}$/.test(String(modell))) throw new Error("Ukjent sammenligningsmodell.");
  if(!INNSATSER.includes(innsats)) throw new Error(`Innsatsen må være ${INNSATSER.join(", ")}.`);
  return (url, init = {}) => {
    const kropp = JSON.parse(init.body);
    kropp.model = modell;
    kropp.output_config = { ...kropp.output_config, effort: innsats };
    return hent(url, { ...init, body: JSON.stringify(kropp) });
  };
}

/* A eller B for den nye varianten, tilfeldig per tilfelle og repetisjon,
   så vurdereren ikke kan lære seg hvilken side som er hvilken. */
export function fordel(tilfeldig = Math.random){
  return tilfeldig() < 0.5 ? ["ny", "forrige"] : ["forrige", "ny"];
}

/* Vurderingsfilen har bare det en person trenger for å vurdere: tilfellet,
   vurderingspunktene og de to brevene. Ingen modellnavn, tokentall eller
   tider, for de avslører varianten. Fasiten ligger i rapporten. Rekkefølgen
   er rapportens, og hvilken side som er ny, er trukket per rad (fordel). */
export function blindfil(rader, tilfeller){
  const etter = new Map(tilfeller.map(t => [t.id, t]));
  const deler = ["# Blind vurdering av søknadsbrev", "",
    "Vurder hvert brev fra 1 til 5 på hvert kriterium i evals/README.md, og noter oppdiktede påstander.",
    "Hvilken modell som skrev A og B, står i rapporten (variant), og leses først når alle brevene er vurdert.", ""];
  for(const r of rader){
    const t = etter.get(r.id);
    deler.push(`## ${r.id}/${r.repetisjon}: ${r.tema}`, "", "Vurderingspunkter:", "",
      ...(t?.vurderingspunkter ?? []).map(p => `- ${p}`), "");
    for(const side of ["A", "B"]){
      const v = r.varianter?.[side];
      deler.push(`### Brev ${side}`, "");
      deler.push(v?.brev?.tekst ? ["```text", v.brev.tekst, "```"].join("\n") : `Ingen tekst (${v?.feil?.code ?? "feil"}).`, "");
    }
  }
  return deler.join("\n");
}
