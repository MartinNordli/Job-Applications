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
  energi:     "Energi",
  industri:   "Industri og produksjon",
  konsulent:  "Konsulent",
  finans:     "Finans",
  teknologi:  "Teknologi",
  offentlig:  "Offentlig sektor",
  studentorg: "Verv og studentorg",
  annet:      "Annet"
};

/* Hva slags stilling utlysningen gjelder. Myk som sektor, og valgfri:
   de fleste radene i listen har den ikke, og skal ikke tvinges til å få den. */
export const JOBBTYPER = {
  graduate:   "Graduate",
  internship: "Internship",
  fulltid:    "Fast stilling",
  deltid:     "Deltid"
};

/* Selskaper vi allerede vet sektoren for. Limemodus har brukt denne
   siden appen var én fil; importen fra lenke bruker den til å slippe
   å be modellen klassifisere et selskap brukeren kjenner fra før.
   Nøklene er små bokstaver — oppslaget er eksakt, ikke uklart. */
export const SEKTOR_FOR = {
  "aker bp":"energi","equinor":"energi","statnett":"energi","dnv":"energi",
  "kongsberg":"energi","norconsult":"energi",
  "cognite":"teknologi","autodesk":"teknologi","visma":"teknologi","intility":"teknologi",
  "nbim":"finans","dnb":"finans",
  "mckinsey":"konsulent","bain":"konsulent","accenture":"konsulent","deloitte":"konsulent",
  "kpmg":"konsulent","bearingpoint":"konsulent","capgemini":"konsulent","sopra steria":"konsulent",
  "bouvet":"konsulent","bekk":"konsulent","implement consulting":"konsulent","sprint":"konsulent",
  "pwc":"konsulent","jr consulting":"studentorg",
  "ntnui tennis":"studentorg","cogito ntnu":"studentorg","revolve ntnu":"studentorg","njord ntnu":"studentorg"
};

export const ER_SENDT = s => s === "sent" || s === "interview";
export const FIKK_INTERVJU = s => s === "interview" || s === "accepted";
export const ER_ARKIV = s => s === "rejected" || s === "expired"
                          || s === "accepted" || s === "trukket";

/* Feltgrenser — holder filen lesbar og stopper utilsiktet svær input. */
export const MAKS = { selskap: 200, stilling: 200, sted: 200, notat: 1000, lenke: 2000, id: 64 };

/* Hvem som la inn en hendelse. «lager» er sikkerhetsnettet i
   lagerlogikk.mjs, som merker statusskift klienten ikke loggførte. */
export const HENDELSE_KILDER = ["bruker", "lager", "radar"];

/* Hele listen skrives ved hver lagring, så taket holder raden liten.
   60 statusskift på én søknad er langt over det noen faktisk gjør. */
export const MAKS_HENDELSER = 60;

export const INTERVJUTYPER = {
  fysisk:  "Fysisk",
  video:   "Video",
  telefon: "Telefon"
};
export const MAKS_INTERVJU = { antall: 20, varighet: 600, sted: 200, runde: 80, notat: 1000 };

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

/* Datoer kommer i tre former utenfra, og skal ut i én.

   schema.org sender `validThrough` som fullt tidsstempel
   («2026-09-13T23:59:00+02:00»), som erIsoDato forkaster. Norske
   annonser skriver «13.09.2026», og notatlinjer bare «13.09». Alt
   annet — «snarest», «løpende» — er ikke en dato og blir null.

   Året gjettes bare når det mangler: en dag som ligger mer enn 60
   dager bak oss hører til neste år. Samme regel som limemodus. */
