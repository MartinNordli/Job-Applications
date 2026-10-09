/* ============================================================
   Jobbdokumentene over brevlageret. HTTP-rutene og appen bruker
   denne, med hvert sitt lager under: server/brevlager.mjs i Node,
   brev_les/brev_skriv/dokument_utdrag i Rust.

   lagre() er grensesnittets vei inn, og den skriver annonsen. match
   og forberedelser beholdes fra det lagrede dokumentet, som kjoring
   i brevtjenesten: modellsvarene skrives bare gjennom endre(), av
   tjenestene som lager dem. Da kan en åpen fane med en eldre kopi
   aldri viske ut en vurdering som har kostet penger, og grensesnittet
   kan ikke lagre en vurdering ingen modell har gjort.

   endre() er mønsteret de tjenestene skal bruke: les, endre, skriv
   med forventet revisjon, og prøv igjen ved konflikt.
   ============================================================ */

import { Brevfeil, jobbfil } from "./brevdata.mjs";
import { validerJobbdokument } from "./jobbdokument.mjs";
import { tolkStier } from "./dokumentutdrag.mjs";

export function lagJobbdokumenter({ lager, hentJobb }){
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
      try{ return await lager.skriv(jobbfil(id), neste, d.revisjon); }
      catch(e){ if(e.code !== "konflikt" || i === 3) throw e; }
    }
  }

  async function gjenopprett(id){ return lager.gjenopprett(jobbfil(id)); }

  /* Ingen jobbsjekk: utdraget gjelder hele profilen, også dokumenter
     til søknader som er fjernet. Listen viser bare de den har. */
  async function utdrag(stier){ return lager.utdrag("jobb-", tolkStier(stier)); }

  return { hent, lagre, endre, gjenopprett, utdrag };
}
