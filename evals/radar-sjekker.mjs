/* ============================================================
   Automatiske sjekker for Radar-evalen. De beviser ikke at en
   vurdering er god, bare at den ikke er åpenbart feil: prosent i
   båndet, grunner på CV-ens språk, ingen spor av injeksjonen, og at
   forslaget faktisk virker i forfilter. Resten avgjør en person med
   vurderingspunktene i tilfellene.
   ============================================================ */
import { forfilter, BOLK } from "../src/radarlogikk.mjs";
import { radarForespørsel, forslagForespørsel } from "../src/radarprompt.mjs";

/* Forespørslene appen ville sendt for et tilfelle: én bolk og ett forslag. */
export function forespørslerFor(t, leverandor = "anthropic"){
  if(t.annonser.length > BOLK) throw new Error(`${t.id}: høyst ${BOLK} annonser per tilfelle.`);
  const annonser = t.annonser.map(({ id, stilling, selskap, sted, frist, tekst }) => ({ id, stilling, selskap, sted, frist, tekst }));
  return { vurdering: radarForespørsel({ cv: t.cv, annonser, leverandor }), forslag: forslagForespørsel({ cv: t.cv, leverandor }) };
}

const NB = /\b(og|ikke|som|med|har|på|til|av|fra|er|krav|mangler|viser)\b|[æøå]/iu;
const EN = /\b(the|and|with|not|has|of|is|requires?|missing|shows?)\b/iu;

/* Grovt, med vilje: grunnene er korte, og språket kjennes på småordene. */
export function språkI(tekst){
  const nb = NB.test(tekst), en = EN.test(tekst);
  return nb && !en ? "nb" : en && !nb ? "en" : "uklart";
}

/* vurderinger er [{ id, prosent, grunner }] i annonsenes rekkefølge. */
export function sjekkVurdering(tilfelle, vurderinger){
  const feil = [];
  for(const a of tilfelle.annonser){
    const v = vurderinger.find(x => x.id === a.id);
    if(!v){ feil.push(`${a.id}: mangler vurdering.`); continue; }
    const [min, maks] = a.forventet;
    if(v.prosent < min || v.prosent > maks) feil.push(`${a.id}: ${v.prosent} prosent, ventet ${min} til ${maks}.`);
    const tekst = v.grunner.join(" ");
    if(!v.grunner.length) feil.push(`${a.id}: ingen grunner.`);
    const s = språkI(tekst);
    if(tekst && s !== tilfelle.sprak) feil.push(`${a.id}: grunnene ser ut til å være på ${s}, ventet ${tilfelle.sprak}.`);
    for(const f of tilfelle.forbudt ?? []) if(tekst.toLowerCase().includes(f.toLowerCase())) feil.push(`${a.id}: grunnene har «${f}», som ikke skal stå der.`);
  }
  return feil;
}

/* Forslaget brukt slik Radar ville brukt det: de relevante annonsene
   skal gjennom forfilter, de som er åpenbart feil, skal stoppe.
   forslag er det tolkForslag ga, allerede filtrert. */
export function sjekkForslag(tilfelle, forslag){
  const feil = [];
  if(!forslag.sokeord.length) feil.push("Forslaget har ingen søkeord.");
  for(const a of tilfelle.annonser){
    if(a.relevant === null) continue;
    /* Stedene er et ønske om hvor, ikke om hva, og sjekkes for seg i tolkForslag. */
    const grunn = forfilter({ ...a, status: "aktiv" }, { ...forslag, steder: [] }, "2000-01-01");
    if(a.relevant && grunn) feil.push(`${a.id} (${a.stilling}) stoppes av forslaget (${grunn}), men passer.`);
    if(!a.relevant && !grunn) feil.push(`${a.id} (${a.stilling}) slipper gjennom forslaget, men er feil bransje.`);
  }
  return feil;
}
