export class Brevfeil extends Error {
  constructor(code, message, status = 400){ super(message); this.code = code; this.melding = message; this.status = status; }
}
export function revisjon(v){
  if(!Number.isSafeInteger(v) || v < 0) throw new Brevfeil("ugyldig", "Dokumentets revisjon mangler eller er ugyldig.");
  return v;
}