export function normaliserIsoDato(v, iDag = new Date()){
  const s = tekst(v);
  if(!s) return null;

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/);
  if(iso){
    const d = `${iso[1]}-${iso[2]}-${iso[3]}`;
    return erIsoDato(d) ? d : null;
  }

  const norsk = s.match(/^(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?\.?$/);
  if(norsk){
    const dag = Number(norsk[1]), mnd = Number(norsk[2]);
    let aar;
    if(norsk[3]){
      aar = Number(norsk[3]);
      if(aar < 100) aar += 2000;
    }else{
      aar = iDag.getFullYear();
      const kandidat = new Date(aar, mnd - 1, dag);
      if((iDag - kandidat) / 86400000 > 60) aar += 1;
    }
    const d = `${aar}-${String(mnd).padStart(2, "0")}-${String(dag).padStart(2, "0")}`;
    return erIsoDato(d) ? d : null;
  }

  return null;
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
const erObjekt = v => !!v && typeof v === "object" && !Array.isArray(v);

/* ---------- hendelser ---------- */
/*
   Statusloggen på en søknad: [{ til, dato, tid?, kilde? }].

   Tilgivende som sektor, fordi loggen er historikk og ikke noe brukeren
   skriver inn: en oppføring vi ikke forstår droppes, og resten av raden
   lagres som før. Å avvise hele raden for én rar hendelse ville gjort
   brukerens egne søknader ulagrelige.

   `tid` sjekkes strengere enn erIsoTid, fordi Date.parse godtar «1» og
   annet rusk. Er tiden ugyldig, mister hendelsen bare tiden, ikke datoen.
*/
const ISO_TIDSPUNKT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function renHendelse(h){
  if(!erObjekt(h)) return null;
  const til = tekst(h.til);
  if(!Object.hasOwn(STATUSER, til) || !erIsoDato(h.dato)) return null;
  const ut = { til, dato: h.dato };
  if(typeof h.tid === "string" && ISO_TIDSPUNKT.test(h.tid) && !Number.isNaN(Date.parse(h.tid)))
    ut.tid = h.tid;
  if(HENDELSE_KILDER.includes(h.kilde)) ut.kilde = h.kilde;
  return ut;
}

/* Sortert på dato og så tid. Tidene sammenlignes som tidspunkt, ikke
   som tekst, fordi to klokker kan skrive med ulik sone. Uten tid står
   hendelsen først den dagen. Sorteringen er stabil, så to like holder
   rekkefølgen de kom i. */
const tidsverdi = h => (h.tid ? Date.parse(h.tid) : -Infinity);
export function sorterHendelser(liste){
  return liste.slice().sort((a, b) =>
    a.dato < b.dato ? -1 : a.dato > b.dato ? 1 : tidsverdi(a) - tidsverdi(b));
}

/* Går listen over taket, beholdes den første hendelsen (da søknaden ble
   lagt til) og de nyeste. Midten er den minst nyttige delen av loggen. */
export function validerHendelser(inn){
  if(!Array.isArray(inn)) return [];
  const rene = sorterHendelser(inn.map(renHendelse).filter(Boolean));
  if(rene.length <= MAKS_HENDELSER) return rene;
  return [rene[0], ...rene.slice(rene.length - (MAKS_HENDELSER - 1))];
}

/* ---------- intervjuer ---------- */
/*
   Ett intervju: { id, dato, tid, varighet, sted, type, lenke, runde, notat }.
   validerIntervju er streng og gir meldinger, til skjemaet som legger
   inn et intervju. validerIntervjuer er listeversjonen på raden, og den
   er tilgivende: et intervju som ikke består droppes, resten blir med.
*/
export function validerIntervju(inn){
  const feil = [];
  if(!erObjekt(inn))
    return { ok: false, feil: [{ felt: null, melding: "Intervjuet må være et objekt." }], verdi: null };

  const id = tekst(inn.id);
  if(!/^[A-Za-z0-9_-]{1,32}$/.test(id)) feil.push({ felt: "id", melding: "Intervjuet mangler en gyldig id." });

  if(!erIsoDato(inn.dato)) feil.push({ felt: "dato", melding: "Velg en gyldig dato for intervjuet." });

  let tid = inn.tid;
  if(tid === "" || tid === undefined) tid = null;
  if(tid !== null && !(typeof tid === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(tid)))
    feil.push({ felt: "tid", melding: "Skriv klokkeslettet som TT:MM." });

  let varighet = inn.varighet;
  if(varighet === "" || varighet === undefined) varighet = null;
  if(typeof varighet === "string" && /^\d{1,4}$/.test(varighet)) varighet = Number(varighet);
  if(varighet !== null && !(Number.isInteger(varighet) && varighet > 0 && varighet <= MAKS_INTERVJU.varighet))
    feil.push({ felt: "varighet", melding: `Varigheten må være hele minutter, høyst ${MAKS_INTERVJU.varighet}.` });

  const sted = tekst(inn.sted);
  if(sted.length > MAKS_INTERVJU.sted) feil.push({ felt: "sted", melding: `Maks ${MAKS_INTERVJU.sted} tegn.` });

  const runde = tekst(inn.runde);
  if(runde.length > MAKS_INTERVJU.runde) feil.push({ felt: "runde", melding: `Maks ${MAKS_INTERVJU.runde} tegn.` });

  const notat = tekst(inn.notat);
  if(notat.length > MAKS_INTERVJU.notat) feil.push({ felt: "notat", melding: `Maks ${MAKS_INTERVJU.notat} tegn.` });

  const l = sjekkLenke(inn.lenke);
  if(!l.ok) feil.push({ felt: "lenke", melding: l.melding });

  /* Mild som jobbtype: ukjent type blir tom, ikke en feil. */
  const type = Object.hasOwn(INTERVJUTYPER, tekst(inn.type)) ? tekst(inn.type) : "";

  if(feil.length) return { ok: false, feil, verdi: null };
  return { ok: true, feil: [],
           verdi: { id, dato: inn.dato, tid, varighet, sted, type, lenke: l.verdi, runde, notat } };
}

/* Sortert på dato og klokkeslett. Over taket beholdes de 20 seneste,
   fordi det er de kommende intervjuene varslene trenger. */
export function validerIntervjuer(inn){
  if(!Array.isArray(inn)) return [];
  const sett = new Set(), rene = [];
  for(const i of inn){
    const r = validerIntervju(i);
    if(!r.ok || sett.has(r.verdi.id)) continue;
    sett.add(r.verdi.id);
    rene.push(r.verdi);
  }
  rene.sort((a, b) => a.dato < b.dato ? -1 : a.dato > b.dato ? 1
                    : (a.tid ?? "") < (b.tid ?? "") ? -1 : (a.tid ?? "") > (b.tid ?? "") ? 1 : 0);
  return rene.slice(Math.max(0, rene.length - MAKS_INTERVJU.antall));
}

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

  /* Id-en havner rett inn i data-id="…" i en mengde maler. Å begrense
     tegnsettet her er sikrere enn å escape den ti steder. */
  const id = tekst(o.id);
  if(!id && !valg.lagId) feil.push({ felt: "id", melding: "Mangler id." });
  else if(id && !/^[A-Za-z0-9_-]{1,64}$/.test(id))
    feil.push({ felt: "id", melding: "Id-en kan bare inneholde bokstaver, tall, bindestrek og understrek." });

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

  /* Samme mildhet, men med tomt som gyldig hvilested: en søknad uten
     kjent jobbtype er helt vanlig, og «annet» ville løyet. */
  const jobbtype = Object.hasOwn(JOBBTYPER, tekst(o.jobbtype)) ? tekst(o.jobbtype) : "";

  /* Om søknaden noen gang ga intervju. Statusen sier bare hvor den står
     nå, og et avslag etter intervjuet ville ellers slettet sporet av det.
     Står den på intervju eller videre, har den åpenbart fått et. */
  const intervju = o.intervju === true || FIKK_INTERVJU(status);

  /* Begge listene er tilgivende: rusk i dem koster oppføringen, ikke raden. */
  const hendelser  = validerHendelser(o.hendelser);
  const intervjuer = validerIntervjuer(o.intervjuer);

  if(feil.length) return { ok: false, feil, verdi: null };

  return {
    ok: true,
    feil: [],
    verdi: {
      id: id || valg.lagId(),
      selskap, stilling,
      lenke: l.verdi,
      sted, frist, status, sektor, jobbtype, notat, sendtDato, intervju,
      hendelser, intervjuer,
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
