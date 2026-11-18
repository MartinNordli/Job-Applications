import { Brevfeil } from "../dokumenter/dokumentfeil.mjs";
export const FORMAL = Object.freeze(["brev", "vurdering", "radar", "annonse"]);
export const LEVERANDORER = Object.freeze({
  anthropic: { modell: "claude-opus-5-5", modeller: Object.freeze({ brev: "claude-opus-5-5", vurdering: "claude-sonnet-5-5", radar: "claude-haiku-5-5", annonse: "claude-haiku-5-5" }),
    innsats: Object.freeze({ brev: "medium", vurdering: "high", radar: "medium", annonse: "low" }), url: "https://api.anthropic.com/v1/messages", nokkelfil: "nokkel.txt", miljo: "ANTHROPIC_API_KEY" },
  openai: { modell: "gpt-6-astra", modeller: Object.freeze({ brev: "gpt-6-astra", vurdering: "gpt-6-astra", radar: "gpt-6-astra", annonse: "gpt-6-astra" }), url: "https://api.openai.com/v1/responses", nokkelfil: "nokkel-openai.txt", miljo: "OPENAI_API_KEY" }
});
const MAKS_UT = Object.freeze({ brev: 16_000, vurdering: 8_000, radar: 8_000, annonse: 8_000 });

export function leverandorFor(navn){
  if(!Object.hasOwn(LEVERANDORER, navn)) throw new Error("Ukjent modellleverandør.");
  return LEVERANDORER[navn];
}

export function modellFor(navn, formal = "brev"){
  if(!FORMAL.includes(formal)) throw new Error("Ukjent formål.");
  return leverandorFor(navn).modeller[formal];
}

export function byggModellkropp({ leverandor, system, kilder, innhold, skjema, trinn, formal = "brev" }){
  const modell = modellFor(leverandor, formal);
  const innsats = leverandorFor(leverandor).innsats?.[formal];
  if(typeof system !== "string" || !system.trim()) throw new Error("Mangler skriveinstruksjoner.");
  if(!skjema || typeof skjema !== "object" || Array.isArray(skjema)) throw new Error("Mangler svarformat.");
  const tekst = typeof innhold === "string" ? innhold : JSON.stringify(innhold);
  if(typeof tekst !== "string" || !tekst.trim()) throw new Error("Mangler grunnlag.");
  const blokker = kilder == null ? [] : [kilder].flat();
  if(blokker.length > 3 || blokker.some(k => typeof k !== "string" || !k.trim())) throw new Error("Mangler grunnlag.");
  if(tekst.length + blokker.join("").length > 500_000 || system.length > 40_000)
    throw new Brevfeil("for-stort", "Grunnlaget er for stort. Kort ned CV-en, annonsen eller stilreferansen.", 413);
  const maks = MAKS_UT[formal];
  if(leverandor === "anthropic") return {
    model: modell,
    max_tokens: maks,
    stream: true,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [
      ...blokker.map(k => ({ type: "text", text: k, cache_control: { type: "ephemeral" } })),
      { type: "text", text: tekst }
    ] }],
    output_config: { effort: innsats, format: { type: "json_schema", schema: skjema } }
  };
  return {
    model: modell,
    store: false,
    stream: true,
    instructions: system,
    input: [{ role: "user", content: [
      ...blokker.map(k => ({ type: "input_text", text: k })),
      { type: "input_text", text: tekst }
    ] }],
    max_output_tokens: maks,
    text: { format: { type: "json_schema", name: /^[a-z][a-z0-9_-]{0,40}$/i.test(trinn || "") ? trinn : "soknadsbrev", schema: skjema, strict: true } }
  };
}

function formatfeil(melding){
  const e = new Error(melding); e.navn = "modellformat"; return e;
}

export function tolkModellsvar(leverandor, raa){
  const valg = leverandorFor(leverandor);
  let tekst;
  if(leverandor === "anthropic"){
    if(raa?.stop_reason === "max_tokens") throw formatfeil("Modellen ble avbrutt før teksten var ferdig. Prøv igjen med et kortere grunnlag.");
    if(raa?.stop_reason === "refusal") throw formatfeil("Modellen kunne ikke skrive et brev fra dette grunnlaget.");
    tekst = raa?.content?.filter(b => b.type === "text").map(b => b.text).join("");
  }else{
    if(raa?.status && raa.status !== "completed") throw formatfeil("Modellen leverte ikke et fullstendig svar. Prøv igjen.");
    const blokker = (raa?.output || []).filter(b => b.type === "message").flatMap(b => b.content || []);
    if(blokker.some(b => b.type === "refusal")) throw formatfeil("Modellen kunne ikke skrive et brev fra dette grunnlaget.");
    tekst = blokker.filter(b => b.type === "output_text").map(b => b.text).join("");
  }
  if(typeof tekst !== "string" || !tekst.trim()) throw formatfeil("Modellen svarte uten innhold.");
  let data;
  try{ data = JSON.parse(tekst); }
  catch{ throw formatfeil("Modellen svarte i feil format. Prøv igjen."); }
  if(!data || typeof data !== "object" || Array.isArray(data)) throw formatfeil("Modellen svarte i feil format. Prøv igjen.");
  const u = raa?.usage ?? {};
  const bruk = {
    input_tokens: Number(u.input_tokens) || 0,
    output_tokens: Number(u.output_tokens) || 0,
    cache_creation_input_tokens: Number(u.cache_creation_input_tokens) || 0,
    cache_read_input_tokens: Number(u.cache_read_input_tokens ?? u.input_tokens_details?.cached_tokens) || 0
  };
  return { data, bruk, modell: typeof raa.model === "string" ? raa.model : valg.modell };
}
