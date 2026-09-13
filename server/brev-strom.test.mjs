import test from "node:test";
import assert from "node:assert/strict";
import { delSse, lagSvarsamler, lagFeltstrøm } from "../src/brev-strom.mjs";

const ramme = (hendelse, data) => `event: ${hendelse}\ndata: ${JSON.stringify(data)}\n\n`;
function alle(del, tekst){ return del(tekst); }
function tegnForTegn(tekst, ta){
  let ut = "";
  for(const tegn of tekst) ut += ta(tegn);
  return ut;
}

test("SSE-leseren tåler delte rammer, flere rammer per bit, CRLF og kommentarer", () => {
  const del = delSse();
  assert.deepEqual(del("event: fase\ndata: {\"a\""), []);
  assert.deepEqual(del(":1}\n\n"), [{ hendelse: "fase", data: "{\"a\":1}" }]);
  assert.deepEqual(del("data: en\n\ndata: to\n\n"), [{ hendelse: "", data: "en" }, { hendelse: "", data: "to" }]);
  assert.deepEqual(del("event: x\r\ndata: y\r\n\r\n"), [{ hendelse: "x", data: "y" }]);
  assert.deepEqual(del(":hjerteslag\n\n"), []);
  assert.deepEqual(del("data: a\ndata: b\n\n"), [{ hendelse: "", data: "a\nb" }]);
  assert.deepEqual(del("data:uten mellomrom\n\n"), [{ hendelse: "", data: "uten mellomrom" }]);
  assert.deepEqual(del("id: 7\nretry: 10\nevent: bare\n\n"), []);
  assert.deepEqual(del("data: [DONE]\n\n"), [{ hendelse: "", data: "[DONE]" }]);
  // En ramme uten avsluttende blank linje er ikke sendt, og forkastes.
  assert.deepEqual(del("data: halv\n"), []);
});

test("SSE-leseren gir samme rammer bit for bit som i én bit", () => {
  const kilde = ramme("fase", { trinn: "skriv" }) + ":hjerteslag\n\n" + ramme("delta", { tekst: "hei" }) + ramme("ferdig", { ok: true });
  const samlet = alle(delSse(), kilde);
  const delvis = [];
  const del = delSse();
  for(const tegn of kilde) delvis.push(...del(tegn));
  assert.deepEqual(delvis, samlet);
  assert.equal(samlet.length, 3);
});

