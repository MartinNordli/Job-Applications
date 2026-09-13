/* Samme meldingsformat i Node og Tauri. Ingen nøkler eller nettverk her. */
export const LEVERANDORER = Object.freeze({
  anthropic: { modell: "claude-opus-5", url: "https://api.anthropic.com/v1/messages", nokkelfil: "nokkel.txt", miljo: "ANTHROPIC_API_KEY" },
  openai: { modell: "gpt-6-astra", url: "https://api.openai.com/v1/responses", nokkelfil: "nokkel-openai.txt", miljo: "OPENAI_API_KEY" }
});

export function leverandorFor(navn){
  if(!Object.hasOwn(LEVERANDORER, navn)) throw new Error("Ukjent modellleverandør.");
  return LEVERANDORER[navn];
}

export function byggModellkropp({ leverandor, system, innhold, skjema, trinn }){
  const { modell } = leverandorFor(leverandor);
  if(typeof system !== "string" || !system.trim()) throw new Error("Mangler skriveinstruksjoner.");
  if(!skjema || typeof skjema !== "object" || Array.isArray(skjema)) throw new Error("Mangler svarformat.");
  const tekst = typeof innhold === "string" ? innhold : JSON.stringify(innhold);
  if(typeof tekst !== "string" || !tekst.trim()) throw new Error("Mangler grunnlag.");
  if(tekst.length > 500_000 || system.length > 40_000) throw new Error("Grunnlaget er for stort.");
  // Begge leverandørene strømmer alltid. Én transportvei betyr én feilsemantikk.
  if(leverandor === "anthropic") return {
    model: modell,
    max_tokens: 8000,
    stream: true,
    system,
    messages: [{ role: "user", content: tekst }],
    output_config: { format: { type: "json_schema", schema: skjema } }
  };
  return {
    model: modell,
    store: false,
    stream: true,
    instructions: system,
    input: [{ role: "user", content: [{ type: "input_text", text: tekst }] }],
    max_output_tokens: 8000,
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
  const bruk = {
    input_tokens: Number(raa?.usage?.input_tokens) || 0,
    output_tokens: Number(raa?.usage?.output_tokens) || 0
  };
  return { data, bruk, modell: typeof raa.model === "string" ? raa.model : valg.modell };
}
