/* ============================================================
   Detaljpanelet: alt om én søknad på ett sted.

   Fra 1100 px står panelet til høyre for listen, som en ny kortflate
   speilvendt av sidepanelet, og listen smalner. Under det er det et
   ark i full høyde over listen, med slør, og da er det modalt: fokus
   holdes inni, og listen bak er inert (se oppdaterInert i app.js).

   Adressen er #jobb/<id>/<fane>. Å åpne panelet legger én oppføring i
   historikken, så tilbakeknappen lukker det. Å bytte søknad eller fane
   mens det står åpent, erstatter oppføringen i stedet for å fylle
   historikken. En direktelenke åpner panelet når listen er lastet.

   Panelet leser søknaden fra listen hver gang listen tegnes (oppdater),
   så en ny status, et notat eller en endring fra skuffen vises med en
   gang, uten at fanen eller rulleposisjonen går tapt. Er søknaden
   slettet, lukker panelet seg.

   ---- Fanene ----

   En fane er { navn, monter(flate, ktx, api) } og registreres med
   registrerFane(id, fane). Rekkefølgen er den første registreringen;
   registreres en id på nytt, byttes innholdet og plassen beholdes.
   Det er slik intervjugrenen erstatter plassholderen.

   monter() fyller `flate` og gir tilbake et objekt med det fanen
   trenger av livssyklus, alt valgfritt:

     oppdater(ktx)   ny søknadstilstand eller nytt dokument. Skal ikke
                     tegne om det brukeren holder på med.
     lukk()          før fanen forlates. Gir false (eller et løfte om
                     false) for å bli stående, som brevet gjør når det
                     ikke fikk lagret.
     rydd()          etter lukk, eller når panelet tvinges igjen.

   ktx = { jobb, dok, dokFeil, iDag }. dok er jobb-<id>.json, eller null
   mens det hentes. api gir varsle, melde (skjermleserstatus),
   settDokument(id, dok), lastDokument(), rediger(), slett(),
   lagreNotat(tekst), påLagring(fn), brukernavn(), bunn (foten under
   flaten, skjult til en fane viser den), åpneFane(id, hensikt?) og
   etterSelvlukking() (for en fane som har ryddet seg selv).

   hensikt er det en annen fane ber den nye om å begynne med, som når
   brevet sender brukeren til annonsen for å lime den inn. Den kommer
   som ktx.hensikt til monter(), bare den ene gangen. Har fanen da en
   fokuser(), får den fokuset i stedet for overskriften.

   Utenfra: oppdaterDokument(id, dok?) når noe annet har skrevet
   jobbdokumentet (vurderingen, forberedelsene, Radar). Med dok brukes
   det som det er; uten hentes det på nytt.
   ============================================================ */

import * as Jobbdokumenter from "./jobbdokumenter.js";
import { åpneBrevflate } from "./brevflate.js";
import { STATUSER, SEKTORER, JOBBTYPER } from "./felles.mjs";
import { dagerSidenSendt } from "./hendelser.mjs";
import { esc, monogram, omTekst, hast, datoMedÅr, ukedag, antall, tilIso } from "./formater.js";
import { tidslinjeHtml, stegdatoer, lengstKommet, datoTekst, LØP, UTGANGER } from "./tidslinje.js";
import { monterAnnonse } from "./annonseflate.js";

/* ---------- fanene ---------- */

const FANER = new Map();
export function registrerFane(id, { navn, monter }){
  if(!/^[a-z]{1,20}$/.test(id)) throw new Error("Fane-id-en må være små bokstaver.");
  FANER.set(id, { navn, monter });
  aktivt?.fanerEndret();
}

let aktivt = null;
export function oppdaterDokument(id, dok){ aktivt?.oppdaterDokument(id, dok); }

/* ---------- Oversikt ---------- */

const ALVOR = { hoy: "viktig", middels: "middels", lav: "lite viktig" };

