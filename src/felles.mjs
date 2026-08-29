/* ============================================================
   Felles — delt mellom nettleseren og serveren.

   Én definisjon av statuser, sektorer og validering. Klienten
   validerer for rask tilbakemelding; serveren validerer på nytt
   fordi den ikke kan stole på klienten. Ingen Node- eller
   nettleser-spesifikke API-er her.
   ============================================================ */

export const STATUSER = {
  todo:      "Å søke på",
  sent:      "Sendt",
  interview: "Intervju",
  accepted:  "Videre",
  rejected:  "Avslag",
  trukket:   "Trukket",
  expired:   "Utløpt"
};

export const SEKTORER = {
  energi:     "Energi og industri",
  konsulent:  "Konsulent",
  finans:     "Finans",
  teknologi:  "Teknologi",
  studentorg: "Verv og studentorg",
  annet:      "Annet"
};

export const ER_SENDT = s => s === "sent" || s === "interview";
export const ER_ARKIV = s => s === "rejected" || s === "expired"
                          || s === "accepted" || s === "trukket";

/* Feltgrenser — holder filen lesbar og stopper utilsiktet svær input. */
export const MAKS = { selskap: 200, stilling: 200, sted: 200, notat: 1000, lenke: 2000, id: 64 };

/* ---------- små byggeklosser ---------- */

/* Ekte kalenderdato, ikke bare rett form: 2026-02-31 skal falle. */
export function erIsoDato(v){
  if(typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [a, m, d] = v.split("-").map(Number);
  const dt = new Date(a, m - 1, d);
  return dt.getFullYear() === a && dt.getMonth() === m - 1 && dt.getDate() === d;
}

export function erIsoTid(v){
  return typeof v === "string" && v !== "" && !Number.isNaN(Date.parse(v));
}

/* Lenker havner rett i href. Bare http og https slipper gjennom —
   ellers ville en javascript:-lenke fra innlimt markdown kunne kjøre. */
export function sjekkLenke(v){
  if(v == null) return { ok: true, verdi: "" };
  const s = String(v).trim();
  if(!s) return { ok: true, verdi: "" };
  if(s.length > MAKS.lenke) return { ok: false, melding: `Lenken er for lang (maks ${MAKS.lenke} tegn).` };
  let u;
  try{ u = new URL(s); }
  catch{ return { ok: false, melding: "Lenken må være en full nettadresse, f.eks. https://…" }; }
  if(u.protocol !== "http:" && u.protocol !== "https:")
    return { ok: false, melding: "Bare http- og https-lenker er tillatt." };
  return { ok: true, verdi: s };          /* lagrer originalen, ikke URL-normalisert form */
}

const tekst = v => (v == null ? "" : String(v)).trim();

/* ---------- én søknad ---------- */
/*
   Returnerer { ok, feil: [{felt, melding}], verdi }.
   `verdi` er en normalisert kopi med bare kjente felt — ukjente
   felt faller bort, så filen ikke fylles opp med rusk over tid.

   Merk: `sted` og `lenke` får være tomme. Ekte oppføringer i denne
   listen mangler begge (åpne/uoppgitte steder, verv uten utlysning),
   og å avvise dem ville gjort brukerens egne data ugyldige.
*/
export function validerSoknad(inn, valg = {}){
  const feil = [];
  const o = (inn && typeof inn === "object" && !Array.isArray(inn)) ? inn : null;
  if(!o){
    return { ok: false, feil: [{ felt: null, melding: "Søknaden må være et objekt." }], verdi: null };
  }

  const id = tekst(o.id);
  if(!id && !valg.lagId) feil.push({ felt: "id", melding: "Mangler id." });
  else if(id.length > MAKS.id) feil.push({ felt: "id", melding: "Id-en er for lang." });

  const selskap = tekst(o.selskap);
  if(!selskap) feil.push({ felt: "selskap", melding: "Skriv inn selskapet." });
  else if(selskap.length > MAKS.selskap) feil.push({ felt: "selskap", melding: `Maks ${MAKS.selskap} tegn.` });

  const stilling = tekst(o.stilling);
  if(!stilling) feil.push({ felt: "stilling", melding: "Skriv inn stillingen." });
  else if(stilling.length > MAKS.stilling) feil.push({ felt: "stilling", melding: `Maks ${MAKS.stilling} tegn.` });

  const sted = tekst(o.sted);
  if(sted.length > MAKS.sted) feil.push({ felt: "sted", melding: `Maks ${MAKS.sted} tegn.` });

  const notat = tekst(o.notat);
  if(notat.length > MAKS.notat) feil.push({ felt: "notat", melding: `Maks ${MAKS.notat} tegn.` });

  const l = sjekkLenke(o.lenke);
  if(!l.ok) feil.push({ felt: "lenke", melding: l.melding });

  let frist = o.frist;
  if(frist === "" || frist === undefined) frist = null;
  if(frist !== null && !erIsoDato(frist))
    feil.push({ felt: "frist", melding: "Fristen må være en gyldig dato (ÅÅÅÅ-MM-DD)." });

  let sendtDato = o.sendtDato;
  if(sendtDato === "" || sendtDato === undefined) sendtDato = null;
  if(sendtDato !== null && !erIsoDato(sendtDato))
    feil.push({ felt: "sendtDato", melding: "Sendt-datoen må være en gyldig dato (ÅÅÅÅ-MM-DD)." });

  const status = tekst(o.status) || "todo";
  if(!Object.hasOwn(STATUSER, status))
    feil.push({ felt: "status", melding: `Ukjent status «${status}».` });

  /* Sektor er en myk gruppering, ikke en livssyklustilstand:
     ukjente verdier havner i «annet» i stedet for å avvise raden. */
  const sektor = Object.hasOwn(SEKTORER, tekst(o.sektor)) ? tekst(o.sektor) : "annet";

  if(feil.length) return { ok: false, feil, verdi: null };

  return {
    ok: true,
    feil: [],
    verdi: {
      id: id || valg.lagId(),
      selskap, stilling,
      lenke: l.verdi,
      sted, frist, status, sektor, notat, sendtDato,
      opprettet: erIsoTid(o.opprettet) ? o.opprettet : null,
      oppdatert: erIsoTid(o.oppdatert) ? o.oppdatert : null
    }
  };
}

/* ---------- hele samlingen ---------- */
/*
   Beholder de gyldige radene og forkaster resten i stedet for å
   avvise alt — én ødelagt rad skal ikke gjøre hele filen ubrukelig.
   Duplikate id-er forkastes; den første vinner.
*/
export function validerSamling(liste, valg = {}){
  if(!Array.isArray(liste)){
    return { gyldige: [], forkastet: [{ indeks: null, feil: [{ felt: null, melding: "Forventet en liste med søknader." }] }] };
  }
  const gyldige = [], forkastet = [], sett = new Set();
  liste.forEach((rad, indeks) => {
    const r = validerSoknad(rad, valg);
    if(!r.ok){ forkastet.push({ indeks, feil: r.feil }); return; }
    if(sett.has(r.verdi.id)){
      forkastet.push({ indeks, feil: [{ felt: "id", melding: `Duplikat id «${r.verdi.id}».` }] });
      return;
    }
    sett.add(r.verdi.id);
    gyldige.push(r.verdi);
  });
  return { gyldige, forkastet };
}
