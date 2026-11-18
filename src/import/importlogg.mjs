import { FELT } from "./importlogikk.mjs";

export const LOGGFIL = "importlogg.jsonl";

export const MAKS_LINJER = 500;

const PRIS = { inn: 0.1, ut: 0.5 };

export const KURS = 11;

export function kroner({ inn = 0, ut = 0 }){
  return ((inn / 1e6) * PRIS.inn + (ut / 1e6) * PRIS.ut) * KURS;
}

export function lagLinje({ url, felt = [], bruk = null, tid = new Date() }){
  let vert = "";
  try{ vert = new URL(url).hostname.replace(/^www\./i, ""); }catch{}

  return {
    tid:    tid.toISOString(),
    vert,
    modell: felt.length > 0,
    felt:   felt.filter(f => FELT.includes(f)),
    inn:    Number(bruk?.input_tokens)  || 0,
    ut:     Number(bruk?.output_tokens) || 0
  };
}

export function tolkLogg(tekst){
  return String(tekst || "").split("\n")
    .map(l => l.trim()).filter(Boolean)
    .map(l => { try{ return JSON.parse(l); }catch{ return null; } })
    .filter(o => o && typeof o === "object" && typeof o.tid === "string");
}

export function leggTil(tekst, linje){
  const rader = tolkLogg(tekst);
  rader.push(linje);
  return rader.slice(-MAKS_LINJER).map(r => JSON.stringify(r)).join("\n") + "\n";
}

export function sammendrag(tekst){
  const rader = tolkLogg(tekst);
  if(!rader.length) return null;

  let inn = 0, ut = 0, medModell = 0;
  const perFelt = new Map();

  for(const r of rader){
    inn += Number(r.inn) || 0;
    ut  += Number(r.ut)  || 0;
    if(r.modell) medModell++;
    for(const f of Array.isArray(r.felt) ? r.felt : [])
      perFelt.set(f, (perFelt.get(f) || 0) + 1);
  }

  return {
    antall:      rader.length,
    utenModell:  rader.length - medModell,
    inn, ut,
    kroner:      kroner({ inn, ut }),
    snittKroner: kroner({ inn, ut }) / rader.length,
    felt:        [...perFelt.entries()].sort((a, b) => b[1] - a[1]),
    fra:         rader[0].tid
  };
}
