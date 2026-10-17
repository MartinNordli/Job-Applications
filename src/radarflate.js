/* ============================================================
   Radar-visningen: innstillingene, «Søk nå» og innboksen.

   Visningen eier sin egen DOM inni #innhold og sine egne lyttere, som
   detaljpanelet. Alt den trenger fra listen (søknadene, lagringen,
   panelet, varselet), får den fra app.js gjennom `api`, så den aldri
   leser modultilstanden der direkte. Radar selv nås bare gjennom
   src/radarklient.js.

   Oppbyggingen, ovenfra:
   - Toppen: når Radar sist søkte og søker igjen, forbruket i dag og
     «Søk nå». Under det trakten fra siste kjøring: fire tall med en
     stolpe hver, fra alt som ble hentet ned til det som nådde terskelen.
     Setningen om kjøringen står bare for skjermlesere (#radarStatus);
     den synlige linjen sier noe bare når det er noe å si (søker, feil,
     kø).
   - Merknadene: det som stopper Radar (CV, nøkkel), det som gjør den
     dyr (ingen søkeord) og kilder som feilet ved siste søk.
   - Fanene: Innboks, Under terskelen, Lagt til, Kjøringer og
     Innstillinger. Bare den valgte tegnes. Valget huskes mens appen er
     åpen; første gang er det Innstillinger hvis Radar er på uten
     søkeord, ellers Innboks.
   - Innboksen er en rangering, ikke en logg: funnene står i bånd etter
     skalaen, best først. Det som er midt i blinken, får hvert sitt
     toppkort med grunnene synlige; resten er rader på to linjer der
     «Hvorfor» folder ut grunnene. Innenfor et bånd står en frist som
     haster først, så høyeste prosent, så det nyeste.
   - Innstillingene er et utkast som lagres med én knapp; av og på og
     karrieresidene lagres med en gang, fordi de har egne veier inn.

   Kulør: treff-skalaen (--treff-1 til 4) sier hvor godt noe passer, og
   bare det, og alltid med tallet ved siden av. Ild og rav er fortsatt
   bare frist. Det som har feilet, sies med ord.
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
const SKALA = p => p >= 95 ? "midt i blinken, med fag, rolle og nivå som i CV-en"
  : p >= 80 ? "passer godt"
  : p >= 65 ? "passer på det meste"
  : p >= 50 ? "verdt å lese, passer delvis"
  : "også stillinger som passer dårlig";

/* Trinnene i innboksen, med samme grenser som SKALA. Trinn 0 er det
   mellom terskelen og 49 %, og finnes bare når terskelen er under 50. */
const TRINN = { 4: { navn: "Midt i blinken", fra: 95 }, 3: { navn: "Passer godt", fra: 80 },
  2: { navn: "Passer på det meste", fra: 65 }, 1: { navn: "Verdt å lese", fra: 50 }, 0: { navn: "Passer dårlig", fra: 40 } };
const trinn = p => p >= 95 ? 4 : p >= 80 ? 3 : p >= 65 ? 2 : p >= 50 ? 1 : 0;

const FANER = [["innboks", "Innboks"], ["under", "Under terskelen"], ["lagt", "Lagt til"], ["kjoringer", "Kjøringer"], ["innstillinger", "Innstillinger"]];

const ANGRETID = 7000;
const PIL = '<svg class="baand__pil" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="m3.5 2 3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const KRYSS = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
/* Ikonene i radene: samme strek og samme 12-rute, så krysset og pila
   står like store ved siden av hverandre. */
const IKON_KRYSS = '<svg class="ikon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const IKON_UT = '<svg class="ikon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4.5 2.75h4.75v4.75M9 3 3 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TRAKTPIL = '<svg class="radartrakt__pil" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m4.5 2.5 3.5 3.5-3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/* Blinken i introkortet: fire ringer i treff-trinnene rundt en prikk. */
const MOTIV = '<svg class="radar__motiv" width="76" height="76" viewBox="0 0 76 76" aria-hidden="true">'
  + [36, 27, 18, 9, 2.6].map((r, i) => '<circle class="radar__ring" data-ring="' + i + '" cx="38" cy="38" r="' + r + '"/>').join("") + '</svg>';

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
   Kjøringer fra før passet fantes, sier bare hvor mange som ble vurdert,
   og de fra før det gjemte fantes, ingenting om det under terskelen. */
