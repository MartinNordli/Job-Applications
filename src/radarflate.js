/* ============================================================
   Radar-visningen: innstillingene, «Søk nå» og innboksen.

   Visningen eier sin egen DOM inni #innhold og sine egne lyttere, som
   detaljpanelet. Alt den trenger fra listen (søknadene, lagringen,
   panelet, varselet), får den fra app.js gjennom `api`, så den aldri
   leser modultilstanden der direkte. Radar selv nås bare gjennom
   src/radarklient.js.

   Oppbyggingen, ovenfra:
   - Kontrollraden: hva Radar gjør nå, og «Søk nå».
   - Innstillingene i ett kort som kan foldes. Det står åpent til Radar
     har søkeord, og sammenfoldet når den er i gang. Ordlistene, terskelen,
     kildene og døgntaket er et utkast som lagres med én knapp; av og på
     og karrieresidene lagres med en gang, fordi de har egne veier inn.
   - Merknadene: det som stopper Radar (CV, nøkkel), det som gjør den
     dyr (ingen søkeord) og kilder som feilet ved siste søk.
   - Innboksen i to bånd, «Nye» og «Lagt til», i samme materiale som
     listen. Prosenten står i venstrekolonnen, der listen har datoen:
     den er det man skanner etter.

   Kulør følger resten av appen: en frist som haster, og ingenting
   annet. Prosenten er opplysning og står i samme dempede merke som
   matchen på raden. Det som har feilet, sies med ord.
   ============================================================ */
import * as Radar from "./radarklient.js";
import * as Brev from "./brev.js";
import { påCvEndring, harCvTekst } from "./cvflate.js";
import * as Varsling from "./varsling.js";
import { valgtLeverandør } from "./jobbdokumenter.js";
import * as F from "./formater.js";
import { esc, antall, vert, MND_K } from "./formater.js";

/* Fylkene med fylkesnummeret fra 2024, som Jobbnorge får som «county».
   Et nummer i radar.json som ikke står her, vises som det er. */
const FYLKER = [
  [42, "Agder"], [32, "Akershus"], [33, "Buskerud"], [56, "Finnmark"], [34, "Innlandet"],
  [15, "Møre og Romsdal"], [18, "Nordland"], [3, "Oslo"], [11, "Rogaland"], [40, "Telemark"],
  [55, "Troms"], [50, "Trøndelag"], [39, "Vestfold"], [46, "Vestland"], [31, "Østfold"]
];
const FYLKENAVN = new Map(FYLKER);

const KILDENAVN = { nav: "NAV", jobbnorge: "Jobbnorge", greenhouse: "Greenhouse", lever: "Lever",
  teamtailor: "Teamtailor", jsonld: "Karriereside" };

const LISTER = {
  sokeord:   { navn: "Søkeord", ent: "søkeord", fl: "søkeord", plass: "Legg til søkeord",
               hjelp: "Minst ett må stå i tittelen eller annonsen. «data» treffer også «Dataingeniør»." },
  steder:    { navn: "Steder", ent: "sted", fl: "steder", plass: "Legg til sted",
               hjelp: "Tomt betyr hele landet. En annonse uten sted slipper alltid gjennom." },
  ekskluder: { navn: "Ekskluderte ord", ent: "ekskludert ord", fl: "ekskluderte ord", plass: "Legg til ord",
               hjelp: "Står ordet i tittelen eller selskapsnavnet, hoppes stillingen over." }
};

/* Samme skala som matchen i panelet. */
const SKALA = p => p >= 90 ? "alle krav, med bevis i CV-en"
  : p >= 70 ? "kravene er oppfylt"
  : p >= 50 ? "kravene er delvis oppfylt"
  : "også når et sentralt krav mangler";

const ANGRETID = 7000;
const PIL = '<svg class="baand__pil" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="m3.5 2 3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const KRYSS = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

const DØGN = 86_400_000;
const tallTekst = n => Number(n).toLocaleString("nb-NO");
/* Et tall brytes ikke bort fra ordet eller prosenttegnet etter. */
const bind = s => s.replace(/(\d|<\/span>) (?=[\p{L}%])/gu, "$1\u00a0");

/* Det som avgjør om Radar søker gjennom alle aktive på nytt, grovt brettet.
   Serveren bretter grundigere, så et lite avvik gir bare en tekst for mye. */
const søkeavtrykk = i => {
  const l = v => [...new Set((v ?? []).map(o => String(o).trim().toLocaleLowerCase("nb")))].sort();
  return JSON.stringify([l(i.sokeord), l(i.ekskluder), l(i.steder), [...(i.kilder?.jobbnorge?.fylker ?? [])].sort((a, b) => a - b)]);
};

/* Hva én kjøring gjorde, i én setning. Søket gjennom alle aktive sier
   hvor mange det gikk gjennom; oppfølgingen sier hvor mange som var nye.
   tall formaterer hvert tall (ren tekst i statuslinjen, et mono-spenn i
   listen), og terskel er med bare når den er den kjøringen brukte.
   Kjøringer fra før passet fantes, sier bare hvor mange som ble vurdert. */
function kjøringstekst(k, { tall: t = tallTekst, tid = "", terskel = null } = {}){
  const hentet = k.kandidater ?? 0, vurdert = k.vurdert ?? 0, treff = k.treff ?? 0, passet = k.passet;
  const deler = [];
  if(hentet && passet != null) deler.push(passet ? t(passet) + " passet søkeordene" : "ingen passet søkeordene");
  if(vurdert){
    deler.push(t(vurdert) + (passet === 0 ? " vurdert fra køen" : " vurdert"));
    deler.push(terskel != null ? (treff ? t(treff) : "ingen") + " nådde " + t(terskel) + " %" : treff ? t(treff) + " treff" : "ingen treff");
  }else if(passet && !k.nye) deler.push("alle var sett før");
  const resten = deler.join(", ");
  if(k.kilder?.some(s => s.sok))
    return (hentet ? "Søkte gjennom " + t(hentet) + (hentet === 1 ? " aktiv stilling" : " aktive stillinger") : "Fant ingen aktive stillinger")
      + (tid ? " " + tid : "") + "."
      + (resten ? " " + resten[0].toLocaleUpperCase("nb") + resten.slice(1) + "." : "");
  const nye = hentet ? t(hentet) + (hentet === 1 ? " ny stilling" : " nye stillinger") : "ingen nye stillinger";
  const setning = [nye, resten].filter(Boolean).join(", ");
  return (tid ? tid + ": " + setning : setning[0].toLocaleUpperCase("nb") + setning.slice(1)) + ".";
}

const to = n => String(n).padStart(2, "0");
const klokke = d => to(d.getHours()) + ":" + to(d.getMinutes());

