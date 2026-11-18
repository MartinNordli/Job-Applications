import { Brevfeil, jobbfil, brevfil } from "../dokumenter/brevdata.mjs";
import { validerJobbdokument, validerAnnonse, normaliserAnnonse } from "./jobbdokument.mjs";
import { tolkStier } from "../dokumenter/dokumentutdrag.mjs";
import { erId } from "../dokumenter/dokumentnavn.mjs";
import { annonseFraSide, hentefeil } from "./annonsetekst.mjs";

const KLIENTKILDER = ["import", "limt", "radar"];

const harTekst = a => !!normaliserAnnonse(a?.tekst);
const erNettlenke = v => typeof v === "string" && /^https?:\/\//i.test(v.trim());

export function lagJobbdokumenter({ lager, hentJobb, hentJobber, hentSide, foranHenting, nå = () => new Date() }){
  async function sjekkJobb(id){
    const j = await hentJobb(id);
    if(!j) throw new Brevfeil("finnes-ikke", "Søknaden finnes ikke. Den kan være slettet i et annet vindu.", 404);
    return j;
  }
  const les = id => lager.les(jobbfil(id));

  async function hent(id){ await sjekkJobb(id); return les(id); }

  async function lagre(id, inn){
    await sjekkJobb(id);
    const d = validerJobbdokument(id, inn);
    const før = await les(id);
    d.match = før.match;
    d.forberedelser = før.forberedelser;
    return lager.skriv(jobbfil(id), d, d.revisjon);
  }

  async function endre(id, fn){
    for(let i = 0; i < 4; i++){
      const d = await les(id);
      const neste = await fn(structuredClone(d));
      if(neste === undefined) return d;
      try{ return await lager.skriv(jobbfil(id), neste, d.revisjon); }
      catch(e){ if(e.code !== "konflikt" || i === 3) throw e; }
    }
  }

  async function gjenopprett(id){ return lager.gjenopprett(jobbfil(id)); }

  async function utdrag(stier){ return lager.utdrag("jobb-", tolkStier(stier)); }

  async function skrivAnnonse(id, inn){
    const annonse = validerAnnonse(inn);
    if(!harTekst(annonse)) throw new Brevfeil("tom-annonse", "Lim inn teksten fra annonsen.");
    return endre(id, d => ({ ...d, annonse }));
  }

  async function settAnnonse(id, inn = {}){
    const j = await sjekkJobb(id);
    const kilde = inn?.kilde ?? "limt";
    if(!KLIENTKILDER.includes(kilde)) throw new Brevfeil("ugyldig", "Ukjent kilde for annonsen.");
    const url = inn.url || (erNettlenke(j.lenke) ? j.lenke.trim() : "");
    return skrivAnnonse(id, { tekst: inn.tekst, url, kilde, hentet: inn.hentet || nå().toISOString() });
  }
  const limInn = (id, tekst) => settAnnonse(id, { tekst, kilde: "limt" });

  async function hentAnnonse(id, { velg } = {}){
    const j = await sjekkJobb(id);
    if(!hentSide) throw new Brevfeil("ugyldig", "Henting er ikke satt opp her.", 500);
    const lenke = typeof j.lenke === "string" ? j.lenke.trim() : "";
    if(!lenke) throw new Brevfeil("mangler-lenke", "Søknaden har ingen lenke. Legg inn lenken eller lim inn annonsen.", 422);
    await foranHenting?.();
    let side;
    try{ side = await hentSide(lenke); }
    catch(e){
      if(e?.code === "utlogget") throw e;
      throw hentefeil(e);
    }
    const lest = annonseFraSide(side?.html);
    const tekst = typeof velg === "function" ? await velg(lest, j) : lest;
    const url = erNettlenke(side?.sluttUrl) ? side.sluttUrl : lenke;
    return skrivAnnonse(id, { tekst, url, kilde: "hentet", hentet: nå().toISOString() });
  }

  async function flyttFraBrev(id){
    const d = await hent(id);
    if(harTekst(d.annonse) || d.annonse.kilde) return { annonse: d.annonse, flyttet: false };
    let brev;
    try{ brev = await lager.les(brevfil(id)); }
    catch(e){ if(e?.code === "utlogget") throw e; return { annonse: d.annonse, flyttet: false }; }
    if(!harTekst(brev?.annonse)) return { annonse: d.annonse, flyttet: false };
    const annonse = validerAnnonse({ tekst: brev.annonse.tekst, url: erNettlenke(brev.annonse.url) ? brev.annonse.url : "",
      kilde: "brev", hentet: brev.annonse.hentet });
    let flyttet = false;
    const ny = await endre(id, x => {
      if(harTekst(x.annonse) || x.annonse.kilde) return undefined;
      flyttet = true;
      return { ...x, annonse };
    });
    return { annonse: ny.annonse, flyttet };
  }
  async function annonseFor(id){ return (await flyttFraBrev(id)).annonse; }

  async function hentManglende({ ider, signal } = {}){
    if(!hentJobber) throw new Brevfeil("ugyldig", "Listen er ikke satt opp her.", 500);
    const ønsket = ider ? new Set(ider) : null;
    const jobber = (await hentJobber()).filter(j => erId(j?.id) && (!ønsket || ønsket.has(j.id)));
    const ut = { hentet: [], fraBrev: [], hadde: 0, utenLenke: [], feilet: [], gjenstar: [], stoppet: null };
    for(const j of jobber){
      if(!ut.stoppet && signal?.aborted) ut.stoppet = "avbrutt";
      if(ut.stoppet){ ut.gjenstar.push(j.id); continue; }
      try{
        const f = await flyttFraBrev(j.id);
        if(f.flyttet){ ut.fraBrev.push(j.id); continue; }
        if(harTekst(f.annonse)){ ut.hadde++; continue; }
        if(!(typeof j.lenke === "string" && j.lenke.trim())){ ut.utenLenke.push(j.id); continue; }
        await hentAnnonse(j.id);
        ut.hentet.push(j.id);
      }catch(e){
        if(e?.code === "utlogget") throw e;
        if(e?.code === "for-mange"){ ut.stoppet = "for-mange"; ut.gjenstar.push(j.id); continue; }
        ut.feilet.push(e instanceof Brevfeil
          ? { id: j.id, feil: e.code, melding: e.melding }
          : { id: j.id, feil: "intern", melding: "Noe gikk galt med denne søknaden." });
      }
    }
    return ut;
  }

  async function slettForberedelse(id, iid){
    await sjekkJobb(id);
    if(!erId(iid)) throw new Brevfeil("ugyldig", "Ugyldig intervju.");
    return endre(id, d => {
      if(!Object.hasOwn(d.forberedelser ?? {}, iid)) return undefined;
      const { [iid]: _borte, ...resten } = d.forberedelser;
      return { ...d, forberedelser: resten };
    });
  }

  return { hent, lagre, endre, gjenopprett, utdrag, slettForberedelse, settAnnonse, limInn, hentAnnonse, annonseFor, hentManglende };
}
