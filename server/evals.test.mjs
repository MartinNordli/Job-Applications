import test from "node:test";
import assert from "node:assert/strict";
import { tilfeller } from "../evals/tilfeller.mjs";
import { sjekkBrev } from "../evals/sjekker.mjs";
import { validerGrunnlag, STILEKSEMPLER } from "../src/brevlogikk.mjs";

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