export function lagRadarflate(api){
  let t = null, tSignatur = ""; /* tilstanden fra klienten */
  let lastFeil = null;          /* tilstanden kunne ikke leses */
  let rot = null;               /* #radar når visningen står */
  let utkast = null;            /* innstillingene som ikke er lagret, eller null */
  let foreslått = new Set();    /* ord forslaget la til, til de er lagret */
  let skriver = { sokeord: "", steder: "", ekskluder: "" };
  let innstÅpen = null;         /* null: følg regelen; ellers brukerens valg */
  let lagrer = false, lagreFeil = "";
  let forslag = { går: false, tekst: "", feil: null };
  let side = { går: false, url: "", feil: "" };
  let søk = { går: false, start: 0, tekst: "", feil: false };
  let grunnlag = { cv: null, nøkkel: null };   /* null: ukjent */
  let stoppTimeplan = null, avmeld = null, avmeldCv = null, profil = null;
  let klokketimer = null, pollTimer = null, grunnlagTimer = null;
  let søkEndret = 0;             /* når søkeordene, stedene eller fylkene sist ble lagret på nytt */
  const utsatt = new Map();     /* «Ikke interessert» som venter på angrefristen */
  const legger = new Set();     /* rader som legges til nå */
  const slårPå = new Set();     /* karrieresider som slås på igjen nå */
  const jobbFor = new Map();    /* radId → jobbId der annonsen ikke ble lagret */

  /* ---------- tilstand ---------- */

  const innstillinger = () => t?.innstillinger ?? null;
  const fraTilstand = () => {
    const i = innstillinger();
    return { sokeord: [...i.sokeord], steder: [...i.steder], ekskluder: [...i.ekskluder], terskel: i.terskel,
      maksVurderingerPerDogn: i.maksVurderingerPerDogn,
      kilder: { nav: { pa: i.kilder.nav.pa }, jobbnorge: { pa: i.kilder.jobbnorge.pa, fylker: [...i.kilder.jobbnorge.fylker] } } };
  };
  const gjeldende = () => utkast ?? fraTilstand();
  const endret = () => !!utkast && JSON.stringify(utkast) !== JSON.stringify(fraTilstand());
  const rediger = fn => { if(!utkast) utkast = fraTilstand(); fn(utkast); if(!endret()){ utkast = null; foreslått = new Set(); } };

  const nye = () => (t?.innboks ?? []).filter(r => r.status === "ny" && !utsatt.has(r.id));
  const lagtTil = () => (t?.innboks ?? []).filter(r => r.status !== "ny");
  const antallNye = () => t ? nye().length : null;

  /* Søknaden en rad ble til. Lenken er annonsens adresse, og står i
     søknaden slik soknadFraRad la den dit. */
  function søknadFor(rad){
    const kjent = jobbFor.get(rad.id);
    const jobber = api.jobber();
    if(kjent && jobber.some(j => j.id === kjent)) return kjent;
    const url = String(rad.url || "").replace(/\/+$/, "");
    return jobber.find(j => String(j.lenke || "").replace(/\/+$/, "") === url)?.id ?? null;
  }

  function settTilstand(ny){
    if(!ny) return;
    if(t && typeof ny.revisjon === "number" && ny.revisjon < t.revisjon) return;
    /* Samme tilstand tegnes ikke på nytt: en knapp som byttes ut mellom
       trykk og slipp, mister klikket. */
    const signatur = JSON.stringify(ny);
    if(signatur === tSignatur && !lastFeil) return;
    tSignatur = signatur;
    t = ny;
    lastFeil = null;
    if(utkast && !endret()){ utkast = null; foreslått = new Set(); }
    api.etterEndring();
    følgKjøring();
    tegn();
  }

  /* En kjøring som ikke er vår (en annen fane, eller serverens time),
     følges med et oppslag hvert tiende sekund mens visningen står. */
  function følgKjøring(){
    clearTimeout(pollTimer);
    if(!t?.kjorerNa || søk.går || !rot) return;
    pollTimer = setTimeout(async () => {
      try{ settTilstand(await Radar.hentTilstand()); }catch{ /* neste forsøk når visningen tegnes */ }
    }, 10_000);
  }

  async function lastGrunnlag(){
    const hvem = profil;
    const [cv, nøkkel] = await Promise.allSettled([Brev.hentCv(), Brev.nokkelStatus(valgtLeverandør())]);
    if(hvem !== profil) return;
    grunnlag = {
      cv: cv.status === "fulfilled" ? !!cv.value?.tekst?.trim() : null,
      nøkkel: nøkkel.status === "fulfilled" ? !!nøkkel.value?.finnes : null
    };
    tegnMerknader();
    /* CV-en og nøkkelen legges inn i panelet ved siden av. Mens noe
       mangler og visningen står, sjekkes det igjen av og til, så
       merknaden går bort uten at man må bytte visning. */
    clearTimeout(grunnlagTimer);
    if(rot && (grunnlag.cv === false || grunnlag.nøkkel === false)) grunnlagTimer = setTimeout(lastGrunnlag, 15_000);
  }

  async function last(){
    try{ settTilstand(await Radar.hentTilstand()); }
    catch(e){
      if(e?.code === "utlogget") return;
      lastFeil = e?.message || "Fikk ikke lest Radar.";
      tegn();
    }
  }

  /* ---------- livsløpet ---------- */

  function start(brukerId){
    stopp();
    profil = brukerId;
    avmeld = Radar.påEndring(settTilstand);
    /* En CV lagt inn under Innstillinger eller i Brev-fanen tar bort
       merknaden med en gang, og feilen fra et forslag som manglet den. */
    avmeldCv = påCvEndring(cv => {
      grunnlag = { ...grunnlag, cv: harCvTekst(cv?.tekst) };
      if(grunnlag.cv && forslag.feil?.code === "mangler-cv") forslag = { ...forslag, feil: null };
      if(grunnlag.cv && !søk.går && /CV-en/.test(søk.tekst)) søk = { ...søk, tekst: "", feil: false };
      tegn();
    });
    last();
    lastGrunnlag();
    startTimeplan();
  }
  function startTimeplan(){
    stoppTimeplan?.();
    stoppTimeplan = Radar.startTimeplan({
      påResultat: svar => { if(!søk.går) visSvar(svar); },
      påFeil: e => { søk = { ...søk, tekst: e?.message || "Radar stoppet uventet.", feil: true }; tegnStatus(); }
    });
  }
  function stopp(){
    stoppTimeplan?.(); stoppTimeplan = null;
    avmeld?.(); avmeld = null;
    avmeldCv?.(); avmeldCv = null;
    clearTimeout(pollTimer); clearTimeout(grunnlagTimer); clearInterval(klokketimer);
    for(const id of [...utsatt.keys()]) fullførIkkeInteressert(id);
  }

  /* ---------- visningen ---------- */

  function vis(beholder){
    const ny = !rot || !beholder.contains(rot);
    if(ny){
      beholder.innerHTML = '<div class="radar" id="radar"></div>';
      rot = beholder.querySelector("#radar");
      rot.addEventListener("click", klikk);
      rot.addEventListener("input", input);
      rot.addEventListener("change", endring);
      rot.addEventListener("keydown", tast);
      rot.addEventListener("paste", lim);
      rot.addEventListener("toggle", e => { if(e.target.id === "radarInnst") innstÅpen = e.target.open; }, true);
      if(t) lastGrunnlag();
      if(t) Radar.hentTilstand().then(settTilstand, () => {});
      tegn();
    }else tegnInnboks();
  }
  function skjul(){ rot = null; clearTimeout(pollTimer); clearTimeout(grunnlagTimer); }

  /* Alt tegnes på nytt, og fokus settes tilbake på det elementet som
     hadde det, gjenkjent på data-fokus. */
  function medFokus(fn){
    const a = document.activeElement;
    const nøkkel = rot?.contains(a) ? a.dataset.fokus : null;
    const valg = nøkkel && "selectionStart" in a && a.type !== "range" && a.type !== "number" ? [a.selectionStart, a.selectionEnd] : null;
    fn();
    if(!nøkkel) return;
    const b = rot.querySelector('[data-fokus="' + CSS.escape(nøkkel) + '"]');
    if(b && !b.disabled){ b.focus({ preventScroll: true }); if(valg) try{ b.setSelectionRange(...valg); }catch{} }
  }

  function tegn(){
    if(!rot) return;
    medFokus(() => {
      if(!t){
        rot.innerHTML = lastFeil
          ? '<div class="tomt"><p class="tomt__tittel">Radar kunne ikke leses</p><p class="tomt__tekst">' + esc(lastFeil) + '</p>'
            + '<button class="knapp" type="button" data-radar="last" data-fokus="last">Prøv igjen</button></div>'
          : '<p class="radar__laster henter">Henter Radar…</p>';
        return;
      }
      const på = innstillinger().pa;
      rot.innerHTML = (på ? kontrollHtml() : introHtml())
        + '<div class="radar__merknader" id="radarMerknader">' + merknaderHtml() + '</div>'
        + innstillingerHtml()
        + '<div id="radarInnboks">' + innboksHtml() + '</div>';
    });
    tegnKlokke();
  }
  function tegnMerknader(){
    const el = rot?.querySelector("#radarMerknader");
    if(el) medFokus(() => { el.innerHTML = merknaderHtml(); });
  }
  function tegnInnboks(){
    const el = rot?.querySelector("#radarInnboks");
    if(el) medFokus(() => { el.innerHTML = innboksHtml(); });
    api.etterEndring();
  }
  function tegnStatus(){
    const el = rot?.querySelector("#radarStatus");
    if(el) el.textContent = bind(statustekst());
    const k = rot?.querySelector("#radarSokNa");
    if(k){ k.disabled = søk.går || !!t?.kjorerNa; k.textContent = søk.går || t?.kjorerNa ? "Søker…" : "Søk nå"; }
    rot?.querySelector(".radar__kontroll")?.toggleAttribute("data-soker", søk.går || !!t?.kjorerNa);
    rot?.querySelector(".radar__kontroll")?.toggleAttribute("data-feil", søk.feil && !søk.går);
    tegnKlokke();
  }

  /* ---------- kontrollraden ---------- */

  function sisteKjøring(){ return t?.kjoringer?.[0] ?? null; }
  function når(iso){
    const d = new Date(iso);
    if(Number.isNaN(d.getTime())) return "";
    const iDag = api.iDag();
    const dag = new Date(d.toDateString());
    const diff = Math.round((iDag - dag) / 86400000);
    return (diff === 0 ? "i dag" : diff === 1 ? "i går" : d.getDate() + ". " + MND_K[d.getMonth()]) + " " + klokke(d);
  }
  const tidHtml = iso => '<time class="radar__tid" datetime="' + esc(iso) + '">' + esc(når(iso)) + '</time>';
  /* Kildene neste kjøring søker gjennom alle aktive stillinger hos, med
     samme regel som skalSøke i radarlogikk.mjs så langt tilstanden viser
     den: søket er aldri gjort, NAV-søket er ikke ferdig, Jobbnorge er
     søkt for over et døgn siden, NAV har ikke hentet på tre døgn, eller
     søkeordene, stedene eller fylkene er lagret på nytt siden siste
     kjøring. Fingeravtrykket ligger ikke i tilstanden, så det siste
     vet bare denne fanen. */
  function søkerAlle(){
    const i = innstillinger();
    if(!i?.sokeord?.length) return [];
    const nå = Date.now(), siste = sisteKjøring();
    const endretSiden = søkEndret && (!siste || Date.parse(siste.start) < søkEndret);
    const ut = [];
    const nav = t.kilder?.nav ?? {}, jn = t.kilder?.jobbnorge ?? {};
    if(i.kilder.nav.pa && (endretSiden || !nav.sokFerdig || nav.sokPagar || !nav.sist || nå - Date.parse(nav.sist) >= 3 * DØGN)) ut.push("NAV");
    if(i.kilder.jobbnorge.pa && (endretSiden || !jn.sokFerdig || nå - Date.parse(jn.sokFerdig) >= DØGN)) ut.push("Jobbnorge");
    return ut;
  }
  const og = liste => liste.length > 1 ? liste.slice(0, -1).join(", ") + " og " + liste.at(-1) : liste.join("");

  /* Det som venter i køen, sagt med det som avgjør når det tas. */
  function ventertekst(n, når = " og tas ved neste søk"){
    if(!n) return "";
    const f = t?.forbruk;
    return " " + tallTekst(n) + " venter på vurdering" + (f && f.vurderinger >= f.tak ? ". Døgntaket er nådd, så de tas i morgen." : når + ".");
  }
  const fortsettertekst = (når = "ved neste kjøring") => t?.kilder?.nav?.sokPagar && innstillinger()?.kilder.nav.pa
    ? " Søket gjennom NAV fortsetter " + når + "." : "";

  function statustekst(){
    if(søk.går){
      const alle = søk.alle ?? [];
      return alle.length
        ? "Søker gjennom alle aktive stillinger hos " + og(alle) + " og vurderer det som passer. Det tar gjerne et minutt."
        : "Ser etter nye stillinger og vurderer det som passer.";
    }
    if(t?.kjorerNa) return "Radar søker nå, startet fra en annen fane eller fra serveren.";
    if(søk.tekst) return søk.tekst;
    const s = sisteKjøring();
    if(!s) return "Ikke søkt ennå. Første søk starter av seg selv mens Hired er åpen.";
    const neste = new Date(Date.parse(s.start) + Radar.TIME);
    return "Sist søkt " + når(s.start) + ". Søker igjen rundt " + klokke(neste) + " mens Hired er åpen."
      + (fortsettertekst("da") || (søkerAlle().length ? " Neste søk går gjennom alle aktive stillinger." : ""))
      + ventertekst(t.venter ?? 0, "");
  }
  function kontrollHtml(){
    const går = søk.går || !!t.kjorerNa;
    return '<div class="radar__kontroll"' + (går ? " data-soker" : "") + (søk.feil && !går ? " data-feil" : "") + '>'
      + '<p class="radar__status" id="radarStatus" role="status" aria-live="polite">' + esc(bind(statustekst())) + '</p>'
      + '<span class="radar__klokke" id="radarKlokke" aria-hidden="true"></span>'
      + '<button class="knapp knapp--liten radar__sok" type="button" id="radarSokNa" data-radar="sok" data-fokus="sok"'
      + (går ? " disabled" : "") + '>' + (går ? "Søker…" : "Søk nå") + '</button></div>';
  }
  function tegnKlokke(){
    clearInterval(klokketimer);
    const el = rot?.querySelector("#radarKlokke");
    if(!el) return;
    const vis = () => {
      if(!søk.går){ el.textContent = ""; return; }
      const s = Math.floor((Date.now() - søk.start) / 1000);
      el.textContent = Math.floor(s / 60) + ":" + to(s % 60);
    };
    vis();
    if(søk.går) klokketimer = setInterval(vis, 1000);
  }

  function introHtml(){
    return '<section class="kort radar__intro" aria-labelledby="radarIntroTittel">'
      + '<h3 class="radar__introtittel" id="radarIntroTittel">Radar er av</h3>'
      + '<p class="radar__introtekst">Radar ser etter nye stillinger hos NAV, Jobbnorge og karrieresider du legger inn, '
      + 'og sorterer bort det som ikke treffer søkeordene og stedene dine. Resten vurderes mot CV-en din, '
      + 'og det som passer godt nok, havner her, med et varsel.</p>'
      + '<p class="radar__introtekst radar__introtekst--liten">Den søker hver time mens Hired er åpen. '
      + 'CV-en og teksten i annonsene som passerer sorteringen, sendes til modellleverandøren din. '
      + 'En kjøring koster noen få øre.</p>'
      + '<button class="knapp knapp--primar" type="button" data-radar="pa" data-fokus="pa">Slå på Radar</button></section>';
  }

  /* ---------- innstillingene ---------- */

  function sammendrag(){
    const g = gjeldende(), i = innstillinger();
    const kilder = [];
    if(g.kilder.nav.pa) kilder.push("NAV");
    if(g.kilder.jobbnorge.pa) kilder.push("Jobbnorge");
    const sider = i.karrieresider.filter(s => s.pa).length;
    if(sider) kilder.push(antall(sider, "karriereside", "karrieresider"));
    const deler = [
      i.pa ? "På" : "Av",
      g.sokeord.length ? antall(g.sokeord.length, "søkeord", "søkeord") : "ingen søkeord",
      g.steder.length ? antall(g.steder.length, "sted", "steder") : "hele landet",
      "fra " + g.terskel + " %",
      kilder.length ? kilder.join(", ").replace(/, ([^,]*)$/, " og $1") : "ingen kilder"
    ];
    return deler.join(" · ") + (endret() ? " · ikke lagret" : "");
  }

  function innstillingerHtml(){
    const i = innstillinger(), g = gjeldende();
    const åpen = innstÅpen ?? (i.pa && !g.sokeord.length);
    return '<details class="kort radarinnst" id="radarInnst"' + (åpen ? " open" : "") + '>'
      + '<summary class="radarinnst__topp" data-fokus="innst">' + PIL
        + '<h3 class="radarinnst__tittel">Innstillinger</h3>'
        + '<span class="radarinnst__sammendrag" id="radarSammendrag">' + esc(sammendrag()) + '</span></summary>'
      + '<div class="radarinnst__kropp">'
        + delHtml("Radar", '<label class="avkrys"><input type="checkbox" data-radar="paav" data-fokus="paav"' + (i.pa ? " checked" : "") + '> Søk etter nye stillinger hver time</label>'
          + '<p class="felt__hjelp">' + esc(varselhjelp(i.pa)) + '</p>')
        + delHtml("Hva Radar ser etter", ordlisteHtml("sokeord", g) + forslagHtml() + ordlisteHtml("steder", g) + ordlisteHtml("ekskluder", g))
        + delHtml("Terskel", terskelHtml(g))
        + delHtml("Kilder", kilderHtml(g) + siderHtml())
        + delHtml("Forbruk i dag", forbrukHtml(g))
        + delHtml("Siste kjøringer", kjøringerHtml())
      + '</div>'
      + lagrelinjeHtml()
      + '</details>';
  }
  const delHtml = (tittel, innhold) => '<section class="radarinnst__del"><h4 class="merkelinje radarinnst__deltittel">' + tittel + '</h4>'
    + '<div class="radarinnst__innhold">' + innhold + '</div></section>';

  function varselhjelp(på){
    const v = Varsling.tillatelse();
    if(!på) return "Av. Innboksen blir stående, men Radar leter ikke etter nye stillinger.";
    if(v === "app") return "Nye treff kommer som Mac-varsel.";
    if(v === "granted") return "Nye treff kommer som varsel mens Hired er åpen i nettleseren.";
    if(v === "denied") return "Nettleseren har blokkert varsler fra denne siden. Treffene havner i innboksen likevel.";
    return "Treffene havner i innboksen. Nettleseren har ikke gitt lov til varsler.";
  }

  function ordlisteHtml(liste, g){
    const L = LISTER[liste], ord = g[liste];
    const id = "radarOrd-" + liste;
    return '<div class="felt ordliste" data-liste="' + liste + '">'
      + '<label class="felt__merke" for="' + id + '">' + L.navn + '</label>'
      + '<div class="ordliste__flate">'
      + (ord.length ? '<ul class="ordliste__ord" aria-label="' + esc(L.navn) + '">' + ord.map(o => {
          const ny = foreslått.has(liste + "\n" + o);
          return '<li class="ord' + (ny ? " ord--ny" : "") + '"><span class="ord__tekst">' + esc(o) + '</span>'
            + (ny ? '<span class="skjult"> (foreslått)</span>' : "")
            + '<button class="ord__fjern" type="button" data-radar="fjernOrd" data-liste="' + liste + '" data-ord="' + esc(o) + '"'
            + ' data-fokus="fjern-' + liste + '-' + esc(o) + '" aria-label="Fjern ' + esc(L.ent) + ' ' + esc(o) + '">' + KRYSS + '</button></li>';
        }).join("") + '</ul>' : "")
      + '<input class="ordliste__inn" id="' + id + '" type="text" autocomplete="off" spellcheck="false" enterkeyhint="done"'
      + ' data-radar="ordInn" data-liste="' + liste + '" data-fokus="inn-' + liste + '" value="' + esc(skriver[liste]) + '"'
      + ' placeholder="' + esc(L.plass) + '" aria-describedby="' + id + '-hjelp">'
      + '</div><p class="felt__hjelp" id="' + id + '-hjelp">' + esc(L.hjelp) + ' Trykk Enter eller komma for å legge til.</p></div>';
  }

  function forslagHtml(){
    const f = forslag;
    const vei = f.feil?.code === "mangler-cv" ? '<button class="knapp knapp--liten" type="button" data-radar="tilCv" data-fokus="tilCv-forslag">Legg inn CV</button>'
      : f.feil?.code === "mangler-nokkel" ? '<button class="knapp knapp--liten" type="button" data-radar="tilNokkel" data-fokus="tilNokkel-forslag">Legg til nøkkel</button>' : "";
    return '<div class="radar__forslag">'
      + '<button class="knapp knapp--liten" type="button" data-radar="foresla" data-fokus="foresla"' + (f.går ? " disabled" : "") + '>Foreslå fra CV</button>'
      + '<p class="henter radar__forslagstatus" role="status" aria-live="polite">' + esc(f.går ? "Leser CV-en…" : f.feil ? "" : f.tekst) + '</p>'
      + (f.feil ? '<div class="radar__forslagfeil"><p class="feil">' + esc(f.feil.message || "Forslaget kom ikke.") + '</p>' + vei + '</div>' : "")
      + '</div>';
  }

  function terskelHtml(g){
    return '<div class="terskel">'
      + '<label class="felt__merke" for="radarTerskel">Vis stillinger som passer fra</label>'
      + '<div class="terskel__rad"><input class="terskel__glider" id="radarTerskel" type="range" min="40" max="95" step="5"'
      + ' value="' + g.terskel + '" data-radar="terskel" data-fokus="terskel" aria-describedby="radarTerskelHjelp">'
      + '<output class="terskel__verdi" for="radarTerskel" id="radarTerskelVerdi">' + g.terskel + ' %</output></div>'
      + '<p class="felt__hjelp" id="radarTerskelHjelp">' + esc(terskeltekst(g.terskel)) + '</p></div>';
  }
  const terskeltekst = p => "Fra " + p + " %: " + SKALA(p) + ". Samme skala som vurderingen i panelet.";

  function kildeLinje(id){
    const k = t.kilder?.[id] ?? {};
    if(k.feil) return '<span class="kilde__feil">Feilet ved siste søk: ' + esc(k.feil) + '</span>';
    if(!k.sist) return "Ikke hentet ennå";
    return "Sist hentet " + tidHtml(k.sist) + "."
      + (k.sokPagar ? " Søket gjennom alle aktive fortsetter ved neste kjøring."
        : k.sokFerdig ? " Alle aktive gjennomgått " + tidHtml(k.sokFerdig) + "." : "");
  }
  function kilderHtml(g){
    const jn = g.kilder.jobbnorge;
    const valgte = jn.fylker;
    const ukjente = valgte.filter(n => !FYLKENAVN.has(n));
    const fylkenavn = valgte.map(n => FYLKENAVN.get(n) || "fylke " + n);
    return '<ul class="kilder">'
      + '<li class="kilde"><label class="avkrys"><input type="checkbox" data-radar="kilde" data-kilde="nav" data-fokus="kilde-nav"'
        + (g.kilder.nav.pa ? " checked" : "") + '> NAV</label><p class="kilde__linje">' + kildeLinje("nav") + '</p></li>'
      + '<li class="kilde"><label class="avkrys"><input type="checkbox" data-radar="kilde" data-kilde="jobbnorge" data-fokus="kilde-jobbnorge"'
        + (jn.pa ? " checked" : "") + '> Jobbnorge</label><p class="kilde__linje">' + kildeLinje("jobbnorge") + '</p>'
        + '<details class="fylker"' + (jn.pa ? "" : " hidden") + '>'
          + '<summary class="fylker__topp" data-fokus="fylker">' + PIL + '<span>' + (valgte.length ? esc(fylkenavn.join(", ")) : "Hele landet") + '</span></summary>'
          + '<fieldset class="fylker__valg"><legend class="skjult">Fylker hos Jobbnorge</legend>'
          + FYLKER.concat(ukjente.map(n => [n, "Fylke " + n])).map(([n, navn]) =>
              '<label class="avkrys fylker__post"><input type="checkbox" data-radar="fylke" value="' + n + '" data-fokus="fylke-' + n + '"'
              + (valgte.includes(n) ? " checked" : "") + '> ' + esc(navn) + '</label>').join("")
          + '</fieldset><p class="felt__hjelp">Ingen valgt betyr hele landet.</p></details></li>'
      + '</ul>';
  }

  /* Grunnen til en side som er slått av, sier det selv («Slått av etter
     5 feil på rad: …»). Ellers settes det foran. */
  const sidegrunn = s => !s.pa && !/^slått av/i.test(s.grunn) ? "Slått av: " + s.grunn : s.grunn;
  function siderHtml(){
    const sider = innstillinger().karrieresider;
    return '<div class="ksider">'
      + '<p class="felt__merke ksider__tittel" id="radarSiderTittel">Karrieresider</p>'
      + (sider.length ? '<ul class="ksider__liste" aria-labelledby="radarSiderTittel">' + sider.map(s => {
          const navn = s.navn || vert(s.url) || s.url;
          const status = !s.pa && s.grunn ? '<span class="kilde__feil">' + esc(sidegrunn(s)) + '</span>'
            : s.feilRad > 0 && s.grunn ? '<span class="kilde__feil">Feilet ' + (s.feilRad === 1 ? "ved siste henting" : s.feilRad + " ganger på rad") + ': ' + esc(s.grunn) + '</span>'
            : s.sist ? "Sist hentet " + tidHtml(s.sist) : s.pa ? "Hentes ved neste søk" : "Ikke hentet ennå";
          const av = !s.pa && !!s.grunn;
          const statusId = "radarSide-" + esc(s.id) + "-status";
          return '<li class="kside' + (av ? " kside--av" : "") + '"><div class="kside__hvem"><span class="kside__navn">' + esc(navn) + '</span>'
            + '<span class="kside__type">' + esc(KILDENAVN[s.type] || s.type) + '</span></div>'
            + '<a class="kside__url" href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' + esc(s.url) + '</a>'
            + '<p class="kilde__linje" id="' + statusId + '">' + status + '</p>'
            + (av ? '<button class="handling kside__pa" type="button" data-radar="slaPaSide" data-id="' + esc(s.id) + '"'
              + ' data-fokus="slaPaSide-' + esc(s.id) + '" aria-describedby="' + statusId + '"' + (slårPå.has(s.id) ? " disabled" : "") + '>'
              + (slårPå.has(s.id) ? "Slår på…" : "Slå på igjen") + '</button>' : "")
            + '<button class="handling handling--stille kside__fjern" type="button" data-radar="fjernSide" data-id="' + esc(s.id) + '"'
            + ' data-fokus="fjernSide-' + esc(s.id) + '" aria-label="Fjern ' + esc(navn) + '">Fjern</button></li>';
        }).join("") + '</ul>' : '<p class="felt__hjelp ksider__tom">Ingen ennå. Greenhouse, Lever, Teamtailor og sider med strukturerte stillingsdata kan leses.</p>')
      + '<div class="ksider__ny"><label class="skjult" for="radarSideUrl">Adressen til karrieresiden</label>'
      + '<input class="felt__inn" id="radarSideUrl" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://…"'
      + ' data-radar="sideUrl" data-fokus="sideUrl" value="' + esc(side.url) + '" aria-describedby="radarSideStatus"' + (side.feil ? ' aria-invalid="true"' : "") + '>'
      + '<button class="knapp knapp--liten" type="button" data-radar="leggTilSide" data-fokus="leggTilSide"' + (side.går ? " disabled" : "") + '>Legg til side</button></div>'
      + (side.feil ? '<p class="feil ksider__feil" id="radarSideStatus">' + esc(side.feil) + '</p>'
        : '<p class="henter" id="radarSideStatus" role="status" aria-live="polite">' + (side.går ? "Sjekker siden…" : "") + '</p>')
      + '</div>';
  }

  function forbrukHtml(g){
    const f = t.forbruk ?? { vurderinger: 0, tak: g.maksVurderingerPerDogn };
    const tak = f.tak || 0;
    const andel = tak ? Math.min(100, Math.round(f.vurderinger / tak * 100)) : 100;
    return '<p class="forbruk__tall"><b>' + f.vurderinger + '</b> av <b>' + tak + '</b> vurderinger i dag'
      + (tak && f.vurderinger >= tak ? '. Taket er nådd, og Radar vurderer igjen i morgen.' : "") + '</p>'
      + '<div class="forbruk__spor" aria-hidden="true"><div class="forbruk__fyll" style="width:' + andel + '%"></div></div>'
      + '<div class="innst__rad forbruk__tak"><label class="felt__merke" for="radarTak">Døgntak</label>'
      + '<input class="felt__inn forbruk__inn" id="radarTak" type="number" inputmode="numeric" min="0" max="1000" step="10"'
      + ' value="' + g.maksVurderingerPerDogn + '" data-radar="tak" data-fokus="tak" aria-describedby="radarTakHjelp"></div>'
      + '<p class="felt__hjelp" id="radarTakHjelp">Høyst 1000. Hver vurdering koster omtrent en kvart øre med Haiku.</p>';
  }

  const kr = n => n == null ? "–" : n === 0 ? "0 kr" : n < 0.005 ? "under 1 øre"
    : n.toLocaleString("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " kr";

  function kjøringerHtml(){
    const k = t.kjoringer ?? [];
    if(!k.length) return '<p class="felt__hjelp radar__ingen">Ingen kjøringer ennå.</p>';
    const tallHtml = n => '<span class="kjoringer__tall">' + esc(tallTekst(n)) + '</span>';
    return '<table class="kjoringer"><caption class="skjult">De fem siste kjøringene</caption>'
      + '<thead><tr><th scope="col">Når</th><th scope="col">Hva skjedde</th><th scope="col" class="kjoringer__kost">Kostnad</th></tr></thead><tbody>'
      + k.map(x => {
          const feil = [...x.kilder.filter(s => s.feil).map(s => (s.navn || KILDENAVN[s.kilde] || s.kilde) + ": " + s.feil), ...x.feil];
          const venter = x.venter ? " " + tallHtml(x.venter) + " ventet på vurdering." : "";
          return '<tr><td class="kjoringer__nar">' + esc(når(x.start)) + '</td>'
            + '<td class="kjoringer__hva">' + bind(kjøringstekst(x, { tall: tallHtml }) + venter) + '</td>'
            + '<td class="kjoringer__kost">' + kr(x.kostnad) + '</td></tr>'
            + (feil.length ? '<tr class="kjoringer__feil"><td colspan="3"><span class="kilde__feil">Feil:</span> ' + esc(feil.slice(0, 3).join(" ")) + '</td></tr>' : "");
        }).join("") + '</tbody></table>';
  }

  function lagrelinjeHtml(){
    const e = endret();
    return '<div class="radarinnst__bunn"' + (e ? " data-endret" : "") + '>'
      + '<p class="radarinnst__lagret" id="radarLagret" role="status" aria-live="polite"' + (lagreFeil ? ' data-t="feil"' : e ? ' data-t="endret"' : "") + '>'
      + esc(lagreFeil || (lagrer ? "Lagrer…" : e ? "Endringene er ikke lagret" : "Alt er lagret")) + '</p>'
      + '<button class="knapp knapp--stille knapp--liten" type="button" data-radar="forkast" data-fokus="forkast"' + (e && !lagrer ? "" : " disabled") + '>Forkast</button>'
      + '<button class="knapp knapp--primar knapp--liten" type="button" data-radar="lagre" data-fokus="lagre"' + (e && !lagrer ? "" : " disabled") + '>Lagre innstillingene</button></div>';
  }
  function tegnLagrelinje(){
    const el = rot?.querySelector(".radarinnst__bunn");
    if(el) medFokus(() => { el.outerHTML = lagrelinjeHtml(); });
    const s = rot?.querySelector("#radarSammendrag");
    if(s) s.textContent = sammendrag();
  }

  /* ---------- merknadene ---------- */

  function merknad(hva, tittel, tekst, knapp){
    return '<div class="notis radar__merknad" data-merknad="' + hva + '"><p><b>' + esc(tittel) + '</b> ' + esc(tekst) + '</p>'
      + (knapp || "") + '</div>';
  }
  function merknaderHtml(){
    if(!t || !innstillinger().pa) return "";
    const ut = [];
    /* CV-en og nøkkelen er det som stopper Radar. Mangler begge, er det
       én merknad med to veier, ikke to merknader som sier det samme. */
    const tilCv = '<button class="knapp knapp--liten" type="button" data-radar="tilCv" data-fokus="tilCv">Legg inn CV</button>';
    const tilNøkkel = '<button class="knapp knapp--liten" type="button" data-radar="tilNokkel" data-fokus="tilNokkel">Legg til nøkkel</button>';
    if(grunnlag.cv === false && grunnlag.nøkkel === false) ut.push(merknad("cv nokkel", "CV-en og API-nøkkelen mangler.",
      "Radar kan ikke vurdere stillingene før begge er på plass. Nøkkelen er den du skriver brev med.",
      '<span class="radar__veier">' + tilCv + tilNøkkel + '</span>'));
    else if(grunnlag.cv === false) ut.push(merknad("cv", "CV-en mangler.", "Radar kan ikke vurdere stillingene før CV-en er lagt inn.", tilCv));
    else if(grunnlag.nøkkel === false) ut.push(merknad("nokkel", "API-nøkkelen mangler.",
      "Vurderingen gjøres av modellen du skriver brev med, og den trenger en nøkkel.", tilNøkkel));
    if(!innstillinger().sokeord.length && !gjeldende().sokeord.length) ut.push(merknad("sokeord", "Ingen søkeord ennå.",
      "Uten dem sendes alt Radar finner til vurdering, helt til døgntaket er nådd."
        + (grunnlag.cv === false ? " Skriv dem inn under Innstillinger, eller legg inn CV-en og la den foreslå noen." : " La CV-en foreslå noen, og se over dem før du lagrer."),
      grunnlag.cv === false ? "" : '<button class="knapp knapp--liten" type="button" data-radar="foresla" data-fokus="foresla-merknad"' + (forslag.går ? " disabled" : "") + '>Foreslå fra CV</button>'));
    const feilet = [];
    for(const id of ["nav", "jobbnorge"]) if(innstillinger().kilder[id].pa && t.kilder?.[id]?.feil) feilet.push(KILDENAVN[id] + ": " + t.kilder[id].feil);
    for(const s of innstillinger().karrieresider) if(s.grunn) feilet.push((s.navn || vert(s.url)) + ": " + sidegrunn(s));
    if(feilet.length) ut.push(merknad("kilde", feilet.length === 1 ? "En kilde feilet." : feilet.length + " kilder feilet.",
      feilet.join(" ") + " De andre kildene søkes som vanlig."));
    return ut.join("");
  }

  /* ---------- innboksen ---------- */

  function baand(navn, rader, ent, fl, innhold){
    return '<section class="baandblokk" aria-label="' + esc(navn) + '"><div class="baand"><h3 class="merkelinje baand__navn">' + navn + '</h3>'
      + '<span class="baand__strek" aria-hidden="true"></span>'
      + '<span class="baand__tall" aria-label="' + antall(rader.length, ent, fl) + '">' + rader.length + '</span></div>'
      + '<div class="stabel">' + innhold + '</div></section>';
  }

  function innboksHtml(){
    const n = nye(), l = lagtTil();
    const på = innstillinger().pa;
    let h = "";
    if(!n.length && på){
      const s = sisteKjøring();
      const tekst = !s ? "Første søk starter av seg selv, eller trykk Søk nå. Stillinger som passer fra " + innstillinger().terskel + " %, havner her."
        : "Radar har ikke funnet noe som passer fra " + innstillinger().terskel + " % ennå. "
          + (l.length ? "Det du har lagt til, står under." : "Blir det stille lenge, kan du legge til søkeord eller senke terskelen.");
      h += '<div class="tomt tomt--lav radar__tomt"><p class="tomt__tittel">' + (l.length ? "Ingenting nytt" : "Ingen treff ennå") + '</p>'
        + '<p class="tomt__tekst">' + esc(tekst) + '</p></div>';
    }
    if(n.length) h += baand("Nye", n, "ny stilling", "nye stillinger", n.map(funnHtml).join(""));
    if(l.length) h += baand("Lagt til", l, "stilling lagt til", "stillinger lagt til", l.map(funnHtml).join(""));
    return h;
  }

  function funnHtml(r){
    const lagt = r.status !== "ny";
    const iDag = api.iDag();
    const meta = [];
    if(r.sted) meta.push('<span class="funn__sted">' + esc(r.sted) + '</span>');
    meta.push('<span>' + esc(KILDENAVN[r.kilde] || r.kilde) + '</span>');
    const publ = r.publisert || r.funnet;
    if(publ){
      const d = new Date(publ);
      if(!Number.isNaN(d.getTime())) meta.push('<span>' + (r.publisert ? "publisert" : "funnet") + ' <time class="funn__tid" datetime="' + esc(publ) + '">'
        + d.getDate() + ". " + MND_K[d.getMonth()] + '</time></span>');
    }
    if(r.frist){
      const hast = F.hast(r.frist, iDag);
      meta.push('<span class="funn__frist"' + (!lagt && (hast === "naa" || hast === "snart") ? ' data-hast="' + hast + '"' : "") + '>frist <time class="funn__tid" datetime="' + r.frist + '">'
        + F.kortDatoMnd(r.frist) + '</time> <span class="funn__om">' + esc(F.omTekst(r.frist, iDag)) + '</span></span>');
    }
    const grunner = lagt ? "" : (r.grunner ?? []).slice(0, 3);
    const jobbId = lagt ? søknadFor(r) : null;
    const tittelId = "funn-" + CSS.escape(r.id).replace(/[^A-Za-z0-9_-]/g, "_");
    const åpne = '<a class="handling handling--stille funn__lenke" href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer"'
      + ' data-fokus="apne-' + esc(r.id) + '" aria-label="Åpne annonsen hos ' + esc(r.selskap || "arbeidsgiveren") + ' i ny fane">Åpne<span class="rad__pil" aria-hidden="true">↗</span></a>';
    const handlinger = lagt
      ? (jobbId ? '<button class="handling funn__hoved" type="button" data-radar="apneSoknad" data-jobb="' + esc(jobbId) + '" data-fokus="soknad-' + esc(r.id) + '">Åpne søknaden</button>'
               : '<span class="funn__borte">Søknaden er slettet</span>') + åpne
      : '<button class="handling handling--hoved funn__hoved" type="button" data-radar="leggTil" data-id="' + esc(r.id) + '" data-fokus="legg-' + esc(r.id) + '"'
        + (legger.has(r.id) ? " disabled" : "") + '>' + (legger.has(r.id) ? "Legger til…" : jobbFor.has(r.id) ? "Prøv igjen" : "Legg til") + '</button>'
        + '<button class="handling handling--stille" type="button" data-radar="ikke" data-id="' + esc(r.id) + '" data-fokus="ikke-' + esc(r.id) + '">Ikke interessert</button>'
        + åpne;
    return '<article class="funn' + (lagt ? " funn--lagt" : "") + '" data-radar-id="' + esc(r.id) + '" aria-labelledby="' + tittelId + '">'
      + '<div class="funn__prosent"><span class="rad__match" title="Hvor godt stillingen passer CV-en">' + r.prosent + ' %</span></div>'
      + '<div class="funn__hoved-kol">'
        + '<h4 class="funn__tittel" id="' + tittelId + '"><span class="funn__selskap">' + esc(r.selskap || "Ukjent arbeidsgiver") + '</span>'
        + '<span class="skjult">, </span><span class="funn__stilling">' + esc(r.stilling) + '</span></h4>'
        + '<p class="funn__meta">' + meta.join("") + '</p>'
        + (grunner.length ? '<ul class="funn__grunner" aria-label="Hvorfor den passer">' + grunner.map(g => '<li>' + esc(g) + '</li>').join("") + '</ul>' : "")
        + (lagt && jobbId ? '<p class="funn__lagtinn">Lagt til i søknadene dine.</p>' : "")
      + '</div>'
      + '<div class="funn__handlinger">' + handlinger + '</div>'
      + '</article>';
  }

  /* Etter at en rad har gått ut av «Nye», går fokus til neste rad, så
     man kan gå gjennom innboksen med tastaturet uten å miste plassen. */
  function fokuserEtter(id, liste){
    const i = liste.findIndex(r => r.id === id);
    const igjen = nye();
    const neste = igjen[i] || igjen[i - 1];
    requestAnimationFrame(() => {
      const el = neste ? rot?.querySelector('[data-fokus="legg-' + CSS.escape(neste.id) + '"]') : null;
      if(el) el.focus(); else api.fokuserTittel();
    });
  }

  /* ---------- handlingene ---------- */

  async function leggTil(id){
    const rad = t.innboks.find(r => r.id === id);
    if(!rad || legger.has(id)) return;
    const hvem = profil, før = nye();
    legger.add(id);
    tegnInnboks();
    try{
      let jobbId = søknadFor(rad);
      if(!jobbId){
        const r = api.leggTilSøknad(Radar.soknadFraRad(rad));
        if(!r.ok) throw new Error(r.melding);
        jobbId = r.jobb.id;
        jobbFor.set(id, jobbId);
        await api.ventPåLagring();
      }
      jobbFor.set(id, jobbId);
      if(hvem !== profil) return;
      const ny = await Radar.lagtTil(id, jobbId);
      jobbFor.delete(id);
      legger.delete(id);
      settTilstand(ny);
      api.varsle("La til " + (rad.selskap || "stillingen") + " i søknadene");
      fokuserEtter(id, før);
    }catch(e){
      legger.delete(id);
      if(e?.code === "utlogget" || hvem !== profil) return;
      api.varsle(jobbFor.has(id) && søknadFor(rad)
        ? "Søknaden er lagt til, men ikke annonsen. Trykk Prøv igjen." : (e?.message || "Fikk ikke lagt til stillingen"));
      tegnInnboks();
    }
  }

  /* «Ikke interessert» kan ikke tas tilbake av Radar. Kallet venter
     derfor til angrefristen er ute; så lenge står raden bare skjult. */
  function ikkeInteressert(id){
    const rad = t.innboks.find(r => r.id === id);
    if(!rad || utsatt.has(id)) return;
    const før = nye();
    utsatt.set(id, setTimeout(() => fullførIkkeInteressert(id), ANGRETID));
    tegnInnboks();
    fokuserEtter(id, før);
    api.varsle("Fjernet " + (rad.selskap || "stillingen") + " fra innboksen", () => {
      clearTimeout(utsatt.get(id));
      utsatt.delete(id);
      tegnInnboks();
      requestAnimationFrame(() => rot?.querySelector('[data-fokus="legg-' + CSS.escape(id) + '"]')?.focus());
    });
  }
  async function fullførIkkeInteressert(id){
    if(!utsatt.has(id)) return;
    clearTimeout(utsatt.get(id));
    try{ settTilstand(await Radar.ikkeInteressert(id)); }
    catch(e){
      if(e?.code !== "finnes-ikke" && e?.code !== "utlogget") api.varsle(e?.message || "Fikk ikke fjernet stillingen");
    }finally{ utsatt.delete(id); tegnInnboks(); }
  }
  addEventListener("visibilitychange", () => {
    if(document.visibilityState === "hidden") for(const id of [...utsatt.keys()]) fullførIkkeInteressert(id);
  });

  async function slåPå(på){
    if(på) Varsling.beOmTillatelse();    /* må skje i klikket, før noe annet ventes på */
    try{
      settTilstand(await Radar.lagreInnstillinger({ pa: på }));
      if(på){
        startTimeplan();
        lastGrunnlag();
        if(!innstillinger().sokeord.length){
          innstÅpen = true; tegn();
          rot?.querySelector('[data-fokus="inn-sokeord"]')?.focus();
        }else rot?.querySelector('[data-fokus="sok"]')?.focus();
      }
    }catch(e){
      if(e?.code !== "utlogget") api.varsle(e?.message || "Fikk ikke lagret");
      tegn();
    }
  }

  async function lagre(){
    if(!endret() || lagrer) return;
    lagrer = true; lagreFeil = ""; tegnLagrelinje();
    const fra = utkast;
    try{
      const ny = await Radar.lagreInnstillinger(fra);
      if(søkeavtrykk(fra) !== søkeavtrykk(fraTilstand())) søkEndret = Date.now();
      if(utkast === fra){ utkast = null; foreslått = new Set(); }
      lagrer = false;
      settTilstand(ny);
      const el = rot?.querySelector("#radarLagret");
      if(el && !endret()) el.textContent = "Lagret";
    }catch(e){
      lagrer = false;
      if(e?.code === "utlogget") return;
      lagreFeil = "Ikke lagret. " + (e?.message || "");
      tegnLagrelinje();
    }
  }

  async function foreslå(){
    if(forslag.går) return;
    innstÅpen = true;
    forslag = { går: true, tekst: "", feil: null };
    tegn();
    rot?.querySelector('[data-fokus="foresla"]')?.scrollIntoView({ block: "nearest" });
    try{
      const f = await Radar.foreslaFraCv();
      let lagtTil = 0;
      rediger(u => {
        for(const liste of ["sokeord", "steder", "ekskluder"])
          for(const o of f[liste] ?? []){
            if(u[liste].some(x => x.toLocaleLowerCase("nb") === o.toLocaleLowerCase("nb"))) continue;
            u[liste].push(o); foreslått.add(liste + "\n" + o); lagtTil++;
          }
      });
      const deler = [antall(f.sokeord?.length ?? 0, "søkeord", "søkeord"), antall(f.steder?.length ?? 0, "sted", "steder"),
        antall(f.ekskluder?.length ?? 0, "ekskludert ord", "ekskluderte ord")];
      forslag = { går: false, feil: null, tekst: lagtTil
        ? "Forslaget ga " + deler.join(", ") + ". Se over og lagre."
        : "Forslaget ga ingenting nytt." };
      if(grunnlag.cv === false) grunnlag.cv = true;
    }catch(e){
      if(e?.code === "mangler-cv") grunnlag.cv = false;
      if(e?.code === "mangler-nokkel") grunnlag.nøkkel = false;
      forslag = { går: false, tekst: "", feil: e?.code === "utlogget" ? null : e };
    }
    tegn();
    const mål = forslag.feil ? rot?.querySelector('[data-fokus="foresla"]') : rot?.querySelector('[data-fokus="inn-sokeord"]');
    if(mål && !rot.contains(document.activeElement)) mål.focus();
  }

  async function søkNå(){
    if(søk.går || t?.kjorerNa) return;
    søk = { går: true, start: Date.now(), tekst: "", feil: false, alle: søkerAlle() };
    tegnStatus();
    try{
      const svar = await Radar.sokNa();
      søk.går = false;
      visSvar(svar);
    }catch(e){
      søk = { går: false, start: 0, tekst: e?.code === "utlogget" ? "" : (e?.message || "Søket stoppet uventet."), feil: e?.code !== "for-mange" };
      if(e?.code === "mangler-cv"){ grunnlag.cv = false; tegnMerknader(); }
      if(e?.code === "mangler-nokkel"){ grunnlag.nøkkel = false; tegnMerknader(); }
      tegnStatus();
    }
  }
  function visSvar(svar){
    const k = svar?.kjoring;
    if(!svar?.kjort){
      søk = { ...søk, går: false, feil: false, tekst: svar?.grunn === "opptatt"
        ? "Radar søker allerede, fra en annen fane eller fra serveren." : svar?.grunn === "av" ? "Radar er av." : "" };
    }else{
      const tid = k?.start ? klokke(new Date(k.start)) : "";
      const feil = k?.feil?.length ? " " + k.feil[0] : "";
      søk = { ...søk, går: false, feil: !!feil || !svar.lagret,
        tekst: (k ? kjøringstekst(k, { tid, terskel: innstillinger().terskel }) : "Søket er ferdig.")
          + (svar.lagret ? fortsettertekst() + ventertekst(k?.venter ?? 0) : " Resultatet ble ikke lagret.") + feil };
      if(/CV-en/.test(feil) && grunnlag.cv !== false){ grunnlag.cv = false; tegnMerknader(); }
    }
    tegnStatus();
  }

  async function leggTilSide(){
    const url = side.url.trim();
    if(!url){ side = { ...side, feil: "Lim inn adressen til karrieresiden først." }; tegn(); rot?.querySelector("#radarSideUrl")?.focus(); return; }
    side = { går: true, url, feil: "" };
    tegn();
    try{
      const ny = await Radar.leggTilKarriereside({ url });
      side = { går: false, url: "", feil: "" };
      settTilstand(ny);
      api.varsle("La til karrieresiden");
    }catch(e){
      side = { går: false, url, feil: e?.code === "utlogget" ? "" : (e?.message || "Siden kunne ikke legges til.") };
      tegn();
    }
    rot?.querySelector("#radarSideUrl")?.focus();
  }

  async function fjernSide(id){
    const s = innstillinger().karrieresider.find(x => x.id === id);
    if(!s) return;
    try{
      settTilstand(await Radar.fjernKarriereside(id));
      rot?.querySelector("#radarSideUrl")?.focus();
      api.varsle("Fjernet " + (s.navn || vert(s.url)), async () => {
        try{ settTilstand(await Radar.leggTilKarriereside({ url: s.url, navn: s.navn })); }
        catch(e){ if(e?.code !== "utlogget") api.varsle(e?.message || "Fikk ikke lagt siden inn igjen"); }
      });
    }catch(e){ if(e?.code !== "utlogget") api.varsle(e?.message || "Fikk ikke fjernet siden"); }
  }

  /* En side Radar slo av etter fem feil, slås på av brukeren. Den hentes
     ved neste søk; fokus går til «Fjern» på samme side, siden knappen
     man trykket på, forsvinner. */
  async function slåPåSide(id){
    const s = innstillinger().karrieresider.find(x => x.id === id);
    if(!s || slårPå.has(id)) return;
    slårPå.add(id);
    tegn();
    try{
      const ny = await Radar.slaPaKarriereside(id);
      slårPå.delete(id);
      settTilstand(ny);
      api.varsle("Slo på " + (s.navn || vert(s.url)) + " igjen. Den hentes ved neste søk.");
      rot?.querySelector('[data-fokus="fjernSide-' + CSS.escape(id) + '"]')?.focus();
    }catch(e){
      slårPå.delete(id);
      if(e?.code === "finnes-ikke") last();
      if(e?.code !== "utlogget") api.varsle(e?.message || "Fikk ikke slått på siden");
      tegn();
    }
  }

  /* Ord fra feltet: komma og linjeskift skiller, og et ord som står
     der fra før (uansett store og små bokstaver), legges ikke til igjen. */
  function leggTilOrd(liste, tekst){
    const ord = String(tekst).split(/[,\n;]/).map(o => o.replace(/\s+/g, " ").trim()).filter(o => o && o.length <= 80);
    if(!ord.length) return false;
    rediger(u => { for(const o of ord) if(!u[liste].some(x => x.toLocaleLowerCase("nb") === o.toLocaleLowerCase("nb"))) u[liste].push(o); });
    return true;
  }

  /* ---------- lyttere ---------- */

  function klikk(e){
    /* Valget huskes med en gang, ikke først ved toggle: tegnes kortet på
       nytt i mellomtiden, skal det nye stå slik brukeren ville. */
    const topp = e.target.closest(".radarinnst__topp");
    if(topp) innstÅpen = !topp.parentElement.open;
    /* Hele flaten rundt brikkene er feltet. */
    if(e.target.classList.contains("ordliste__flate") || e.target.classList.contains("ordliste__ord"))
      e.target.closest(".ordliste__flate").querySelector(".ordliste__inn")?.focus();
    const b = e.target.closest("[data-radar]");
    if(!b || !rot.contains(b) || b.disabled) return;
    const hva = b.dataset.radar;
    if(hva === "sok") søkNå();
    else if(hva === "pa") slåPå(true);
    else if(hva === "last") last();
    else if(hva === "lagre") lagre();
    else if(hva === "forkast"){ utkast = null; foreslått = new Set(); lagreFeil = ""; tegn(); }
    else if(hva === "foresla") foreslå();
    else if(hva === "fjernOrd"){
      const liste = b.dataset.liste, ord = b.dataset.ord;
      const før = gjeldende()[liste], i = før.indexOf(ord);
      rediger(u => { u[liste] = u[liste].filter(x => x !== ord); });
      foreslått.delete(liste + "\n" + ord);
      tegn();
      const igjen = gjeldende()[liste];
      const mål = igjen[i] ?? igjen[i - 1];
      const fokus = (mål != null && rot.querySelector('[data-fokus="fjern-' + CSS.escape(liste + "-" + mål) + '"]'))
        || rot.querySelector('[data-fokus="inn-' + liste + '"]');
      fokus?.focus();
    }
    else if(hva === "leggTilSide") leggTilSide();
    else if(hva === "fjernSide") fjernSide(b.dataset.id);
    else if(hva === "slaPaSide") slåPåSide(b.dataset.id);
    else if(hva === "leggTil") leggTil(b.dataset.id);
    else if(hva === "ikke") ikkeInteressert(b.dataset.id);
    else if(hva === "apneSoknad") api.åpneSøknad(b.dataset.jobb, { fra: b });
    else if(hva === "tilCv") api.tilCv(b);
    else if(hva === "tilNokkel") api.tilNøkkel(b);
  }

  function input(e){
    const el = e.target, hva = el.dataset.radar;
    if(hva === "ordInn"){
      const liste = el.dataset.liste;
      if(/[,;]/.test(el.value)){
        const deler = el.value.split(/[,;]/);
        const rest = deler.pop();
        skriver[liste] = rest;
        if(leggTilOrd(liste, deler.join(","))){ tegn(); return; }
      }
      skriver[liste] = el.value;
    }else if(hva === "terskel"){
      const v = Number(el.value);
      rediger(u => { u.terskel = v; });
      rot.querySelector("#radarTerskelVerdi").textContent = v + " %";
      rot.querySelector("#radarTerskelHjelp").textContent = terskeltekst(v);
      tegnLagrelinje();
    }else if(hva === "tak"){
      const v = Math.round(Number(el.value));
      if(el.value !== "" && Number.isFinite(v) && v >= 0 && v <= 1000){ rediger(u => { u.maksVurderingerPerDogn = v; }); tegnLagrelinje(); }
    }else if(hva === "sideUrl"){
      side.url = el.value;
      if(side.feil){ side.feil = ""; const s = rot.querySelector("#radarSideStatus"); if(s){ s.className = "henter"; s.textContent = ""; s.setAttribute("role", "status"); } el.removeAttribute("aria-invalid"); }
    }
  }

  function endring(e){
    const el = e.target, hva = el.dataset.radar;
    if(hva === "paav") slåPå(el.checked);
    else if(hva === "kilde"){ rediger(u => { u.kilder[el.dataset.kilde].pa = el.checked; }); tegn(); }
    else if(hva === "fylke"){
      const n = Number(el.value);
      rediger(u => { const f = u.kilder.jobbnorge.fylker; u.kilder.jobbnorge.fylker = el.checked ? [...new Set([...f, n])] : f.filter(x => x !== n); });
      tegn();
      const d = rot.querySelector(".fylker"); if(d) d.open = true;
      rot.querySelector('[data-fokus="fylke-' + n + '"]')?.focus();
    }else if(hva === "tak"){
      const v = Math.round(Number(el.value));
      if(!Number.isFinite(v) || el.value === "" || v < 0 || v > 1000){ el.value = gjeldende().maksVurderingerPerDogn; return; }
      el.value = v;
    }
  }

  function tast(e){
    const el = e.target;
    if(el.dataset.radar === "ordInn"){
      const liste = el.dataset.liste;
      if(e.key === "Enter"){
        e.preventDefault();
        if(leggTilOrd(liste, el.value)){ skriver[liste] = ""; tegn(); }
      }else if(e.key === "Backspace" && !el.value && el.selectionStart === 0){
        const ord = gjeldende()[liste];
        if(ord.length){ e.preventDefault(); rot.querySelector('[data-fokus="fjern-' + CSS.escape(liste + "-" + ord[ord.length - 1]) + '"]')?.focus(); }
      }
    }else if(el.id === "radarSideUrl" && e.key === "Enter"){ e.preventDefault(); leggTilSide(); }
    else if(el.dataset.radar === "tak" && e.key === "Enter"){ e.preventDefault(); lagre(); }
  }

  function lim(e){
    const el = e.target;
    if(el.dataset.radar !== "ordInn") return;
    const tekst = e.clipboardData?.getData("text") ?? "";
    if(!/[,;\n]/.test(tekst)) return;
    e.preventDefault();
    const liste = el.dataset.liste;
    if(leggTilOrd(liste, el.value + tekst)){ skriver[liste] = ""; tegn(); }
  }

  /* ---------- det app.js ser ---------- */

  function undertittel(){
    if(!t) return lastFeil ? "Kunne ikke leses" : "";
    if(!innstillinger().pa) return "Av" + (lagtTil().length || nye().length ? " · <b>" + nye().length + "</b> nye i innboksen" : "");
    return "<b>" + nye().length + "</b> nye · <b>" + lagtTil().length + "</b> lagt til";
  }
  /* Tallet i sidepanelet: bare når Radar er på, eller har noe å vise. */
  function tall(){
    if(!t || (!innstillinger().pa && !nye().length)) return "";
    return String(antallNye());
  }

  return { vis, skjul, start, stopp, undertittel, tall, oppdater: () => { if(rot) tegnInnboks(); } };
}