function matchHtml(ktx){
  if(!ktx.dok && !ktx.dokFeil) return '<p class="detalj__tomt detalj__tomt--venter">Henter vurderingen…</p>';
  const m = ktx.dok?.match;
  if(!m) return '<p class="detalj__tomt">Ingen vurdering av hvor godt stillingen passer ennå.'
    + (ktx.dok?.annonse?.tekst ? "" : " Den bygger på annonsen, så lagre den først.") + '</p>';
  const punkt = (tittel, liste, fn) => liste.length
    ? '<div class="match__del"><p class="match__deltittel">' + tittel + '</p><ul class="match__liste">' + liste.map(fn).join("") + '</ul></div>' : "";
  return '<div class="match">'
    + '<p class="match__tall"><span class="match__prosent">' + m.prosent + ' %</span>'
      + (m.oppsummering ? '<span class="match__sammendrag">' + esc(m.oppsummering) + '</span>' : "") + '</p>'
    + punkt("Styrker", m.styrker, s => '<li><b>' + esc(s.krav) + '</b>' + (s.bevis ? ' <span>' + esc(s.bevis) + '</span>' : "") + '</li>')
    + punkt("Mangler", m.mangler, x => '<li><b>' + esc(x.krav) + '</b> <span class="match__alvor">' + (ALVOR[x.alvor] || "") + '</span></li>')
    + '</div>';
}

function monterOversikt(flate, ktx, api){
  let k = ktx;
  const MAKS = 1000;
  flate.innerHTML = '<div class="oversikt">'
    + '<section class="detalj__del" aria-labelledby="detaljMatchTittel"><h3 class="merkelinje detalj__deltittel" id="detaljMatchTittel">Match</h3>'
      + '<div data-del="match"></div></section>'
    + '<section class="detalj__del" aria-labelledby="detaljTidTittel"><h3 class="merkelinje detalj__deltittel" id="detaljTidTittel">Tidslinje</h3>'
      + '<div data-del="tid"></div></section>'
    + '<section class="detalj__del">'
      + '<label class="merkelinje detalj__deltittel" for="detaljNotat">Notat</label>'
      + '<textarea class="detalj__notat" id="detaljNotat" maxlength="' + MAKS + '" rows="3" placeholder="Hva må du huske om denne søknaden?" aria-describedby="detaljNotatLinje"></textarea>'
      + '<p class="detalj__notatlinje" id="detaljNotatLinje"><span data-del="notatstatus"></span><span data-del="teller"></span></p>'
    + '</section>'
    + '<div class="detalj__fot"><button class="knapp knapp--liten knapp--stille knapp--fare" type="button" data-panel="slett">Slett søknaden</button></div>'
    + '</div>';
  const del = n => flate.querySelector('[data-del="' + n + '"]');
  const notat = flate.querySelector("#detaljNotat");
  notat.value = k.jobb.notat || "";

  /* Notatet lagres når man slutter å skrive, og med en gang feltet
     forlates. Lagringstilstanden er listens egen: «Lagrer…», «Lagret»
     eller «Ikke lagret», i samme mono som nede i sidepanelet. */
  let tid = null, venter = false, skrevetFor = k.jobb.id;
  const status = (tekst, feil) => { const s = del("notatstatus"); s.textContent = tekst; s.classList.toggle("er-feil", !!feil); };
  const teller = () => { const n = notat.value.length; del("teller").textContent = n > MAKS - 200 ? n + " / " + MAKS : ""; };
  function lagreNå(){
    clearTimeout(tid); tid = null;
    if(skrevetFor !== k.jobb.id) return;
    if(notat.value.trim() === (k.jobb.notat || "")) { if(!venter) status(""); return; }
    const feil = api.lagreNotat(notat.value);
    if(feil){ status(feil, true); return; }
    venter = true; status("Lagrer…");
  }
  const avmeld = api.påLagring(t => {
    if(!venter) return;
    if(t.navn === "lagrer") status("Lagrer…");
    else if(t.navn === "lagret"){ venter = false; status("Lagret"); }
    else if(["ulagret", "frakoblet", "konflikt", "utlogget", "blokkert"].includes(t.navn)){ venter = false; status("Ikke lagret", true); }
  });
  notat.addEventListener("input", () => {
    teller(); status("");
    clearTimeout(tid); tid = setTimeout(lagreNå, 700);
  });
  notat.addEventListener("blur", lagreNå);

  function tegn(){
    del("match").innerHTML = matchHtml(k);
    del("tid").innerHTML = tidslinjeHtml(k.jobb, k.iDag);
    /* Et notat brukeren skriver i, overskrives aldri av en omtegning. */
    if(document.activeElement !== notat && notat.value !== (k.jobb.notat || "")) notat.value = k.jobb.notat || "";
    teller();
  }
  tegn();
  return {
    oppdater(ny){
      if(ny.jobb.id !== k.jobb.id){ lagreNå(); skrevetFor = ny.jobb.id; venter = false; status(""); notat.value = ny.jobb.notat || ""; }
      k = ny; tegn();
    },
    lukk(){ lagreNå(); return true; },
    rydd(){ clearTimeout(tid); avmeld(); }
  };
}

