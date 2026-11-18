import { forfilter, BOLK } from "../src/radar/radarlogikk.mjs";
import { radarForespørsel, forslagForespørsel } from "../src/radar/radarprompt.mjs";

export function forespørslerFor(t, leverandor = "anthropic"){
  if(t.annonser.length > BOLK) throw new Error(`${t.id}: høyst ${BOLK} annonser per tilfelle.`);
  const annonser = t.annonser.map(({ id, stilling, selskap, sted, frist, tekst }) => ({ id, stilling, selskap, sted, frist, tekst }));
  return { vurdering: radarForespørsel({ cv: t.cv, annonser, leverandor }), forslag: forslagForespørsel({ cv: t.cv, leverandor }) };
}

const NB = /\b(og|ikke|som|med|har|på|til|av|fra|er|krav|mangler|viser)\b|[æøå]/iu;
const EN = /\b(the|and|with|not|has|of|is|requires?|missing|shows?)\b/iu;

export function språkI(tekst){
  const nb = NB.test(tekst), en = EN.test(tekst);
  return nb && !en ? "nb" : en && !nb ? "en" : "uklart";
}

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

export function sjekkForslag(tilfelle, forslag){
  const feil = [];
  if(!forslag.sokeord.length) feil.push("Forslaget har ingen søkeord.");
  for(const a of tilfelle.annonser){
    if(a.relevant === null) continue;
    const grunn = forfilter({ ...a, status: "aktiv" }, { ...forslag, steder: [] }, "2000-01-01");
    if(a.relevant && grunn) feil.push(`${a.id} (${a.stilling}) stoppes av forslaget (${grunn}), men passer.`);
    if(!a.relevant && !grunn) feil.push(`${a.id} (${a.stilling}) slipper gjennom forslaget, men er feil bransje.`);
  }
  return feil;
}
