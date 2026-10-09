/* ============================================================
   Formatering som listen og detaljpanelet deler: escaping, datoer
   og monogrammet. Ingen tilstand. Det som avhenger av «i dag» tar
   dagen inn som argument, så app.js kan holde sin egen klokke (den
   byttes ved midnatt) og panelet spørre etter den samme.
   ============================================================ */

export const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const DAGER = ["søn.", "man.", "tir.", "ons.", "tor.", "fre.", "lør."];
export const MND   = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];
export const MND_K = ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"];

export const tilDato = iso => { const [a, m, d] = iso.split("-").map(Number); return new Date(a, m - 1, d); };
export const tilIso  = dt  => dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");

/* Hele dager fra `iDag` (en Date ved midnatt) til datoen. */
export const dagerTil = (iso, iDag) => Math.round((tilDato(iso) - iDag) / 86400000);

export function hast(iso, iDag){
  if(!iso) return "ingen";
  const d = dagerTil(iso, iDag);
  if(d < 0)  return "forbi";
  if(d <= 7) return "naa";
  if(d <= 21) return "snart";
  return "senere";
}

export function omTekst(iso, iDag){
  const d = dagerTil(iso, iDag);
  if(d === 0) return "i dag";
  if(d === 1) return "i morgen";
  if(d === -1) return "i går";
  if(d < 0) return Math.abs(d) + " dager siden";
  return "om " + d + " dager";
}

export const ukedag      = iso => DAGER[tilDato(iso).getDay()];
export const langDato    = iso => { const d = tilDato(iso); return d.getDate() + ". " + MND[d.getMonth()]; };
export const kortDatoMnd = iso => { const d = tilDato(iso); return d.getDate() + ". " + MND_K[d.getMonth()]; };

/* «12. okt», med år bare når det ikke er i år. */
export function datoMedÅr(iso, iDag){
  const d = tilDato(iso);
  return d.getDate() + ". " + MND_K[d.getMonth()] + (d.getFullYear() === iDag.getFullYear() ? "" : " " + d.getFullYear());
}

export const antall = (n, ent, fl) => n + " " + (n === 1 ? ent : fl);

/* Tegn foran ordet teller ikke: «Abakus (Webcom og Bedcom)» skal bli
   AW, ikke A(. */
export function monogram(navn){
  const ord = navn.trim().split(/\s+/).map(o => o.replace(/^[^\p{L}\p{N}]+/u, "")).filter(Boolean);
  if(ord.length > 1) return (ord[0][0] + ord[1][0]).toUpperCase();
  return (ord[0] || navn.trim()).slice(0, 2).toUpperCase();
}

/* Vertsnavnet uten «www.», til kildelinjer. Tomt for alt som ikke er en
   gyldig nettadresse. */
export function vert(url){
  try{ return new URL(url).hostname.replace(/^www\./, ""); }catch{ return ""; }
}
