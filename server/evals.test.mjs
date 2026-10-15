import test from "node:test";
import assert from "node:assert/strict";
import { tilfeller } from "../evals/tilfeller.mjs";
import { sjekkBrev } from "../evals/sjekker.mjs";
import { validerGrunnlag, STILEKSEMPLER } from "../src/brevlogikk.mjs";
import { dollar, medModell, fordel, blindfil, PRISER } from "../evals/sammenligning.mjs";
import { byggModellkropp, modellFor } from "../src/brev-provider.mjs";

/* Evalueringen kjøres sjelden og koster penger. Disse testene sørger for
   at den er brukbar når den først kjøres: tilfellene er gyldige, og de
   automatiske sjekkene gjør det de sier. */

test("tilfellene er gyldige, unike og dekker bokmål, nynorsk og engelsk",()=>{
  assert.ok(tilfeller.length>=20);
  assert.equal(new Set(tilfeller.map(t=>t.id)).size,tilfeller.length);
  assert.deepEqual([...new Set(tilfeller.map(t=>t.forventetSprak))].sort(),["en","nb","nn"]);
  for(const t of tilfeller){
    assert.doesNotThrow(()=>validerGrunnlag(t.grunnlag),t.id);
    assert.ok(t.ord[0]<=t.ord[1]&&t.avsnitt[0]<=t.avsnitt[1],t.id);
    assert.ok(t.vurderingspunkter.length>0,t.id);
    assert.equal(JSON.stringify(t).includes("\u2014"),false,t.id);
  }
});
test("tilfellene låner ingenting fra stileksemplene",()=>{
  const særord=STILEKSEMPLER.flatMap(e=>e.særord);
  for(const t of tilfeller){
    const tekst=JSON.stringify(t.grunnlag);
    for(const o of særord) assert.equal(tekst.includes(o),false,`${t.id}: ${o}`);
  }
});

const eksempel=STILEKSEMPLER[0];
const tilfelle={forventetSprak:"nb",ord:[220,300],avsnitt:[4,5],kontaktperson:"",forbudt:null,
  grunnlag:{cv:eksempel.særord.join(", "),annonse:"Annonse.",jobb:{selskap:"Strandvik Logistikk"},sprak:"auto",leverandor:"anthropic"}};
const brev={tekst:eksempel.tekst,sprak:"nb"};

test("et brev i målformen består alle sjekkene",()=>{
  assert.deepEqual(sjekkBrev(tilfelle,brev),[]);
  assert.deepEqual(sjekkBrev({...tilfelle,forventetSprak:"en"},{tekst:STILEKSEMPLER[1].tekst,sprak:"English"}).filter(f=>!/særord/.test(f)),[]);
});
test("sjekkene fanger språk, lengde, avsnitt, hilsen, kontaktperson, lån og forbudte ord",()=>{
  assert.deepEqual(sjekkBrev(tilfelle,{tekst:"",sprak:"nb"}),["Brevet er tomt."]);
  assert.match(sjekkBrev(tilfelle,{...brev,sprak:"en"}).join(" "),/Språket er en/);
  assert.match(sjekkBrev({...tilfelle,ord:[0,150]},brev).join(" "),/ventet 0 til 150/);
  assert.match(sjekkBrev({...tilfelle,avsnitt:[4,4]},brev).join(" "),/5 innholdsavsnitt/);
  assert.match(sjekkBrev(tilfelle,{...brev,tekst:brev.tekst.replace("Med vennlig hilsen","Hilsen")}).join(" "),/Med vennlig hilsen/);
  assert.match(sjekkBrev({...tilfelle,kontaktperson:"Kari Lund"},brev).join(" "),/Kari Lund/);
  assert.match(sjekkBrev({...tilfelle,grunnlag:{...tilfelle.grunnlag,cv:"Ingen særord her."}},brev).join(" "),/særord.*Kvernhus/);
  assert.match(sjekkBrev({...tilfelle,forbudt:"Python"},brev).join(" "),/ikke skal/);
  assert.match(sjekkBrev(tilfelle,{...brev,tekst:brev.tekst.replace("Jeg vil gjerne bidra","Jeg brenner for å bidra")}).join(" "),/tomme fraser/);
});

/* ---------- modellsammenligningen ---------- */
test("sammenligningen bytter bare modell og innsats, og resten av kroppen er byte for byte lik",async()=>{
  const kropp=byggModellkropp({leverandor:"anthropic",system:"Regler.",kilder:"{\"kilder\":{}}",innhold:"{}",skjema:{type:"object"},trinn:"skriv"});
  let sendt;
  const hent=medModell("claude-opus-5","high",async(url,init)=>{sendt={url,init};return new Response("ok");});
  await hent("https://api.anthropic.com/v1/messages",{method:"POST",headers:{a:"b"},body:JSON.stringify(kropp)});
  const ut=JSON.parse(sendt.init.body);
  assert.equal(ut.model,"claude-opus-5");assert.equal(ut.output_config.effort,"high");
  assert.deepEqual({...ut,model:kropp.model,output_config:{...ut.output_config,effort:kropp.output_config.effort}},kropp);
  assert.deepEqual(sendt.init.headers,{a:"b"});
  assert.throws(()=>medModell("gpt-6-astra","high"),/sammenligningsmodell/);
  assert.throws(()=>medModell("claude-opus-5","maks"),/Innsatsen/);
});
test("kostnaden regnes av alle fire tellingene, og er ukjent uten pris",()=>{
  // Én million av hver: inn 4 + ut 20 + skriv 5 + les 0,2 dollar for Opus 5.5.
  const mill={input_tokens:1e6,output_tokens:1e6,cache_creation_input_tokens:1e6,cache_read_input_tokens:1e6};
  assert.ok(Math.abs(dollar([mill,null],"claude-opus-5-5")-29.2)<1e-9);
  assert.ok(Math.abs(dollar(mill,"claude-opus-5")-36.75)<1e-9);
  assert.equal(dollar(mill,"gpt-6-astra"),null);
  assert.ok(PRISER[modellFor("anthropic","brev")],"brevmodellen har en pris");
});
test("den blinde vurderingsfilen viser brevene uten noe som avslører varianten",()=>{
  assert.deepEqual(fordel(()=>0.1),["ny","forrige"]);assert.deepEqual(fordel(()=>0.9),["forrige","ny"]);
  const v=(variant,tekst)=>({variant,modell:variant==="ny"?"claude-opus-5-5":"claude-opus-5",dollar:0.1,bruk:[{output_tokens:9}],millisekunder:5,brev:{tekst}});
  const md=blindfil([{id:"01",tema:"Gull",repetisjon:1,varianter:{A:v("forrige","Brev en."),B:v("ny","Brev to.")}},
    {id:"02",tema:"Tynt",repetisjon:1,varianter:{A:{variant:"ny",feil:{code:"kildefeil"}},B:v("forrige","Brev tre.")}}],tilfeller);
  for(const t of ["Brev en.","Brev to.","Brev tre.","kildefeil",tilfeller[0].vurderingspunkter.at(-1)]) assert.ok(md.includes(t),t);
  for(const t of ["opus","forrige","\"ny\"","dollar","millisekunder"]) assert.equal(md.includes(t),false,t);
});
