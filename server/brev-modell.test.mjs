import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { byggModellkropp, tolkModellsvar } from "../src/brev-provider.mjs";
import { lagBrevModell, brevNokkelStatus, settBrevNokkel, fjernBrevNokkel } from "./brev-modell.mjs";

const schema = { type: "object", properties: { tekst: { type: "string" } }, required: ["tekst"], additionalProperties: false };
const inn = { system: "Skriv saklig.", innhold: { cv: "Eksempel", annonse: "Eksempelrolle" }, skjema: schema, trinn: "kontroll" };
const NOKKEL = "en-testnokkel-uten-ekte-tilgang-012345";
async function profil(t){ const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "brev-modell-")); t.after(()=>fs.rm(katalog,{recursive:true,force:true})); return { katalog }; }

const ramme = (hendelse, data) => `event: ${hendelse}\ndata: ${JSON.stringify(data)}\n\n`;
/* En ekte SSE-kropp, delt i små biter, så transporten prøves slik den
   faktisk møter leverandøren og ikke som én ferdig JSON-streng. */
function sseSvar(leverandor, tekst, biter = 3){
  const deler = [];
  for(let i = 0; i < tekst.length; i += Math.ceil(tekst.length / biter)) deler.push(tekst.slice(i, i + Math.ceil(tekst.length / biter)));
  const rammer = leverandor === "anthropic"
    ? [ramme("message_start", { type: "message_start", message: { id: "msg", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 1 } } }),
        ramme("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        ...deler.map(d => ramme("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: d } })),
        ramme("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }),
        ramme("message_stop", { type: "message_stop" })]
    : [...deler.map(d => ramme("response.output_text.delta", { type: "response.output_text.delta", delta: d })),
        ramme("response.completed", { type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: tekst }] }], usage: { input_tokens: 3, output_tokens: 7 } } }),
        "data: [DONE]\n\n"];
  return strøm(rammer);
}
function strøm(deler){
  const kode = new TextEncoder();
  return new Response(new ReadableStream({ start(k){ for(const d of deler) k.enqueue(kode.encode(d)); k.close(); } }),
    { headers: { "content-type": "text/event-stream" } });
}

