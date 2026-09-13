/* All protokollkunnskap om strømmende modellsvar, ett sted. Node-serveren,
   nettleseren og Tauri-frontenden leser samme strøm gjennom denne filen, slik
   at leverandørformatet aldri finnes i to implementasjoner som må holdes i takt.
   Ingen nettverk, ingen nøkler, ingen DOM. */
import { leverandorFor } from "./brev-provider.mjs";

/* Forhåndsvisningen er provisorisk og skal ikke kunne vokse uten tak. */
const MAKS_FELT = 100_000;
const MAKS_NØKKEL = 200;

function formatfeil(melding){
  const e = new Error(melding); e.navn = "modellformat"; return e;
}

/* Inkrementell SSE-rammeleser. Mat den dekodet tekst; den gir ut ferdige
   rammer. Byte-taket hører hjemme hos den som leser sokkelen, ikke her,
   så de to leserne har hver sin grense mot hver sin motpart. */
export function delSse(){
  let rest = "", hendelse = "", data = [], harData = false;
  return function del(bit){
    rest += bit == null ? "" : String(bit);
    const rammer = [];
    let start = 0, i;
    while((i = rest.indexOf("\n", start)) !== -1){
      let linje = rest.slice(start, i);
      if(linje.endsWith("\r")) linje = linje.slice(0, -1);
      start = i + 1;
      if(!linje){
        // En ramme uten data-linjer sendes ikke videre, slik SSE foreskriver.
        if(harData) rammer.push({ hendelse, data: data.join("\n") });
        hendelse = ""; data = []; harData = false;
        continue;
      }
      if(linje.startsWith(":")) continue; // kommentar, blant annet hjerteslag
      const skille = linje.indexOf(":");
      const felt = skille === -1 ? linje : linje.slice(0, skille);
      let verdi = skille === -1 ? "" : linje.slice(skille + 1);
      if(verdi.startsWith(" ")) verdi = verdi.slice(1);
      if(felt === "event") hendelse = verdi;
      else if(felt === "data"){ data.push(verdi); harData = true; }
      // id, retry og ukjente felt er uten betydning for oss.
    }
    rest = rest.slice(start);
    return rammer;
  };
}

function tolkRamme(ramme){
  const d = ramme?.data;
  if(!d || d === "[DONE]") return {};
  try{ return JSON.parse(d); }
  catch{ throw formatfeil("Modellen svarte i feil format."); }
}

function erFeil(ramme, h){
  // Leverandørens egen feiltekst kan inneholde grunnlaget vårt og slippes aldri ut.
  return ramme.hendelse === "error" || h?.type === "error";
}

function anthropicSamler(){
  let melding = null, komplett = false;
  return {
    ta(ramme){
      const h = tolkRamme(ramme);
      if(erFeil(ramme, h)) throw formatfeil("Modelltjenesten avbrøt svaret. Prøv igjen.");
      if(h.type === "message_start"){
        melding = h.message && typeof h.message === "object" && !Array.isArray(h.message)
          ? { ...h.message, content: [] } : null;
      }else if(h.type === "content_block_start"){
        if(melding && Number.isInteger(h.index) && h.index >= 0 && h.index < 100)
          melding.content[h.index] = { ...h.content_block };
      }else if(h.type === "content_block_delta"){
        const blokk = melding?.content?.[h.index];
        const t = h.delta?.type === "text_delta" ? h.delta.text : "";
        if(blokk && typeof t === "string" && typeof blokk.text === "string"){
          blokk.text += t;
          return t;
        }
      }else if(h.type === "message_delta"){
        if(melding){
          if(h.delta && typeof h.delta === "object" && !Array.isArray(h.delta)) Object.assign(melding, h.delta);
          // Anthropics tellinger er kumulative totaler. Summering ville doblet dem.
          if(h.usage && typeof h.usage === "object" && !Array.isArray(h.usage)){
            melding.usage = { ...melding.usage, ...h.usage };
          }
        }
      }else if(h.type === "message_stop") komplett = true;
      // ping, content_block_stop og ukjente typer er uten betydning.
      return "";
    },
    svar(){ return komplett ? melding : null; }
  };
}

function openaiSamler(){
  let ferdig = null;
  return {
    ta(ramme){
      const h = tolkRamme(ramme);
      if(erFeil(ramme, h)) throw formatfeil("Modelltjenesten avbrøt svaret. Prøv igjen.");
      if(h.type === "response.output_text.delta") return typeof h.delta === "string" ? h.delta : "";
      // response-objektet er allerede nøyaktig formen tolkModellsvar tar imot,
      // også når det er mislykket: da avviser tolkningen det på vanlig vis.
      if(h.type === "response.completed" || h.type === "response.failed" || h.type === "response.incomplete"){
        if(h.response && typeof h.response === "object" && !Array.isArray(h.response)) ferdig = h.response;
      }
      return "";
    },
    svar(){ return ferdig; }
  };
}

