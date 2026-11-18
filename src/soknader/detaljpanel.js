import * as Jobbdokumenter from "../stilling/jobbdokumenter.js";
import { åpneBrevflate } from "../brev/brevflate.js";
import { STATUSER, SEKTORER, JOBBTYPER } from "../felles/felles.mjs";
import { dagerSidenSendt } from "./hendelser.mjs";
import { matchUtdatert } from "../stilling/jobbdokument.mjs";
import { esc, monogram, omTekst, hast, datoMedÅr, ukedag, antall, tilIso } from "../felles/formater.js";
import { tidslinjeHtml, stegdatoer, lengstKommet, datoTekst, LØP, UTGANGER } from "./tidslinje.js";
import { monterAnnonse } from "../stilling/annonseflate.js";
import { monterIntervju, intervjuMerke } from "../intervju/intervjuflate.js";

const FANER = new Map();
function registrerFane(id, { navn, monter, merke = null }){
  if(!/^[a-z]{1,20}$/.test(id)) throw new Error("Fane-id-en må være små bokstaver.");
  FANER.set(id, { navn, monter, merke });
  aktivt?.fanerEndret();
}

let aktivt = null;
export function oppdaterDokument(id, dok){ aktivt?.oppdaterDokument(id, dok); }

const ALVOR = { hoy: "viktig", middels: "middels", lav: "lite viktig" };

const UTDATERT_GRUNN = { cvRevisjon: "CV-en er endret siden vurderingen.", annonseSjekksum: "Annonsen er endret siden vurderingen.",
  promptversjon: "Vurderingen er gjort med en eldre metode." };

function matchHtml(ktx, tilst = {}){
  if(!ktx.dok && !ktx.dokFeil) return '<p class="detalj__tomt detalj__tomt--venter">Henter vurderingen…</p>';
  const m = ktx.dok?.match;
  const harAnnonse = !!ktx.dok?.annonse?.tekst;
  const knapp = '<button class="knapp knapp--liten knapp--stille match__knapp" type="button" data-match="vurder"'
    + (tilst.laster ? ' aria-busy="true"' : "") + (tilst.laster || !harAnnonse ? " disabled" : "") + '>'
    + (tilst.laster ? "Vurderer…" : m ? "Vurder på nytt" : "Vurder") + '</button>';
  const feil = tilst.feil ? '<p class="match__feil" role="alert">' + esc(tilst.feil) + '</p>' : "";
  if(!m) return '<p class="detalj__tomt">Ingen vurdering av hvor godt stillingen passer ennå.'
    + (harAnnonse ? "" : " Den bygger på annonsen, så lagre den først.") + '</p>'
    + '<div class="match__rad">' + knapp + '</div>' + feil;
  const utdatert = tilst.utdatert || [];
  const punkt = (tittel, liste, fn) => liste.length
    ? '<div class="match__del"><p class="match__deltittel">' + tittel + '</p><ul class="match__liste">' + liste.map(fn).join("") + '</ul></div>' : "";
  return '<div class="match' + (utdatert.length ? " match--utdatert" : "") + '">'
    + '<p class="match__tall"><span class="match__prosent">' + m.prosent + ' %</span>'
      + (m.oppsummering ? '<span class="match__sammendrag">' + esc(m.oppsummering) + '</span>' : "") + '</p>'
    + (utdatert.length ? '<p class="match__utdatert">Utdatert. ' + utdatert.map(k => UTDATERT_GRUNN[k]).filter(Boolean).join(" ") + '</p>' : "")
    + punkt("Styrker", m.styrker, s => '<li><b>' + esc(s.krav) + '</b>' + (s.bevis ? ' <span>' + esc(s.bevis) + '</span>' : "") + '</li>')
    + punkt("Mangler", m.mangler, x => '<li><b>' + esc(x.krav) + '</b> <span class="match__alvor">' + (ALVOR[x.alvor] || "") + '</span></li>')
    + '</div><div class="match__rad">' + knapp + '</div>' + feil;
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

  let matchTilst = { laster: false, feil: null }, grunnlag = null, ryddet = false;
  const lastGrunnlag = () => Jobbdokumenter.matchGrunnlag().then(g => { if(!ryddet){ grunnlag = g; tegn(); } }).catch(() => {});
  async function vurder(){
    const hvem = k.jobb.id;
    matchTilst = { laster: true, feil: null }; tegn();
    api.melde("Vurderer hvor godt stillingen passer");
    try{
      const d = await Jobbdokumenter.vurderMatch(hvem, { tving: true });
      api.settDokument(hvem, d);
      api.melde("Vurderingen er ferdig");
      matchTilst = { laster: false, feil: null };
    }catch(e){
      matchTilst = { laster: false, feil: e?.code === "utlogget" ? null : (e?.message || "Fikk ikke vurdert stillingen. Prøv igjen.") };
    }
    if(ryddet) return;
    tegn(); lastGrunnlag();
  }
  del("match").addEventListener("click", e => { if(e.target.closest('[data-match="vurder"]') && !matchTilst.laster) vurder(); });
  lastGrunnlag();

  function tegn(){
    del("match").innerHTML = matchHtml(k, { ...matchTilst, utdatert: grunnlag ? matchUtdatert(k.dok, grunnlag) : [] });
    del("tid").innerHTML = tidslinjeHtml(k.jobb, k.iDag);
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
    rydd(){ ryddet = true; clearTimeout(tid); avmeld(); }
  };
}

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
    fokuser: () => brev.fokuser(),
    oppdater: ny => { if(!ryddet) brev.oppdater(ny); },
    lukk: () => (ryddet ? true : brev.lukk()),
    rydd(){ if(!ryddet){ ryddet = true; brev.rydd(); } api.bunn.hidden = true; }
  };
}

