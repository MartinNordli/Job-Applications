/* ============================================================
   Intervju-fanen i detaljpanelet.

   Intervjuene står som rader i samme form som listen: en smal
   datokolonne i mono, klokkeslettet, og hva slags intervju det er.
   Kommende står først, tidligst først, og de tidligere under dem,
   nyeste først og dempet. Én rad er åpen om gangen; den åpne står på
   et innfelt spor og bærer detaljene, handlingene og forberedelsen.
   Uten valg er det neste intervju som står åpent.

   Skjemaet for å legge inn og endre tar hele flaten mens det står, som
   innlimingen i Annonse-fanen. Reglene er intervjuer.mjs sine:
   skjemaet sender feltene inn og viser meldingene som kommer tilbake.
   Raden lagres av app.js (api.endreIntervjuer), som også gir angre.

   Forberedelsen er et modellkall som tar tid og koster penger. Den
   startes bare av knappen, og en lagret forberedelse vises fra
   jobbdokumentet uten nytt kall. Kallet hører til modulen, ikke til
   flaten: bytter man fane eller søknad mens det går, står fremdriften
   der igjen når man kommer tilbake, og svaret lagres uansett.
   ============================================================ */

import * as Jobbdokumenter from "./jobbdokumenter.js";
import * as Brev from "./brev.js";
import * as Økt from "./okt.js";
import { eksporterIcs } from "./brev-dokumenter.mjs";
import { nyttIntervju, endreIntervju, slettIntervju, starttid, kommende } from "./intervjuer.mjs";
import { INTERVJUTYPER, MAKS_INTERVJU, validerIntervjuer } from "./felles.mjs";
import { FORBEREDELSE_PROMPTVERSJON } from "./forberedelse.mjs";
import { forberedelseUtdatert } from "./jobbdokument.mjs";
import { esc, ukedag, MND_K, tilDato, tilIso, dagerTil, omTekst, datoMedÅr, vert } from "./formater.js";

const STANDARD_VARIGHET = 60;
const KILDENAVN = { cv: "CV-en", annonse: "annonsen", brev: "brevet" };
const UTDATERT_GRUNN = {
  cvRevisjon: "CV-en er endret siden forberedelsen.",
  annonseSjekksum: "Annonsen er endret siden forberedelsen.",
  brevVersjonId: "Brevet er endret siden forberedelsen.",
  promptversjon: "Forberedelsen er laget med en eldre metode."
};
const STEDHINT = {
  fysisk: "Adresse, etasje eller rom",
  video: "Teams, Zoom, Meet eller annet",
  telefon: "Hvem ringer hvem, og hvilket nummer",
  "": "Adresse eller plattform"
};

/* Kallene som går, og feilene fra siste forsøk, per «søknad:intervju». */
const PÅGÅR = new Map();      /* nøkkel -> { start, løfte } */
const FEIL = new Map();       /* nøkkel -> feilen */
/* Hvilket intervju som sto åpent per søknad, så det står åpent igjen når
   man kommer tilbake til fanen, og et kall som går, ikke blir skjult. */
const ÅPEN = new Map();
const nøkkel = (id, iid) => id + ":" + iid;

/* ---------- små hjelpere ---------- */

const pad = n => String(n).padStart(2, "0");
const liste = jobb => validerIntervjuer(jobb?.intervjuer);

/* Slutten som «HH:MM». Går den over midnatt, står klokkeslettet neste døgn. */
function slutt(i){
  if(!i.tid) return null;
  const [t, m] = i.tid.split(":").map(Number);
  const min = (t * 60 + m + (i.varighet ?? STANDARD_VARIGHET)) % 1440;
  return pad(Math.floor(min / 60)) + ":" + pad(min % 60);
}
function varighetTekst(min){
  if(!min) return "";
  const t = Math.floor(min / 60), m = min % 60;
  return (t ? t + " t" : "") + (t && m ? " " : "") + (m ? m + " min" : "");
}
const pågårNå = (i, nå) => {
  const s = starttid(i);
  return !!s && s <= nå && s.getTime() + (i.varighet ?? STANDARD_VARIGHET) * 60000 > nå.getTime();
};
/* Det som står til høyre i raden. Et intervju som pågår, sier det. */
const når = (i, iDag, nå) => (pågårNå(i, nå) ? "pågår" : omTekst(i.dato, iDag));
/* «Video, andre runde» i raden; tomt når ingen av delene er fylt ut. */
const hva = i => [INTERVJUTYPER[i.type], i.runde].filter(Boolean).join(", ");

/* Leverandøren brukeren sist valgte i brevskriveren. Samme nøkkel som
   brevflaten og jobbdokumenter.js leser, så nøkkelsjekken her gjelder
   den modellen kallet faktisk går til. */
function valgtLeverandør(){
  try{
    const profil = Økt.nåværendeBruker()?.id;
    return profil && localStorage.getItem("jobbsoknader-brev-leverandor-" + profil) === "openai" ? "openai" : "anthropic";
  }catch{ return "anthropic"; }
}