function kjøringstekst(k, { tall: t = tallTekst, tid = "", terskel = null } = {}){
  const hentet = k.kandidater ?? 0, vurdert = k.vurdert ?? 0, treff = k.treff ?? 0, passet = k.passet;
  const deler = [];
  if(hentet && passet != null) deler.push(passet ? t(passet) + " passet søkeordene" : "ingen passet søkeordene");
  if(vurdert){
    deler.push(t(vurdert) + (passet === 0 ? " vurdert fra køen" : " vurdert"));
    deler.push(terskel != null ? (treff ? t(treff) : "ingen") + " nådde " + t(terskel) + " %" : treff ? t(treff) + " treff" : "ingen treff");
    /* under er null for kjøringer fra før det gjemte fantes. */
    if(k.under) deler.push(t(k.under) + " under terskelen");
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
  let fane = null;              /* den valgte fanen; null til visningen tegnes første gang */
  let animert = null;           /* starten på kjøringen trakten sist viste */
  const hvorforÅpen = new Set(); /* rader der «Hvorfor» er foldet ut */
  let lagrer = false, lagreFeil = "";
  let forslag = { går: false, tekst: "", feil: null };
  let side = { går: false, url: "", feil: "" };
  /* tekst er hele setningen, til #radarStatus; kort er det som vises,
     og er tom når trakten sier det samme. */
  let søk = { går: false, start: 0, tekst: "", kort: "", feil: false };
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
  const under = () => (t?.under ?? []).filter(r => !utsatt.has(r.id));
  const antallNye = () => t ? nye().length : null;
  /* Handlingene på en rad virker likt i innboksen og under terskelen. */
  const radFor = id => t?.innboks.find(r => r.id === id) ?? t?.under?.find(r => r.id === id);
  const erUnder = id => !!t?.under?.some(r => r.id === id);

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
      if(grunnlag.cv && !søk.går && /CV-en/.test(søk.tekst)) søk = { ...søk, tekst: "", kort: "", feil: false };
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
      påFeil: e => { const m = e?.message || "Radar stoppet uventet."; søk = { ...søk, tekst: m, kort: m, feil: true }; tegnStatus(); }
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

  /* Fanen som står valgt. Første gang visningen tegnes med tilstand,
     velges den etter regelen og huskes, så den ikke bytter under
     brukeren når søkeordene lagres; etterpå er valget brukerens. */
  function aktivFane(){
    if(!fane && t) fane = innstillinger().pa && !gjeldende().sokeord.length ? "innstillinger" : "innboks";
    return fane ?? "innboks";
  }
  /* Med Radar av står fanene bare når det finnes noe å vise i dem. */
  const visFaner = () => innstillinger().pa || !!(t.innboks?.length || t.under?.length || t.kjoringer?.length);
  const erListe = f => f === "innboks" || f === "under" || f === "lagt";

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
      rot.innerHTML = (på ? toppHtml() : introHtml())
        + '<div class="radar__merknader" id="radarMerknader">' + merknaderHtml() + '</div>'
        + (visFaner() ? fanerHtml() + '<div class="radar__panel" id="radarPanel" role="tabpanel" tabindex="0" aria-labelledby="radarFane-' + aktivFane() + '">'
          + panelHtml() + '</div>' : "");
    });
    tegnKlokke();
  }
  function tegnMerknader(){
    const el = rot?.querySelector("#radarMerknader");
    if(el) medFokus(() => { el.innerHTML = merknaderHtml(); });
  }
  /* Fanene og panelet under dem. */
  function tegnFaner(){
    const faner = rot?.querySelector("#radarFaner"), panel = rot?.querySelector("#radarPanel");
    if(!faner || !panel){ tegn(); return; }
    medFokus(() => {
      faner.outerHTML = fanerHtml();
      panel.setAttribute("aria-labelledby", "radarFane-" + aktivFane());
      panel.innerHTML = panelHtml();
    });
  }
  /* Når innboksen endres, følger tallene i fanene med, og panelet hvis
     det viser en av listene. Innstillingene tegnes ikke på nytt for det. */
  function tegnInnboks(){
    if(rot && t){
      const faner = rot.querySelector("#radarFaner");
      if(!faner){ if(visFaner()) tegn(); }
      else if(erListe(aktivFane())) tegnFaner();
      else medFokus(() => { faner.outerHTML = fanerHtml(); });
    }
    api.etterEndring();
  }
  function tegnStatus(){
    const går = søk.går || !!t?.kjorerNa;
    const el = rot?.querySelector("#radarStatus");
    if(el) el.textContent = bind(statustekst());
    const k = rot?.querySelector("#radarSokNa");
    if(k){ k.disabled = går; k.textContent = går ? "Søker…" : "Søk nå"; }
    const topp = rot?.querySelector(".radar__topp");
    if(topp){
      topp.toggleAttribute("data-soker", går);
      topp.toggleAttribute("data-feil", søk.feil && !går);
      topp.querySelector("#radarMeta").innerHTML = metaHtml();
      const n = topp.querySelector("#radarNotat"), tekst = notatHtml();
      n.innerHTML = tekst;
      n.hidden = !tekst;
    }
    tegnKlokke();
  }

  /* ---------- toppen ---------- */

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
  /* Det samme som når(), men bare tallene i mono: «i dag» er ord. */
  function nårHtml(iso){
    const d = new Date(iso);
    if(Number.isNaN(d.getTime())) return "";
    const diff = Math.round((api.iDag() - new Date(d.toDateString())) / 86400000);
    return (diff === 0 ? "i dag " : diff === 1 ? "i går " : '<span class="radar__tid">' + d.getDate() + ". " + MND_K[d.getMonth()] + '</span> ')
      + '<time class="radar__tid" datetime="' + esc(iso) + '">' + klokke(d) + '</time>';
  }
  const tallHtml = n => '<span class="radar__tid">' + esc(tallTekst(n)) + '</span>';
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

  /* Hele setningen om hva Radar gjør, til skjermlesere. Det synlige er
     linjen over trakten og notatet under den. */
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

  /* Linjen over trakten: hva Radar gjør, eller når den sist søkte og
     søker igjen, og forbruket i dag. */
  function metaHtml(){
    const ut = [];
    if(søk.går || t.kjorerNa){
      const alle = søk.går ? søk.alle ?? [] : [];
      ut.push('<span class="radar__soker"><span class="radar__puls" aria-hidden="true"></span>'
        + esc(!søk.går ? "Søker nå, startet et annet sted" : alle.length ? "Søker gjennom alle aktive hos " + og(alle) : "Ser etter nye stillinger")
        + '<span class="radar__klokke radar__tid" id="radarKlokke" aria-hidden="true"></span></span>');
    }else{
      const s = sisteKjøring();
      ut.push(s ? "Sist søkt " + nårHtml(s.start) + ", neste rundt "
        + '<span class="radar__tid">' + klokke(new Date(Date.parse(s.start) + Radar.TIME)) + '</span>' : "Ikke søkt ennå");
    }
    const f = t.forbruk;
    if(f?.tak) ut.push(tallHtml(f.vurderinger) + " av " + tallHtml(f.tak) + " vurderinger i dag");
    return ut.map(d => '<span class="radar__del">' + d + '</span>').join('<span class="radar__skille" aria-hidden="true">·</span>');
  }
  /* Det under trakten: en feil, eller det som gjelder neste kjøring.
     Tomt når trakten sier alt. */
  function notatHtml(){
    if(søk.går || t.kjorerNa) return "";
    if(søk.kort) return esc(bind(søk.kort));
    if(!sisteKjøring()) return "Første søk starter av seg selv mens Hired er åpen.";
    return esc(bind((fortsettertekst() + ventertekst(t.venter ?? 0)).trim()));
  }

  function toppHtml(){
    const går = søk.går || !!t.kjorerNa;
    const notat = notatHtml();
    return '<div class="radar__topp"' + (går ? " data-soker" : "") + (søk.feil && !går ? " data-feil" : "") + '>'
      + '<div class="radar__linje"><p class="radar__meta" id="radarMeta">' + metaHtml() + '</p>'
      + '<button class="knapp knapp--liten radar__sok" type="button" id="radarSokNa" data-radar="sok" data-fokus="sok"'
      + (går ? " disabled" : "") + '>' + (går ? "Søker…" : "Søk nå") + '</button></div>'
      + traktHtml()
      + '<p class="radar__notat" id="radarNotat" aria-hidden="true"' + (notat ? "" : " hidden") + '>' + notat + '</p>'
      + '<p class="skjult" id="radarStatus" role="status" aria-live="polite">' + esc(bind(statustekst())) + '</p>'
      + '</div>';
  }

  /* Trakten fra siste kjøring: fra alt som ble hentet, ned til det som
     nådde terskelen. Stolpene er logaritmiske, så både 11 010 og 5 synes,
     og blir mørkere mot treff-4. Når en ny kjøring er kommet siden
     trakten sist ble tegnet, vokser de fram én gang. */
  function traktHtml(){
    const k = sisteKjøring();
    const alle = !!k?.kilder?.some(s => s.sok);
    const trinnene = [
      [k?.kandidater, !k ? "aktive stillinger" : alle ? "aktive gjennomsøkt" : k.kandidater === 1 ? "ny stilling" : "nye stillinger"],
      [k?.passet, "passet søkeordene"],
      [k?.vurdert, "vurdert mot CV-en"],
      [k?.treff, "nådde terskelen"]
    ];
    const maks = Math.max(1, ...trinnene.map(([n]) => n ?? 0));
    const ny = !!k && animert !== null && animert !== k.start;
    animert = k?.start ?? "";
    return '<ol class="radartrakt"' + (ny ? " data-ny" : "") + ' aria-label="Siste kjøring">' + trinnene.map(([n, navn], i) => {
      const har = n != null;
      const l = har && n > 0 ? Math.log10(n + 1) / Math.log10(maks + 1) : 0;
      return '<li class="radartrakt__trinn" data-trinn="' + (i + 1) + '">' + (i ? TRAKTPIL : "")
        + '<span class="radartrakt__tall">' + (har ? esc(tallTekst(n)) : '<span aria-hidden="true">–</span><span class="skjult">ikke kjent</span>') + '</span>'
        + '<span class="radartrakt__navn">' + navn + '</span>'
        + '<span class="radartrakt__stolpe" aria-hidden="true"><i style="--l:' + l.toFixed(3) + '"></i></span></li>';
    }).join("") + '</ol>';
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
    return '<section class="radar__intro" aria-labelledby="radarIntroTittel">' + MOTIV
      + '<div class="radar__introkropp"><h3 class="radar__introtittel" id="radarIntroTittel">Radar er av</h3>'
      + '<p class="radar__introtekst">Radar ser etter nye stillinger hos NAV, Jobbnorge og karrieresidene du legger inn, '
      + 'og vurderer dem mot CV-en din. Det som passer, havner her, best først.</p>'
      + '<p class="radar__introtekst radar__introtekst--liten">Den søker hver time mens Hired er åpen. '
      + 'CV-en og annonsene som passer søkeordene, sendes til modellleverandøren din, og en kjøring koster noen få øre.</p>'
      + '<button class="knapp knapp--primar" type="button" data-radar="pa" data-fokus="pa">Slå på Radar</button></div></section>';
  }

  /* ---------- fanene ---------- */

  function fanerHtml(){
    const valgt = aktivFane();
    const tall = { innboks: nye().length, under: under().length, lagt: lagtTil().length };
    return '<div class="radar__faner" id="radarFaner" role="tablist" aria-label="Radar">' + FANER.map(([id, navn]) => {
      const er = id === valgt;
      return '<button class="radar__fane" type="button" role="tab" id="radarFane-' + id + '" data-radar="fane" data-fane="' + id + '"'
        + ' data-fokus="fane-' + id + '" aria-selected="' + er + '" tabindex="' + (er ? "0" : "-1") + '"' + (er ? ' aria-controls="radarPanel"' : "") + '>'
        + navn + (id in tall ? ' <span class="radar__fanetall">' + tall[id] + '</span>' : "")
        + (id === "innstillinger" ? '<span class="radar__fanemerke" id="radarFaneMerke"' + (endret() ? "" : " hidden") + '><span class="skjult">, ikke lagret</span></span>' : "")
        + '</button>';
    }).join("") + '</div>';
  }
  function panelHtml(){
    const f = aktivFane();
    if(f === "innstillinger") return innstillingerHtml();
    if(f === "kjoringer") return t.kjoringer?.length ? '<section class="kort radar__kjoringer" aria-label="Kjøringer">' + kjøringerHtml() + '</section>'
      : tomHtml("Ingen kjøringer ennå", "Hver kjøring står her med hva den fant og hva den kostet.");
    if(f === "under") return underHtml();
    if(f === "lagt") return lagtHtml();
    return '<div id="radarInnboks">' + innboksHtml() + '</div>';
  }
  /* fokus: flytt fokus til fanen, for valg fra noe annet enn fanen selv
     (piltastene, «Se under terskelen»). */
  function velgFane(id, fokus){
    if(!FANER.some(([f]) => f === id)) return;
    fane = id;
    tegnFaner();
    const el = rot?.querySelector("#radarFane-" + id);
    if(fokus) el?.focus();
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /* ---------- innstillingene ---------- */

  function innstillingerHtml(){
    const i = innstillinger(), g = gjeldende();
    return '<section class="kort radarinnst" id="radarInnst" aria-label="Innstillinger">'
      + '<div class="radarinnst__kropp">'
        + delHtml("Radar", '<label class="avkrys"><input type="checkbox" data-radar="paav" data-fokus="paav"' + (i.pa ? " checked" : "") + '> Søk etter nye stillinger hver time</label>'
          + '<p class="felt__hjelp">' + esc(varselhjelp(i.pa)) + '</p>')
        + delHtml("Hva Radar ser etter", ordlisteHtml("sokeord", g) + forslagHtml() + ordlisteHtml("steder", g) + ordlisteHtml("ekskluder", g))
        + delHtml("Terskel", terskelHtml(g))
        + delHtml("Kilder", kilderHtml(g) + siderHtml())
        + delHtml("Forbruk i dag", forbrukHtml(g))
      + '</div>'
      + lagrelinjeHtml()
      + '</section>';
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
  const terskeltekst = p => bind("Fra " + p + " %: " + SKALA(p) + ". Samme skala som vurderingen i panelet."
    + (p > 40 ? " Stillinger fra 40 til " + (p - 1) + " % står under terskelen, i fanen ved siden av innboksen." : ""));

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
    const tallSpan = n => '<span class="kjoringer__tall">' + esc(tallTekst(n)) + '</span>';
    return '<table class="kjoringer"><caption class="skjult">De fem siste kjøringene</caption>'
      + '<thead><tr><th scope="col">Når</th><th scope="col">Hva skjedde</th><th scope="col" class="kjoringer__kost">Kostnad</th></tr></thead><tbody>'
      + k.map(x => {
          const feil = [...x.kilder.filter(s => s.feil).map(s => (s.navn || KILDENAVN[s.kilde] || s.kilde) + ": " + s.feil), ...x.feil];
          const venter = x.venter ? " " + tallSpan(x.venter) + " ventet på vurdering." : "";
          return '<tr><td class="kjoringer__nar">' + esc(når(x.start)) + '</td>'
            + '<td class="kjoringer__hva">' + bind(kjøringstekst(x, { tall: tallSpan }) + venter) + '</td>'
            + '<td class="kjoringer__kost">' + kr(x.kostnad) + '</td></tr>'
            + (feil.length ? '<tr class="kjoringer__feil"><td colspan="3"><span class="kilde__feil">Feil:</span> ' + esc(feil.slice(0, 3).join(" ")) + '</td></tr>' : "");
        }).join("") + '</tbody></table>';
  }

  function lagrelinjeHtml(){
    const e = endret();
    return '<div class="radarinnst__bunn"' + (e ? " data-endret" : "") + '>'
      + '<p class="radarinnst__lagret" id="radarLagret" role="status" aria-live="polite" tabindex="-1"' + (lagreFeil ? ' data-t="feil"' : e ? ' data-t="endret"' : "") + '>'
      + esc(lagreFeil || (lagrer ? "Lagrer…" : e ? "Endringene er ikke lagret" : "Alt er lagret")) + '</p>'
      + '<button class="knapp knapp--stille knapp--liten" type="button" data-radar="forkast" data-fokus="forkast"' + (e && !lagrer ? "" : " disabled") + '>Forkast</button>'
      + '<button class="knapp knapp--primar knapp--liten" type="button" data-radar="lagre" data-fokus="lagre"' + (e && !lagrer ? "" : " disabled") + '>Lagre innstillingene</button></div>';
  }
  function tegnLagrelinje(){
    const el = rot?.querySelector(".radarinnst__bunn");
    if(el) medFokus(() => { el.outerHTML = lagrelinjeHtml(); });
    const m = rot?.querySelector("#radarFaneMerke");
    if(m) m.hidden = !endret();
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

  const domId = id => "funn-" + String(id).replace(/[^A-Za-z0-9_-]/g, "_");
  const hvem = r => [r.selskap || "Ukjent arbeidsgiver", r.sted].filter(Boolean).join(", ");
  const tomHtml = (tittel, tekst, knapp = "") => '<div class="tomt tomt--lav radar__tomt"><p class="tomt__tittel">' + esc(tittel) + '</p>'
    + '<p class="tomt__tekst">' + esc(bind(tekst)) + '</p>' + knapp + '</div>';

  /* Innenfor et bånd: en frist som haster først, den tidligste øverst,
     så høyeste prosent, så det som ble funnet sist. */
  function ordne(rader){
    const iDag = api.iDag();
    const haster = r => { const h = r.frist ? F.hast(r.frist, iDag) : ""; return h === "naa" || h === "snart"; };
    return rader.map(r => [r, haster(r)]).sort(([a, ha], [b, hb]) =>
      ha !== hb ? (ha ? -1 : 1)
      : ha && a.frist !== b.frist ? (a.frist < b.frist ? -1 : 1)
      : b.prosent - a.prosent || String(b.funnet ?? "").localeCompare(String(a.funnet ?? ""))).map(([r]) => r);
  }
  const bånd = rader => [4, 3, 2, 1, 0].map(n => ({ n, rader: ordne(rader.filter(r => trinn(r.prosent) === n)) })).filter(b => b.rader.length);
  /* Radene i den rekkefølgen de står på skjermen, så fokus etter en
     handling går til den som står under. */
  const iInnboks = () => bånd(nye()).flatMap(b => b.rader);

  function innboksHtml(){
    const n = nye(), l = lagtTil(), u = under();
    const på = innstillinger().pa, terskel = innstillinger().terskel;
    if(!n.length){
      if(!på) return tomHtml("Innboksen er tom", "Slå på Radar for å få nye stillinger hit.");
      const s = sisteKjøring();
      /* Det som ble vurdert lavere, nevnes først: uten det ser en tom
         innboks ut som at Radar ikke virker. */
      if(!s) return tomHtml("Ingen treff ennå", "Første søk starter av seg selv, eller trykk Søk nå.");
      if(u.length) return tomHtml("Ingenting over terskelen", antall(u.length, "stilling", "stillinger") + " ble vurdert lavere enn " + terskel + " %.",
        '<button class="knapp knapp--liten" type="button" data-radar="fane" data-fane="under" data-fokus="seUnder">Se under terskelen</button>');
      return l.length ? tomHtml("Ingenting nytt", "Radar har ikke funnet noe nytt fra " + terskel + " % siden sist.")
        : tomHtml("Ingen treff ennå", "Blir det stille lenge, kan du legge til søkeord eller senke terskelen.");
    }
    /* Midt i blinken løftes ut som egne kort; finnes ingenting der,
       begynner innboksen med det neste båndet. */
    return bånd(n).map(b => b.n === 4 ? b.rader.map(toppkortHtml).join("") : båndHtml(b, terskel)).join("");
  }

  function båndHtml({ n, rader }, terskel){
    return '<section class="baandblokk radarbaand" data-trinn="' + n + '" aria-labelledby="radarBaand-' + n + '">'
      + '<div class="baand"><span class="prikk" aria-hidden="true"></span>'
      + '<h3 class="radarbaand__navn" id="radarBaand-' + n + '">' + TRINN[n].navn + '</h3>'
      + '<span class="radarbaand__fra">' + bind("fra " + (n ? TRINN[n].fra : terskel) + " %") + '</span>'
      + '<span class="baand__strek" aria-hidden="true"></span>'
      + '<span class="baand__tall" aria-label="' + antall(rader.length, "stilling", "stillinger") + '">' + rader.length + '</span></div>'
      + '<div class="stabel">' + rader.map(r => radHtml(r, "innboks")).join("") + '</div></section>';
  }

  const leggTilKnapp = (r, klasse) => '<button class="' + klasse + '" type="button" data-radar="leggTil" data-id="' + esc(r.id) + '" data-fokus="legg-' + esc(r.id) + '"'
    + (legger.has(r.id) ? " disabled" : "") + '>' + (legger.has(r.id) ? "Legger til…" : jobbFor.has(r.id) ? "Prøv igjen" : "Legg til") + '</button>';
  const grunnerHtml = (r, blokk = "funn") => (r.grunner ?? []).length
    ? '<ul class="' + blokk + '__grunner" aria-label="Hvorfor den passer">' + r.grunner.map(g => '<li>' + esc(g) + '</li>').join("") + '</ul>' : "";
  function kildeHtml(r, blokk = "funn"){
    const deler = ["Fra " + esc(KILDENAVN[r.kilde] || r.kilde)];
    const publ = r.publisert || r.funnet, d = new Date(publ);
    if(publ && !Number.isNaN(d.getTime())) deler.push((r.publisert ? "publisert " : "funnet ")
      + '<time class="funn__dato" datetime="' + esc(publ) + '">' + d.getDate() + ". " + MND_K[d.getMonth()] + '</time>');
    return '<p class="' + blokk + '__kilde">' + deler.join(", ") + '</p>';
  }
  /* Fristen som dato og nedtelling. Hastefargen gjelder bare det som
     ennå ikke er lagt til; etterpå står fristen i søknaden. */
  function fristHtml(r, lagt){
    if(!r.frist) return "";
    const iDag = api.iDag(), h = lagt ? "" : F.hast(r.frist, iDag);
    return '<span class="skjult">Frist </span><time class="funn__dato" datetime="' + esc(r.frist) + '">' + F.kortDatoMnd(r.frist) + '</time>'
      + ' <span class="funn__om"' + (h === "naa" || h === "snart" ? ' data-hast="' + h + '"' : "") + '>' + esc(F.omTekst(r.frist, iDag)) + '</span>';
  }

  /* Det som er midt i blinken: prosenten stor, alle grunnene synlige,
     og «Legg til» som eneste primærknapp. */
  function toppkortHtml(r){
    const id = esc(r.id), tid = domId(r.id);
    const frist = fristHtml(r, false);
    return '<article class="toppfunn" data-trinn="4" data-radar-id="' + id + '" aria-labelledby="' + tid + ' ' + tid + '-hvem">'
      + '<div class="toppfunn__maal"><p class="toppfunn__stor">' + r.prosent + '<span class="toppfunn__pst">%</span></p>'
      + '<p class="toppfunn__trinn"><span class="prikk" aria-hidden="true"></span>' + TRINN[4].navn + '</p></div>'
      + '<div class="toppfunn__kropp"><h3 class="toppfunn__stilling" id="' + tid + '">' + esc(r.stilling) + '</h3>'
      + '<p class="toppfunn__hvem"><span id="' + tid + '-hvem">' + esc(hvem(r)) + '</span>'
      + (frist ? '<span class="toppfunn__frist"><span aria-hidden="true">frist </span>' + frist + '</span>' : "") + '</p>'
      + grunnerHtml(r, "toppfunn") + kildeHtml(r, "toppfunn") + '</div>'
      + '<div class="toppfunn__handlinger">' + leggTilKnapp(r, "knapp knapp--primar")
      + '<a class="knapp knapp--stille toppfunn__ut" href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer" data-fokus="apne-' + id + '">'
      + 'Åpne annonsen<span class="skjult"> hos ' + esc(r.selskap || "arbeidsgiveren") + ' i ny fane</span>' + IKON_UT + '</a>'
      + '<button class="knapp knapp--stille" type="button" data-radar="ikke" data-id="' + id + '" data-fokus="ikke-' + id + '">Ikke interessert</button></div>'
      + '</article>';
  }

  /* Raden i båndene, under terskelen og blant de lagt til: prosenten med
     en måler i trinnets farge, stillingen og hvem, fristen, og
     handlingene. «Hvorfor» folder ut grunnene og kilden under raden. */
  function radHtml(r, del){
    const lagt = del === "lagt", id = esc(r.id), tid = domId(r.id), merId = tid + "-mer";
    const åpen = !lagt && hvorforÅpen.has(r.id);
    const selskap = esc(r.selskap || "arbeidsgiveren");
    const ut = '<a class="handling handling--stille handling--ikon" href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer"'
      + ' data-fokus="apne-' + id + '" aria-label="Åpne annonsen hos ' + selskap + ' i ny fane" title="Åpne annonsen">' + IKON_UT + '</a>';
    let handlinger;
    if(lagt){
      const jobbId = søknadFor(r);
      handlinger = (jobbId ? '<button class="handling handling--hoved" type="button" data-radar="apneSoknad" data-jobb="' + esc(jobbId) + '" data-fokus="soknad-' + id + '">Åpne søknaden</button>'
        : '<span class="funn__borte">Søknaden er slettet</span>') + ut;
    }else handlinger = '<button class="handling handling--stille funn__hvorfor" type="button" data-radar="hvorfor" data-id="' + id + '" data-fokus="hvorfor-' + id + '"'
        + ' aria-expanded="' + åpen + '" aria-controls="' + merId + '">Hvorfor</button>'
      + leggTilKnapp(r, "handling handling--hoved")
      + '<button class="handling handling--stille handling--ikon" type="button" data-radar="ikke" data-id="' + id + '" data-fokus="ikke-' + id + '"'
        + ' aria-label="Ikke interessert i ' + esc(r.stilling) + ' hos ' + selskap + '" title="Ikke interessert">' + IKON_KRYSS + '</button>'
      + ut;
    return '<article class="funn funn--' + del + '" data-trinn="' + trinn(r.prosent) + '" data-radar-id="' + id + '" aria-labelledby="' + tid + ' ' + tid + '-hvem">'
      + '<div class="funn__maal"><span class="funn__tall">' + r.prosent + '<span class="skjult"> %</span></span>'
      + '<span class="maaler" aria-hidden="true"><i style="width:' + Math.max(0, Math.min(100, Number(r.prosent) || 0)) + '%"></i></span></div>'
      + '<div class="funn__kropp"><h4 class="funn__stilling" id="' + tid + '">' + esc(r.stilling) + '</h4>'
      + '<p class="funn__hvem" id="' + tid + '-hvem">' + esc(hvem(r)) + '</p></div>'
      + '<p class="funn__frist">' + fristHtml(r, lagt) + '</p>'
      + '<div class="funn__handlinger">' + handlinger + '</div>'
      + (lagt ? "" : '<div class="funn__mer" id="' + merId + '"' + (åpen ? "" : " hidden") + '>' + grunnerHtml(r) + kildeHtml(r) + '</div>')
      + '</article>';
  }

  /* Det Radar vurderte mellom 40 % og terskelen. Samme rader, ett trinn
     dempet, så en høy terskel aldri gjør at noe forsvinner uten spor. */
  function underHtml(){
    const u = under(), terskel = innstillinger().terskel;
    const hode = terskel > 40 ? '<div class="radar__underhode"><p class="radar__undertekst">'
      + esc(bind("Vurdert lavere enn " + terskel + " %. De står her i 30 dager, og flytter til innboksen om du senker terskelen.")) + '</p>'
      + '<button class="knapp knapp--liten" type="button" data-radar="tilTerskel" data-fokus="tilTerskel">Endre terskelen</button></div>' : "";
    return '<div id="radarUnder">' + hode + (u.length ? '<div class="stabel">' + u.map(r => radHtml(r, "under")).join("") + '</div>'
      : tomHtml("Ingenting under terskelen", terskel > 40 ? "Radar har ikke vurdert noe til mellom 40 og " + (terskel - 1) + " % de siste 30 dagene."
        : "Med terskelen på 40 % står alt Radar vurderer, i innboksen.")) + '</div>';
  }
  function lagtHtml(){
    const l = lagtTil();
    return l.length ? '<div class="stabel">' + l.map(r => radHtml(r, "lagt")).join("") + '</div>'
      : tomHtml("Ingenting lagt til ennå", "Det du legger til fra innboksen, blir en søknad under Frister og står her etterpå.");
  }

  function vekslHvorfor(id, knapp){
    const åpen = !hvorforÅpen.has(id);
    if(åpen) hvorforÅpen.add(id); else hvorforÅpen.delete(id);
    knapp.setAttribute("aria-expanded", String(åpen));
    const mer = rot?.querySelector("#" + CSS.escape(knapp.getAttribute("aria-controls")));
    if(mer) mer.hidden = !åpen;
  }

  /* Etter at en rad har gått ut av innboksen eller «Under terskelen»,
     går fokus til den som nå står på samme plass, så man kan gå gjennom
     listen med tastaturet uten å miste plassen. */
  function fokuserEtter(id, liste, del = iInnboks){
    const i = liste.findIndex(r => r.id === id);
    const igjen = del();
    const neste = igjen[i] || igjen[i - 1];
    requestAnimationFrame(() => {
      const el = neste ? rot?.querySelector('[data-fokus="legg-' + CSS.escape(neste.id) + '"]') : null;
      if(el) el.focus(); else api.fokuserTittel();
    });
  }

  /* ---------- handlingene ---------- */

  async function leggTil(id){
    const rad = radFor(id);
    if(!rad || legger.has(id)) return;
    const hvem = profil, del = erUnder(id) ? under : iInnboks, før = del();
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
      fokuserEtter(id, før, del);
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
    const rad = radFor(id);
    if(!rad || utsatt.has(id)) return;
    const del = erUnder(id) ? under : iInnboks, før = del();
    utsatt.set(id, setTimeout(() => fullførIkkeInteressert(id), ANGRETID));
    tegnInnboks();
    fokuserEtter(id, før, del);
    api.varsle("Fjernet " + (rad.selskap || "stillingen") + (del === iInnboks ? " fra innboksen" : ""), () => {
      clearTimeout(utsatt.get(id));
      utsatt.delete(id);
      /* Raden kan ha flyttet under terskelen i mellomtiden, og brukeren
         kan ha byttet fane; den skal stå synlig når fokus settes tilbake. */
      if(rot) fane = erUnder(id) ? "under" : "innboks";
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
          fane = "innstillinger"; tegn();
          rot?.querySelector('[data-fokus="inn-sokeord"]')?.focus();
        }else rot?.querySelector('[data-fokus="sok"]')?.focus();
      }
    }catch(e){
      if(e?.code !== "utlogget") api.varsle(e?.message || "Fikk ikke lagret");
      tegn();
    }
  }

  /* Knappen er avslått mens det lagres, og etterpå når alt er lagret,
     så fokus som stod på den, ville havnet på <body>. Det settes på
     knappen igjen om den kan trykkes, ellers på statusen ved siden av. */
  function fokusTilLagrelinje(){
    if(rot?.contains(document.activeElement)) return;
    const k = rot?.querySelector('[data-fokus="lagre"]');
    (k && !k.disabled ? k : rot?.querySelector("#radarLagret"))?.focus({ preventScroll: true });
  }

  async function lagre(){
    if(!endret() || lagrer) return;
    const fraKnapp = document.activeElement?.dataset?.fokus === "lagre";
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
    if(fraKnapp) fokusTilLagrelinje();
  }

  async function foreslå(){
    if(forslag.går) return;
    fane = "innstillinger";
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

  /* Fra «Under terskelen» til glideren: Innstillinger velges, og
     glideren får fokus, så piltastene flytter den med en gang. */
  function tilTerskel(){
    fane = "innstillinger";
    tegn();
    const g = rot?.querySelector("#radarTerskel");
    g?.focus({ preventScroll: true });
    g?.closest(".radarinnst__del")?.scrollIntoView({ block: "center" });
  }

  async function søkNå(){
    if(søk.går || t?.kjorerNa) return;
    søk = { går: true, start: Date.now(), tekst: "", kort: "", feil: false, alle: søkerAlle() };
    tegnStatus();
    try{
      const svar = await Radar.sokNa();
      søk.går = false;
      visSvar(svar);
    }catch(e){
      const m = e?.code === "utlogget" ? "" : (e?.message || "Søket stoppet uventet.");
      søk = { går: false, start: 0, tekst: m, kort: m, feil: e?.code !== "for-mange" };
      if(e?.code === "mangler-cv"){ grunnlag.cv = false; tegnMerknader(); }
      if(e?.code === "mangler-nokkel"){ grunnlag.nøkkel = false; tegnMerknader(); }
      tegnStatus();
    }
  }
  function visSvar(svar){
    const k = svar?.kjoring;
    if(!svar?.kjort){
      const m = svar?.grunn === "opptatt" ? "Radar søker allerede, fra en annen fane eller fra serveren." : svar?.grunn === "av" ? "Radar er av." : "";
      søk = { ...søk, går: false, feil: false, tekst: m, kort: m };
    }else{
      const tid = k?.start ? klokke(new Date(k.start)) : "";
      const feil = k?.feil?.length ? " " + k.feil[0] : "";
      søk = { ...søk, går: false, feil: !!feil || !svar.lagret,
        tekst: (k ? kjøringstekst(k, { tid, terskel: innstillinger().terskel }) : "Søket er ferdig.")
          + (svar.lagret ? fortsettertekst() + ventertekst(k?.venter ?? 0) : " Resultatet ble ikke lagret.") + feil,
        /* Det trakten viser, gjentas ikke under den; bare det som gikk galt. */
        kort: !svar.lagret ? "Søket ble gjort, men resultatet ble ikke lagret." : feil.trim() };
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
    else if(hva === "tilTerskel") tilTerskel();
    else if(hva === "fane") velgFane(b.dataset.fane, b.getAttribute("role") !== "tab");
    else if(hva === "hvorfor") vekslHvorfor(b.dataset.id, b);
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
    /* Fanene: piltastene flytter valget, Home og End til ytterpunktene. */
    if(el.dataset.radar === "fane" && el.getAttribute("role") === "tab" && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)){
      e.preventDefault();
      const ider = FANER.map(([f]) => f), i = ider.indexOf(el.dataset.fane);
      const n = e.key === "Home" ? 0 : e.key === "End" ? ider.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + ider.length) % ider.length;
      velgFane(ider[n], true);
    }else if(el.dataset.radar === "ordInn"){
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
    const n = nye().length, ord = n === 1 ? " ny" : " nye";
    if(!innstillinger().pa) return "Av" + (lagtTil().length || n ? " · <b>" + n + "</b>" + ord + " i innboksen" : "");
    return "<b>" + n + "</b>" + ord + " · <b>" + lagtTil().length + "</b> lagt til";
  }
  /* Tallet i sidepanelet: bare når Radar er på, eller har noe å vise. */
  function tall(){
    if(!t || (!innstillinger().pa && !nye().length)) return "";
    return String(antallNye());
  }

  return { vis, skjul, start, stopp, undertittel, tall, oppdater: () => { if(rot) tegnInnboks(); } };
}
