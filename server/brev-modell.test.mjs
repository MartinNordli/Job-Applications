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

test("begge leverandører bruker samme schema og låst modell; OpenAI lagrer ikke", () => {
  const a = byggModellkropp({ ...inn, leverandor: "anthropic" });
  assert.equal(a.model, "claude-opus-5"); assert.equal(a.system, inn.system); assert.deepEqual(a.output_config.format.schema, schema);
  const o = byggModellkropp({ ...inn, leverandor: "openai" });
  assert.equal(o.model, "gpt-6-astra"); assert.equal(o.store, false); assert.equal(o.text.format.strict, true);
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
test("API-transporter sender nøkkel til fast vert og normaliserer begge svar", async t => {
  const p = await profil(t);
  for(const leverandor of ["openai","anthropic"]){
    await settBrevNokkel(p,leverandor,NOKKEL);
    const kall = lagBrevModell({...p,fetch:async(url,req)=>{
      assert.equal(url,leverandor==="openai"?"https://api.openai.com/v1/responses":"https://api.anthropic.com/v1/messages");
      assert.equal(leverandor==="openai"?req.headers.authorization:req.headers["x-api-key"],leverandor==="openai"?`Bearer ${NOKKEL}`:NOKKEL);
      const tekst=JSON.stringify({tekst:"Et nøkternt brev."});
      return Response.json(leverandor==="openai"?{status:"completed",output:[{type:"message",content:[{type:"output_text",text:tekst}]}],usage:{input_tokens:3,output_tokens:7}}:{stop_reason:"end_turn",content:[{type:"text",text:tekst}],usage:{input_tokens:3,output_tokens:7}});
    }});
    const r=await kall({...inn,leverandor}); assert.equal(r.data.tekst,"Et nøkternt brev."); assert.equal(r.bruk.output_tokens,7);
  }
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