/* Merket i fanelisten: når neste intervju er, eller ingenting. */
export function intervjuMerke(jobb, iDag){
  const i = kommende(jobb)[0];
  if(!i) return null;
  const d = dagerTil(i.dato, iDag);
  const tekst = d <= 0 ? "i dag" : d === 1 ? "i morgen" : datoMedÅr(i.dato, iDag);
  return { tekst, sr: "neste " + tekst };
}

/* ---------- fanen ---------- */

export function monterIntervju(flate, ktx, api){
  let k = ktx;
  let ryddet = false;
  /* null, { ny: true } eller { iid } mens skjemaet står */
  let skjema = ktx.hensikt === "ny" ? { ny: true } : null;
  let skjemaFeil = [];
  /* id-en som står åpen, null for ingen, undefined for det neste */
  let åpen = ÅPEN.get(ktx.jobb.id);
  let bekrefter = null;         /* intervjuet som venter på bekreftet sletting */
  let manglerFor = null;        /* intervjuet der «Lag på nytt» ble trykket mens noe manglet */
  let grunnlag = null;          /* { harCv, cvRevisjon, harNøkkel, brevVersjonId } */
  const åpneSpørsmål = new Set();
  let klokke = null;

  const id = () => k.jobb.id;
  const settÅpen = v => { åpen = v; if(v === undefined) ÅPEN.delete(id()); else ÅPEN.set(id(), v); };
  const alle = () => liste(k.jobb);
  const finn = iid => alle().find(i => i.id === iid) || null;
  const harAnnonse = () => !!k.dok?.annonse?.tekst?.trim();
  const forberedelse = iid => (Object.hasOwn(k.dok?.forberedelser ?? {}, iid) ? k.dok.forberedelser[iid] : null);

  /* Det forberedelsen bygger på, hentet én gang per montering. Feiler et
     oppslag, er svaret ukjent (null), og knappen står som vanlig: kallet
     sier selv fra om noe mangler. */
  async function lastGrunnlag(){
    const hvem = id();
    const [cv, nøkkelen, brev] = await Promise.allSettled([Brev.hentCv(), Brev.nokkelStatus(valgtLeverandør()), Brev.hentBrev(hvem)]);
    if(ryddet || hvem !== id()) return;
    const b = brev.status === "fulfilled" ? brev.value : null;
    const v = b?.aktivVersjon ? (b.versjoner ?? []).find(x => x.id === b.aktivVersjon) : null;
    grunnlag = {
      harCv: cv.status === "fulfilled" ? !!cv.value?.tekst?.trim() : null,
      cvRevisjon: cv.status === "fulfilled" ? cv.value?.revisjon : undefined,
      harNøkkel: nøkkelen.status === "fulfilled" ? !!nøkkelen.value?.finnes : null,
      brevVersjonId: b ? (v && typeof v.tekst === "string" && v.tekst.trim() ? v.id : null) : undefined
    };
    tegn();
  }

  /* Hvilket intervju som står åpent: valget, ellers det neste, ellers
     det siste som har vært. */
  function åpentIntervju(){
    const ivs = alle();
    if(åpen === null) return null;
    if(åpen && ivs.some(i => i.id === åpen)) return åpen;
    const neste = kommende(k.jobb)[0];
    return neste ? neste.id : ivs.length ? ivs[ivs.length - 1].id : null;
  }

  /* ---------- tegning ---------- */

  function radHtml(i, { tidligere, erÅpen }){
    const nå = new Date();
    const d = tilDato(i.dato);
    const s = slutt(i);
    const tid = i.tid
      ? '<span class="iv__tid">' + esc(i.tid) + (i.varighet ? '<span class="iv__slutt">–' + esc(s) + '</span>' : "") + '</span>'
      : '<span class="iv__tid iv__tid--uten">Uten klokkeslett</span>';
    const h = hva(i);
    const om = når(i, k.iDag, nå);
    const kroppId = "iv-" + i.id;
    return '<li class="iv' + (tidligere ? " iv--tidligere" : "") + (erÅpen ? " er-apen" : "") + '" data-iid="' + esc(i.id) + '"'
        + (pågårNå(i, nå) ? ' data-pagar="true"' : "") + '>'
      + '<h4 class="iv__overskrift"><button class="iv__hode" type="button" data-iv="apne" data-iid="' + esc(i.id) + '"'
        + ' aria-expanded="' + erÅpen + '" aria-controls="' + kroppId + '">'
        + '<span class="iv__dato" aria-hidden="true"><span class="iv__ukedag">' + esc(ukedag(i.dato).slice(0, 2)) + '</span>'
          + '<span class="iv__dag">' + pad(d.getDate()) + " " + MND_K[d.getMonth()] + '</span></span>'
        + '<span class="skjult">' + esc(ukedag(i.dato) + " " + datoMedÅr(i.dato, k.iDag)) + ', </span>'
        + '<span class="iv__hvem">' + tid + (h ? '<span class="iv__hva">' + esc(h) + '</span>' : "") + '</span>'
        + '<span class="iv__om">' + esc(om) + '</span>'
      + '</button></h4>'
      + (erÅpen ? '<div class="iv__kropp" id="' + kroppId + '">' + kroppHtml(i) + '</div>' : "")
      + '</li>';
  }

  function kroppHtml(i){
    const fakta = [];
    if(i.sted) fakta.push(["Sted", esc(i.sted)]);
    if(i.lenke){
      const v = vert(i.lenke) || i.lenke;
      fakta.push(["Lenke", '<a class="iv__lenke" href="' + esc(i.lenke) + '" target="_blank" rel="noopener noreferrer">'
        + esc(v) + '<span class="iv__pil" aria-hidden="true">↗</span><span class="skjult"> (åpnes i ny fane)</span></a>']);
    }
    if(i.varighet) fakta.push(["Varighet", '<span class="iv__tall">' + esc(varighetTekst(i.varighet)) + '</span>']);
    if(i.notat) fakta.push(["Notat", '<span class="iv__notat">' + esc(i.notat) + '</span>']);
    const sletter = bekrefter === i.id;
    return (fakta.length ? '<dl class="iv__fakta">' + fakta.map(([t, v]) => '<dt>' + t + '</dt><dd>' + v + '</dd>').join("") + '</dl>' : "")
      + (sletter
        ? '<div class="iv__bekreft" role="group" aria-labelledby="ivBekreft-' + esc(i.id) + '">'
          + '<p id="ivBekreft-' + esc(i.id) + '">Slette intervjuet og forberedelsen? Forberedelsen kan ikke hentes tilbake.</p>'
          + '<div class="detalj__handlinger">'
            + '<button class="knapp knapp--liten iv__bekreftknapp" type="button" data-iv="bekreft-slett" data-iid="' + esc(i.id) + '">Slett begge</button>'
            + '<button class="knapp knapp--liten knapp--stille" type="button" data-iv="avbryt-slett" data-iid="' + esc(i.id) + '">Behold</button>'
          + '</div></div>'
        : '<div class="iv__handlinger">'
          + '<button class="knapp knapp--liten knapp--stille" type="button" data-iv="kalender" data-iid="' + esc(i.id) + '">Legg i kalender</button>'
          + '<button class="knapp knapp--liten knapp--stille" type="button" data-iv="endre" data-iid="' + esc(i.id) + '">Endre</button>'
          + '<button class="knapp knapp--liten knapp--stille iv__slett" type="button" data-iv="slett" data-iid="' + esc(i.id) + '">Slett</button>'
          + '</div>')
      + forberedelseHtml(i);
  }

  /* ---------- forberedelsen ---------- */

  function forberedelseHtml(i){
    const n = nøkkel(id(), i.id);
    const går = PÅGÅR.get(n);
    const f = forberedelse(i.id);
    const feil = FEIL.get(n);
    const tittel = '<h5 class="merkelinje forb__tittel" id="forbTittel-' + esc(i.id) + '">Forberedelse</h5>';
    const åpning = '<section class="forb" data-forb="' + esc(i.id) + '" aria-labelledby="forbTittel-' + esc(i.id) + '"'
      + (går ? ' aria-busy="true"' : "") + '>' + tittel;

    if(går){
      return åpning + (f ? '<p class="forb__meta">Lager en ny. Den du har, står til den nye er klar.</p>' : "")
        + '<p class="henter forb__henter">Leser CV-en, annonsen og brevet, og skriver spørsmålene. Det tar gjerne et halvt minutt.'
          + '<span class="forb__klokke" data-forb-klokke="' + esc(i.id) + '" aria-hidden="true">' + medgått(går.start) + '</span></p>'
        + (f ? innholdHtml(i, f) : "")
        + '</section>';
    }

    const feilHtml = feil ? feilblokk(feil, i) : "";
    if(f){
      const utdatert = grunnlag ? forberedelseUtdatert(k.dok, i.id, {
        cvRevisjon: grunnlag.cvRevisjon, promptversjon: FORBEREDELSE_PROMPTVERSJON, brevVersjonId: grunnlag.brevVersjonId }) : [];
      const laget = f.laget ? new Date(f.laget) : null;
      return åpning
        + '<div class="forb__topp">'
          + '<p class="forb__meta">' + (laget && !Number.isNaN(laget.getTime())
            ? 'Laget <time datetime="' + esc(f.laget) + '">' + esc(datoMedÅr(tilIso(laget), k.iDag)) + '</time>' : "Lagret")
            + (utdatert.length ? '<span class="forb__utdatert"> Utdatert. ' + esc(utdatert.map(x => UTDATERT_GRUNN[x]).filter(Boolean).join(" ")) + '</span>' : "")
          + '</p>'
          + '<button class="knapp knapp--liten knapp--stille forb__igjen" type="button" data-iv="forbered-igjen" data-iid="' + esc(i.id) + '">Lag på nytt</button>'
        + '</div>'
        + feilHtml
        /* En forberedelse som finnes, står i fred. Hva som mangler for å
           lage en ny, vises først når brukeren ber om en. */
        + (mangler() && !feil && manglerFor === i.id ? manglerHtml() : "")
        + innholdHtml(i, f)
        + '</section>';
    }

    if(feil) return åpning + feilHtml + '</section>';
    const m = mangler();
    if(m) return åpning + manglerHtml() + '</section>';
    return åpning
      + '<p class="forb__intro">Sannsynlige spørsmål med svarskisser, eksempler fra din egen erfaring, spørsmål du kan stille og en sjekkliste. '
        + 'Lages fra CV-en, annonsen og brevet, med ett kall til modellen.</p>'
      + '<button class="knapp knapp--liten knapp--primar" type="button" data-iv="forbered" data-iid="' + esc(i.id) + '">Lag forberedelse</button>'
      + '</section>';
  }

  /* Det som må på plass før kallet kan gå, i den rekkefølgen brukeren
     må ordne det. Ukjent regnes ikke som mangel. */
  function mangler(){
    if(!k.dok) return null;
    if(!harAnnonse()) return "annonse";
    if(grunnlag?.harCv === false) return "cv";
    if(grunnlag?.harNøkkel === false) return "nokkel";
    return null;
  }
  const MANGEL = {
    annonse: { tekst: "Lagre annonsen først. Forberedelsen bygger på den.", knapp: "Gå til annonsen" },
    cv: { tekst: "Legg inn CV-en din i Brev-fanen først. Forberedelsen bygger på den.", knapp: "Legg inn CV" },
    nokkel: { tekst: "Legg til en API-nøkkel først. Forberedelsen lages av modellen du skriver brev med.", knapp: "Legg til nøkkel" }
  };
  function manglerHtml(){
    const hva = mangler(), m = MANGEL[hva];
    return '<div class="forb__mangler" data-mangler="' + hva + '">'
      + '<p>' + esc(m.tekst) + '</p>'
      + '<button class="knapp knapp--liten" type="button" data-iv="til-' + hva + '">' + m.knapp + '</button></div>';
  }

  const FEILVEI = { "mangler-cv": "cv", "mangler-annonse": "annonse", "mangler-nokkel": "nokkel" };
  const FEILTITTEL = {
    "mangler-cv": "CV-en mangler.", "mangler-annonse": "Annonsen mangler.", "mangler-nokkel": "API-nøkkelen mangler.",
    "for-mange": "Taket er nådd.", "kildefeil": "Forberedelsen ble ikke lagret.", "modellformat": "Forberedelsen ble ikke lagret.",
    "finnes-ikke": "Fant ikke intervjuet."
  };
  const FEILTEKST = {
    "kildefeil": "Modellen siterte noe som ikke står i CV-en, annonsen eller brevet, så svaret ble forkastet. Prøv igjen.",
    "mangler-nokkel": "Legg til en API-nøkkel for modellen du skriver brev med."
  };
  function feilblokk(e, i){
    const kode = e?.code || e?.navn;
    const vei = FEILVEI[kode];
    const knapper = vei
      ? '<button class="knapp knapp--liten" type="button" data-iv="til-' + vei + '">' + MANGEL[vei].knapp + '</button>'
      : kode === "finnes-ikke" ? ""
      : '<button class="knapp knapp--liten" type="button" data-iv="' + (forberedelse(i.id) ? "forbered-igjen" : "forbered") + '" data-iid="' + esc(i.id) + '">Prøv igjen</button>';
    return '<div class="detalj__feil forb__feil" role="alert"><p class="detalj__feiltittel">' + esc(FEILTITTEL[kode] || "Fikk ikke laget forberedelsen.") + '</p>'
      + '<p>' + esc(FEILTEKST[kode] || e?.message || "Prøv igjen om litt.") + '</p>'
      + (knapper ? '<div class="detalj__handlinger">' + knapper + '</div>' : "") + '</div>';
  }

  function kilderHtml(kilder){
    if(!kilder?.length) return "";
    return '<ul class="forb__kilder" aria-label="Kilder">' + kilder.map(x =>
      '<li><span class="forb__kildenavn">Fra ' + esc(KILDENAVN[x.kilde] || x.kilde) + '</span> <q>' + esc(x.sitat) + '</q></li>').join("") + '</ul>';
  }

  function innholdHtml(i, f){
    const del = (tittel, innhold) => innhold ? '<div class="forb__del"><h6 class="forb__deltittel">' + tittel + '</h6>' + innhold + '</div>' : "";
    const spørsmål = f.sporsmal.map((s, n) => {
      const key = i.id + ":" + n;
      return '<li class="forb__sporsmal"><details data-sporsmal="' + esc(key) + '"' + (åpneSpørsmål.has(key) ? " open" : "") + '>'
        + '<summary>' + esc(s.sporsmal) + '</summary>'
        + '<div class="forb__svar">'
          + (s.hvorfor ? '<p class="forb__hvorfor">' + esc(s.hvorfor) + '</p>' : "")
          + (s.svarskisse ? '<p class="forb__skisse">' + esc(s.svarskisse) + '</p>' : "")
          + kilderHtml(s.kilder)
        + '</div></details></li>';
    }).join("");
    const eksempler = f.eksempler.map(e =>
      '<li>' + (e.krav ? '<p class="forb__krav">' + esc(e.krav) + '</p>' : "")
        + (e.situasjon ? '<p class="forb__situasjon">' + esc(e.situasjon) + '</p>' : "")
        + kilderHtml(e.kilder) + '</li>').join("");
    const punkter = (l, kl) => l.length ? '<ul class="' + kl + '">' + l.map(t => '<li>' + esc(t) + '</li>').join("") + '</ul>' : "";
    return '<div class="forb__innhold">'
      + (f.sammendrag ? '<p class="forb__sammendrag">' + esc(f.sammendrag) + '</p>' : "")
      + del("Spørsmål de trolig stiller", spørsmål ? '<ul class="forb__sporsmalsliste">' + spørsmål + '</ul>' : "")
      + del("Eksempler du kan bruke", eksempler ? '<ul class="forb__eksempler">' + eksempler + '</ul>' : "")
      + del("Spørsmål du kan stille dem", punkter(f.sporsmalTilDem, "forb__punkter"))
      + del("Før intervjuet", punkter(f.sjekkliste, "forb__punkter forb__punkter--sjekk"))
      + '</div>';
  }

  function medgått(start){
    const s = Math.max(0, Math.floor((Date.now() - start) / 1000));
    return Math.floor(s / 60) + ":" + pad(s % 60);
  }
  function startKlokke(){
    if(klokke) return;
    klokke = setInterval(() => {
      let noen = false;
      flate.querySelectorAll("[data-forb-klokke]").forEach(el => {
        const g = PÅGÅR.get(nøkkel(id(), el.dataset.forbKlokke));
        if(g){ noen = true; el.textContent = medgått(g.start); }
      });
      if(!noen){ clearInterval(klokke); klokke = null; }
    }, 1000);
  }

  /* ---------- skjemaet ---------- */

  function skjemaHtml(){
    const i = skjema.iid ? finn(skjema.iid) : null;
    const v = i || { dato: "", tid: null, varighet: null, type: "", sted: "", lenke: "", runde: "", notat: "" };
    const feilFor = f => skjemaFeil.find(x => x.felt === f);
    const felt = (f, merke, inn, hjelp) => {
      const fe = feilFor(f);
      return '<div class="felt ivskjema__felt ivskjema__felt--' + f + '"><label class="felt__merke" for="iv' + f + '">' + merke + '</label>' + inn
        + (fe ? '<p class="ivskjema__feil" id="iv' + f + 'Feil">' + esc(fe.melding) + '</p>' : "")
        + (hjelp ? '<p class="felt__hjelp" id="iv' + f + 'Hjelp">' + hjelp + '</p>' : "") + '</div>';
    };
    const attr = (f, hjelp) => (feilFor(f) ? ' aria-invalid="true"' : "")
      + ((feilFor(f) || hjelp) ? ' aria-describedby="' + [feilFor(f) ? "iv" + f + "Feil" : "", hjelp ? "iv" + f + "Hjelp" : ""].filter(Boolean).join(" ") + '"' : "");
    const generell = skjemaFeil.filter(x => !["dato", "tid", "varighet", "sted", "lenke", "runde", "notat"].includes(x.felt));
    const flytter = !i && (k.jobb.status === "todo" || k.jobb.status === "sent");
    return '<form class="ivskjema" id="ivSkjema" novalidate aria-labelledby="ivSkjemaTittel">'
      + '<h3 class="ivskjema__tittel" id="ivSkjemaTittel" tabindex="-1">' + (i ? "Endre intervjuet" : "Nytt intervju") + '</h3>'
      + (flytter ? '<p class="ivskjema__ingress">Søknaden flyttes til Intervju når du lagrer. Det kan angres.</p>' : "")
      + (generell.length ? '<p class="feil" role="alert">' + esc(generell.map(x => x.melding).join(" ")) + '</p>' : "")
      + '<div class="ivskjema__rad ivskjema__rad--tid">'
        + felt("dato", "Dato", '<input class="felt__inn" id="ivdato" name="dato" type="date" required value="' + esc(v.dato) + '"' + attr("dato") + '>')
        + felt("tid", "Klokkeslett", '<input class="felt__inn" id="ivtid" name="tid" type="time" value="' + esc(v.tid || "") + '"' + attr("tid") + '>')
        + felt("varighet", "Minutter", '<input class="felt__inn" id="ivvarighet" name="varighet" type="number" inputmode="numeric" min="1" max="' + MAKS_INTERVJU.varighet + '" step="5" placeholder="' + STANDARD_VARIGHET + '" value="' + esc(v.varighet ?? "") + '"' + attr("varighet") + '>')
      + '</div>'
      + '<div class="ivskjema__rad">'
        + felt("type", "Type", '<select class="felt__inn" id="ivtype" name="type"><option value="">Ikke valgt</option>'
          + Object.entries(INTERVJUTYPER).map(([kode, navn]) => '<option value="' + kode + '"' + (v.type === kode ? " selected" : "") + '>' + navn + '</option>').join("") + '</select>')
        + felt("runde", "Runde", '<input class="felt__inn" id="ivrunde" name="runde" type="text" maxlength="' + MAKS_INTERVJU.runde + '" placeholder="Første runde, case, teknisk" value="' + esc(v.runde) + '"' + attr("runde") + '>')
      + '</div>'
      + felt("sted", "Sted", '<input class="felt__inn" id="ivsted" name="sted" type="text" maxlength="' + MAKS_INTERVJU.sted + '" placeholder="' + esc(STEDHINT[v.type] || STEDHINT[""]) + '" value="' + esc(v.sted) + '"' + attr("sted") + '>')
      + felt("lenke", "Lenke", '<input class="felt__inn" id="ivlenke" name="lenke" type="url" inputmode="url" placeholder="https://" value="' + esc(v.lenke) + '"' + attr("lenke", true) + '>',
          "Møtelenken eller en veibeskrivelse.")
      + felt("notat", "Notat", '<textarea class="felt__inn felt__notat" id="ivnotat" name="notat" rows="3" maxlength="' + MAKS_INTERVJU.notat + '" placeholder="Hvem du skal møte, hva du skal ha med"' + attr("notat") + '>' + esc(v.notat) + '</textarea>')
      + '<div class="detalj__handlinger ivskjema__knapper">'
        + '<button class="knapp knapp--primar" type="submit" data-iv="lagre">' + (i ? "Lagre endringene" : "Lagre intervjuet") + '</button>'
        + '<button class="knapp knapp--stille" type="button" data-iv="avbryt">Avbryt</button>'
      + '</div></form>';
  }

  function lesSkjema(){
    const f = flate.querySelector("#ivSkjema");
    const v = n => f.elements[n].value.trim();
    return { dato: v("dato"), tid: v("tid") || null, varighet: v("varighet") || null, type: v("type"),
      sted: v("sted"), lenke: v("lenke"), runde: v("runde"), notat: f.elements.notat.value.trim() };
  }

  function lagreSkjema(){
    const felt = lesSkjema();
    const iid = skjema.iid;
    const r = iid
      ? api.endreIntervjuer(j => endreIntervju(j, iid, felt))
      : api.endreIntervjuer((j, klokka) => nyttIntervju(j, felt, klokka));
    if(!r.ok){
      skjemaFeil = r.feil || [];
      /* Det brukeren skrev, blir stående. Bare meldingene tegnes inn. */
      tegn();
      const første = skjemaFeil.find(x => x.felt && flate.querySelector("#iv" + x.felt));
      (første ? flate.querySelector("#iv" + første.felt) : flate.querySelector("#ivSkjemaTittel"))?.focus();
      return;
    }
    skjema = null; skjemaFeil = [];
    settÅpen(r.intervju.id);
    tegn();
    fokuserRad(r.intervju.id);
    if(r.statusEndret){
      api.varsle("Status satt til intervju", () => r.angre(["status", "sendtDato", "intervju", "hendelser"]));
    }else api.melde(iid ? "Endringene er lagret" : "Intervjuet er lagret");
  }

  function fyllSkjema(v){
    const f = flate.querySelector("#ivSkjema");
    if(!f) return;
    for(const [n, x] of Object.entries(v)) if(f.elements[n]) f.elements[n].value = x ?? "";
  }

  function åpneSkjema(s){
    skjema = s; skjemaFeil = []; bekrefter = null;
    tegn();
    requestAnimationFrame(() => flate.querySelector("#ivdato")?.focus());
  }
  function lukkSkjema(){
    const var_ = skjema;
    skjema = null; skjemaFeil = [];
    tegn();
    if(var_?.iid && finn(var_.iid)) fokuserRad(var_.iid);
    else flate.querySelector('[data-iv="ny"]')?.focus();
  }

  /* ---------- tegn ---------- */

  function tegn(){
    if(ryddet) return;
    if(skjema){
      /* Står skjemaet alt, tegnes det med det brukeren har skrevet. */
      const verdier = flate.querySelector("#ivSkjema") ? lesSkjema() : null;
      flate.innerHTML = '<div class="intervjuer">' + skjemaHtml() + '</div>';
      if(verdier) fyllSkjema(verdier);
      return;
    }
    const fokus = huskFokus();
    const ivs = alle();
    if(!ivs.length){
      const flytter = k.jobb.status === "todo" || k.jobb.status === "sent";
      flate.innerHTML = '<div class="intervjuer intervjuer--tom detalj__plass">'
        + '<p class="detalj__tomtittel">Ingen intervjuer ennå</p>'
        + '<p class="detalj__tomtekst">Legg inn tid og sted når du blir kalt inn. Da kan du legge intervjuet i kalenderen '
          + 'og lage en forberedelse med sannsynlige spørsmål og svarskisser.' + (flytter ? " Søknaden flyttes til Intervju." : "") + '</p>'
        + '<div class="detalj__handlinger"><button class="knapp knapp--primar" type="button" data-iv="ny">Legg til intervju</button></div>'
        + '</div>';
      gjenopprettFokus(fokus);
      return;
    }
    const kom = kommende(k.jobb);
    const komIder = new Set(kom.map(i => i.id));
    const tidligere = ivs.filter(i => !komIder.has(i.id)).reverse();
    const valgt = åpentIntervju();
    const fullt = ivs.length >= MAKS_INTERVJU.antall;
    const gruppe = (tittel, gid, rader, tidl) => rader.length
      ? '<section class="intervjuer__del" aria-labelledby="' + gid + '"><h3 class="merkelinje detalj__deltittel" id="' + gid + '">' + tittel + '</h3>'
        + '<ul class="intervjuer__liste" role="list">' + rader.map(i => radHtml(i, { tidligere: tidl, erÅpen: i.id === valgt })).join("") + '</ul></section>'
      : "";
    flate.innerHTML = '<div class="intervjuer">'
      + gruppe("Kommende", "ivKommende", kom, false)
      + gruppe("Tidligere", "ivTidligere", tidligere, true)
      + '<div class="intervjuer__fot">'
        + '<button class="knapp knapp--liten" type="button" data-iv="ny"' + (fullt ? ' disabled aria-describedby="ivFullt"' : "") + '>Legg til intervju</button>'
        + (fullt ? '<p class="felt__hjelp" id="ivFullt">Du kan ha opptil ' + MAKS_INTERVJU.antall + ' intervjuer på én søknad. Slett et gammelt for å legge til et nytt.</p>' : "")
      + '</div></div>';
    gjenopprettFokus(fokus);
    if([...PÅGÅR.keys()].some(n => n.startsWith(id() + ":"))) startKlokke();
  }

  /* En omtegning skal ikke sende fokus ut i ingenting. */
  function huskFokus(){
    const a = document.activeElement;
    if(!a || !flate.contains(a) || a === flate) return null;
    if(a.dataset.iv) return '[data-iv="' + a.dataset.iv + '"]' + (a.dataset.iid ? '[data-iid="' + CSS.escape(a.dataset.iid) + '"]' : "");
    const d = a.closest("details[data-sporsmal]");
    if(d) return 'details[data-sporsmal="' + CSS.escape(d.dataset.sporsmal) + '"] > summary';
    return null;
  }
  function gjenopprettFokus(velger){
    if(!velger) return;
    const el = flate.querySelector(velger);
    if(el) el.focus({ preventScroll: true });
    else if(velger.includes("data-iid")) flate.querySelector('[data-iv="ny"]')?.focus({ preventScroll: true });
  }
  function fokuserRad(iid){
    requestAnimationFrame(() => {
      const b = flate.querySelector('[data-iv="apne"][data-iid="' + CSS.escape(iid) + '"]');
      if(!b) return;
      b.focus({ preventScroll: true });
      b.closest(".iv")?.scrollIntoView({ block: "nearest" });
    });
  }

  /* ---------- handlinger ---------- */

  async function lagForberedelse(iid, tving){
    const hvem = id();
    const n = nøkkel(hvem, iid);
    if(PÅGÅR.has(n)) return;
    FEIL.delete(n);
    const løfte = (async () => {
      /* Kallet leser intervjuet fra lageret. Et intervju som nettopp er
         lagt inn, må være skrevet før det går. */
      await api.ventPåLagring();
      return Jobbdokumenter.lagForberedelse(hvem, iid, { tving });
    })();
    PÅGÅR.set(n, { start: Date.now(), løfte });
    tegn(); startKlokke();
    api.melde("Lager forberedelsen. Det tar gjerne et halvt minutt.");
    try{
      const d = await løfte;
      api.settDokument(hvem, d);
      api.melde("Forberedelsen er klar");
    }catch(e){
      if(e?.code !== "utlogget") FEIL.set(n, e);
      api.melde("Fikk ikke laget forberedelsen");
    }finally{
      PÅGÅR.delete(n);
    }
    /* Var fanen lukket underveis, viser neste montering resultatet. */
    if(!ryddet && hvem === id()){
      if(FEIL.has(n)) lastGrunnlag();
      tegn();
      if(document.activeElement === document.body || !flate.contains(document.activeElement))
        flate.querySelector('[data-forb="' + CSS.escape(iid) + '"] :is(.forb__feil button, .forb__sammendrag, summary)')?.focus?.({ preventScroll: true });
    }
  }

  function slett(iid){
    const i = finn(iid);
    if(!i) return;
    const harForb = !!forberedelse(iid);
    if(harForb && bekrefter !== iid){
      bekrefter = iid; tegn();
      flate.querySelector('[data-iv="avbryt-slett"][data-iid="' + CSS.escape(iid) + '"]')?.focus();
      return;
    }
    bekrefter = null;
    const hvem = id();
    const r = api.endreIntervjuer(j => slettIntervju(j, iid));
    if(!r.ok){ api.varsle(r.feil?.[0]?.melding || "Fikk ikke slettet intervjuet."); return; }
    if(åpen === iid) settÅpen(undefined);
    FEIL.delete(nøkkel(hvem, iid));
    const tekst = "Slettet intervjuet " + datoMedÅr(i.dato, k.iDag);
    if(harForb){
      Jobbdokumenter.slettForberedelse(hvem, iid).then(d => api.settDokument(hvem, d))
        .catch(() => api.varsle("Intervjuet er slettet, men forberedelsen ble liggende. Den tas med neste gang du sletter."));
      api.varsle(tekst + " og forberedelsen");
    }else{
      api.varsle(tekst, () => { settÅpen(iid); r.angre(["intervjuer"]); });
    }
    tegn();
    (flate.querySelector('[data-iv="apne"]') || flate.querySelector('[data-iv="ny"]'))?.focus();
  }

  async function kalender(iid){
    const i = finn(iid);
    if(!i) return;
    try{
      const r = await eksporterIcs({ jobb: k.jobb, intervju: i });
      if(r?.lagret === true) api.varsle("Kalenderfilen er lastet ned. Åpne den for å legge intervjuet i kalenderen.");
      else if(r?.lagret) api.varsle("Kalenderfilen er lagret. Åpne den for å legge intervjuet i kalenderen.");
    }catch(e){
      api.varsle(e?.message || "Fikk ikke laget kalenderfilen.");
    }
  }

  function handling(hva, iid){
    if(hva === "ny") åpneSkjema({ ny: true });
    else if(hva === "avbryt") lukkSkjema();
    else if(hva === "apne"){
      settÅpen(åpentIntervju() === iid ? null : iid);
      bekrefter = null;
      tegn();
      fokuserRad(iid);
    }
    else if(hva === "endre") åpneSkjema({ iid });
    else if(hva === "slett" || hva === "bekreft-slett") slett(iid);
    else if(hva === "avbryt-slett"){ bekrefter = null; tegn(); flate.querySelector('[data-iv="slett"][data-iid="' + CSS.escape(iid) + '"]')?.focus(); }
    else if(hva === "kalender") kalender(iid);
    else if(hva === "forbered") lagForberedelse(iid, false);
    else if(hva === "forbered-igjen"){
      if(mangler()){
        manglerFor = iid; tegn();
        flate.querySelector('[data-forb="' + CSS.escape(iid) + '"] .forb__mangler button')?.focus();
      }else lagForberedelse(iid, true);
    }
    /* Annonsen hentes fra lenken når søknaden har en; ellers limes den inn. */
    else if(hva === "til-annonse") api.åpneFane("annonse", (k.jobb.lenke || "").trim() ? undefined : "lim");
    else if(hva === "til-cv") api.åpneFane("brev", "cv");
    else if(hva === "til-nokkel") api.åpneFane("brev", "nokkel");
  }

  const lytt = new AbortController();
  flate.addEventListener("click", e => {
    const b = e.target.closest("[data-iv]");
    if(!b || b.disabled || !flate.contains(b)) return;
    if(b.type === "submit") return;
    handling(b.dataset.iv, b.dataset.iid);
  }, { signal: lytt.signal });
  flate.addEventListener("submit", e => {
    if(e.target.id !== "ivSkjema") return;
    e.preventDefault();
    lagreSkjema();
  }, { signal: lytt.signal });
  /* Typen styrer hva stedsfeltet foreslår. */
  flate.addEventListener("change", e => {
    if(e.target.id === "ivtype"){
      const sted = flate.querySelector("#ivsted");
      if(sted) sted.placeholder = STEDHINT[e.target.value] || STEDHINT[""];
    }
  }, { signal: lytt.signal });
  /* Åpne spørsmål blir stående åpne gjennom en omtegning. */
  flate.addEventListener("toggle", e => {
    const d = e.target;
    if(!(d instanceof HTMLDetailsElement) || !d.dataset.sporsmal) return;
    if(d.open) åpneSpørsmål.add(d.dataset.sporsmal); else åpneSpørsmål.delete(d.dataset.sporsmal);
  }, { capture: true, signal: lytt.signal });
  /* Esc i skjemaet eller i en bekreftelse avbryter den, i stedet for å
     lukke hele panelet. */
  flate.addEventListener("keydown", e => {
    if(e.key !== "Escape" || e.defaultPrevented) return;
    if(skjema){ e.preventDefault(); lukkSkjema(); }
    else if(bekrefter){ e.preventDefault(); handling("avbryt-slett", bekrefter); }
  }, { signal: lytt.signal });

  /* Et kall som gikk da fanen sist sto, tegnes ferdig når det er ferdig. */
  for(const [n, g] of PÅGÅR) if(n.startsWith(id() + ":")) g.løfte.catch(() => {}).finally(() => { if(!ryddet) setTimeout(tegn); });

  tegn();
  lastGrunnlag();

  let sist = { intervjuer: k.jobb.intervjuer, status: k.jobb.status, dok: k.dok, dokFeil: k.dokFeil };
  return {
    fokuser(){
      (flate.querySelector("#ivdato") || flate.querySelector('[data-iv="ny"]'))?.focus({ preventScroll: true });
    },
    oppdater(ny){
      const nySøknad = ny.jobb.id !== k.jobb.id;
      k = ny;
      if(nySøknad){
        skjema = null; skjemaFeil = []; åpen = ÅPEN.get(ny.jobb.id); bekrefter = null; manglerFor = null; grunnlag = null; åpneSpørsmål.clear();
        lastGrunnlag();
      }else if(sist.intervjuer === ny.jobb.intervjuer && sist.status === ny.jobb.status && sist.dok === ny.dok && sist.dokFeil === ny.dokFeil) return;
      sist = { intervjuer: ny.jobb.intervjuer, status: ny.jobb.status, dok: ny.dok, dokFeil: ny.dokFeil };
      /* Et intervju som er slettet et annet sted, kan ikke endres videre. */
      if(skjema?.iid && !finn(skjema.iid)) skjema = null;
      if(skjema) return;
      tegn();
    },
    lukk(){ return true; },
    rydd(){ ryddet = true; lytt.abort(); clearInterval(klokke); klokke = null; }
  };
}
