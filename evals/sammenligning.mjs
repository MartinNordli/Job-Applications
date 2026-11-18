export const PRISER = Object.freeze({
  "claude-opus-5-5": Object.freeze({ inn: 4, ut: 20, skriv: 5, les: 0.2 }),
  "claude-opus-5": Object.freeze({ inn: 5, ut: 25, skriv: 6.25, les: 0.5 }),
  "claude-sonnet-5-5": Object.freeze({ inn: 2, ut: 10, skriv: 2.5, les: 0.2 })
});
export { KURS } from "../src/import/importlogg.mjs";
export const INNSATSER = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

export function dollar(bruk, modell){
  const p = PRISER[modell];
  if(!p) return null;
  return [bruk].flat().filter(Boolean).reduce((s, b) => s
    + (Number(b.input_tokens) || 0) * p.inn
    + (Number(b.output_tokens) || 0) * p.ut
    + (Number(b.cache_creation_input_tokens) || 0) * p.skriv
    + (Number(b.cache_read_input_tokens) || 0) * p.les, 0) / 1e6;
}

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

export function fordel(tilfeldig = Math.random){
  return tilfeldig() < 0.5 ? ["ny", "forrige"] : ["forrige", "ny"];
}

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