test("begge leverandører bruker samme schema og låst modell; OpenAI lagrer ikke", () => {
  const a = byggModellkropp({ ...inn, leverandor: "anthropic" });
  assert.equal(a.model, "claude-opus-5"); assert.equal(a.system, inn.system); assert.deepEqual(a.output_config.format.schema, schema);
  assert.equal(a.stream, true);
  const o = byggModellkropp({ ...inn, leverandor: "openai" });
  assert.equal(o.model, "gpt-6-astra"); assert.equal(o.store, false); assert.equal(o.text.format.strict, true); assert.equal(o.stream, true);
  assert.deepEqual(o.text.format.schema, schema); assert.equal(o.instructions, inn.system);
  assert.throws(()=>byggModellkropp({ ...inn, leverandor: "https://example.com" }));
});
test("nøkler holdes adskilt og returneres aldri", async t => {
  const p = await profil(t); assert.equal((await brevNokkelStatus(p, "openai")).finnes, false);
  assert.deepEqual(await settBrevNokkel(p, "openai", NOKKEL), {ok:true});
  assert.equal((await brevNokkelStatus(p, "anthropic")).finnes, false);
  const status = await brevNokkelStatus(p, "openai"); assert.equal(status.hale, "2345"); assert.equal(JSON.stringify(status).includes(NOKKEL), false);
  assert.equal((await fs.stat(path.join(p.katalog,"nokkel-openai.txt"))).mode & 0o777, 0o600);
  assert.equal((await settBrevNokkel(p,"openai",NOKKEL+"\r\nx-header: nope")).ok, false);
  await fjernBrevNokkel(p,"openai"); assert.equal((await brevNokkelStatus(p,"openai")).finnes,false);
});
test("miljønøkkel krever eksplisitt tillatelse og egen nøkkel vinner", async t => {
  const p = await profil(t), gammel = process.env.OPENAI_API_KEY;
  t.after(()=>{ if(gammel === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY=gammel; });
  process.env.OPENAI_API_KEY = NOKKEL;
  assert.equal((await brevNokkelStatus(p,"openai")).finnes,false);
  assert.deepEqual(await brevNokkelStatus({...p,tillatMiljø:true},"openai"),{finnes:true,kilde:"miljø"});
  await settBrevNokkel(p,"openai",NOKKEL+"egen");
  assert.equal((await brevNokkelStatus({...p,tillatMiljø:true},"openai")).kilde,"egen");
});
test("API-transporter sender nøkkel til fast vert, strømmer og normaliserer begge svar", async t => {
  const p = await profil(t);
  for(const leverandor of ["openai","anthropic"]){
    await settBrevNokkel(p,leverandor,NOKKEL);
    const deltaer=[];
    const kall = lagBrevModell({...p,fetch:async(url,req)=>{
      assert.equal(url,leverandor==="openai"?"https://api.openai.com/v1/responses":"https://api.anthropic.com/v1/messages");
      assert.equal(leverandor==="openai"?req.headers.authorization:req.headers["x-api-key"],leverandor==="openai"?`Bearer ${NOKKEL}`:NOKKEL);
      assert.equal(JSON.parse(req.body).stream,true);
      return sseSvar(leverandor,JSON.stringify({tekst:"Et nøkternt brev."}));
    }});
    const r=await kall({...inn,leverandor,felt:"tekst",påDelta:t=>deltaer.push(t)});
    assert.equal(r.data.tekst,"Et nøkternt brev."); assert.equal(r.bruk.output_tokens,7);
    // Deltaene er dekodet tekst, aldri rå JSON, og utgjør hele feltverdien.
    assert.equal(deltaer.join(""),"Et nøkternt brev.");
    assert.ok(deltaer.length>1);
    assert.ok(deltaer.every(d=>!d.includes("{")));
  }
});
test("uten påDelta strømmer transporten fortsatt, men dekoder ingenting", async t => {
  const p = await profil(t); await settBrevNokkel(p,"anthropic",NOKKEL);
  const kall = lagBrevModell({...p,fetch:async()=>sseSvar("anthropic",JSON.stringify({tekst:"Uten forhåndsvisning."}))});
  assert.equal((await kall({...inn,leverandor:"anthropic"})).data.tekst,"Uten forhåndsvisning.");
});
test("en strøm uten avsluttende hendelse blir aldri et svar", async t => {
  const p = await profil(t); await settBrevNokkel(p,"anthropic",NOKKEL);
  const halv = [ramme("message_start",{type:"message_start",message:{content:[],usage:{}}}),
    ramme("content_block_start",{type:"content_block_start",index:0,content_block:{type:"text",text:""}}),
    ramme("content_block_delta",{type:"content_block_delta",index:0,delta:{type:"text_delta",text:'{"tekst":"halv'}})];
  const deltaer=[];
  const kall = lagBrevModell({...p,fetch:async()=>strøm(halv)});
  await assert.rejects(kall({...inn,leverandor:"anthropic",felt:"tekst",påDelta:t=>deltaer.push(t)}),e=>e.navn==="modellformat");
  assert.equal(deltaer.join(""),"halv");
});
test("påDelta fyres ikke etter avbrudd", async t => {
  const p = await profil(t); await settBrevNokkel(p,"anthropic",NOKKEL);
  const c = new AbortController(); const deltaer=[]; const kode = new TextEncoder();
  const biter=[ramme("message_start",{type:"message_start",message:{content:[],usage:{}}})
      + ramme("content_block_start",{type:"content_block_start",index:0,content_block:{type:"text",text:""}})
      + ramme("content_block_delta",{type:"content_block_delta",index:0,delta:{type:"text_delta",text:'{"tekst":"før'}}),
    ramme("content_block_delta",{type:"content_block_delta",index:0,delta:{type:"text_delta",text:' og etter"}'}})];
  // Brukeren avbryter mens forhåndsvisningen tegnes. Resten av strømmen leses
  // fortsatt ut, men ingen flere deltaer skal nå fram.
  const kall = lagBrevModell({...p,fetch:async()=>new Response(new ReadableStream({start(k){
    for(const b of biter) k.enqueue(kode.encode(b));
    k.close();
  }}))});
  await assert.rejects(kall({...inn,leverandor:"anthropic",felt:"tekst",signal:c.signal,
    påDelta:t=>{deltaer.push(t);c.abort();}}),e=>e.navn==="avbrutt");
  assert.equal(deltaer.join(""),"før");
});
test("rå leverandørfeil og nøkler lekker ikke og kallet gjentas ikke automatisk", async t => {
  const p=await profil(t); await settBrevNokkel(p,"openai",NOKKEL); let antall=0;
  const kall=lagBrevModell({...p,fetch:async()=>{antall++;return Response.json({error:{message:NOKKEL+" privat CV-tekst"}},{status:500});}});
  await assert.rejects(kall({...inn,leverandor:"openai"}),e=>!e.message.includes(NOKKEL)&&!e.message.includes("CV-tekst")); assert.equal(antall,1);
});
test("avbrudd klassifiseres uten nytt modellkall", async t => {
  const p=await profil(t);await settBrevNokkel(p,"openai",NOKKEL);const c=new AbortController();
  const kall=lagBrevModell({...p,fetch:async(_url,{signal})=>{c.abort();signal.throwIfAborted();}});
  await assert.rejects(kall({...inn,leverandor:"openai",signal:c.signal}),e=>e.navn==="avbrutt");
});
test("avbrutte og ugyldige modellresultater blir ikke ferdige brev", () => {
  assert.throws(()=>tolkModellsvar("anthropic",{stop_reason:"max_tokens",content:[{type:"text",text:'{"tekst":"halve"}'}]}));
  assert.throws(()=>tolkModellsvar("openai",{status:"incomplete",output:[]}));
  assert.throws(()=>tolkModellsvar("openai",{status:"completed",output:[{type:"message",content:[{type:"refusal",refusal:"nei"}]}]}));
  assert.throws(()=>tolkModellsvar("anthropic",{content:[{type:"text",text:"ikke json"}]}));
});