/* ---------- Intervju: plassen står klar ---------- */

function monterIntervju(flate){
  flate.innerHTML = '<div class="detalj__plass">'
    + '<p class="detalj__tomtittel">Intervjuene får plass her</p>'
    + '<p class="detalj__tomtekst">Her kommer tid og sted, forberedelser og spørsmål du vil stille. '
    + 'Til da kan du merke søknaden med Intervju i stegraden og skrive detaljene i notatet under Oversikt.</p></div>';
  return {};
}

/* ---------- Brev ---------- */

/* Brevflaten får panelets flate og fot, og jobbdokumentet, så den kan
   vise om annonsen er lagret og sende til Annonse-fanen. Den lagrer
   selv; lukk() venter på det, og gir false hvis lagringen feilet, så
   panelet blir stående på brevet. */
function monterBrev(flate, ktx, api){
  api.bunn.hidden = false;
  let ryddet = false;
  const brev = åpneBrevflate({ jobb: ktx.jobb, navn: api.brukernavn(), kropp: flate, bunn: api.bunn, ktx,
    påLukk: () => { ryddet = true; api.bunn.hidden = true; api.etterSelvlukking(); },
    åpneFane: (f, hensikt) => api.åpneFane(f, hensikt),
    settDokument: (id, d) => api.settDokument(id, d),
    lastDokument: () => api.lastDokument()
  });
  return {
    oppdater: ny => { if(!ryddet) brev.oppdater(ny); },
    lukk: () => (ryddet ? true : brev.lukk()),
    rydd(){ if(!ryddet){ ryddet = true; brev.rydd(); } api.bunn.hidden = true; }
  };
}

registrerFane("oversikt", { navn: "Oversikt", monter: monterOversikt });
registrerFane("annonse",  { navn: "Annonse",  monter: monterAnnonse });
registrerFane("intervju", { navn: "Intervju", monter: monterIntervju });
registrerFane("brev",     { navn: "Brev",     monter: monterBrev });

/* Pila skal aldri stå alene på en linje: siste ord og pila brytes ikke. */
function medPil(tekst){
  const t = String(tekst).trim(), i = t.lastIndexOf(" ");
  return esc(t.slice(0, i + 1)) + '<span class="ubrutt">' + esc(t.slice(i + 1)) + '<span class="rad__pil" aria-hidden="true">↗</span></span>';
}

/* ---------- panelet ---------- */

const RUTE = /^#jobb\/([A-Za-z0-9_-]{1,64})(?:\/([a-z]{1,20}))?$/;
const LUKK_IKON = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const FOKUSERBARE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

