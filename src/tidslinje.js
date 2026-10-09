/* ============================================================
   Tidslinjen i detaljpanelet, og datoene stegraden viser.

   Kilden er tidslinje() i hendelser.mjs: ekte hendelser, og for eldre
   søknader anslåtte steg laget av `opprettet` og `sendtDato`. Et anslag
   står som «ca.» og sier det til skjermlesere også, og et steg uten
   kjent dato sier det i stedet for å gjette.

   Nyeste står øverst: det er det man oftest vil vite. En søknad som
   ennå ikke er sendt, får fristen som et punkt foran alt det andre,
   med hastekulør bare når den faktisk haster.
   ============================================================ */

import { tidslinje } from "./hendelser.mjs";
import { esc, tilIso, datoMedÅr, omTekst, hast } from "./formater.js";

/* Hva hver hendelse heter i loggen. Den første «Å søke på» er da
   søknaden ble lagt til; kommer den senere, ble den gjenåpnet. */
const NAVN = {
  sent: "Sendt",
  interview: "Fikk intervju",
  accepted: "Gikk videre",
  rejected: "Fikk avslag",
  trukket: "Trakk søknaden",
  expired: "Markert som utløpt"
};
const KILDE = { lager: "registrert av appen", radar: "fra Radar" };

/* Hovedløpet og sideutgangene, i rekkefølge. */
export const LØP = ["todo", "sent", "interview", "accepted"];
export const UTGANGER = ["rejected", "trukket", "expired"];

/* Datoen hvert steg sist ble nådd, og om den er anslått.
   { todo: { dato, anslått }, sent: … }. «Å søke på» er første gang
   søknaden sto der, de andre siste gang. Et steg som er nådd uten
   kjent dato, får dato null. */
export function stegdatoer(jobb, iDag){
  const ut = {};
  for(const h of tidslinje(jobb, tilIso(iDag))){
    if(h.til === "todo" && ut.todo) continue;
    ut[h.til] = { dato: h.dato, anslått: !!h.anslått };
  }
  return ut;
}

/* Hvor langt søknaden kom i hovedløpet, også når den har gått ut av det
   (et avslag etter intervju kom til intervju). */
export function lengstKommet(jobb, iDag){
  const nådd = new Set(tidslinje(jobb, tilIso(iDag)).map(h => h.til));
  nådd.add(jobb.status);
  if(jobb.sendtDato) nådd.add("sent");
  if(jobb.intervju) nådd.add("interview");
  let i = 0;
  LØP.forEach((s, n) => { if(nådd.has(s)) i = n; });
  return i;
}

export function datoTekst(h, iDag){
  if(!h || !h.dato) return { tekst: "dato ukjent", sr: "dato ukjent" };
  const d = datoMedÅr(h.dato, iDag);
  return h.anslått ? { tekst: "ca. " + d, sr: "anslått " + d } : { tekst: d, sr: d };
}

export function tidslinjeHtml(jobb, iDag){
  const liste = tidslinje(jobb, tilIso(iDag));
  let lagtTil = false;
  const poster = liste.map(h => {
    let navn = NAVN[h.til];
    if(h.til === "todo"){ navn = lagtTil ? "Gjenåpnet" : "Lagt til"; lagtTil = true; }
    return { navn, h };
  }).reverse();

  const rader = poster.map(({ navn, h }, i) => {
    const d = datoTekst(h, iDag);
    const kilde = KILDE[h.kilde] ? '<span class="tidslinje__kilde"> ' + KILDE[h.kilde] + '</span>' : "";
    return '<li class="tidslinje__post' + (i === 0 ? " tidslinje__post--siste" : "") + (h.anslått ? " tidslinje__post--anslått" : "") + '">'
      + '<span class="tidslinje__hva">' + navn + kilde + '</span>'
      + '<time class="tidslinje__når"' + (h.dato ? ' datetime="' + h.dato + '"' : "") + '>'
      + '<span aria-hidden="true">' + esc(d.tekst) + '</span><span class="skjult">' + esc(d.sr) + '</span></time></li>';
  });

  /* Fristen er det neste som skjer med en søknad du ikke har sendt. */
  if(jobb.status === "todo" && jobb.frist){
    const h = hast(jobb.frist, iDag);
    const forbi = h === "forbi";
    /* «gikk ut for 3 dager siden», men «gikk ut i går». */
    const om = omTekst(jobb.frist, iDag);
    const omSetning = forbi && !om.startsWith("i ") ? "for " + om : om;
    rader.unshift('<li class="tidslinje__post tidslinje__post--frist" data-hast="' + h + '">'
      + '<span class="tidslinje__hva">' + (forbi ? "Fristen gikk ut" : "Frist") + ' <span class="tidslinje__om">' + esc(omSetning) + '</span></span>'
      + '<time class="tidslinje__når" datetime="' + jobb.frist + '">' + esc(datoMedÅr(jobb.frist, iDag)) + '</time></li>');
  }

  if(!rader.length) return '<p class="detalj__tomt">Ingen hendelser ennå. Statusendringer havner her.</p>';
  return '<ol class="tidslinje">' + rader.join("") + '</ol>'
    + (poster.some(p => p.h.anslått)
        ? '<p class="detalj__fotnote">«ca.» er anslått fra datoene på søknaden. Nye statusendringer får nøyaktig dato.</p>' : "");
}