registrerFane("oversikt", { navn: "Oversikt", monter: monterOversikt });
registrerFane("annonse",  { navn: "Annonse",  monter: monterAnnonse });
registrerFane("intervju", { navn: "Intervju", monter: monterIntervju, merke: intervjuMerke });
registrerFane("brev",     { navn: "Brev",     monter: monterBrev });

function medPil(tekst){
  const t = String(tekst).trim(), i = t.lastIndexOf(" ");
  return esc(t.slice(0, i + 1)) + '<span class="ubrutt">' + esc(t.slice(i + 1)) + '<span class="rad__pil" aria-hidden="true">↗</span></span>';
}

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
  let montert = null;
  let presset = false;
  let fokusFor = null;
  let hensikt = null;
  let kø = Promise.resolve();
  let skall = null;

  const iKø = fn => (kø = kø.then(fn, fn));

  const ktx = () => ({ jobb: deps.jobb(id), dok, dokFeil, iDag: deps.iDag() });
  const erÅpen = () => id !== null;

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
      + esc(f.navn) + (f.merke ? '<span class="detalj__fanemerke" data-fanemerke="' + fid + '"></span>' : "") + '</button>').join("");
    skall.flate.setAttribute("aria-labelledby", "detaljFane-" + fane);
    el.dataset.fane = fane;
    tegnFanemerker();
  }

  function tegnFanemerker(){
    const j = id && deps.jobb(id);
    if(!j) return;
    skall.faner.querySelectorAll("[data-fanemerke]").forEach(m => {
      const r = FANER.get(m.dataset.fanemerke)?.merke?.(j, deps.iDag());
      const html = r ? '<span class="skjult">, </span><span aria-hidden="true">' + esc(r.tekst) + '</span><span class="skjult">' + esc(r.sr) + '</span>' : "";
      if(m.innerHTML !== html) m.innerHTML = html;
      m.hidden = !r;
    });
  }

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

  async function lastDokument(){
    const mitt = ++dokNr, hvem = id;
    dokFeil = null;
    dok = dokumenter.get(hvem) || null;
    oppdaterFane();
    try{
      let d = await Jobbdokumenter.hent(hvem);
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
    endreIntervjuer: regel => deps.endreIntervjuer(id, regel),
    ventPåLagring: () => deps.ventPåLagring(),
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

  function åpne(nyId, { fane: ønsket, fra, hensikt: h = null } = {}){
    return iKø(async () => {
      if(!deps.jobb(nyId)) return;
      hensikt = h;
      const varÅpen = erÅpen();
      const nyFane = ønsket || (varÅpen ? fane : "oversikt");
      if(!varÅpen) fokusFor = fra || document.activeElement;
      const ok = await vis(nyId, nyFane, { push: !varÅpen, erstatt: varÅpen });
      hensikt = null;
      if(!ok) return;
      if(!varÅpen) presset = true;
      const rad = merkRad();
      if(rad && bred.matches) rad.scrollIntoView({ block: "nearest" });
      if(h && montert?.obj.fokuser) requestAnimationFrame(() => montert?.obj.fokuser?.());
      else fokuserTittel();
    });
  }

  function fokuserTittel(){
    requestAnimationFrame(() => el.querySelector("#detaljTittel")?.focus({ preventScroll: true }));
  }

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
      const rad = !slettet && document.querySelector('#innhold .rad[data-id="' + CSS.escape(var_) + '"] .rad__selskap');
      const mål = fokusFor && fokusFor.isConnected && !el.contains(fokusFor) ? fokusFor : rad || deps.tilListen();
      fokusFor = null;
      if(mål && !deps.skuffErÅpen()) mål.focus({ preventScroll: !bred.matches });
      return true;
    });
  }

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

  el.addEventListener("click", e => {
    const t = e.target.closest("[data-panel],.detalj__fane");
    if(!t || !el.contains(t)) return;
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
    oppdater(){
      if(!erÅpen()){ if(RUTE.test(location.hash)) følgAdressen(); return; }
      if(!deps.jobb(id)){ lukk({ tvang: true, slettet: true }); return; }
      merkRad();
      tegnTopp();
      tegnFanemerker();
      oppdaterFane();
    }
  };
}
