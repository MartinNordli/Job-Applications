/* Samme meldingsformat i Node og Tauri. Ingen nøkler eller nettverk her.
   Feil brukeren kan gjøre noe med, er Brevfeil, så de når fram til
   flaten. De andre er programmeringsfeil, og blir en generell melding
   med en referanse i serverloggen (offentligFeil i server/brev-api.mjs). */
import { Brevfeil } from "./dokumentfeil.mjs";
/* Modellen følger formålet. Brevet er det brukeren leser og står inne
   for, så det beholder den beste modellen. Vurderingen av hvor godt en
   stilling passer, og radaren, er mange og korte kall, og får hver sin
   rimeligere. OpenAI har ingen billigere modell i prosjektet ennå, så
   alle tre formålene bruker den samme der.

   Hos Anthropic tenker alle tre modellene alltid (adaptiv tenkning), og
   innsatsen (output_config.effort) styrer hvor mye. Den står eksplisitt
   per formål, for standarden er ikke lik mellom modellene: Opus 5.5 og
   Haiku 5.5 har medium, Sonnet 5.5 high. Opus 5 hadde high, men Opus
   5.5 på medium skal skrive minst like godt med færre tokens. Det er
   det evals/kjor.mjs --sammenlign måler før byttet regnes som godt.
   Tenkningen teller med i max_tokens. */
export const FORMAL = Object.freeze(["brev", "vurdering", "radar"]);
export const LEVERANDORER = Object.freeze({
  anthropic: { modell: "claude-opus-5-5", modeller: Object.freeze({ brev: "claude-opus-5-5", vurdering: "claude-sonnet-5-5", radar: "claude-haiku-5-5" }),
    innsats: Object.freeze({ brev: "medium", vurdering: "high", radar: "medium" }), url: "https://api.anthropic.com/v1/messages", nokkelfil: "nokkel.txt", miljo: "ANTHROPIC_API_KEY" },
  openai: { modell: "gpt-6-astra", modeller: Object.freeze({ brev: "gpt-6-astra", vurdering: "gpt-6-astra", radar: "gpt-6-astra" }), url: "https://api.openai.com/v1/responses", nokkelfil: "nokkel-openai.txt", miljo: "OPENAI_API_KEY" }
});

export function leverandorFor(navn){
  if(!Object.hasOwn(LEVERANDORER, navn)) throw new Error("Ukjent modellleverandør.");
  return LEVERANDORER[navn];
}

export function modellFor(navn, formal = "brev"){
  if(!FORMAL.includes(formal)) throw new Error("Ukjent formål.");
  return leverandorFor(navn).modeller[formal];
}

/* Kroppen er bygd for hurtigbufferen. Rekkefølgen er system, så kildene,
   så trinnets oppgave, og de to første er like i alle trinnene i en
   kjøring (se src/brevlogikk.mjs). Anthropic bufrer bare det som står
   foran et cache_control-merke, så begge de faste delene får hvert sitt:
   systemet kan da gjenbrukes også mellom ulike søknader. OpenAI bufrer
   en lik begynnelse av seg selv, og får samme rekkefølge uten merker.
   kilder er valgfri, så et kall uten kildeblokk (evalenes sammenligning)
   fortsatt er ett enkelt brukerinnhold. */
export function byggModellkropp({ leverandor, system, kilder, innhold, skjema, trinn, formal = "brev" }){
  const modell = modellFor(leverandor, formal);
  const innsats = leverandorFor(leverandor).innsats?.[formal];
  if(typeof system !== "string" || !system.trim()) throw new Error("Mangler skriveinstruksjoner.");
  if(!skjema || typeof skjema !== "object" || Array.isArray(skjema)) throw new Error("Mangler svarformat.");
  const tekst = typeof innhold === "string" ? innhold : JSON.stringify(innhold);
  if(typeof tekst !== "string" || !tekst.trim()) throw new Error("Mangler grunnlag.");
  if(kilder != null && (typeof kilder !== "string" || !kilder.trim())) throw new Error("Mangler grunnlag.");
  const kildetekst = kilder ?? "";
  if(tekst.length + kildetekst.length > 500_000 || system.length > 40_000)
    throw new Brevfeil("for-stort", "Grunnlaget er for stort. Kort ned CV-en, annonsen eller stilreferansen.", 413);
  // Begge leverandørene strømmer alltid. Én transportvei betyr én feilsemantikk.
  if(leverandor === "anthropic") return {
    model: modell,
    max_tokens: 8000,
    stream: true,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [
      ...(kildetekst ? [{ type: "text", text: kildetekst, cache_control: { type: "ephemeral" } }] : []),
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
      ...(kildetekst ? [{ type: "input_text", text: kildetekst }] : []),
      { type: "input_text", text: tekst }
    ] }],
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
  /* Bufringen telles med, så kostnaden kan regnes ut og måles. Hos
     Anthropic er input_tokens bare det som ikke kom fra bufferen. Hos
     OpenAI er de bufrede tokenene en del av input_tokens, og står i
     cache_read_input_tokens i tillegg. */
  const u = raa?.usage ?? {};
  const bruk = {
    input_tokens: Number(u.input_tokens) || 0,
    output_tokens: Number(u.output_tokens) || 0,
    cache_creation_input_tokens: Number(u.cache_creation_input_tokens) || 0,
    cache_read_input_tokens: Number(u.cache_read_input_tokens ?? u.input_tokens_details?.cached_tokens) || 0
  };
  return { data, bruk, modell: typeof raa.model === "string" ? raa.model : valg.modell };
}
