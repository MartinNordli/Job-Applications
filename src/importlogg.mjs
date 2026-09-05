/* ============================================================
   Importloggen — hva importen har kostet, uten I/O.

   Tre tall, og ikke flere: hva den har kostet, hvor ofte modellen
   slapp å kjøre, og hvilke felt modellen måtte fylle. Det siste er
   det eneste som er handlingsrettet — står «selskap» øverst lenge,
   er et selskapsuttrekk neste ting å skrive.

   Loggen bærer vertsnavn, ikke hele adressen. Hvilke stillinger du
   har sett på står allerede i jobber.json; loggen trenger bare å
   vite hva slags side det var.
   ============================================================ */

import { FELT } from "./importlogikk.mjs";

export const LOGGFIL = "importlogg.jsonl";

/* Nok til flere år med import, lite nok til å leses i én jafs. */
export const MAKS_LINJER = 500;

/* Claude Haiku 4.5, dollar per million tokens. Et øyeblikksbilde —
   endrer prisen seg, er det denne linjen som skal rettes. */
export const PRIS = { inn: 1, ut: 5 };

/* Omtrentlig, og med vilje ikke hentet fra nettet: tallet skal være
   det samme i morgen, og en valutakurs på fire desimaler ville gitt
   et inntrykk av presisjon som ikke finnes. */
export const KURS = 11;

export function kroner({ inn = 0, ut = 0 }){
  return ((inn / 1e6) * PRIS.inn + (ut / 1e6) * PRIS.ut) * KURS;
}

/* ---------- én linje ---------- */

export function lagLinje({ url, felt = [], bruk = null, tid = new Date() }){
  let vert = "";
  try{ vert = new URL(url).hostname.replace(/^www\./i, ""); }catch{ /* uten vert er linjen fortsatt nyttig */ }

  return {
    tid:    tid.toISOString(),
    vert,
    modell: felt.length > 0,
    felt:   felt.filter(f => FELT.includes(f)),
    inn:    Number(bruk?.input_tokens)  || 0,
    ut:     Number(bruk?.output_tokens) || 0
  };
}

/* JSONL: én linje per import, så en halvskrevet linje bare koster
   den ene raden — ikke hele loggen. Ødelagte linjer hoppes over. */
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

/* ---------- de tre tallene ---------- */

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
    /* Snittet regnes over alle importer, ikke bare de som kostet noe:
       det er den prisen en import faktisk har i praksis. */
    snittKroner: kroner({ inn, ut }) / rader.length,
    felt:        [...perFelt.entries()].sort((a, b) => b[1] - a[1]),
    fra:         rader[0].tid
  };
}
