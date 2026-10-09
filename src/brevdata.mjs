/* Brevdata har eget lager. Jobblisten og dens format forblir små.
   Lageret har fire dokumenttyper (se src/dokumentnavn.mjs), og hver har
   sitt skjema, sitt tomme dokument og sin validator. Det er her typen
   velges, så lageret, sikkerhetskopien og begge transportene får samme
   regel uten å kjenne typene selv. */
import { Brevfeil, revisjon } from "./dokumentfeil.mjs";
import { dokumenttype, dokumentId, erId, navnFor } from "./dokumentnavn.mjs";
import { SKJEMA as JOBB_SKJEMA, RADAR_SKJEMA, tomtJobbdokument, tomRadar, validerJobbdokument, validerRadar,
  harJobbinnhold, harRadarinnhold } from "./jobbdokument.mjs";
export { Brevfeil, revisjon };
export const SKJEMA = 1;
export const MAKS_DOKUMENT = 32 * 1024 * 1024;
export function jobbId(id){
  if(!erId(id)) throw new Brevfeil("ugyldig", "Ugyldig jobb.");
  return id;
}
export const brevfil = id => navnFor("brev", jobbId(id));
export const jobbfil = id => navnFor("jobb", jobbId(id));
export function dokumentnavn(navn){
  if(!dokumenttype(navn)) throw new Brevfeil("ugyldig", "Ugyldig dokumentnavn.");
  return navn;
}
export const tomCv = () => ({ skjemaVersjon: SKJEMA, revisjon: 0, tekst: "", navn: "", format: "tekst", oppdatert: null });
export const tomtBrev = id => ({ skjemaVersjon: SKJEMA, revisjon: 0, jobbId: jobbId(id), annonse: { tekst: "", url: "", hentet: null }, kontekst: "", sprak: "auto", leverandor: "anthropic", tekst: "", aktivVersjon: null, versjoner: [], kjoring: null, oppdatert: null });
function tekst(v, maks, felt){
  if(typeof v !== "string" || v.length > maks || v.includes("\0")) throw new Brevfeil("ugyldig", `${felt} må være tekst på høyst ${maks.toLocaleString("nb-NO")} tegn.`);
  return v;
}
export function validerCv(inn){
  return { ...tomCv(), revisjon: revisjon(inn?.revisjon), tekst: tekst(inn?.tekst ?? "", 100000, "CV"), navn: tekst(inn?.navn ?? "", 255, "Filnavn"), format: ["pdf", "docx", "tekst", "txt"].includes(inn?.format) ? inn.format : "tekst", oppdatert: inn?.oppdatert ?? null };
}
export function validerBrev(id, inn){
  if(!inn || typeof inn !== "object") throw new Brevfeil("ugyldig", "Brevet mangler.");
  const d = { ...tomtBrev(id), revisjon: revisjon(inn.revisjon) };
  d.annonse = { tekst: tekst(inn.annonse?.tekst ?? "", 100000, "Annonse"), url: tekst(inn.annonse?.url ?? "", 2000, "Lenke"), hentet: inn.annonse?.hentet ?? null };
  if(d.annonse.url){
    let u; try{ u = new URL(d.annonse.url); }catch{}
    if(!u || !["http:", "https:"].includes(u.protocol)) throw new Brevfeil("ugyldig", "Annonselenken må begynne med http eller https.");
  }
  d.kontekst = tekst(inn.kontekst ?? "", 10000, "Ekstra kontekst");
  d.sprak = tekst(inn.sprak ?? "auto", 80, "Språk");
  if(!["anthropic", "openai"].includes(inn.leverandor)) throw new Brevfeil("ugyldig", "Velg Anthropic eller OpenAI.");
  d.leverandor = inn.leverandor;
  d.tekst = tekst(inn.tekst ?? "", 16000, "Søknadsbrev");
  if(!Array.isArray(inn.versjoner) || inn.versjoner.length > 100) throw new Brevfeil("ugyldig", "Brevet kan ha høyst 100 versjoner.");
  const ids = new Set();
  d.versjoner = inn.versjoner.map(v => {
    if(!v || typeof v !== "object" || typeof v.id !== "string" || ids.has(v.id)) throw new Brevfeil("ugyldig", "Ugyldig brevversjon.");
    jobbId(v.id); ids.add(v.id);
    tekst(v.tekst, 16000, "Brevversjon");
    if(v.grunnlag) {
      for(const [felt, maks] of [["cv",100000],["annonse",100000],["kontekst",10000]]) tekst(v.grunnlag[felt] ?? "",maks,felt);
    }
    return structuredClone(v);
  });
  d.aktivVersjon = inn.aktivVersjon ?? null;
  if(d.aktivVersjon !== null && !ids.has(d.aktivVersjon)) throw new Brevfeil("ugyldig", "Brevversjonen finnes ikke.");
  d.kjoring = inn.kjoring ? structuredClone(inn.kjoring) : null;
  d.oppdatert = inn.oppdatert ?? null;
  if(new TextEncoder().encode(JSON.stringify(d,null,2)).byteLength > MAKS_DOKUMENT) throw new Brevfeil("for-stort", "Brevhistorikken er for stor. Eksporter og rydd historikken først.", 413);
  return d;
}

/* harInnhold svarer på om en gjenoppretting fra sikkerhetskopi ville
   skrevet over noe. Et tømt dokument har revisjon, men ikke innhold. */
const TYPER = {
  cv: { skjema: SKJEMA, tom: () => tomCv(), valider: (navn, d) => validerCv(d), harInnhold: d => !!(d.tekst || d.navn) },
  brev: { skjema: SKJEMA, tom: navn => tomtBrev(dokumentId(navn)), valider: (navn, d) => validerBrev(dokumentId(navn), d),
    harInnhold: d => !!(d.tekst || d.annonse?.tekst || d.kontekst || d.versjoner?.length || d.kjoring) },
  jobb: { skjema: JOBB_SKJEMA, tom: navn => tomtJobbdokument(dokumentId(navn)), valider: (navn, d) => validerJobbdokument(dokumentId(navn), d),
    harInnhold: harJobbinnhold },
  radar: { skjema: RADAR_SKJEMA, tom: () => tomRadar(), valider: (navn, d) => validerRadar(d), harInnhold: harRadarinnhold }
};
function type(navn){ return TYPER[dokumenttype(dokumentnavn(navn))]; }
export const skjemaFor = navn => type(navn).skjema;
export const validerDokument = (navn, d) => type(navn).valider(navn, d);
export const harInnhold = (navn, d) => type(navn).harInnhold(d);
export function lesDokument(navn, rå){
  const t = type(navn);
  if(rå == null) return t.tom(navn);
  let d;
  try{ d = JSON.parse(rå); }catch{ throw new Brevfeil("odelagt", "Dokumentet kunne ikke leses. Originalen er bevart. Gjenopprett fra sikkerhetskopi.", 503); }
  if(d?.skjemaVersjon !== t.skjema) throw new Brevfeil("versjon", "Dokumentformatet støttes ikke av denne appversjonen.", 409);
  return t.valider(navn, d);
}
