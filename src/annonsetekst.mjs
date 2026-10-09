/* ============================================================
   Annonseteksten ut av en hentet side. Ren tekstbehandling uten
   I/O, så importen, «Hent annonsen» og brevet bruker samme uttrekk i
   Node og i webviewet. JobPosting i JSON-LD går foran <main> og
   <article>, og hele siden er siste utvei.
   ============================================================ */
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

/* Hentefeilene, slik brukeren trenger å skille dem. Node og Rust sier
   det samme med samme ord («Siden svarte 404.», «Adressen peker ikke
   til en nettside.»), og over invoke kommer Rust-feilen som en streng.
   Derfor tolkes teksten, ikke en type: én regel for begge transporter.
   Resten av meldingene er skrevet for brukeren i server/nett.mjs og
   src-tauri/src/nett.rs, og går videre som de er. */
export function hentefeil(e){
  const m = (typeof e === "string" ? e : String(e?.melding || e?.message || "")).trim();
  const status = Number(m.match(/^Siden svarte (\d{3})\.$/)?.[1]);
  if(status === 404 || status === 410)
    return new Brevfeil("dod-lenke", "Annonsen ligger ikke lenger på den adressen. Lim inn teksten hvis du har den.", 502);
  if(m === "Adressen peker ikke til en nettside.")
    return new Brevfeil("ikke-nettside", "Lenken peker ikke til en nettside. Lim inn annonsen i stedet.", 502);
  if(status)
    return new Brevfeil("henting", `Siden svarte ${status}. Prøv igjen senere, eller lim inn annonsen.`, 502);
  return new Brevfeil("henting", m && m.length <= 200 ? m : "Fikk ikke hentet siden.", 502);
}

/* Det samme uttrekket som trekkUtAnnonse, men med meldinger for den som
   har bedt om å hente annonsen til en søknad, ikke for brevets
   tekstfelt. For lite tekst betyr nesten alltid en side som bygges med
   JavaScript, og da hjelper bare innliming. */
export function annonseFraSide(html){
  try{ return trekkUtAnnonse(String(html ?? "")); }
  catch(e){
    if(e?.code === "tom-annonse")
      throw new Brevfeil("tom-annonse", "Fant for lite tekst på siden. Den er kanskje bygget med JavaScript. Lim inn annonsen i stedet.", 422);
    if(e?.code === "for-lang")
      throw new Brevfeil("for-lang", "Siden har mer enn 100 000 tegn tekst. Lim inn selve annonsen i stedet.", 422);
    throw e;
  }
}