export function lagDetaljpanel(deps){
  const el = document.getElementById("detalj");
  const slør = document.getElementById("detaljSlor");
  const bred = matchMedia("(min-width:1100px)");

  let id = null, fane = "oversikt";
  let dok = null, dokFeil = null, dokNr = 0;
  const dokumenter = new Map();
  let montert = null;           /* { id, fane, obj } */
  let presset = false;          /* la vi selv oppføringen i historikken */
  let fokusFor = null;
  let hensikt = null;           /* se åpneFane */
  let kø = Promise.resolve();
  let skall = null;

  /* Alt som endrer hva panelet viser, går i kø: å forlate brevet venter
     på lagringen, og to raske klikk skal ikke flette seg i hverandre. */
  const iKø = fn => (kø = kø.then(fn, fn));

  const ktx = () => ({ jobb: deps.jobb(id), dok, dokFeil, iDag: deps.iDag() });
  const erÅpen = () => id !== null;

  /* ---------- skallet ---------- */

  function byggSkall(){
    el.innerHTML = '<div class="detalj__topp" data-del="topp"></div>'
      + '<div class="detalj__faner" role="tablist" aria-label="Om søknaden" data-del="faner"></div>'
      + '<div class="detalj__flate" id="detaljFlate" role="tabpanel" tabindex="0"></div>'
      + '<div class="detalj__bunn" id="detaljBunn" hidden></div>'
      + '<p class="skjult" id="detaljMelding" role="status" aria-live="polite"></p>';
    skall = {
      topp: el.querySelector('[data-del="topp"]'),
      faner: el.querySelector('[data-del="faner"]'),
      flate: el.querySelector("#detaljFlate"),
      bunn: el.querySelector("#detaljBunn"),
      melding: el.querySelector("#detaljMelding")
    };
  }

  function tegnFaner(){
    skall.faner.innerHTML = Array.from(FANER, ([fid, f]) =>
      '<button class="detalj__fane" type="button" role="tab" id="detaljFane-' + fid + '" data-fane="' + fid + '"'
      + ' aria-controls="detaljFlate" aria-selected="' + (fid === fane) + '" tabindex="' + (fid === fane ? 0 : -1) + '">'
      + esc(f.navn) + '</button>').join("");
    skall.flate.setAttribute("aria-labelledby", "detaljFane-" + fane);
    el.dataset.fane = fane;
  }

  /* Hva søknaden står på nå, i én linje av fakta: fristen eller
     statusen med dato, så sted, sektor og jobbtype. Kulør bare på en
     frist som haster. */
  function faktaHtml(j, iDag){
    const fakta = [];
    const datoer = stegdatoer(j, iDag);
    if(j.status === "todo"){
      if(j.frist){
        const h = hast(j.frist, iDag);
        fakta.push('<span class="detalj__frist">Frist <time datetime="' + j.frist + '">' + esc(ukedag(j.frist) + " " + datoMedÅr(j.frist, iDag)) + '</time>'
          + ' <span class="detalj__om" data-hast="' + h + '">' + esc(omTekst(j.frist, iDag)) + '</span></span>');
      }else fakta.push('<span>Løpende opptak</span>');
    }else if(j.status === "sent"){
      const d = dagerSidenSendt(j, iDag);
      fakta.push('<span>Sendt' + (j.sendtDato ? ' <time datetime="' + j.sendtDato + '">' + esc(datoMedÅr(j.sendtDato, iDag)) + '</time>' : "")
        + (d != null && d > 0 ? ', venter ' + antall(d, "dag", "dager") : "") + '</span>');
    }else{
      const d = datoer[j.status];
      fakta.push('<span>' + esc(STATUSER[j.status]) + (d?.dato ? ' <time datetime="' + d.dato + '">' + esc(datoTekst(d, iDag).tekst) + '</time>' : "") + '</span>');
    }
    if(j.sted) fakta.push('<span>' + esc(j.sted) + '</span>');
    fakta.push('<span>' + esc(SEKTORER[j.sektor] || SEKTORER.annet) + '</span>');
    if(JOBBTYPER[j.jobbtype]) fakta.push('<span>' + esc(JOBBTYPER[j.jobbtype]) + '</span>');
    if(dok?.match && dok.jobbId === j.id) fakta.push('<span class="detalj__match" title="Hvor godt stillingen passer CV-en din">' + dok.match.prosent + ' % match</span>');
    return '<p class="detalj__fakta">' + fakta.join("") + '</p>';
  }

  /* Stegraden. Hovedløpet står alltid; sideutgangene er stille knapper
     under, eller merket med dato når søknaden har tatt en av dem. Hvert
     steg er en knapp som setter statusen, med samme angre som raden. */
  function stegHtml(j, iDag){
    const datoer = stegdatoer(j, iDag);
    const her = LØP.indexOf(j.status);
    const kom = her >= 0 ? her : lengstKommet(j, iDag);
    const steg = LØP.map((s, i) => {
      const tilstand = her >= 0 ? (i < her ? "ferdig" : i === her ? "naa" : "kommende") : (i <= kom ? "ferdig" : "kommende");
      const d = tilstand !== "kommende" ? datoer[s] : null;
      const dt = d?.dato ? datoTekst(d, iDag) : null;
      const naa = tilstand === "naa";
      return '<li class="steg__post" data-tilstand="' + tilstand + '">'
        + '<button class="steg__knapp" type="button" data-panel="status" data-status="' + s + '"'
        + (naa ? ' aria-current="step" aria-disabled="true"' : ' aria-label="Sett status til ' + esc(STATUSER[s]) + (dt ? ", nådd " + esc(dt.sr) : "") + '"') + '>'
        + '<span class="steg__prikk" aria-hidden="true"></span>'
        + '<span class="steg__navn">' + esc(STATUSER[s]) + '</span>'
        + '<span class="steg__dato">' + (dt ? '<span aria-hidden="true">' + esc(dt.tekst) + '</span>' + (naa ? '<span class="skjult">, ' + esc(dt.sr) + '</span>' : "") : "") + '</span>'
        + '</button></li>';
    }).join("");

    let ut = "";
    if(UTGANGER.includes(j.status)){
      const d = datoer[j.status];
      const dt = d?.dato ? datoTekst(d, iDag) : null;
      ut = '<p class="steg__utfall"><span class="merkelapp" data-s="' + j.status + '">' + esc(STATUSER[j.status]) + '</span>'
        + (dt ? '<span class="steg__dato"><span aria-hidden="true">' + esc(dt.tekst) + '</span><span class="skjult">' + esc(dt.sr) + '</span></span>' : "")
        + '<span class="steg__hint">Velg et steg over for å åpne den igjen.</span></p>';
    }else{
      const valg = [];
      if(j.status === "sent" || j.status === "interview"){
        valg.push(["rejected", "Fikk avslag"], ["trukket", "Trakk søknaden"]);
      }
      if(j.status === "todo" && j.frist && hast(j.frist, iDag) === "forbi") valg.push(["expired", "Marker som utløpt"]);
      if(valg.length) ut = '<p class="steg__utganger">' + valg.map(([s, t]) =>
        '<button class="steg__utgang" type="button" data-panel="status" data-status="' + s + '">' + t + '</button>').join("") + '</p>';
    }
    return '<div class="steg" role="group" aria-label="Status"><ol class="steg__lop">' + steg + '</ol>' + ut + '</div>';
  }

  /* Tegner toppen på nytt og setter fokus tilbake på samme kontroll,
     så et klikk i stegraden ikke sender fokus ut i ingenting. */
  function tegnTopp(){
    const j = deps.jobb(id);
    if(!j) return;
    const iDag = deps.iDag();
    const aktiv = document.activeElement;
    const nøkkel = skall.topp.contains(aktiv) && aktiv !== skall.topp
      ? (aktiv.dataset.status ? '[data-status="' + aktiv.dataset.status + '"]' : aktiv.dataset.panel ? '[data-panel="' + aktiv.dataset.panel + '"]' : aktiv.id ? "#" + aktiv.id : null) : null;

    const stilling = j.lenke
      ? '<a class="detalj__stilling" href="' + esc(j.lenke) + '" target="_blank" rel="noopener noreferrer">' + medPil(j.stilling) + '<span class="skjult"> (åpner annonsen)</span></a>'
      : '<span class="detalj__stilling">' + esc(j.stilling) + '</span>';
    skall.topp.innerHTML = '<div class="detalj__hode">'
        + '<span class="monogram monogram--stor" aria-hidden="true">' + esc(monogram(j.selskap)) + '</span>'
        + '<div class="detalj__hvem"><h2 class="detalj__tittel" id="detaljTittel" tabindex="-1">' + esc(j.selskap) + '</h2>' + stilling + faktaHtml(j, iDag) + '</div>'
        + '<div class="detalj__verktoy">'
          + '<button class="knapp knapp--stille knapp--liten" type="button" data-panel="rediger">Rediger</button>'
          + '<button class="detalj__lukk" type="button" data-panel="lukk" aria-label="Lukk detaljene">' + LUKK_IKON + '</button>'
        + '</div></div>'
      + stegHtml(j, iDag);
    if(nøkkel){
      const igjen = skall.topp.querySelector(nøkkel);
      if(igjen) igjen.focus({ preventScroll: true });
    }
  }

  /* ---------- dokumentet ---------- */

  async function lastDokument(){
    const mitt = ++dokNr, hvem = id;
    dokFeil = null;
    dok = dokumenter.get(hvem) || null;
    oppdaterFane();
    try{
      let d = await Jobbdokumenter.hent(hvem);
      /* Har dokumentet aldri hatt en annonse, ligger den kanskje i brevet
         fra før jobbdokumentet fantes. annonseFor flytter den over én gang. */
      if(!d.annonse?.tekst && !d.annonse?.kilde){
        const a = await Jobbdokumenter.annonseFor(hvem);
        if(a?.tekst) d = { ...d, annonse: a };
      }
      if(mitt !== dokNr || hvem !== id) return;
      dokumenter.set(hvem, d);
      dok = d;
    }catch(e){
      if(mitt !== dokNr || hvem !== id || e?.code === "utlogget") return;
      dokFeil = e;
    }
    tegnTopp();
    oppdaterFane();
  }

  function settDokument(hvem, d){
    dokumenter.set(hvem, d);
    if(hvem !== id) return;
    dok = d; dokFeil = null; dokNr++;
    tegnTopp();
    oppdaterFane();
  }

  function oppdaterFane(){
    if(montert && montert.id === id && deps.jobb(id)) montert.obj.oppdater?.(ktx());
  }

  /* ---------- fanen som står ---------- */

  const api = {
    varsle: (t, angre) => deps.varsle(t, angre),
    melde: t => { skall.melding.textContent = ""; requestAnimationFrame(() => { skall.melding.textContent = t; }); },
    settDokument,
    lastDokument: () => lastDokument(),
    rediger: () => deps.rediger(id),
    slett: () => deps.slett(id),
    lagreNotat: tekst => deps.lagreNotat(id, tekst),
    påLagring: fn => {
      let første = true;
      return deps.påLagring(t => { if(første){ første = false; return; } fn(t); });
    },
    brukernavn: () => deps.brukernavn(),
    get bunn(){ return skall.bunn; },
    åpneFane: (f, h) => åpne(id, { fane: f, hensikt: h }),
    etterSelvlukking: () => { montert = null; iKø(() => vis(id, "oversikt", { erstatt: true })); }
  };

  async function demonter(tvang){
    if(!montert) return true;
    const m = montert;
    if(!tvang){
      let ok = true;
      try{ ok = (await m.obj.lukk?.()) !== false; }catch{ ok = false; }
      if(!ok) return false;
    }
    if(montert === m){ m.obj.rydd?.(); montert = null; }
    skall.bunn.hidden = true;
    skall.bunn.replaceChildren();
    skall.bunn.className = "detalj__bunn";
    skall.flate.className = "detalj__flate";
    return true;
  }

  function monter(){
    const f = FANER.get(fane) || FANER.get("oversikt");
    skall.flate.replaceChildren();
    skall.flate.scrollTop = 0;
    const h = hensikt; hensikt = null;
    montert = { id, fane, obj: f.monter(skall.flate, h ? { ...ktx(), hensikt: h } : ktx(), api) || {} };
  }

  /* Viser søknaden og fanen. Gir false når fanen som står, ikke kunne
     forlates. */
  async function vis(nyId, nyFane, { erstatt = true, push = false } = {}){
    if(!FANER.has(nyFane)) nyFane = "oversikt";
    const sammeId = nyId === id;
    if(montert && (montert.id !== nyId || montert.fane !== nyFane)){
      if(!(await demonter(false))) return false;
    }
    if(!deps.jobb(nyId)) return false;
    const varÅpen = erÅpen();
    if(!skall) byggSkall();
    id = nyId; fane = nyFane;
    if(!sammeId){ dok = dokumenter.get(id) || null; dokFeil = null; }
    tegnFaner();
    tegnTopp();
    if(!montert) monter();
    if(!varÅpen) visFram();
    merkRad();
    if(!sammeId) lastDokument();
    const adresse = "#jobb/" + id + "/" + fane;
    if(location.hash !== adresse){
      if(push) history.pushState(null, "", adresse);
      else if(erstatt) history.replaceState(history.state, "", adresse);
    }
    return true;
  }

  function visFram(){
    el.hidden = false;
    document.body.classList.add("har-detalj");
    settModus();
    requestAnimationFrame(() => el.classList.add("er-apen"));
  }

  /* Ark eller kolonne. Bare arket er en dialog. */
  function settModus(){
    const modal = erÅpen() && !bred.matches;
    if(modal){
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-modal", "true");
      el.removeAttribute("aria-label");
    }else{
      el.setAttribute("role", "complementary");
      el.removeAttribute("aria-modal");
    }
    el.setAttribute("aria-labelledby", "detaljTittel");
    slør.classList.toggle("er-apen", modal);
    deps.etterEndring();
  }

  function merkRad(){
    document.querySelectorAll("#innhold .rad.er-valgt").forEach(r => {
      if(r.dataset.id !== id){ r.classList.remove("er-valgt"); r.removeAttribute("aria-current"); }
    });
    const rad = id && document.querySelector('#innhold .rad[data-id="' + CSS.escape(id) + '"]');
    if(rad){
      rad.classList.add("er-valgt");
      rad.setAttribute("aria-current", "true");
    }
    return rad;
  }

  /* ---------- inn og ut ---------- */

  function åpne(nyId, { fane: ønsket, fra, hensikt: h = null } = {}){
    return iKø(async () => {
      if(!deps.jobb(nyId)) return;
      hensikt = h;
      const varÅpen = erÅpen();
      /* Fanen blir stående når man går fra søknad til søknad, så man kan
         lese annonsene eller tidslinjene etter hverandre. */
      const nyFane = ønsket || (varÅpen ? fane : "oversikt");
      if(!varÅpen) fokusFor = fra || document.activeElement;
      const ok = await vis(nyId, nyFane, { push: !varÅpen, erstatt: varÅpen });
      hensikt = null;
      if(!ok) return;
      if(!varÅpen) presset = true;
      /* Raden skal stå synlig ved siden av panelet; listen kan ha flyttet
         seg da den smalnet. */
      const rad = merkRad();
      if(rad && bred.matches) rad.scrollIntoView({ block: "nearest" });
      if(h && montert?.obj.fokuser) requestAnimationFrame(() => montert?.obj.fokuser?.());
      else fokuserTittel();
    });
  }

  function fokuserTittel(){
    requestAnimationFrame(() => el.querySelector("#detaljTittel")?.focus({ preventScroll: true }));
  }

  /* fraHistorikk: tilbakeknappen har allerede tatt adressen bort.
     tvang: søknaden er borte, eller økten er det; ingen fane får nekte. */
  function lukk({ tvang = false, fraHistorikk = false, slettet = false } = {}){
    return iKø(async () => {
      if(!erÅpen()) return true;
      const var_ = id;
      if(!(await demonter(tvang))){
        if(fraHistorikk) history.pushState(null, "", "#jobb/" + var_ + "/" + fane);
        return false;
      }
      id = null; dokNr++;
      el.classList.remove("er-apen");
      el.hidden = true;
      document.body.classList.remove("har-detalj");
      settModus();
      merkRad();
      if(!fraHistorikk && RUTE.test(location.hash)){
        if(presset) history.back();
        else history.replaceState(history.state, "", location.pathname + location.search);
      }
      presset = false;
      /* Fokus tilbake til raden panelet ble åpnet fra, eller til en rad
         for samme søknad hvis listen er tegnet på nytt siden. */
      const rad = !slettet && document.querySelector('#innhold .rad[data-id="' + CSS.escape(var_) + '"] .rad__selskap');
      const mål = fokusFor && fokusFor.isConnected && !el.contains(fokusFor) ? fokusFor : rad || deps.tilListen();
      fokusFor = null;
      if(mål && !deps.skuffErÅpen()) mål.focus({ preventScroll: !bred.matches });
      return true;
    });
  }

  /* Adressen er sannheten om hva som skal stå. */
  function følgAdressen(){
    const m = location.hash.match(RUTE);
    if(!m){ if(erÅpen()) lukk({ fraHistorikk: true }); return; }
    if(!deps.harData()) return;
    const [, nyId, f] = m;
    if(!deps.jobb(nyId)){
      history.replaceState(history.state, "", location.pathname + location.search);
      if(erÅpen()) lukk({ tvang: true, fraHistorikk: true });
      deps.varsle("Fant ikke søknaden lenken peker til. Den kan være slettet.");
      return;
    }
    if(erÅpen() && nyId === id && (f || "oversikt") === fane) return;
    iKø(async () => {
      const varÅpen = erÅpen();
      if(!varÅpen) fokusFor = document.activeElement;
      if(!(await vis(nyId, f || "oversikt", { erstatt: true }))) return;
      /* En direktelenke kan peke på en søknad listen ikke viser nå. Da
         byttes visningen, så den valgte raden står der ved siden av. */
      if(!varÅpen){
        deps.visRad(nyId);
        const rad = merkRad();
        if(rad) rad.scrollIntoView({ block: "center" });
        fokuserTittel();
      }
    });
  }

  function velgFane(ny, fokus){
    if(ny === fane || !erÅpen()) { if(fokus) skall.faner.querySelector('[data-fane="' + ny + '"]')?.focus({ preventScroll: true }); return; }
    iKø(async () => {
      await vis(id, ny, { erstatt: true });
      if(fokus) skall.faner.querySelector('[data-fane="' + fane + '"]')?.focus({ preventScroll: true });
    });
  }

  /* ---------- hendelser ---------- */

  el.addEventListener("click", e => {
    const t = e.target.closest("[data-panel],.detalj__fane");
    if(!t || !el.contains(t)) return;
    /* Fanene eier sin egen flate. Brevflaten bruker både data-panel og
       data-fane til sitt eget, så bare panelets slett-knapp tas her. */
    if(skall.flate.contains(t) && t.dataset.panel !== "slett") return;
    if(t.classList.contains("detalj__fane")){ velgFane(t.dataset.fane, false); return; }
    const hva = t.dataset.panel;
    if(hva === "lukk") lukk();
    else if(hva === "rediger") deps.rediger(id);
    else if(hva === "slett") deps.slett(id);
    else if(hva === "status"){
      if(t.getAttribute("aria-disabled") === "true") return;
      deps.settStatus(id, t.dataset.status);
    }
  });

  el.addEventListener("keydown", e => {
    const tab = e.target.closest && e.target.closest('[role="tab"].detalj__fane');
    if(tab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)){
      e.preventDefault();
      const ider = Array.from(FANER.keys());
      const i = ider.indexOf(tab.dataset.fane);
      const n = e.key === "Home" ? 0 : e.key === "End" ? ider.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + ider.length) % ider.length;
      velgFane(ider[n], true);
    }
  });

  /* Arket holder fokus inni seg, som skuffen gjør. */
  document.addEventListener("keydown", e => {
    if(e.key !== "Tab" || !erÅpen() || bred.matches || deps.skuffErÅpen()) return;
    const f = Array.from(el.querySelectorAll(FOKUSERBARE)).filter(x => x.getClientRects().length && getComputedStyle(x).visibility !== "hidden");
    if(!f.length) return;
    const første = f[0], siste = f[f.length - 1];
    if(e.shiftKey && (document.activeElement === første || !el.contains(document.activeElement))){ e.preventDefault(); siste.focus(); }
    else if(!e.shiftKey && (document.activeElement === siste || !el.contains(document.activeElement))){ e.preventDefault(); første.focus(); }
  });

  slør.addEventListener("click", () => lukk());
  addEventListener("hashchange", følgAdressen);
  bred.addEventListener("change", () => { if(erÅpen()) settModus(); });

  aktivt = {
    fanerEndret(){ if(skall && erÅpen()) tegnFaner(); },
    oppdaterDokument(hvem, d){
      if(d){ settDokument(hvem ?? d.jobbId, d); return; }
      if(hvem) dokumenter.delete(hvem); else dokumenter.clear();
      if(erÅpen() && (!hvem || hvem === id)) lastDokument();
    }
  };

  return {
    åpne,
    lukk,
    erÅpen,
    erModal: () => erÅpen() && !bred.matches,
    valgtId: () => id,
    fokuser: fokuserTittel,
    oppdaterDokument: (hvem, d) => aktivt.oppdaterDokument(hvem, d),
    /* Kalles hver gang listen er tegnet. */
    oppdater(){
      if(!erÅpen()){ if(RUTE.test(location.hash)) følgAdressen(); return; }
      if(!deps.jobb(id)){ lukk({ tvang: true, slettet: true }); return; }
      merkRad();
      tegnTopp();
      oppdaterFane();
    }
  };
}
