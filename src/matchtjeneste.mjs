/* ============================================================
   Vurderingen av hvor godt en stilling passer, som tjeneste.

   Samme kjede i Node og i appen, med det som berører verden sendt
   inn: lager for CV-en, jobbdokumentene for annonsen og skrivingen,
   kallModell for modellen og foranKall for taket. Resultatet skrives
   med jobbdokumentets endre(), så en samtidig lagring av annonsen
   eller notatet ikke går tapt, og bare match-feltet endres.

   Grunnlaget (CV-revisjon, annonsens sjekksum, promptversjon)
   lagres sammen med svaret. En vurdering som allerede bygger på
   nøyaktig det som ligger der nå, brukes om igjen uten nytt kall,
   med mindre brukeren ber om det (tving). To kall for samme søknad
   samtidig deler ett modellkall.
   ============================================================ */
import { Brevfeil } from "./dokumentfeil.mjs";
import { MATCH_PROMPTVERSJON, matchForesporsel, tolkMatch } from "./matchlogikk.mjs";
import { LEVERANDORER } from "./jobbdokument.mjs";

export function lagMatchtjeneste({ lager, jobbdokumenter, kallModell, hentJobb, foranKall, nå = () => new Date() }){
  const pagar = new Map();

  async function kjor(jobbId, { tving, leverandor, signal }){
    const jobb = await hentJobb(jobbId);
    if(!jobb) throw new Brevfeil("finnes-ikke", "Søknaden finnes ikke. Den kan være slettet i et annet vindu.", 404);
    const cv = await lager.les("cv.json");
    if(!cv.tekst?.trim()) throw new Brevfeil("mangler-cv", "Legg inn CV-en din før stillingen kan vurderes.", 409);
    const annonse = await jobbdokumenter.annonseFor(jobbId);
    if(!annonse?.tekst?.trim()) throw new Brevfeil("mangler-annonse", "Lagre annonsen først. Vurderingen bygger på den.", 409);

    const dok = await jobbdokumenter.hent(jobbId);
    const m = dok.match;
    if(!tving && m && m.cvRevisjon === cv.revisjon && m.annonseSjekksum === (annonse.sjekksum ?? null)
      && m.promptversjon === MATCH_PROMPTVERSJON) return dok;

    foranKall?.();
    const svar = await kallModell({ ...matchForesporsel({ cv: cv.tekst.trim(), annonse: annonse.tekst.trim(), jobb, leverandor }), signal });
    const resultat = tolkMatch(svar?.data, { cv: cv.tekst.trim(), annonse: annonse.tekst.trim() });
    return jobbdokumenter.endre(jobbId, d => ({ ...d, match: {
      ...resultat, cvRevisjon: cv.revisjon, annonseSjekksum: annonse.sjekksum ?? null,
      promptversjon: MATCH_PROMPTVERSJON, leverandor, modell: String(svar?.modell ?? ""), bruk: svar?.bruk ?? undefined,
      vurdert: nå().toISOString() } }));
  }

  /* Gir hele jobbdokumentet med den nye vurderingen. */
  async function vurder(jobbId, { tving = false, leverandor = "anthropic", signal } = {}){
    if(!LEVERANDORER.includes(leverandor)) throw new Brevfeil("ugyldig", "Velg en støttet leverandør.");
    const nokkel = jobbId + ":" + leverandor;
    if(!tving && pagar.has(nokkel)) return pagar.get(nokkel);
    const p = kjor(jobbId, { tving, leverandor, signal }).finally(() => { if(pagar.get(nokkel) === p) pagar.delete(nokkel); });
    pagar.set(nokkel, p);
    return p;
  }
  return { vurder };
}
