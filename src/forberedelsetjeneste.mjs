/* ============================================================
   Intervjuforberedelsen som tjeneste.

   Samme kjede i Node og i appen som matchtjenesten, med det som
   berører verden sendt inn: lager for CV-en og brevet, jobbdokumentene
   for annonsen og skrivingen, kallModell for modellen og foranKall for
   taket (30 i timen per profil i Node). Resultatet skrives med
   jobbdokumentets endre() i forberedelser[<intervju-id>], så en
   samtidig lagring av annonsen eller en vurdering ikke går tapt.

   Grunnlaget (CV-revisjon, annonsens sjekksum, aktiv brevversjon,
   promptversjon) lagres sammen med svaret. En forberedelse som
   allerede bygger på nøyaktig det som ligger der nå, brukes om igjen
   uten nytt kall, med mindre brukeren ber om det (tving). To kall for
   samme intervju samtidig deler ett modellkall.

   Brevet er en valgfri kilde: bare den aktive versjonen brukes, og
   har søknaden ikke noe aktivt brev, forberedes det uten.
   ============================================================ */
import { Brevfeil, brevfil } from "./brevdata.mjs";
import { FORBEREDELSE_PROMPTVERSJON, forberedelseForesporsel, tolkForberedelse } from "./forberedelse.mjs";
import { LEVERANDORER, forberedelseUtdatert } from "./jobbdokument.mjs";
import { erId } from "./dokumentnavn.mjs";
import { validerIntervjuer } from "./felles.mjs";

export function lagForberedelsetjeneste({ lager, jobbdokumenter, kallModell, hentJobb, foranKall, nå = () => new Date() }){
  const pagar = new Map();

  /* Teksten og id-en til den aktive brevversjonen, eller tomt. Et brev
     som ikke kan leses, hindrer ikke forberedelsen. */
  async function aktivtBrev(jobbId){
    try{
      const b = await lager.les(brevfil(jobbId));
      const v = b?.aktivVersjon ? (b.versjoner ?? []).find(x => x.id === b.aktivVersjon) : null;
      return v && typeof v.tekst === "string" && v.tekst.trim() ? { tekst: v.tekst.trim(), versjonId: v.id } : { tekst: "", versjonId: null };
    }catch(e){
      if(e?.code === "utlogget") throw e;
      return { tekst: "", versjonId: null };
    }
  }

  async function kjor(jobbId, iid, { tving, leverandor, signal }){
    const jobb = await hentJobb(jobbId);
    if(!jobb) throw new Brevfeil("finnes-ikke", "Søknaden finnes ikke. Den kan være slettet i et annet vindu.", 404);
    const intervju = validerIntervjuer(jobb.intervjuer).find(i => i.id === iid);
    if(!intervju) throw new Brevfeil("finnes-ikke", "Intervjuet finnes ikke. Det kan være slettet i et annet vindu.", 404);
    const cv = await lager.les("cv.json");
    if(!cv.tekst?.trim()) throw new Brevfeil("mangler-cv", "Legg inn CV-en din før du forbereder intervjuet.", 409);
    const annonse = await jobbdokumenter.annonseFor(jobbId);
    if(!annonse?.tekst?.trim()) throw new Brevfeil("mangler-annonse", "Lagre annonsen først. Forberedelsen bygger på den.", 409);
    const brev = await aktivtBrev(jobbId);

    const dok = await jobbdokumenter.hent(jobbId);
    const grunnlag = { cvRevisjon: cv.revisjon, promptversjon: FORBEREDELSE_PROMPTVERSJON, brevVersjonId: brev.versjonId };
    if(!tving && Object.hasOwn(dok.forberedelser ?? {}, iid) && !forberedelseUtdatert(dok, iid, grunnlag).length) return dok;

    foranKall?.();
    const tekster = { cv: cv.tekst.trim(), annonse: annonse.tekst.trim(), brev: brev.tekst };
    const svar = await kallModell({ ...forberedelseForesporsel({ ...tekster, jobb, intervju, leverandor }), signal });
    const resultat = tolkForberedelse(svar?.data, tekster);
    return jobbdokumenter.endre(jobbId, d => ({ ...d, forberedelser: { ...d.forberedelser, [iid]: {
      ...resultat, cvRevisjon: cv.revisjon, annonseSjekksum: annonse.sjekksum ?? null, brevVersjonId: brev.versjonId,
      promptversjon: FORBEREDELSE_PROMPTVERSJON, leverandor, modell: String(svar?.modell ?? ""), bruk: svar?.bruk ?? undefined,
      laget: nå().toISOString() } } }));
  }

  /* Gir hele jobbdokumentet med den nye forberedelsen. */
  async function lag(jobbId, iid, { tving = false, leverandor = "anthropic", signal } = {}){
    if(!LEVERANDORER.includes(leverandor)) throw new Brevfeil("ugyldig", "Velg en støttet leverandør.");
    if(!erId(iid)) throw new Brevfeil("ugyldig", "Ugyldig intervju.");
    const nokkel = `${jobbId}:${iid}:${leverandor}`;
    if(!tving && pagar.has(nokkel)) return pagar.get(nokkel);
    const p = kjor(jobbId, iid, { tving, leverandor, signal }).finally(() => { if(pagar.get(nokkel) === p) pagar.delete(nokkel); });
    pagar.set(nokkel, p);
    return p;
  }

  const slett = (jobbId, iid) => jobbdokumenter.slettForberedelse(jobbId, iid);
  return { lag, slett };
}
