/* Brevdata har eget lager. Jobblisten og dens format forblir små. */
export const SKJEMA = 1;
export const MAKS_DOKUMENT = 32 * 1024 * 1024;
export class Brevfeil extends Error {
  constructor(code, message, status = 400){ super(message); this.code = code; this.melding = message; this.status = status; }
}
export function jobbId(id){
  if(typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Brevfeil("ugyldig", "Ugyldig jobb.");
  return id;
}
export const brevfil = id => `brev-${jobbId(id)}.json`;
export function dokumentnavn(navn){
  if(navn !== "cv.json" && !/^brev-[A-Za-z0-9_-]{1,64}\.json$/.test(navn)) throw new Brevfeil("ugyldig", "Ugyldig dokumentnavn.");
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
export function revisjon(v){
  if(!Number.isSafeInteger(v) || v < 0) throw new Brevfeil("ugyldig", "Dokumentets revisjon mangler eller er ugyldig.");
  return v;
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
export function lesDokument(navn, rå){
  if(rå == null) return navn === "cv.json" ? tomCv() : tomtBrev(navn.slice(5,-5));
  let d;
  try{ d = JSON.parse(rå); }catch{ throw new Brevfeil("odelagt", "Dokumentet kunne ikke leses. Originalen er bevart. Gjenopprett fra sikkerhetskopi.", 503); }
  if(d?.skjemaVersjon !== SKJEMA) throw new Brevfeil("versjon", "Dokumentformatet støttes ikke av denne appversjonen.", 409);
  return navn === "cv.json" ? validerCv(d) : validerBrev(navn.slice(5,-5), d);
}
