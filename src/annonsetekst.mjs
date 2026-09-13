import { Brevfeil } from "./brevdata.mjs";

function ren(html){
  return String(html).replace(/<(script|style|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi," ")
    .replace(/<\/(p|div|li|h[1-6]|section|article)>|<br\s*\/?>/gi,"\n")
    .replace(/<[^>]*>/g," ").replace(/&nbsp;|&#160;/gi," ").replace(/&amp;/gi,"&")
    .replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'")
    .replace(/&#(\d+);/g,(_,n)=>{const c=Number(n);return c<=0x10ffff?String.fromCodePoint(c):"";})
    .replace(/[ \t]+/g," ").replace(/ *\n */g,"\n").replace(/\n{3,}/g,"\n\n").trim();
}
function jobb(v){
  if(!v || typeof v!=="object")return null;
  if(Array.isArray(v)){for(const x of v){const r=jobb(x);if(r)return r;}}
  if([].concat(v["@type"]||[]).some(t=>/JobPosting$/i.test(t)) && typeof v.description==="string")return v.description;
  if(v["@graph"])return jobb(v["@graph"]);
  return null;
}
export function trekkUtAnnonse(html){
  let beskrivelse;
  for(const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    try{beskrivelse=jobb(JSON.parse(m[1]));}catch{}
    if(beskrivelse)break;
  }
  const hoved=html.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i)?.[1];
  const tekst=ren(beskrivelse||hoved||html);
  if(tekst.length<80)throw new Brevfeil("tom-annonse","Fant for lite annonsetekst. Lim inn annonsen i tekstfeltet.");
  if(tekst.length>100000)throw new Brevfeil("for-lang","Annonsen inneholder mer enn 100 000 tegn. Lim inn den relevante annonseteksten.");
  return tekst;
}