test("Anthropic-strøm settes sammen til nøyaktig et ikke-strømmet svar", () => {
  const s = lagSvarsamler("anthropic");
  const del = delSse();
  const tekst = "{\"tekst\":\"Et brev.\"}";
  const kilde = ramme("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 31, output_tokens: 1 } } })
    + ramme("ping", { type: "ping" })
    + ramme("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
    + ramme("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: tekst.slice(0, 9) } })
    + ramme("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: tekst.slice(9) } })
    + ramme("content_block_stop", { type: "content_block_stop", index: 0 })
    + ramme("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 42 } })
    + ramme("message_stop", { type: "message_stop" });
  let biter = "";
  for(const r of del(kilde)) biter += s.ta(r);
  assert.equal(biter, tekst);
  assert.deepEqual(s.svar(), {
    id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5",
    content: [{ type: "text", text: tekst }], stop_reason: "end_turn", stop_sequence: null,
    // Tellingen er kumulativ og settes: 1 + 42 ville vært feil.
    usage: { input_tokens: 31, output_tokens: 42 }
  });
});

test("Anthropic-strøm uten message_stop gir ikke noe svar, og max_tokens bevares", () => {
  const uferdig = lagSvarsamler("anthropic");
  for(const r of delSse()(ramme("message_start", { type: "message_start", message: { content: [], usage: {} } }))) uferdig.ta(r);
  assert.equal(uferdig.svar(), null);

  const s = lagSvarsamler("anthropic");
  const kilde = ramme("message_start", { type: "message_start", message: { content: [], usage: { input_tokens: 5, output_tokens: 1 } } })
    + ramme("message_delta", { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 8000 } })
    + ramme("message_stop", { type: "message_stop" });
  for(const r of delSse()(kilde)) s.ta(r);
  assert.equal(s.svar().stop_reason, "max_tokens");
  assert.equal(s.svar().usage.output_tokens, 8000);
});

test("OpenAI-strøm gir response-objektet uendret, både fullført og mislykket", () => {
  const svar = { id: "resp_1", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{\"tekst\":\"Hei.\"}" }] }], usage: { input_tokens: 3, output_tokens: 7 } };
  const s = lagSvarsamler("openai");
  const kilde = ramme("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } })
    + ramme("response.output_text.delta", { type: "response.output_text.delta", delta: "{\"tekst\":" })
    + ramme("response.output_text.delta", { type: "response.output_text.delta", delta: "\"Hei.\"}" })
    + ramme("response.completed", { type: "response.completed", response: svar })
    + "data: [DONE]\n\n";
  let biter = "";
  for(const r of delSse()(kilde)) biter += s.ta(r);
  assert.equal(biter, "{\"tekst\":\"Hei.\"}");
  assert.deepEqual(s.svar(), svar);

  const f = lagSvarsamler("openai");
  for(const r of delSse()(ramme("response.failed", { type: "response.failed", response: { status: "failed" } }))) f.ta(r);
  assert.deepEqual(f.svar(), { status: "failed" });
});

test("feilhendelser og ugyldig JSON gir modellformat uten leverandørens ordlyd", () => {
  for(const [leverandor, kilde] of [
    ["anthropic", ramme("error", { type: "error", error: { type: "overloaded_error", message: "sk-hemmelig i klartekst" } })],
    ["openai", ramme("error", { type: "error", code: "x", message: "sk-hemmelig i klartekst" })]
  ]){
    const s = lagSvarsamler(leverandor);
    assert.throws(() => { for(const r of delSse()(kilde)) s.ta(r); },
      e => e.navn === "modellformat" && !e.message.includes("sk-hemmelig"));
  }
  const s = lagSvarsamler("anthropic");
  assert.throws(() => { for(const r of delSse()("data: {ikke json\n\n")) s.ta(r); }, e => e.navn === "modellformat");
  assert.throws(() => lagSvarsamler("https://example.invalid"));
});

test("feltstrømmen gir samme tekst tegn for tegn som i én bit", () => {
  const dokument = JSON.stringify({
    sprak: "nb",
    pastander: [{ tekst: "Nøstet påstand som ikke er brevet.", kilder: [{ kilde: "cv", sitat: "x" }] }],
    tekst: "Første linje.\nAndre \"linje\" med \\ og /.",
    merknader: [],
    maAvklares: false
  });
  const hel = lagFeltstrøm("tekst");
  assert.equal(hel.ta(dokument), "Første linje.\nAndre \"linje\" med \\ og /.");
  assert.equal(hel.ferdig, true);

  const smått = lagFeltstrøm("tekst");
  assert.equal(tegnForTegn(dokument, smått.ta), "Første linje.\nAndre \"linje\" med \\ og /.");
  assert.equal(smått.ferdig, true);
});

test("feltstrømmen finner feltet uansett rekkefølge og ignorerer nøstede navnebrødre", () => {
  const først = lagFeltstrøm("tekst");
  assert.equal(først.ta(JSON.stringify({ tekst: "Først i dokumentet.", pastander: [{ tekst: "nøstet" }] })), "Først i dokumentet.");
  const sist = lagFeltstrøm("tekst");
  assert.equal(sist.ta(JSON.stringify({ pastander: [{ tekst: "nøstet", kilder: [{ kilde: "cv", sitat: "tekst" }] }], sprak: "nb", tekst: "Sist i dokumentet." })), "Sist i dokumentet.");
  const dypt = lagFeltstrøm("tekst");
  assert.equal(dypt.ta(JSON.stringify({ analyse: { tekst: "to nivåer ned" }, tekst: "på toppen" })), "på toppen");
  const begrunnelse = lagFeltstrøm("begrunnelse");
  assert.equal(begrunnelse.ta(JSON.stringify({ sprak: "nb", begrunnelse: "Annonsen er på bokmål.", sporsmal: [] })), "Annonsen er på bokmål.");
});

test("feltstrømmen tåler escape, \\uXXXX og surrogatpar delt mellom biter", () => {
  const delt = (...biter) => { const f = lagFeltstrøm("tekst"); return biter.map(b => f.ta(b)).join(""); };
  assert.equal(delt('{"tekst":"a\\', 'nb"}'), "a\nb");
  assert.equal(delt('{"tekst":"a\\', '"b"}'), 'a"b');
  assert.equal(delt('{"tekst":"a\\u00', 'e5b"}'), "aåb");
  assert.equal(delt('{"tekst":"a\\u', '00e5b"}'), "aåb");
  // Surrogatpar som escape, delt midt i paret.
  assert.equal(delt('{"tekst":"\\ud83d', '\\ude00"}'), "\u{1f600}");
  // Surrogatpar som rå tegn, delt midt i paret.
  assert.equal(delt('{"tekst":"\u{1f600}'.slice(0, -1), "\u{1f600}".slice(1) + '"}'), "\u{1f600}");
  // Et ensomt høyt surrogat holdes tilbake i stedet for å vises som erstatningstegn.
  const ensom = lagFeltstrøm("tekst");
  assert.equal(ensom.ta('{"tekst":"a\\ud83d'), "a");
  assert.equal(ensom.ferdig, false);
});

test("feltstrømmen kaster aldri, og en avbrutt strøm er bare uferdig", () => {
  const f = lagFeltstrøm("tekst");
  assert.equal(f.ta('{"sprak":"nb","tekst":"Halvferdig bre'), "Halvferdig bre");
  assert.equal(f.ferdig, false);
  assert.equal(f.ta(""), "");
  for(const rart of [null, undefined, "", "}}}]]]", '{"tekst":', '{"tekst":null,"a":1}', "[1,2,3]", "ikke json i det hele tatt"]){
    const g = lagFeltstrøm("tekst");
    assert.doesNotThrow(() => g.ta(rart));
  }
  assert.equal(lagFeltstrøm("").ta('{"tekst":"noe"}'), "");
  assert.equal(lagFeltstrøm("tekst").ta('{"tekst":null,"b":2}'), "");
});

test("feltstrømmen har et tak, så en forhåndsvisning ikke kan vokse fritt", () => {
  const f = lagFeltstrøm("tekst");
  let sum = f.ta('{"tekst":"').length;
  for(let i = 0; i < 200; i++) sum += f.ta("x".repeat(1000)).length;
  assert.equal(sum, 100_000);
  assert.equal(f.ferdig, false);
});