/* Setter hendelsene sammen til nøyaktig samme svarform et ikke-strømmet kall
   gir, slik at tolkModellsvar og all validering står uendret. `ta` gir ut
   tekstbiten rammen bar, eller tom streng. */
export function lagSvarsamler(leverandor){
  leverandorFor(leverandor);
  return leverandor === "anthropic" ? anthropicSamler() : openaiSamler();
}

const ESCAPE = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
function lesEscape(s, i){
  if(i + 1 >= s.length) return null;
  const c = s[i + 1];
  if(c !== "u") return { tekst: Object.hasOwn(ESCAPE, c) ? ESCAPE[c] : c, neste: i + 2 };
  if(i + 6 > s.length) return null;
  const hex = s.slice(i + 2, i + 6);
  if(!/^[0-9a-fA-F]{4}$/.test(hex)) return { tekst: "", neste: i + 2 };
  return { tekst: String.fromCharCode(parseInt(hex, 16)), neste: i + 6 };
}

/* Dekoder ett toppnivåfelt ut av en JSON-streng som fortsatt strømmer inn.
   Rekkefølgeuavhengig, fordi ingen leverandør garanterer feltrekkefølge, og
   den hopper over nøstede objekter så pastander[].tekst aldri forveksles med
   toppnivåets tekst. Den kaster aldri: en halv strøm er ikke en feil her,
   bare en forhåndsvisning som ikke ble ferdig. */
export function lagFeltstrøm(felt){
  const navn = typeof felt === "string" ? felt : "";
  const stabel = [];
  let rest = "", modus = "skann", nøkkel = "", treff = false, forventerVerdi = false;
  let høyt = "", sendt = 0, stoppet = !navn;
  const strøm = { ferdig: false, ta };

  function legg(tekst){
    if(!tekst) return "";
    let t = høyt + tekst; høyt = "";
    const siste = t.charCodeAt(t.length - 1);
    // Et ensomt høyt surrogat holdes tilbake til partneren kommer; ellers
    // ville forhåndsvisningen vist et erstatningstegn som aldri forsvant.
    if(siste >= 0xd800 && siste <= 0xdbff){ høyt = t.slice(-1); t = t.slice(0, -1); }
    if(sendt >= MAKS_FELT) return "";
    if(sendt + t.length > MAKS_FELT) t = t.slice(0, MAKS_FELT - sendt);
    sendt += t.length;
    return t;
  }

  function ta(bit){
    if(stoppet) return "";
    const s = rest + (bit == null ? "" : String(bit));
    rest = "";
    let ut = "", i = 0;
    while(i < s.length){
      const c = s[i];
      if(modus === "skann"){
        if(c === '"'){
          i++;
          if(stabel.length === 1 && stabel[0] === "{" && !forventerVerdi){ nøkkel = ""; treff = false; modus = "nøkkel"; }
          else if(forventerVerdi && treff && stabel.length === 1) modus = "felt";
          else modus = "hopp";
          forventerVerdi = false;
        }else if(c === "{" || c === "["){ stabel.push(c); forventerVerdi = false; treff = false; i++; }
        else if(c === "}" || c === "]"){ stabel.pop(); forventerVerdi = false; i++; }
        else if(c === ":"){ forventerVerdi = true; i++; }
        else if(c === ","){ forventerVerdi = false; i++; }
        else i++;
        continue;
      }
      if(c === '"'){
        i++;
        if(modus === "felt"){ strøm.ferdig = true; stoppet = true; break; }
        if(modus === "nøkkel") treff = nøkkel === navn;
        modus = "skann";
        continue;
      }
      if(c === "\\"){
        const e = lesEscape(s, i);
        if(e === null){ rest = s.slice(i); break; }
        if(modus === "felt") ut += legg(e.tekst);
        else if(modus === "nøkkel") nøkkel += e.tekst;
        i = e.neste;
        continue;
      }
      let j = i;
      while(j < s.length && s[j] !== '"' && s[j] !== "\\") j++;
      const løp = s.slice(i, j);
      if(modus === "felt") ut += legg(løp);
      else if(modus === "nøkkel"){
        nøkkel += løp;
        if(nøkkel.length > MAKS_NØKKEL){ nøkkel = ""; modus = "hopp"; }
      }
      i = j;
    }
    return ut;
  }
  return strøm;
}
