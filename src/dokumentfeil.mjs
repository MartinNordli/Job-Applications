/* Feiltypen og revisjonsregelen alle profildokumentene deler. Egen fil
   fordi brevdata.mjs velger validator etter dokumenttype og dermed
   importerer jobbdokument.mjs. Lå feilen i brevdata.mjs, ville de to
   importert hverandre, og da avgjør lasterekkefølgen om en klasse
   finnes ennå. Brevfeil eksporteres videre fra brevdata.mjs som før. */
export class Brevfeil extends Error {
  constructor(code, message, status = 400){ super(message); this.code = code; this.melding = message; this.status = status; }
}
export function revisjon(v){
  if(!Number.isSafeInteger(v) || v < 0) throw new Brevfeil("ugyldig", "Dokumentets revisjon mangler eller er ugyldig.");
  return v;
}
