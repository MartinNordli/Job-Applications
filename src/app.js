/* ============================================================
   1. Data
   ============================================================ */
import { STATUSER, SEKTORER, JOBBTYPER, ER_SENDT, ER_ARKIV, validerSoknad, sjekkLenke } from "./felles.mjs";
import { START } from "./startliste.js";
import * as Lagring from "./lagring.js";
import { importerFraLenke, TRINN } from "./import.js";
import * as Jobbdokumenter from "./jobbdokumenter.js";
import * as Økt from "./okt.js";
import { krevØkt, krevØktIgjen, portenStår } from "./innlogging.js";
import * as Varsling from "./varsling.js";
import { DAGVALG } from "./fristvarsel.mjs";
import { medStatus, synkSendt, tidslinje, dagerSidenSendt, medianSvartid, svartidDager, utenSvarOver } from "./hendelser.mjs";
import * as F from "./formater.js";
import { esc, MND, MND_K, tilDato, tilIso, antall, monogram, langDato, kortDatoMnd } from "./formater.js";
import { lagDetaljpanel } from "./detaljpanel.js";
import { kommende as kommendeIntervjuer } from "./intervjuer.mjs";
import { lagMeny } from "./radmeny.js";
import { lagRadarflate } from "./radarflate.js";
import { oppdaterFlyt } from "./flyt.js";
import { lagCvInnstilling } from "./cvflate.js";

const NOKKEL = "jobbsoknader-2027";
window.__jobbsoknaderKjorer = true;   /* se fallback-skriptet i index.html */

/* Midnatt i dag. Ikke const: en fane som blir stående over midnatt
   må få ny dato, ellers viser den «i dag» om gårsdagen. Se seksjon 16. */
let I_DAG = new Date(new Date().toDateString());



/* ============================================================
   2. Tilstand og lagring
   ============================================================ */
let data = [];
/* Hvem listen tilhører. Settes av porten før noe hentes, og trengs to
   steder etterpå: sidefoten skal vise navnet, og en gjeninnlogging må
   kunne se om det er samme person som kom tilbake. */
let brukeren = null, erFørste = false;
let visning = "frister";
let sok = "", filtSektor = "", filtSted = "";
let angre = null, angreTid = null;

const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

const nyId = () => "s" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

function fraStart(){
  return START.map(r => ({
    id: nyId(), selskap: r[0], stilling: r[1], lenke: r[2], sted: r[3],
    frist: r[4], status: r[5], sektor: r[6], notat: r[7], sendtDato: null
  }));
}
/* localStorage er ikke lager lenger — bare det gamle stedet dataene
   kan flyttes fra én gang. Den tømmes aldri; den blir liggende som
   sikkerhetskopi til brukeren selv rydder den bort. */
function fraNettleser(){
  try{
    const raa = localStorage.getItem(NOKKEL);
    if(raa){ const p = JSON.parse(raa); if(Array.isArray(p) && p.length) return p; }
  }catch(e){}
  return null;
}

/* Alt som endrer data går gjennom denne ene funksjonen. Den samler
   opp raske endringer og skriver hele dokumentet til kontoens jobber.json. */
function lagre(){ Lagring.lagre(data); }

/* Detaljpanelet og «⋯»-menyen eier sin egen DOM og sine egne taster.
   Alt de trenger fra listen, får de her, så de aldri leser modultilstanden
   direkte. Funksjonene er hoistet, så rekkefølgen i filen spiller ingen rolle. */
let lastet = false;
const panel = lagDetaljpanel({
  jobb: id => data.find(p => p.id === id) || null,
  harData: () => lastet,
  iDag: () => I_DAG,
  settStatus: (id, ny) => settStatus(id, ny),
  lagreNotat: (id, tekst) => lagreNotat(id, tekst),
  endreIntervjuer: (id, regel) => endreIntervjuer(id, regel),
  ventPåLagring: () => ventPåLagring(),
  rediger: id => apneSkuff("rediger", id),
  slett: id => slett(id),
  varsle: (tekst, angreFn) => varsle(tekst, angreFn),
  brukernavn: () => brukeren?.navn || "",
  skuffErÅpen: () => $("#skuff").classList.contains("er-apen"),
  påLagring: fn => Lagring.påTilstand(fn),
  etterEndring: () => oppdaterInert(),
  visRad: id => visRad(id),
  tilListen: () => $("#sidetittel")
});
const meny = lagMeny({ valg: id => menyvalg(id) });
/* Radar eier sin egen DOM i #innhold mens visningen står. Søknaden
   «Legg til» lager, går gjennom samme regler og samme lagring som
   skjemaet: validerSoknad, så medStatus, så listen. */
const radar = lagRadarflate({
  jobber: () => data,
  iDag: () => I_DAG,
  leggTilSøknad: utkast => {
    const sjekk = validerSoknad(utkast, { lagId: nyId });
    if(!sjekk.ok) return { ok: false, melding: sjekk.feil[0].melding };
    const verdi = medStatus(sjekk.verdi, sjekk.verdi.status, { iDag: tilIso(I_DAG) });
    data.push(verdi);
    lagre(); tegn();
    return { ok: true, jobb: verdi };
  },
  ventPåLagring: () => ventPåLagring(),
  åpneSøknad: (id, valg) => panel.åpne(id, valg),
  /* CV-en er profilens, og legges inn under Innstillinger, også før
     det finnes en søknad. Nøkkelen bor i Brev-fanen, som Intervju-fanen
     sender til. Radar har ingen søknad selv, så den åpnes på den
     panelet viser, ellers den neste med frist, ellers den første. Uten
     søknader står Anthropic-nøkkelen også under Innstillinger. */
  tilCv: () => apneSkuff("innstillinger", null, { fokus: "cv" }),
  tilNøkkel: fra => nøkkelFor(fra),
  varsle: (tekst, angreFn) => varsle(tekst, angreFn),
  fokuserTittel: () => $("#sidetittel").focus(),
  etterEndring: () => {
    $("#tallRadar").textContent = radar.tall();
    if(visning === "radar") $("#sideUnder").innerHTML = radar.undertittel();
  }
});
function nøkkelFor(fra){
  const id = panel.valgtId() || data.filter(p => p.status === "todo").sort(sorterFrist)[0]?.id || data[0]?.id;
  if(id) return panel.åpne(id, { fane: "brev", hensikt: "nokkel", fra });
  apneSkuff("innstillinger");
}

/* ============================================================
   3. Datohjelpere
   ============================================================ */
/* Hjelperne står i formater.js og tar dagen inn. Her bindes de til
   appens egen klokke, som byttes ved midnatt. */
const dagerTil = iso => F.dagerTil(iso, I_DAG);
const hast     = iso => F.hast(iso, I_DAG);
const omTekst  = iso => F.omTekst(iso, I_DAG);
const ukedag   = F.ukedag;

/* ISO-ukenummer, mandag som ukestart */
function ukeStart(dt){ const d = new Date(dt); const v = (d.getDay() + 6) % 7; d.setDate(d.getDate() - v); return d; }
function ukeNr(dt){
  const d = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  d.setDate(d.getDate() + 4 - ((d.getDay() + 6) % 7));
  const a1 = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - a1) / 86400000 + 1) / 7);
}

/* ============================================================
   4. Utvalg
   ============================================================ */

function passererFilter(p){
  if(filtSektor && p.sektor !== filtSektor) return false;
  if(filtSted && !(p.sted || "").toLowerCase().includes(filtSted.toLowerCase())) return false;
  if(sok){
    const t = (p.selskap + " " + p.stilling + " " + (p.sted||"") + " " + (p.notat||"")).toLowerCase();
    if(!t.includes(sok.toLowerCase())) return false;
  }
  return true;
}
function iVisning(p, v){
  if(v === "frister") return p.status === "todo";
  if(v === "sendt")   return ER_SENDT(p.status);
  if(v === "arkiv")   return ER_ARKIV(p.status);
  return true;
}
function sorterFrist(a, b){
  if(a.frist && b.frist) return a.frist < b.frist ? -1 : a.frist > b.frist ? 1 : a.selskap.localeCompare(b.selskap,"no");
  if(a.frist) return -1;
  if(b.frist) return 1;
  return a.selskap.localeCompare(b.selskap,"no");
}

/* ============================================================
   5. Jobbraden — datokolonne, innhold, handlinger
   ============================================================ */

/* Kolonnen hver rad starter med viser det som faktisk skiller radene i
   visningen du står i: fristen under Frister, selskapet under Sendt og
   Arkiv — der har fristen gjort jobben sin.

   Datoen står som en smal mono-kolonne, ikke som en fylt pastellflis:
   samme opplysning, en brøkdel av vekten. Dagen nullpolstres og måneden
   forkortes til tre tegn, så datoene står rett under hverandre. */
function datoHtml(p){
  if(visning === "frister"){
    if(!p.frist) return '<div class="dato dato--lopende"><span class="dato__dag">–</span></div>';
    const d = tilDato(p.frist);
    return '<div class="dato">'
         + '<span class="dato__ukedag">' + ukedag(p.frist).slice(0, 2) + '</span>'
         + '<span class="dato__dag">' + String(d.getDate()).padStart(2, "0") + " " + MND_K[d.getMonth()] + '</span></div>';
  }
  /* Monogrammet er ren gjenkjenning. Statusen står i merkelappen til
     høyre, og trenger ikke også en kulør her. */
  return '<div class="dato dato--merke" aria-hidden="true"><span class="monogram">'
       + esc(monogram(p.selskap)) + '</span></div>';
}

/* Hva nedtellingskolonnen sier under Sendt: hvor lenge du har ventet på
   svar, eller hvor du står med intervjuet.

   - Et kommende intervju går foran alt annet. Det er en avtale, og den
     står med dato, «i dag» eller «i morgen». `kommer` gir teksten blekkets
     egen farge i stedet for den dempede: den er viktigere enn en
     teller, men den er ikke en frist, så den får ingen hastekulør.
   - Ellers teller et intervju fra dagen det ble logget.
   - En sendt søknad teller fra sendtdatoen.
   - Eldre søknader uten dato får ingen tekst. Kolonnen står like bred
     uansett, så raden flytter seg ikke, og et anslag ville vært gjetning. */

function ventetekst(p){
  /* Samme regel som Intervju-fanen: et intervju er kommende til det er over. */
  const kommende = kommendeIntervjuer(p)[0];
  if(kommende){
    const d = dagerTil(kommende.dato);
    return { kommer: true, tekst: "intervju " + (d === 0 ? "i dag" : d === 1 ? "i morgen" : kortDatoMnd(kommende.dato)) };
  }
  if(p.status === "interview"){
    const steg = tidslinje(p, I_DAG).filter(h => h.til === "interview" && h.dagerSiden != null).pop();
    if(!steg) return { tekst: "" };
    const d = steg.dagerSiden;
    return { tekst: d <= 0 ? "intervju fra i dag" : "i intervju i " + antall(d, "dag", "dager") };
  }
  const d = dagerSidenSendt(p, I_DAG);
  if(d == null || d < 0) return { tekst: "" };
  return { tekst: d === 0 ? "sendt i dag" : "venter " + antall(d, "dag", "dager") };
}

/* Prosentmerkene på radene. Ett utdrag per liste, hentet etter første
   tegning og på nytt når en vurdering eller en annonse er skrevet.
   Profilen står med, så merkene til én bruker aldri vises for en annen. */
let matchMerker = { profil: null, data: {}, henter: false }, matchSkitten = false;
async function lastMatchMerker(){
  const profil = brukeren?.id;
  if(!profil || matchMerker.henter) return;
  matchMerker.henter = true; matchSkitten = false;
  let data = {};
  try{ data = await Jobbdokumenter.matchMerker(); }catch{}
  matchMerker = { profil, data, henter: false };
  if(matchSkitten) return lastMatchMerker();
  if(profil === brukeren?.id) tegn();
}
/* Skrives noe mens utdraget hentes, leses det om med en gang det er ferdig. */
Jobbdokumenter.påMatchEndring(() => { matchSkitten = true; lastMatchMerker(); });
const UTDATERT_GRUNN = { cvRevisjon: "CV-en er endret", annonseSjekksum: "annonsen er endret", promptversjon: "eldre vurderingsmetode" };
function matchMerkeHtml(p){
  const m = matchMerker.profil === brukeren?.id ? matchMerker.data[p.id] : null;
  if(!m) return "";
  const gammel = m.utdatert.length > 0;
  const tittel = "Hvor godt stillingen passer CV-en" + (gammel ? ". Utdatert: " + m.utdatert.map(k => UTDATERT_GRUNN[k]).join(", ") : "");
  return '<span class="rad__match' + (gammel ? ' er-utdatert' : '') + '" title="' + esc(tittel) + '">' + m.prosent + ' %</span>';
}

function radHtml(p){
  const stilling = p.lenke
    ? '<a class="rad__stilling" href="' + esc(p.lenke) + '" target="_blank" rel="noopener noreferrer">' + esc(p.stilling) + '<span class="rad__pil">↗</span></a>'
    : '<span class="rad__stilling">' + esc(p.stilling) + '</span>';

  const meta = [];
  if(p.sted) meta.push(esc(p.sted));
  /* Sektoren er båndoverskriften under Sendt og Arkiv. Å gjenta den i
     hver rad der sier ingenting nytt; sendtdatoen står alt i kolonnen
     til høyre. Begge deler er tatt ut. */
  if(visning === "frister") meta.push(esc(SEKTORER[p.sektor] || SEKTORER.annet));
  const metaHtml = meta.length || p.notat
    ? '<span class="rad__meta">' + meta.join(" · ")
      + (p.notat ? (meta.length ? " · " : "") + '<span class="rad__notat">' + esc(p.notat) + '</span>' : "")
      + '</span>'
    : "";

  const underforstatt = (visning === "frister" && p.status === "todo") || (visning === "sendt" && p.status === "sent");
  const merke = (p.status !== "todo" && !underforstatt)
    ? '<span class="merkelapp" data-s="' + p.status + '">' + STATUSER[p.status] + '</span>' : "";

  /* Hastestripa på radens forkant leses av CSS. Den settes bare under
     Frister — det er den eneste visningen der en frist ennå haster. */
  const radHast = (visning === "frister" && p.status === "todo") ? hast(p.frist) : "";

  /* Nedtellingskolonnen tegnes alltid, også når den er tom. Bredden er
     reservert i CSS, så selskapsnavnet står like langt ut i hver rad og
     ingenting flytter seg mellom rader som har og ikke har tekst her. */
  let omTxt = "", omHast = "", omKommer = false;
  if(p.status === "todo" && p.frist){
    omTxt = omTekst(p.frist); omHast = hast(p.frist);
  }else if(visning === "frister" && p.status === "todo"){
    omTxt = "løpende";
  }else if(visning === "sendt"){
    const v = ventetekst(p);
    omTxt = v.tekst; omKommer = v.kommer;
  }
  const om = '<span class="rad__om"' + (omHast ? ' data-hast="' + omHast + '"' : "")
           + (omKommer ? ' data-kommer=""' : "") + '>' + omTxt + '</span>';

  const hoved = '<button class="handling handling--hoved" data-gjor="' + HOVEDSTEG[p.status].til + '" data-id="' + p.id + '">'
              + HOVEDSTEG[p.status].tekst + '</button>';

  /* Den valgte raden er den detaljpanelet viser. */
  const valgt = panel.valgtId() === p.id;

  /* Selskapsnavnet er en ekte lenke til panelet, så Enter, midtklikk og
     «åpne i ny fane» virker som venter. Resten av raden åpner det samme
     med et vanlig klikk (se klikklytteren). Sidehandlingene ligger bak
     «⋯»: de brukes sjelden, og en knapperad som dukker opp ved hover
     flyttet både blikket og raden. Høyrekolonnen har faste bredder, så
     knappene står i samme kolonne i alle rader og alle bånd. */
  return '<article class="rad' + (valgt ? ' er-valgt' : '') + '" data-id="' + p.id + '"'
    + (valgt ? ' aria-current="true"' : '')
    + (radHast ? ' data-hast="' + radHast + '"' : '') + '>'
    + datoHtml(p)
    + '<div class="rad__hoved">'
      + '<a class="rad__selskap" href="#jobb/' + p.id + '/oversikt">' + esc(p.selskap) + '</a>'
      + '<span class="rad__und">' + stilling + metaHtml + '</span>'
    + '</div>'
    + '<div class="rad__hoyre">' + merke + matchMerkeHtml(p) + om
      + '<div class="rad__verktoy"><button class="handling handling--brev" data-gjor="brev" data-id="' + p.id + '">Søknadsbrev</button>' + hoved
        + '<button class="handling rad__meny" type="button" data-meny="' + p.id + '" aria-haspopup="menu" aria-expanded="false"'
        + ' aria-label="Flere valg for ' + esc(p.selskap) + '">' + PRIKKER + '</button>'
      + '</div>'
    + '</div></article>';
}

/* Hovedhandlingen følger statusen. */
const HOVEDSTEG = {
  todo:      { til: "sent",      tekst: "Merk sendt" },
  sent:      { til: "interview", tekst: "Fikk intervju" },
  interview: { til: "accepted",  tekst: "Fikk tilbud" },
  accepted:  { til: "todo",      tekst: "Gjenåpne" },
  rejected:  { til: "todo",      tekst: "Gjenåpne" },
  trukket:   { til: "todo",      tekst: "Gjenåpne" },
  expired:   { til: "todo",      tekst: "Gjenåpne" }
};
const PRIKKER = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
  + '<circle cx="3.5" cy="8" r="1.35" fill="currentColor"/><circle cx="8" cy="8" r="1.35" fill="currentColor"/>'
  + '<circle cx="12.5" cy="8" r="1.35" fill="currentColor"/></svg>';

/* Valgene bak «⋯», i den rekkefølgen de står. Sideveiene ut av løpet
   vises bare der de gir mening. */
function menyvalg(id){
  const p = data.find(x => x.id === id);
  if(!p) return [];
  const valg = [{ gjor: "rediger", tekst: "Rediger" }];
  if(p.status === "sent" || p.status === "interview"){
    valg.push({ gjor: "rejected", tekst: "Fikk avslag" });
    valg.push({ gjor: "trukket",  tekst: "Trakk søknaden" });
  }
  if(p.status === "todo" && p.frist && dagerTil(p.frist) < 0)
    valg.push({ gjor: "expired", tekst: "Marker som utløpt" });
  valg.push({ gjor: "slett", tekst: "Slett", fare: true, skille: true });
  return valg;
}


/* «Løpende» betyr opptak uten frist. En frist som har gått ut er noe
   helt annet, og skal ikke telles som løpende. */
const erLopende = p => !p.frist;
const erUtgatt  = p => !!p.frist && dagerTil(p.frist) < 0;

function fristOppdeling(apne){
  const medFrist = apne.filter(p => p.frist && dagerTil(p.frist) >= 0);
  const lopende  = apne.filter(erLopende);
  const utgatt   = apne.filter(erUtgatt);
  const deler = [medFrist.length + " med frist", lopende.length + " løpende"];
  if(utgatt.length) deler.push(utgatt.length + " gikk ut");
  return { medFrist, lopende, utgatt, deler };
}

/* Båndoverskriften klistrer seg til toppen mens du blar. Antallet står
   som et bart tall i tabulære siffer — hva det teller sier navnet
   allerede — med den lange formen igjen som tilgjengelig navn. */
function baandHtml(navn, rader, id){
  return '<section class="baandblokk"' + (id ? ' id="' + id + '"' : '') + '>'
    + '<div class="baand"><h3 class="merkelinje baand__navn">' + navn + '</h3>'
      + '<span class="baand__strek" aria-hidden="true"></span>'
      + '<span class="baand__tall" aria-label="' + antall(rader.length, "søknad", "søknader") + '">'
      + rader.length + '</span></div>'
    + '<div class="stabel">' + rader.map(radHtml).join("") + '</div></section>';
}

/* ============================================================
   6. Visningene
   ============================================================ */
/* Bånd i den rekkefølgen en person faktisk planlegger i: det som haster
   denne uka først, så opptakene uten frist, som er de letteste å glemme,
   og til slutt én bolk per kalendermåned.

   Frister som har gått ut står ikke lenger i «Denne uka». Der skjøv de
   den ene fristen som faktisk haster ut av synet. De har sitt eget,
   sammenfoldede bånd nederst; se utgattHtml.

   Grensen er med vilje: står det 30. august, holder «Denne uka» ut 6.
   september, og SEPTEMBER-bolken begynner 7. september. */
function mndNavn(d){
  const n = MND[d.getMonth()];
  return n[0].toUpperCase() + n.slice(1)
       + (d.getFullYear() === I_DAG.getFullYear() ? "" : " " + d.getFullYear());
}

function fristBaand(liste){
  const baand = [];
  /* liste er sortert med sorterFrist og har ingen utgåtte frister. */
  const uka     = liste.filter(p => p.frist && dagerTil(p.frist) >= 0 && dagerTil(p.frist) <= 7);
  const lopende = liste.filter(p => !p.frist);
  const senere  = liste.filter(p => p.frist && dagerTil(p.frist) > 7);

  if(uka.length)     baand.push({ id: "naa",     navn: "Denne uka",      rader: uka });
  if(lopende.length) baand.push({ id: "lopende", navn: "Løpende opptak", rader: lopende });

  const mnd = new Map();
  senere.forEach(p => {
    const d = tilDato(p.frist), n = d.getFullYear() * 12 + d.getMonth();
    if(!mnd.has(n)) mnd.set(n, { id: "m" + n, navn: mndNavn(d), rader: [] });
    mnd.get(n).rader.push(p);
  });
  Array.from(mnd.keys()).sort((a, b) => a - b).forEach(n => baand.push(mnd.get(n)));
  return baand;
}

/* Søknadene i utløpsbåndet: de som vises nå, så filtrene gjelder også
   for «Flytt alle til arkivet». Den som gikk ut sist, står først. */
const synligeUtgatte = () => data.filter(p => p.status === "todo" && erUtgatt(p) && passererFilter(p))
  .sort((a, b) => sorterFrist(b, a));

/* Om båndet står åpent. Listen tegnes på nytt ved hver endring, og uten
   dette ville båndet klappet sammen hver gang en rad i det ble endret.
   Tilstanden leses fra båndet som står der når listen tegnes: toggle
   kommer først i en senere oppgave, og en omtegning rett etter et
   klikk ville ellers tegnet båndet lukket. Lytteren under trengs for
   at valget huskes når båndet har vært borte en stund. */
let utgattApen = false;

/* Utgåtte frister er sammenfoldet nederst: de trenger en avgjørelse,
   men ikke i dag, og de skal ikke ta plass fra det som haster. Raden i
   overskriften er samme klebende bånd som de andre, bare med en pil som
   sier at det kan foldes ut. Kulør er tatt ut av radene her (se CSS):
   en frist som har gått ut haster ikke lenger. */
function utgattHtml(rader){
  const filtrert = sok || filtSektor || filtSted;
  return '<section class="baandblokk baandblokk--utgatt" id="baand-utgatt">'
    + '<details class="utgatt" id="utgatt"' + (utgattApen ? " open" : "") + '>'
    + '<summary class="baand baand--fold">'
      + '<svg class="baand__pil" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="m3.5 2 3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      + '<h3 class="merkelinje baand__navn">Fristen har gått ut</h3>'
      + '<span class="baand__strek" aria-hidden="true"></span>'
      + '<span class="baand__tall" aria-label="' + antall(rader.length, "søknad", "søknader") + '">'
      + rader.length + '</span></summary>'
    + '<div class="utgatt__rad">'
      + '<p class="utgatt__tekst">Søknader du ikke rakk å sende. I arkivet står de som utløpt.'
        + (filtrert ? ' Bare de ' + rader.length + ' som passer filtrene, flyttes.' : '') + '</p>'
      + '<button class="knapp knapp--liten" type="button" data-gjor="arkiverUtgatte">Flytt alle til arkivet</button>'
    + '</div>'
    + '<div class="stabel">' + rader.map(radHtml).join("") + '</div>'
    + '</details></section>';
}

function visFrister(){
  const nå = document.getElementById("utgatt");
  if(nå) utgattApen = nå.open;
  const liste = data.filter(p => p.status === "todo" && passererFilter(p) && !erUtgatt(p)).sort(sorterFrist);
  const utgatte = synligeUtgatte();
  if(!liste.length && !utgatte.length) return tomHtml();
  const filtrert = sok || filtSektor || filtSted;
  /* Er alt som er igjen gått ut, sier listen det i stedet for å vise
     bare et sammenfoldet bånd. */
  const over = liste.length
    ? fristBaand(liste).map(b => baandHtml(b.navn, b.rader, "baand-" + b.id)).join("")
    : '<div class="tomt tomt--lav"><p class="tomt__tittel">Ingen åpne frister</p>'
      + '<p class="tomt__tekst">' + (filtrert
          ? "Ingen åpne frister passer filtrene. Det som har gått ut, ligger samlet under."
          : "Det som har gått ut, ligger samlet under. Legg til en ny søknad når du finner noe å søke på.") + '</p>'
      + (filtrert
          ? '<button class="knapp" data-gjor="nullstillFilter">Nullstill filtre</button>'
          : '<button class="knapp knapp--primar" data-gjor="nyFraTom">Legg til søknad</button>') + '</div>';
  return over + (utgatte.length ? utgattHtml(utgatte) : "");
}

function visEtterSektor(filterFn, tomTekst){
  const liste = data.filter(p => filterFn(p.status) && passererFilter(p));
  if(!liste.length) return tomHtml(tomTekst);
  const grupper = new Map();
  liste.forEach(p => { if(!grupper.has(p.sektor)) grupper.set(p.sektor, []); grupper.get(p.sektor).push(p); });
  return Object.keys(SEKTORER).filter(k => grupper.has(k)).map(k => {
    const rader = grupper.get(k).sort((a, b) => a.selskap.localeCompare(b.selskap, "no"));
    return baandHtml(esc(SEKTORER[k]), rader, null);
  }).join("");
}

function tomHtml(tekst){
  const filtrert = sok || filtSektor || filtSted;
  return '<div class="tomt">'
    + '<p class="tomt__tittel">' + (filtrert ? "Ingen treff" : "Ingenting her ennå") + '</p>'
    + '<p class="tomt__tekst">' + (filtrert
        ? "Ingen søknader passer filtrene. Nullstill dem for å se alt igjen."
        : (tekst || "Legg til den første søknaden, for hånd eller rett fra lenken til utlysningen.")) + '</p>'
    + (filtrert
        ? '<button class="knapp" data-gjor="nullstillFilter">Nullstill filtre</button>'
        : '<button class="knapp knapp--primar" data-gjor="nyFraTom">Legg til søknad</button>') + '</div>';
}

/* ============================================================
   7. Tall
   ============================================================ */
/* Ingen diagramfarge står her. Kulørtrinnene (--graf-1…4) ligger i
   CSS, så begge temaer får sine egne trinn uten at JS vet om dem. */
function liggendeStolper(rader){
  const maks = Math.max(1, ...rader.map(r => r.verdi));
  return '<div class="stolper">' + rader.map(r =>
      '<div class="stolpe"><div class="stolpe__navn" title="' + esc(r.navn) + '">' + esc(r.navn) + '</div>'
    + '<div class="stolpe__spor"><div class="stolpe__fyll" style="width:' + ((r.verdi / maks) * 100) + '%"></div>'
    + '<span class="stolpe__verdi">' + r.verdi + '</span></div></div>').join("") + '</div>';
}

function delteStolper(rader){
  const maks = Math.max(1, ...rader.map(r => r.a + r.b));
  return '<div class="stolper">' + rader.map(r =>
      '<div class="stolpe"><div class="stolpe__navn" title="' + esc(r.navn) + '">' + esc(r.navn) + '</div>'
    + '<div class="stolpe__spor stolpe__spor--delt">'
      + (r.a ? '<div class="stolpe__fyll" style="width:' + ((r.a / maks) * 100) + '%'
             + (r.b ? ';border-radius:6px 0 0 6px' : '') + '"></div>' : "")
      + (r.b ? '<div class="stolpe__fyll stolpe__fyll--mykt" style="width:' + ((r.b / maks) * 100) + '%'
             + (r.a ? ';border-radius:0 6px 6px 0' : '') + '"></div>' : "")
      + '<span class="stolpe__verdi">' + r.a + ' / ' + r.b + '</span>'
    + '</div></div>').join("") + '</div>';
}

/* Én del av en underlinje, som ikke brytes inni seg selv. Uten den kunne
   «18 gikk ut» bli delt, med «ut» alene på neste linje. */
const del = tekst => '<span class="nokkel__del">' + tekst + '</span>';

/* Høyst tre navn, så «og 2 til». Navnene får bryte som vanlig, men
   halen holdes samlet. */
function navneliste(navn){
  if(navn.length <= 3) return esc(navn.join(", "));
  return esc(navn.slice(0, 3).join(", ")) + " " + del("og " + (navn.length - 3) + " til");
}

/* `tom` er en flis uten tall ennå: streken står dempet, så den ikke
   leses som en verdi. */
function nokkel(merke, verdi, under, varsel, tom){
  return '<div class="nokkel' + (varsel ? " nokkel--varsel" : "") + (tom ? " nokkel--tom" : "") + '">'
    + '<p class="merkelinje nokkel__merke">' + merke + '</p>'
    + '<p class="nokkel__verdi">' + verdi + '</p>'
    + '<p class="nokkel__under">' + under + '</p></div>';
}

function visTall(){
  const alle    = data.filter(passererFilter);
  const sendt   = alle.filter(p => ER_SENDT(p.status) || p.status === "accepted"
                                 || p.status === "rejected" || p.status === "trukket");
  /* Intervjuet telles fra flagget, ikke fra statusen: et avslag etter
     intervjuet er fortsatt et intervju. Begge er utvalg av det sendte,
     så trakten aldri får et trinn som er større enn det over. */
  const intervju = sendt.filter(p => p.intervju);
  const svar     = sendt.filter(p => p.intervju || p.status === "rejected");
  const andel    = n => Math.round((n / sendt.length) * 100) + " %";
  const aSoke   = alle.filter(p => p.status === "todo");
  const medFrist = aSoke.filter(p => p.frist && dagerTil(p.frist) >= 0).sort(sorterFrist);
  const denneUka = medFrist.filter(p => dagerTil(p.frist) <= 7);
  const neste = medFrist[0];

  /* Svartiden regnes bare fra ekte hendelser, så eldre søknader uten
     logg teller ikke. Står det ingen ennå, sier flisen hvordan den fylles
     i stedet for å vise en null som ser ut som et svar. */
  const median = medianSvartid(sendt);
  const medSvartid = sendt.filter(p => svartidDager(p) !== null).length;
  /* Den som har ventet lengst står først i navnelisten. */
  const venter = utenSvarOver(alle, 30, I_DAG)
    .sort((a, b) => dagerSidenSendt(b, I_DAG) - dagerSidenSendt(a, I_DAG) || a.selskap.localeCompare(b.selskap, "no"));
  const unike = liste => liste.map(p => p.selskap).filter((v, i, a) => a.indexOf(v) === i);

  /* Rekkefølgen er to rader på bred skjerm: det som ligger foran deg
     (neste frist går over to kolonner), så det du har sendt og hva det
     har gitt. I to kolonner står neste frist alene øverst og resten
     parvis, så rutenettet går opp ved hver bredde. */
  let h = '<div class="fliser">'
    + nokkel("Neste frist", neste ? omTekst(neste.frist).replace("om ", "") : "–",
        neste ? del('<b>' + esc(neste.selskap) + '</b>') + ' · ' + del(esc(langDato(neste.frist))) : "Ingen frister framover",
        neste && dagerTil(neste.frist) <= 7, !neste)
    + nokkel("Frister denne uka", denneUka.length,
        denneUka.length ? navneliste(unike(denneUka)) : "Pusterom",
        denneUka.length > 0)
    + nokkel("Å søke på", aSoke.length, fristOppdeling(aSoke).deler.map(del).join(" · "), false)
    + nokkel("Sendt", sendt.length,
        sendt.length ? andel(svar.length) + " har svart" : "Ingen sendt ennå", false)
    + nokkel("Intervju", intervju.length,
        sendt.length ? andel(intervju.length) + " av de sendte" : "Ingen sendt ennå", false)
    + (median === null
        ? nokkel("Svartid", "–", "Måles fra du merker en søknad som sendt til den får svar.", false, true)
        : nokkel("Svartid", antall(Math.round(median), "dag", "dager"),
            del(medSvartid === 1 ? "Fra én søknad" : "Median av " + medSvartid + " søknader") + ", "
            + del("fra sendt til svar"), false))
    + nokkel("Uten svar", venter.length,
        venter.length ? del("Over 30 dager:") + " " + navneliste(unike(venter))
                      : "Ingen har ventet over 30 dager", false)
    + '</div>';

  const trinn = [
    { navn:"Sporet",      verdi: alle.length },
    { navn:"Sendt",       verdi: sendt.length },
    { navn:"Fått svar",   verdi: svar.length },
    { navn:"Fikk intervju", verdi: intervju.length }
  ];
  const tMaks = Math.max(1, trinn[0].verdi);
  h += '<div class="kort"><h3 class="kort__tittel">Fra liste til intervju</h3>'
    + '<p class="kort__und">Hvert trinn er et utvalg av trinnet over. Andelen måles mot antallet du har sendt.</p>'
    + '<div class="trakt">' + trinn.map((t, i) =>
        '<div class="trakt__trinn"><div class="trakt__navn">' + t.navn + '</div>'
      + '<div class="trakt__spor"><div class="trakt__fyll" style="width:' + ((t.verdi / tMaks) * 100) + '%"></div>'
      + '<span class="trakt__verdi">' + t.verdi + '</span>'
      + (i > 1 && sendt.length ? '<span class="trakt__andel">' + andel(t.verdi) + ' av sendt</span>' : "")
      + '</div></div>').join("") + '</div></div>';

  const uker = [];
  const u0 = ukeStart(I_DAG);
  for(let i = 0; i < 10; i++){
    const s = new Date(u0); s.setDate(s.getDate() + i * 7);
    const e = new Date(s);  e.setDate(e.getDate() + 6);
    uker.push({ nr: ukeNr(s), fra: tilIso(s), til: tilIso(e), verdi: 0 });
  }
  medFrist.forEach(p => { const u = uker.find(u => p.frist >= u.fra && p.frist <= u.til); if(u) u.verdi++; });
  const uMaks = Math.max(1, ...uker.map(u => u.verdi));
  h += '<div class="kort"><h3 class="kort__tittel">Fristtrykk de neste ti ukene</h3>'
    + '<p class="kort__und">Antall frister per uke. Toppene er ukene du må planlegge rundt.</p>'
    + '<div class="soyler">' + uker.map(u =>
        '<div class="soyle" title="Uke ' + u.nr + ': ' + antall(u.verdi, "frist", "frister") + '">'
      + (u.verdi ? '<span class="soyle__topp" style="bottom:calc(' + ((u.verdi / uMaks) * 100) + '% + 7px)">' + u.verdi + '</span>'
                 + '<div class="soyle__fyll" style="height:' + ((u.verdi / uMaks) * 100) + '%"></div>' : "")
      + '</div>').join("") + '</div>'
    + '<div class="akse">' + uker.map(u => '<span class="akse__hakk">' + u.nr + '</span>').join("") + '</div>'
    + '<p class="kort__und" style="margin:9px 0 0">Ukenummer</p></div>';

  const perSektor = Object.keys(SEKTORER).map(k => {
    const g = alle.filter(p => p.sektor === k);
    return { navn: SEKTORER[k], a: g.filter(p => p.status !== "todo").length, b: g.filter(p => p.status === "todo").length };
  }).filter(r => r.a + r.b > 0).sort((x, y) => (y.a + y.b) - (x.a + x.b));

  const steder = new Map();
  alle.forEach(p => (p.sted || "Ikke oppgitt").split("/").map(s => s.trim()).filter(Boolean)
    .forEach(s => steder.set(s, (steder.get(s) || 0) + 1)));
  const perSted = Array.from(steder, ([navn, verdi]) => ({ navn, verdi })).sort((x, y) => y.verdi - x.verdi).slice(0, 7);

  h += '<div class="rutenett">'
    + '<div class="kort"><h3 class="kort__tittel">Sektorene du satser på</h3>'
      + '<p class="kort__und">Tallene står i samme rekkefølge som fargene: sendt, så igjen.</p>'
      + '<div class="tegn"><span class="tegn__post"><span class="tegn__pryd"></span>Sendt</span>'
      + '<span class="tegn__post"><span class="tegn__pryd tegn__pryd--mykt"></span>Å søke på</span></div>'
      + delteStolper(perSektor) + '</div>'
    + '<div class="kort"><h3 class="kort__tittel">Hvor stillingene ligger</h3>'
      + '<p class="kort__und">En søknad med to steder telles begge steder.</p>'
      + liggendeStolper(perSted) + '</div>'
    + '</div>';

  const selsk = new Map();
  alle.forEach(p => selsk.set(p.selskap, (selsk.get(p.selskap) || 0) + 1));
  const topp = Array.from(selsk, ([navn, verdi]) => ({ navn, verdi }))
    .sort((x, y) => y.verdi - x.verdi || x.navn.localeCompare(y.navn, "no")).slice(0, 10);
  h += '<div class="kort"><h3 class="kort__tittel">Selskapene du følger tettest</h3>'
    + '<p class="kort__und">Antall stillinger du sporer hos hvert selskap, sendt og usendt.</p>'
    + liggendeStolper(topp) + '</div>';

  const medDato = alle.filter(p => p.sendtDato);
  h += '<div class="kort"><h3 class="kort__tittel">Sendt per uke</h3>';
  if(medDato.length < 2){
    h += '<p class="kort__und">Datoen settes automatisk når du merker en søknad som sendt.</p>'
      + '<p class="notis">' + medDato.length + ' av ' + sendt.length + ' sendte søknader har dato. '
      + 'Merk flere som sendt herfra, så tegnes tempoet ditt opp her.</p>';
  }else{
    const uk = new Map();
    medDato.forEach(p => { const s = tilIso(ukeStart(tilDato(p.sendtDato))); uk.set(s, (uk.get(s) || 0) + 1); });
    const rader = Array.from(uk, ([iso, verdi]) => ({ iso, navn: "uke " + ukeNr(tilDato(iso)), verdi }))
      .sort((x, y) => x.iso < y.iso ? -1 : 1).map(r => ({ navn: r.navn, verdi: r.verdi }));
    h += '<p class="kort__und">Hvor mange søknader du sendte hver uke.</p>' + liggendeStolper(rader);
  }
  h += '</div>';
  return h;
}

/* ============================================================
   8. Tegn opp
   ============================================================ */
const SIDER = {
  frister: { tittel:"Frister",  ingen:"Ingenting å søke på akkurat nå." },
  sendt:   { tittel:"Sendt",    ingen:"Ingen søknader venter på svar ennå. Merk en som sendt fra Frister." },
  arkiv:   { tittel:"Arkiv",    ingen:"Arkivet er tomt. Hit havner avslag, tilbud og frister som gikk ut." },
  tall:    { tittel:"Tall",     ingen:"" },
  radar:   { tittel:"Radar",    ingen:"" }
};

function tegn(){
  const antTodo  = data.filter(p => p.status === "todo").length;
  const antSendt = data.filter(p => ER_SENDT(p.status)).length;
  const antArkiv = data.filter(p => ER_ARKIV(p.status)).length;
  $("#tallFrister").textContent = antTodo;
  $("#tallSendt").textContent   = antSendt;
  $("#tallArkiv").textContent   = antArkiv;

  const apne = data.filter(p => p.status === "todo");
  const medFrist = apne.filter(p => p.frist && dagerTil(p.frist) >= 0).sort(sorterFrist);
  const neste = medFrist[0];

  /* Blokken er en knapp: den hopper til raden og blinker den fram.
     Uten en neste frist har den ingenting å hoppe til, og sperres. */
  const elNeste = $("#neste");
  elNeste.innerHTML = '<p class="merkelinje">Neste frist</p>' + (neste
    ? '<p class="neste__tall">' + esc(omTekst(neste.frist)) + '</p>'
      + '<p class="neste__hvem"><b>' + esc(neste.selskap) + '</b>' + esc(langDato(neste.frist)) + '</p>'
    : '<p class="neste__tall">Ingen</p><p class="neste__hvem">Alt med frist er avklart.</p>');
  elNeste.className = "neste" + (neste && dagerTil(neste.frist) <= 7 ? "" : " neste--rolig");
  elNeste.disabled = !neste;
  if(neste) elNeste.dataset.id = neste.id; else delete elNeste.dataset.id;

  $("#sidetittel").textContent = SIDER[visning].tittel;
  const und = visning === "frister"
      ? (() => {
          const o = fristOppdeling(apne);
          return '<b>' + antTodo + '</b> å søke på · <b>' + o.medFrist.length + '</b> med frist · <b>'
               + o.lopende.length + '</b> løpende'
               + (o.utgatt.length ? ' · <b>' + o.utgatt.length + '</b> gikk ut' : '');
        })()
    : visning === "sendt"  ? '<b>' + antSendt + '</b> venter på svar'
    : visning === "arkiv"  ? '<b>' + antArkiv + '</b> avgjort'
    : visning === "radar"  ? radar.undertittel()
    : '<b>' + data.length + '</b> søknader sporet i alt';
  $("#sideUnder").innerHTML = und;

  $("#nullstill").hidden = !(sok || filtSektor || filtSted);
  $("#tallRadar").textContent = radar.tall();

  /* Søket og filtrene gjelder søknadene, ikke Radar. */
  $(".sok").hidden = $(".filtre").hidden = visning === "radar";
  if(visning === "radar") radar.vis($("#innhold"));
  else{ radar.skjul(); $("#innhold").innerHTML =
      visning === "frister" ? visFrister()
    : visning === "sendt"   ? visEtterSektor(ER_SENDT, SIDER.sendt.ingen)
    : visning === "arkiv"   ? visEtterSektor(ER_ARKIV, SIDER.arkiv.ingen)
    : visTall(); }

  fyllVelg("#filtSektor", Object.entries(SEKTORER).filter(([k]) => data.some(p => p.sektor === k)), filtSektor, "Alle sektorer");
  const steder = Array.from(new Set(data.flatMap(p => (p.sted || "").split("/").map(s => s.trim()).filter(Boolean))))
    .sort((a, b) => a.localeCompare(b, "no"));
  fyllVelg("#filtSted", steder.map(s => [s, s]), filtSted, "Alle steder");

  /* Står panelet åpent, følger det søknaden: ny status, nytt notat eller
     endringer fra skuffen. Er søknaden slettet, lukker det seg. */
  panel.oppdater();
  if(matchMerker.profil !== brukeren?.id) lastMatchMerker();
}

function fyllVelg(sel, par, valgt, forste){
  const el = $(sel);
  const sign = JSON.stringify(par) + valgt;
  if(el.dataset.sign === sign) return;
  el.dataset.sign = sign;
  el.innerHTML = '<option value="">' + forste + '</option>'
    + par.map(([v, t]) => '<option value="' + esc(v) + '"' + (v === valgt ? " selected" : "") + '>' + esc(t) + '</option>').join("");
}

/* ============================================================
   9. Skuffen: skjema, lenkeimport, data og innstillinger
   ============================================================ */
let skuffModus = "lenke", redigerer = null;
/* Hvilken vei inn en ny søknad sist tok. Lenken står først og er
   standard; velger brukeren «For hånd», husker skuffen det til neste gang. */
let nyModus = "lenke";
/* Det importen leste ut av en utlysning. Det er ikke `redigerer`:
   en rad som redigeres finnes allerede i listen, mens et utkast bare
   er forslag til et tomt skjema. Ingenting herfra lagres før brukeren
   trykker «Legg til søknad» selv. */
let utkast = null;
/* Teller, ikke et flagg: lukkes skuffen eller byttes modus mens et
   importsvar er underveis, skal svaret falle på gulvet i stedet for å
   fylle et skjema brukeren har gått bort fra. */
let hentenr = 0;

const SKUFFTITTEL = {
  skjema:  "Legg til søknad",
  lenke:   "Legg til søknad",
  eksport: "Dataene dine",
  innstillinger: "Innstillinger",
  flytt:   "Flytt dataene hit",
  gjenopprett: "Datafilen mangler",
  bekreft: "Er du sikker?"
};

/* Hva skuffen skal gjøre når den lukkes, og hvor fokus skal tilbake. */
let bekreftelse = null, fokusFor = null, fokusTid = null;
/* CV-delen under Innstillinger lagrer selv, og må få gjøre det ferdig
   før skuffen tegnes på nytt eller lukkes. */
let cvInnst = null;
function slippCv(){ cvInnst?.lukk(); cvInnst = null; }

const FOKUSERBARE = 'a[href],summary,button:not([disabled]):not([tabindex="-1"]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
/* Listen er kommaseparert, og «#skuff » foran hele strengen ville bare
   bundet seg til det første leddet — resten hadde plukket opp knapper
   ute i appen. Hvert ledd må få prefikset for seg. */
const I_SKUFF = FOKUSERBARE.split(",").map(v => "#skuff " + v).join(",");
function synligFokus(el){
  if(el.matches(":disabled") || !el.getClientRects().length) return false;
  const foldet = el.closest("details:not([open])");
  /* Firefox kan gi skjulte details-barn en offsetParent. Bare selve
     overskriften skal delta i fokusrekken før innholdet foldes ut. */
  if(foldet && !foldet.querySelector(":scope > summary")?.contains(el)) return false;
  return getComputedStyle(el).visibility !== "hidden";
}

/* Hva som er inert, regnes ut ett sted, fra to modale lag: skuffen
   over alt, og detaljpanelet når det står som ark over listen. Lå
   regelen hos hver av dem, ville skuffen som lukkes over arket ha
   gjort listen bak arket levende igjen.

   Mens skuffen står, er alt utenom den, sløret og varselet inert.
   Varselet også: angreknappen i det kunne ellers stjele fokus ut av
   dialogen. Står arket alene, er det sidepanelet og listen som sover,
   mens arket, varselet og skuffen (lukket og usynlig) er utenfor. */
function oppdaterInert(){
  const skuff = $("#skuff").classList.contains("er-apen");
  const ark = !skuff && panel.erModal();
  const sett = (el, på) => { if(på) el.setAttribute("inert", ""); else el.removeAttribute("inert"); };
  Array.from(document.body.children).forEach(el => {
    if(["skuff", "slor", "varsel"].includes(el.id)) return;
    if(el.classList.contains("skall")){
      sett(el, skuff);
      if(!skuff) Array.from(el.children).forEach(barn => sett(barn, ark && barn.id !== "detalj"));
      return;
    }
    sett(el, skuff || (ark && el.id !== "detaljSlor" && el.id !== "port"));
  });
  const v = $("#varsel");
  if(skuff) v.setAttribute("inert", "");
  else if(v.classList.contains("er-apen")) v.removeAttribute("inert");
}

function apneSkuff(hva, id, { fokus } = {}){
  meny.lukk();
  redigerer = id ? data.find(p => p.id === id) : null;
  if(hva === "rediger")   skuffModus = "skjema";
  else if(hva === "ny")   skuffModus = nyModus;
  else                    skuffModus = hva;

  $("#skuffTittel").textContent = redigerer ? "Rediger søknad"
    : skuffModus === "gjenopprett" ? (filErOdelagt ? "Datafilen kan ikke leses" : "Datafilen mangler")
    : (SKUFFTITTEL[skuffModus] || "Legg til søknad");
  tegnSkuff();

  if(!$("#skuff").classList.contains("er-apen")) fokusFor = document.activeElement;
  $("#skuff").classList.add("er-apen");
  $("#skuff").setAttribute("aria-hidden", "false");
  $("#slor").classList.add("er-apen");
  oppdaterInert();
  /* Lukkes skuffen før dette rekker å kjøre, skal fokus bli der
     brukeren satte det — ikke hoppe inn i en skjult dialog. */
  clearTimeout(fokusTid);
  fokusTid = setTimeout(() => {
    if(!$("#skuff").classList.contains("er-apen")) return;
    if(fokus === "cv" && cvInnst){ cvInnst.fokuser(); return; }
    const f = $$(I_SKUFF).find(synligFokus) || $("#skuff");
    if(f) f.focus();
  }, 60);
}

function lukkSkuff(){
  if(!$("#skuff").classList.contains("er-apen")) return;
  clearTimeout(fokusTid);
  /* Lukkes et valg uten at det ble tatt, står lagringen fortsatt sperret.
     Da må det stå noe på skjermen — ellers ser en tom app helt normal ut. */
  if(skuffModus === "flytt" || skuffModus === "gjenopprett") minnOmValg();
  slippCv();
  $("#skuff").classList.remove("er-apen");
  $("#skuff").setAttribute("aria-hidden", "true");
  $("#slor").classList.remove("er-apen");
  oppdaterInert();
  redigerer = null;
  utkast = null;
  /* Et importsvar som kommer etter dette skal ikke fylle en lukket skuff. */
  hentenr++;
  bekreftelse = null;
  /* Fokus tilbake dit brukeren kom fra. Ble det tegnet på nytt mens
     skuffen sto, og står panelet åpent, er overskriften der det
     naturlige stedet å lande. */
  if(fokusFor && document.contains(fokusFor)) fokusFor.focus();
  else if(panel.erÅpen()) panel.fokuser();
  else $("#sidetittel").focus();
  fokusFor = null;
}

/* Tab skal gå rundt inni dialogen, ikke ut av den. */
function fokusfelle(e){
  if(e.key !== "Tab" || !$("#skuff").classList.contains("er-apen")) return;
  const f = $$(I_SKUFF).filter(synligFokus);
  if(!f.length) return;
  const forst = f[0], siste = f[f.length - 1];
  if(e.shiftKey && document.activeElement === forst){ e.preventDefault(); siste.focus(); }
  else if(!e.shiftKey && document.activeElement === siste){ e.preventDefault(); forst.focus(); }
}

function tegnSkuff(){
  const k = $("#skuffKropp"), b = $("#skuffBunn");
  slippCv();
  if(skuffModus === "eksport"){
    k.innerHTML = '<p class="felt__hjelp" style="margin:0 0 24px">'
      + antall(data.length, "søknad ligger", "søknader ligger") + ' i <code>jobber.json</code> i kontoens katalog.</p>'
      + annonserHtml()
      + '<section class="innst" aria-labelledby="startTittel">'
      + '<p class="merkelinje innst__tittel" id="startTittel">Startlisten</p>'
      + '<p class="felt__hjelp innst__forklaring">Erstatter alt du har lagt inn med de 55 søknadene appen startet med. Du kan angre etterpå.</p>'
      + '<button class="knapp knapp--bred knapp--fare" data-gjor="tilbakestill">Tilbakestill til startlisten</button></section>';
    b.innerHTML = '<button class="knapp" data-gjor="lukk">Lukk</button>';
    tellManglendeAnnonser();
    return;
  }

  if(skuffModus === "innstillinger"){
    const valgt = lestTema();
    k.innerHTML = '<section class="innst cvinnst" id="cvInnst" aria-labelledby="cvTittel"></section>'
      + '<section class="innst" aria-labelledby="temaTittel">'
      + '<p class="merkelinje innst__tittel" id="temaTittel">Fargetema</p>'
      + '<fieldset class="temaer"><legend class="skjult">Fargetema</legend>'
      + window.TEMAER.map(t => '<label class="tema">'
          + '<input type="radio" name="tema" value="' + t.id + '"' + (t.id === valgt ? " checked" : "") + '>'
          + '<span class="tema__prove" aria-hidden="true">'
          + t.prøve.map(f => '<i style="background:' + f + '"></i>').join("") + '</span>'
          + '<span class="tema__navn">' + esc(t.navn) + '</span>'
          + '<span class="tema__om">' + esc(t.om) + '</span></label>').join("")
      + '</fieldset>'
      + '<p class="felt__hjelp">Gjelder denne ' + (Lagring.I_APP ? "maskinen" : "nettleseren") + '.</p></section>'
      + '<section class="innst" aria-labelledby="varselTittel">'
      + '<p class="merkelinje innst__tittel" id="varselTittel">Fristvarsel</p>'
      + '<label class="avkrys"><input type="checkbox" id="varselPa" disabled> Varsle meg før søknadsfrister</label>'
      + '<div class="innst__rad"><label class="felt__merke" for="varselDager">Hvor lenge før</label>'
      + '<select class="felt__inn" id="varselDager" disabled>'
      + DAGVALG.map(d => '<option value="' + d + '">' + antall(d, "dag", "dager") + ' før</option>').join("")
      + '</select></div>'
      + '<p class="felt__hjelp" id="varselHjelp" role="status" aria-live="polite"></p>'
      + '<button class="knapp innst__tillat" type="button" data-gjor="tillatVarsler" id="varselTillat" hidden>Tillat varsler</button></section>'
      + '<section class="innst" id="apiNokkel" aria-labelledby="nokkelTittel"></section>';
    b.innerHTML = '<button class="knapp" data-gjor="lukk">Lukk</button>';
    cvInnst = lagCvInnstilling($("#cvInnst"), { varsle });
    visVarsel();
    visNokkel();
    return;
  }

  /* Engangsvalget når det finnes data i nettleseren, men ingen datafil. */
  if(skuffModus === "flytt"){
    const n = (fraNettleser() || []).length;
    k.innerHTML = '<p class="felt__hjelp" style="margin:0 0 6px">Fant</p>'
      + '<p class="flytt__tall">' + n + '</p>'
      + '<p class="felt__hjelp" style="margin:0 0 18px">'
      + (n === 1 ? 'søknad lagret i nettleseren.' : 'søknader lagret i nettleseren.') + '</p>'
      + '<p style="margin:0 0 14px;color:var(--blekk-2);font-size:14px;line-height:1.5">'
      + 'Flytt dem til <code>jobber.json</code> i kontoens katalog, så ligger de som en vanlig fil på maskinen din '
      + 'og følger med i sikkerhetskopier.</p>'
      + '<p class="felt__hjelp">Kopien i nettleseren blir liggende urørt.</p>';
    b.innerHTML = '<button class="knapp" data-gjor="brukStartliste">Bruk startlisten</button>'
      + '<button class="knapp knapp--primar" data-gjor="flyttHit">Flytt dem hit</button>';
    return;
  }

  /* Hovedfilen er borte, men den forrige gode kopien finnes. Den skal
     tilbys før startlisten — å seede over en sikkerhetskopi er tap. */
  if(skuffModus === "gjenopprett" && sisteKopi){
    const n = sisteKopi.jobber.length;
    k.innerHTML = '<p class="felt__hjelp" style="margin:0 0 6px">Sikkerhetskopien har</p>'
      + '<p class="flytt__tall">' + n + '</p>'
      + '<p class="felt__hjelp" style="margin:0 0 18px">'
      + (n === 1 ? 'søknad.' : 'søknader.') + '</p>'
      + '<p style="margin:0 0 14px;color:var(--blekk-2);font-size:14px;line-height:1.5">'
      + (filErOdelagt
          ? '<code>jobber.json</code> kan ikke leses. Den blir flyttet til side, ikke slettet, '
            + 'og <code>jobber.forrige.json</code> skrives inn i stedet.'
          : '<code>jobber.json</code> finnes ikke lenger, men <code>jobber.forrige.json</code> ligger igjen')
      + (sisteKopi.oppdatert ? ' Kopien er fra ' + esc(kortTid(sisteKopi.oppdatert)) + '.' : '.')
      + '</p><p class="felt__hjelp">Ingenting skrives før du velger.</p>';
    b.innerHTML = '<button class="knapp" data-gjor="brukStartliste">Bruk startlisten</button>'
      + '<button class="knapp knapp--primar" data-gjor="gjenopprettKopi">Gjenopprett</button>';
    return;
  }

  /* Appens egen bekreftelse i stedet for nettleserens confirm(). */
  if(skuffModus === "bekreft" && bekreftelse){
    k.innerHTML = '<p style="margin:0;color:var(--blekk-2);font-size:14px;line-height:1.55">'
      + esc(bekreftelse.tekst) + '</p>';
    b.innerHTML = '<button class="knapp" data-gjor="lukk">Avbryt</button>'
      + '<button class="knapp knapp--primar' + (bekreftelse.fare ? ' knapp--fare' : '')
      + '" data-gjor="bekreftJa">' + esc(bekreftelse.knapp) + '</button>';
    return;
  }
  b.innerHTML = '<button class="knapp" data-gjor="lukk">Avbryt</button>'
    + '<button class="knapp knapp--primar" id="lagreSkjema">' + (redigerer ? "Lagre endringer" : "Legg til søknad") + '</button>';

  /* To veier inn i det samme skjemaet. Lenken står først: den gjør mest
     av jobben. Bryteren klistrer seg til toppen av skuffen, så den er
     innen rekkevidde også når skjemaet er rullet ned. */
  const bytter = redigerer ? "" :
      '<div class="modusfeste"><div class="modus" role="tablist">'
    + '<button class="modus__knapp" role="tab" data-modus="lenke" aria-selected="' + (skuffModus === "lenke") + '">Fra lenke</button>'
    + '<button class="modus__knapp" role="tab" data-modus="skjema" aria-selected="' + (skuffModus === "skjema") + '">For hånd</button></div></div>';

  /* Lenkeimporten. Foten har ingen «Legg til søknad» her: det finnes
     ingenting å legge til før annonsen er lest. */
  if(skuffModus === "lenke"){
    b.innerHTML = '<button class="knapp" data-gjor="lukk">Avbryt</button>';
    k.innerHTML = bytter
      + '<div class="felt"><label class="felt__merke" for="importLenke">Lenke til utlysningen</label>'
      + '<input class="felt__inn" id="importLenke" type="url" inputmode="url" spellcheck="false" autocomplete="off"'
      + ' value="' + esc((utkast && utkast.lenke) || "") + '" placeholder="https://…">'
      + '<p class="felt__hjelp">Ingenting lagres nå. Skjemaet fylles ut med det som står i annonsen, og du legger til søknaden selv.</p></div>'
      + '<button class="knapp knapp--primar knapp--bred" type="button" id="hentLenke">Hent utlysningen</button>'
      + '<p class="henter" id="importTilstand" role="status" aria-live="polite"></p>'
      + '<p class="feil" id="skjemaFeil" hidden></p>';
    return;
  }

  const p = redigerer || utkast || {};
  /* Løpende opptak: enten en lagret rad uten frist, eller en annonse
     som selv sier at opptaket er løpende. */
  const utenFrist = redigerer ? !p.frist : !!(utkast && utkast.lopende);
  k.innerHTML = bytter
    + '<p class="feil" id="skjemaFeil" hidden></p>'
    + felt("selskap", "Selskap", p.selskap, "text", "Aker BP")
    + felt("stilling", "Stilling", p.stilling, "text", "Graduate: Data Engineer")
    + felt("lenke", "Lenke til utlysningen", p.lenke, "url", "https://…")
    + '<div class="felt__rad">' + felt("frist", "Søknadsfrist", p.frist, "date", "") + felt("sted", "Sted", p.sted, "text", "Oslo") + '</div>'
    + '<label class="avkrys"><input type="checkbox" id="ingenFrist"' + (utenFrist ? " checked" : "") + '> Løpende opptak, ingen frist</label>'
    /* Sektor og jobbtype hører sammen — begge sier hva slags stilling
       dette er. Status er brukerens egen, og står derfor for seg selv. */
    + '<div class="felt__rad" style="margin-top:15px">'
      + '<div class="felt"><label class="felt__merke" for="fSektor">Sektor</label><select class="felt__inn" id="fSektor">'
        + Object.entries(SEKTORER).map(([k2,v]) => '<option value="' + k2 + '"' + (p.sektor === k2 ? " selected" : "") + '>' + v + '</option>').join("") + '</select></div>'
      + '<div class="felt"><label class="felt__merke" for="fjobbtype">Jobbtype</label><select class="felt__inn" id="fjobbtype">'
        + '<option value="">Ikke oppgitt</option>'
        + Object.entries(JOBBTYPER).map(([k2,v]) => '<option value="' + k2 + '"' + (p.jobbtype === k2 ? " selected" : "") + '>' + v + '</option>').join("") + '</select></div>'
    + '</div>'
    + '<div class="felt"><label class="felt__merke" for="fStatus">Status</label><select class="felt__inn" id="fStatus">'
        + Object.entries(STATUSER).map(([k2,v]) => '<option value="' + k2 + '"' + ((p.status || "todo") === k2 ? " selected" : "") + '>' + v + '</option>').join("") + '</select></div>'
    + (redigerer
        ? '<div class="felt__rad" style="margin-top:15px">'
          + felt("sendtDato", "Sendt", p.sendtDato, "date", "")
          + '<div class="felt"><p class="felt__hjelp" style="margin-top:26px">Settes av seg selv når du merker en søknad som sendt. Fyll den inn her for eldre søknader.</p></div>'
          + '</div>'
          /* Blir stående når statusen senere går til avslag eller trukket,
             så tallene husker at søknaden ga intervju. */
          + '<label class="avkrys avkrys--felt"><input type="checkbox" id="fintervju"' + (p.intervju ? " checked" : "") + '> Fikk intervju</label>'
        : "")
    /* Flere linjer, som i detaljpanelet. Et vanlig tekstfelt ville
       stille fjernet linjeskiftene derfra ved neste lagring. */
    + '<div class="felt"><label class="felt__merke" for="fnotat">Notat</label>'
      + '<textarea class="felt__inn felt__notat" id="fnotat" rows="3" maxlength="1000" placeholder="f.eks. frist kl. 12:00">'
      + esc(p.notat || "") + '</textarea></div>'
    + (redigerer ? '<div class="brev__inngang"><button class="knapp knapp--bred" type="button" data-gjor="brevFraSkjema" data-id="' + esc(p.id) + '">Skriv søknadsbrev</button><p class="felt__hjelp">Lagre endringene og skriv et brev med CV-en og annonsen som grunnlag.</p></div>' : "");
}

function felt(id, merke, verdi, type, plass){
  return '<div class="felt"><label class="felt__merke" for="f' + id + '">' + merke + '</label>'
    + '<input class="felt__inn" id="f' + id + '" type="' + type + '" value="' + esc(verdi || "") + '" placeholder="' + esc(plass) + '"></div>';
}

/* ============================================================
   11. Varsel med angremulighet
   ============================================================ */
function varsle(tekst, angreFn){
  const v = $("#varsel");
  v.innerHTML = '<span>' + esc(tekst) + '</span>' + (angreFn ? '<button class="varsel__angre" id="angreKnapp">Angre</button>' : "");
  v.classList.add("er-apen");
  /* Usynlig varsel skal heller ikke kunne tabbes til. */
  if(!$("#skuff").classList.contains("er-apen")) v.removeAttribute("inert");
  const lukk = () => { v.classList.remove("er-apen"); v.setAttribute("inert", ""); };
  if(angreFn) $("#angreKnapp").onclick = () => { angreFn(); lukk(); };
  clearTimeout(angreTid);
  angreTid = setTimeout(lukk, angreFn ? 7000 : 3000);
}

/* ============================================================
   12. Handlinger
   ============================================================ */
function settStatus(id, ny){
  const p = data.find(x => x.id === id);
  if(!p) return;
  /* Hendelsene er med i øyeblikksbildet, så angre fjerner hendelsen igjen.
     medStatus lager en ny liste, og den gamle står urørt her. */
  const fra = { status: p.status, sendtDato: p.sendtDato, intervju: p.intervju, hendelser: p.hendelser };
  Object.assign(p, medStatus(p, ny, { iDag: tilIso(I_DAG) }));
  lagre(); tegn();
  varsle(p.selskap + " · " + STATUSER[ny].toLowerCase(), () => {
    Object.assign(p, fra); lagre(); tegn();
  });
}
/* Flytter alle utgåtte som vises nå til arkivet, med én lagring og én
   angre. Hendelsen dateres i dag; fristen står fortsatt på søknaden.

   Båndet forsvinner med knappen, så fokus flyttes til sideoverskriften
   i stedet for å falle ut til <body>. Angres det, står båndet der igjen,
   og fokus går til overskriften i det. */
function arkiverUtgatte(){
  const rader = synligeUtgatte();
  if(!rader.length) return;
  const klokke = { iDag: tilIso(I_DAG) };
  const før = rader.map(p => [p, { status: p.status, sendtDato: p.sendtDato, intervju: p.intervju, hendelser: p.hendelser }]);
  rader.forEach(p => Object.assign(p, medStatus(p, "expired", klokke)));
  lagre(); tegn();
  $("#sidetittel").focus();
  varsle("Flyttet " + antall(rader.length, "søknad", "søknader") + " til arkivet", () => {
    før.forEach(([p, fra]) => Object.assign(p, fra));
    lagre(); tegn();
    const tilbake = $("#utgatt > summary");
    if(tilbake) tilbake.focus();
  });
}
function slett(id){
  const i = data.findIndex(p => p.id === id);
  if(i < 0) return;
  const [p] = data.splice(i, 1);
  lagre(); tegn();
  varsle("Slettet " + p.selskap + " · " + p.stilling, () => { data.splice(i, 0, p); lagre(); tegn(); });
}
/* Notatet fra detaljpanelet, gjennom samme regler og samme lagring som
   skjemaet. Gir tilbake feilmeldingen når teksten ikke kan lagres. */
function lagreNotat(id, tekst){
  const p = data.find(x => x.id === id);
  if(!p) return "Søknaden finnes ikke lenger.";
  const sjekk = validerSoknad({ ...p, notat: tekst });
  if(!sjekk.ok) return sjekk.feil[0].melding;
  if(p.notat === sjekk.verdi.notat) return null;
  p.notat = sjekk.verdi.notat;
  lagre(); tegn();
  return null;
}

/* Intervjuene fra detaljpanelet. `regel` er en av funksjonene i
   intervjuer.mjs, bundet til det skjemaet sendte: den får søknaden og
   klokken, og gir { ok, jobb, ... } eller { ok: false, feil }. Bare
   feltene et intervju kan endre, kopieres over. Resultatet får med seg
   angre(felt), som legger de feltene tilbake slik de var: Intervju-fanen
   angrer statusbyttet uten å ta intervjuet bort, og en sletting uten å
   røre statusen. */
const INTERVJUFELT = ["intervjuer", "status", "sendtDato", "intervju", "hendelser"];
function endreIntervjuer(id, regel){
  const p = data.find(x => x.id === id);
  if(!p) return { ok: false, feil: [{ felt: null, melding: "Søknaden finnes ikke lenger." }] };
  const r = regel(p, { iDag: tilIso(I_DAG) });
  if(!r.ok) return r;
  const plukk = (o, felt) => Object.fromEntries(felt.map(f => [f, o[f]]));
  const fra = plukk(p, INTERVJUFELT);
  Object.assign(p, plukk(r.jobb, INTERVJUFELT));
  lagre(); tegn();
  return { ...r, angre: (felt = INTERVJUFELT) => {
    if(!data.includes(p)) return;
    Object.assign(p, plukk(fra, felt.filter(f => INTERVJUFELT.includes(f))));
    lagre(); tegn();
  } };
}
/* Løses når det som ligger i køen, er skrevet. Forberedelsen leser
   intervjuet fra lageret, så et intervju som nettopp er lagt inn, må
   være der først. Kan det ikke skrives, sier feilen hvorfor. */
function ventPåLagring(){
  if(!Lagring.harUlagret()) return Promise.resolve();
  Lagring.nåMedEnGang();
  return new Promise((ok, feil) => {
    let ferdig = false, av = null;
    const slutt = fn => { if(ferdig) return; ferdig = true; queueMicrotask(() => av?.()); fn(); };
    av = Lagring.påTilstand(t => {
      if(t.navn === "lagret" && !Lagring.harUlagret()) slutt(ok);
      else if(["ulagret", "frakoblet", "konflikt", "utlogget", "blokkert"].includes(t.navn)){
        const e = new Error("Endringen er ikke lagret ennå. " + (t.melding || "Prøv igjen når lagringen er i orden."));
        e.code = t.navn === "utlogget" ? "utlogget" : "ulagret";
        slutt(() => feil(e));
      }
    });
    if(ferdig) av();
  });
}

/* ---- annonsene som mangler ----

   Én stille handling i «Dataene dine», ikke en knapp i listen: den
   brukes en gang eller to, og den går ut på nettet for mange søknader
   på én gang. Antallet hentes fra utdraget, så knappen sier hva den
   vil gjøre før den gjør det. Plassen til tallet står avsatt, så
   knappen ikke vokser når svaret kommer. */
let annonsehenting = null;
function annonserHtml(){
  return '<section class="innst" aria-labelledby="annonseTittel">'
    + '<p class="merkelinje innst__tittel" id="annonseTittel">Stillingsannonser</p>'
    + '<p class="felt__hjelp innst__forklaring" id="manglendeHjelp">Henter annonsen fra lenken til hver søknad som ikke har en lagret. '
      + 'Annonser som ligger i et søknadsbrev, flyttes over først.'
      + (Lagring.I_APP ? '' : ' Nettleserversjonen henter høyst 30 i timen.') + '</p>'
    + '<button class="knapp knapp--bred" type="button" id="hentManglende" data-gjor="hentManglende" disabled aria-describedby="manglendeHjelp">'
      + 'Hent manglende annonser <span class="knapp__tall" id="manglendeTall" aria-hidden="true"></span></button>'
    + '<p class="henter" id="manglendeTilstand" role="status" aria-live="polite"></p>'
    + '<div class="oppsummering" id="manglendeSvar" hidden></div></section>';
}

/* Søknader uten lagret annonse. Utdraget har bare dokumentene som
   finnes, så en søknad som ikke står der, mangler også. */
async function manglendeAnnonser(){
  const utdrag = await Jobbdokumenter.utdrag(["annonse.sjekksum"]);
  return data.filter(p => !utdrag["jobb-" + p.id + ".json"]?.["annonse.sjekksum"]);
}

async function tellManglendeAnnonser(){
  const knapp = $("#hentManglende"), tall = $("#manglendeTall"), tilstand = $("#manglendeTilstand");
  if(!knapp) return;
  if(annonsehenting){
    knapp.disabled = true;
    tilstand.textContent = annonsehenting;
    return;
  }
  try{
    const mangler = await manglendeAnnonser();
    if(!knapp.isConnected) return;
    tall.textContent = mangler.length ? "(" + mangler.length + ")" : "";
    knapp.setAttribute("aria-label", "Hent manglende annonser, " + antall(mangler.length, "søknad", "søknader"));
    knapp.disabled = !mangler.length;
    if(!mangler.length) $("#manglendeHjelp").textContent = "Alle søknadene har en lagret annonse.";
  }catch(e){
    if(!knapp.isConnected || e?.code === "utlogget") return;
    tilstand.textContent = "Fikk ikke sjekket hvilke annonser som mangler";
  }
}

async function hentManglende(){
  const knapp = $("#hentManglende");
  if(!knapp || annonsehenting) return;
  const profil = brukeren?.id;
  let mangler;
  try{ mangler = await manglendeAnnonser(); }
  catch(e){ if(e?.code !== "utlogget") varsle("Fikk ikke sjekket hvilke annonser som mangler"); return; }
  if(!mangler.length) return tellManglendeAnnonser();
  annonsehenting = "Henter " + antall(mangler.length, "annonse", "annonser") + ". Det kan ta et minutt.";
  knapp.disabled = true;
  $("#manglendeTilstand").textContent = annonsehenting;
  $("#manglendeSvar").hidden = true;
  let svar = null, feil = null;
  try{ svar = await Jobbdokumenter.hentManglendeAnnonser({ ider: mangler.map(p => p.id) }); }
  catch(e){ feil = e; }
  annonsehenting = null;
  if(profil !== brukeren?.id || feil?.code === "utlogget") return;
  const st = $("#manglendeTilstand");
  if(st) st.textContent = "";
  if(feil){
    varsle(feil.melding || "Fikk ikke hentet annonsene");
    return tellManglendeAnnonser();
  }
  const navn = id => esc(data.find(p => p.id === id)?.selskap || "Slettet søknad");
  const deler = [];
  if(svar.hentet.length)  deler.push("hentet " + svar.hentet.length);
  if(svar.fraBrev.length) deler.push(svar.fraBrev.length + " fra brevet");
  if(svar.feilet.length)  deler.push(svar.feilet.length + " feilet");
  varsle(deler.length ? "Annonser: " + deler.join(", ") : "Ingen nye annonser");
  panel.oppdaterDokument();
  const el = $("#manglendeSvar");
  if(!el) return;
  const linjer = [];
  if(svar.hentet.length)  linjer.push('<p>' + antall(svar.hentet.length, "annonse hentet", "annonser hentet") + ' fra lenken.</p>');
  if(svar.fraBrev.length) linjer.push('<p>' + antall(svar.fraBrev.length, "annonse flyttet", "annonser flyttet") + ' fra søknadsbrevet.</p>');
  if(svar.utenLenke.length) linjer.push('<p>' + antall(svar.utenLenke.length, "søknad har", "søknader har")
    + ' ingen lenke. Lim inn annonsen fra søknaden.</p>');
  if(svar.stoppet === "for-mange") linjer.push('<p>Stoppet ved taket på 30 i timen. '
    + antall(svar.gjenstar.length, "søknad gjenstår", "søknader gjenstår") + '. Prøv igjen senere.</p>');
  if(svar.feilet.length) linjer.push('<p>Disse lot seg ikke hente:</p><ul>'
    + svar.feilet.map(f => '<li><b>' + navn(f.id) + '</b> ' + esc(f.melding) + '</li>').join("") + '</ul>');
  el.innerHTML = linjer.join("") || '<p>Ingen nye annonser å hente.</p>';
  el.hidden = false;
  tellManglendeAnnonser();
}
/* Hvilket felt en feilmelding hører til, så fokus havner riktig sted. */
const FELT_TIL_INN = {
  selskap: "#fselskap", stilling: "#fstilling", lenke: "#flenke", sted: "#fsted",
  frist: "#ffrist", sendtDato: "#fsendtDato", notat: "#fnotat", jobbtype: "#fjobbtype",
  status: "#fStatus", sektor: "#fSektor"
};

function lagreSkjema(){
  const v = id => { const e = $("#f" + id); return e ? e.value.trim() : ""; };
  const feilEl = $("#skjemaFeil");
  const ingen = $("#ingenFrist").checked;

  const utkast = {
    id:        redigerer ? redigerer.id : nyId(),
    selskap:   v("selskap"),
    stilling:  v("stilling"),
    lenke:     v("lenke"),
    sted:      v("sted"),
    notat:     v("notat"),
    frist:     ingen ? null : (v("frist") || null),
    sektor:    $("#fSektor").value,
    jobbtype:  v("jobbtype"),
    status:    $("#fStatus").value,
    sendtDato: redigerer ? (v("sendtDato") || null) : null,
    intervju:  redigerer ? $("#fintervju").checked : false,
    /* Skjemaet viser ikke listene, men må sende dem videre. Ellers ville
       validatoren gitt tomme lister, og Object.assign under slettet dem. */
    hendelser:  redigerer ? redigerer.hendelser  : [],
    intervjuer: redigerer ? redigerer.intervjuer : [],
    opprettet: redigerer ? redigerer.opprettet : null,
    oppdatert: redigerer ? redigerer.oppdatert : null
  };

  /* Samme regler som serveren kjører — én definisjon, ingen glidning. */
  const sjekk = validerSoknad(utkast);
  if(!sjekk.ok){
    feilEl.hidden = false;
    feilEl.innerHTML = sjekk.feil.length === 1
      ? esc(sjekk.feil[0].melding)
      : sjekk.feil.map(f => '<span class="feil__felt">' + esc(f.melding) + "</span>").join("");
    const inn = $(FELT_TIL_INN[sjekk.feil[0].felt] || "#fselskap");
    if(inn) inn.focus();
    return;
  }
  feilEl.hidden = true;

  /* En ny søknad og et nytt statusvalg logges som hendelse. Ellers
     holdes bare sendtDato og sendt-hendelsen i takt, så en rettet
     sendtdato flytter hendelsen i stedet for å legge til en ny. */
  const klokke = { iDag: tilIso(I_DAG) };
  const verdi = !redigerer || redigerer.status !== sjekk.verdi.status
    ? medStatus(sjekk.verdi, sjekk.verdi.status, klokke)
    : synkSendt(sjekk.verdi, klokke);

  const annonse = redigerer ? null : importertAnnonse();
  if(redigerer){
    Object.assign(redigerer, verdi);
    varsle("Lagret " + verdi.selskap);
  }else{
    data.push(verdi);
    varsle("La til " + verdi.selskap + " · " + verdi.stilling);
  }
  lagre(); tegn(); lukkSkuff();
  if(annonse) lagreImportertAnnonse(verdi.id, annonse);
}
/* Utenfor lagreSkjema, der et lokalt `utkast` skygger for importens. */
const importertAnnonse = () => (utkast && utkast.annonse) || null;

/* Annonsen fra importen hører til jobbdokumentet, og det krever at
   søknaden står i den lagrede listen. Derfor skrives den først når
   lagringen er ferdig. Feiler det, er søknaden lagt til likevel, og
   annonsen kan hentes eller limes inn senere. */
async function lagreImportertAnnonse(id, annonse){
  const profil = brukeren?.id;
  try{
    for(let i = 0; i < 20; i++){
      await Lagring.nåMedEnGang();
      if(!Lagring.harUlagret() || Lagring.erBlokkert()) break;
      await new Promise(r => setTimeout(r, 250));
    }
    if(profil !== brukeren?.id) return;
    await Jobbdokumenter.lagreAnnonse(id, { tekst: annonse.tekst, url: annonse.url, hentet: annonse.hentet, kilde: "import" });
    Jobbdokumenter.vurderIBakgrunnen(id);
  }catch(e){
    if(profil !== brukeren?.id) return;
    console.warn("Annonsen fra importen ble ikke lagret:", e);
    varsle("Søknaden er lagt til, men ikke annonsen. Hent den igjen senere.");
  }
}
/* ---- import fra lenke ---- */

/* Husets språk for «noe skjer»: mono mikrotekst, to trinn, ingen
   spinner. Teksten sier hvor i kjeden vi er, ikke hvor lenge det tar. */
const VENTETEKST = {
  [TRINN.HENTER]: "Henter utlysningen…",
  [TRINN.LESER]:  "Leser annonsen…"
};

/* Andre linje under en feilmelding: hva brukeren kan gjøre nå. Strengene
   er våre egne — det eneste som kommer utenfra er `.message`, og den blir
   escapet. */
const IMPORTHJELP = {
  "finnes":         'Åpne den fra listen hvis du vil endre noe. Vil du legge den inn på nytt likevel, velg «For hånd».',
  "mangler-nokkel": 'Importen trenger en API-nøkkel. Legg den inn under Innstillinger.',
  "frakoblet":      'Sjekk at serveren kjører, og prøv igjen.',
  "ellers":         'Lenken står igjen. Velg «For hånd» hvis du heller vil fylle inn resten selv.'
};

function visImportfeil(melding, hjelp){
  const el = $("#skjemaFeil");
  if(!el) return;
  el.hidden = false;
  el.innerHTML = esc(melding) + (hjelp ? '<span class="feil__felt">' + hjelp + '</span>' : "");
}

async function hentFraLenke(){
  const inn = $("#importLenke"), knapp = $("#hentLenke");
  if(!inn || !knapp) return;
  const url = inn.value.trim();

  if(!url){ visImportfeil("Lim inn lenken til utlysningen først."); inn.focus(); return; }
  /* Samme lenkeregel som resten av appen — ingen grunn til å gå til
     serveren med noe vi vet blir avvist. */
  const sl = sjekkLenke(url);
  if(!sl.ok){ visImportfeil(sl.melding); inn.focus(); return; }

  const mitt = ++hentenr;
  const feilEl = $("#skjemaFeil");
  if(feilEl){ feilEl.hidden = true; feilEl.textContent = ""; }
  knapp.disabled = true;

  try{
    const svar = await importerFraLenke(url, {
      jobber: data,
      påTrinn: t => {
        const st = $("#importTilstand");
        if(mitt === hentenr && st) st.textContent = VENTETEKST[t] || "";
      }
    });
    if(mitt !== hentenr) return;

    utkast = Object.assign({}, svar.utkast, { lenke: svar.utkast.lenke || url, annonse: svar.annonse || null });
    skuffModus = "skjema";
    tegnSkuff();
    const f = $("#skuff input, #skuff textarea");
    if(f) f.focus();

    const antall = Object.values(svar.kilder || {}).filter(kk => kk && kk !== "bruker").length;
    varsle(antall
      ? "Leste " + antall + (antall === 1 ? " felt" : " felter") + " fra annonsen. Se over dem før du legger til"
      : "Fant lite i annonsen. Fyll inn resten selv");
  }catch(e){
    if(mitt !== hentenr) return;
    /* Lenken skal aldri gå tapt. Den blir stående i feltet, og den følger
       med over i skjemaet sammen med det importen rakk å lese. */
    utkast = Object.assign({}, (e && e.utkast) || null, { lenke: (e && e.utkast && e.utkast.lenke) || url });
    /* Importfeil har en ferdig formulert norsk melding. Alt annet er en
       feil i koden, og da er en rå JS-melding ikke til hjelp for noen. */
    const kjent = e && typeof e.navn === "string";
    if(!kjent) console.error("Uventet feil under import:", e);
    visImportfeil(kjent ? e.message : "Importen stoppet uventet.",
                  (kjent && IMPORTHJELP[e.navn]) || IMPORTHJELP.ellers);
  }finally{
    if(mitt === hentenr){
      const st = $("#importTilstand");
      if(st) st.textContent = "";
    }
    if(knapp.isConnected) knapp.disabled = false;
  }
}

/* ---- hva importen har kostet ---- */

/* Tre tall, og ikke flere: hva den har kostet, hvor ofte modellen slapp
   å kjøre, og hvilke felt modellen måtte fylle. Det siste er det eneste
   som er handlingsrettet — står «selskap» øverst lenge, er et
   selskapsuttrekk neste ting å skrive. */


function siden(iso){
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.getDate() + ". " + MND[d.getMonth()];
}

/* ---- nøkkelen importen bruker ---- */

/* Nøkkelen går inn og aldri ut. Feltet er tomt hver gang, står utenfor
   noe <form> — nettleserens passordbehandler skal ikke tilby å huske en
   API-nøkkel — og statuslinjen sier bare hvilken nøkkel som gjelder, i
   samme mono-mikrotekst som lagringstilstanden.

   Hele blokken tegnes med én gang og fylles etterpå, så ingenting
   flytter seg når svaret kommer. */
async function visNokkel(){
  const el = $("#apiNokkel");
  if(!el) return;
  el.innerHTML = '<p class="merkelinje innst__tittel" id="nokkelTittel">API-nøkkel for import fra lenke</p>'
    + '<p class="lagret" id="nokkelTilstand" style="margin:9px 0 13px" role="status" aria-live="polite"></p>'
    + '<p class="feil" id="nokkelFeil" hidden></p>'
    + '<label class="felt__merke" for="apiNokkelInn">Ny nøkkel</label>'
    + '<input class="felt__inn" id="apiNokkelInn" type="password" autocomplete="off"'
    + ' spellcheck="false" placeholder="sk-ant-…" aria-describedby="nokkelFeil nokkelHjelp">'
    + '<p class="felt__hjelp" id="nokkelHjelp" style="margin-bottom:11px">Lagres i din egen katalog '
    + 'og vises aldri igjen. Erstatter den som ligger der nå.</p>'
    + '<div class="nokkelrad">'
    + '<button class="knapp" data-gjor="lagreNokkel" id="lagreNokkel">Lagre nøkkel</button>'
    + '<button class="knapp knapp--fare" data-gjor="fjernNokkel" id="fjernNokkel" hidden>Fjern nøkkel</button>'
    + '</div>';

  const r = await Økt.hentNokkel();
  const t = $("#nokkelTilstand");
  if(!t || skuffModus !== "innstillinger") return;

  if(!r.ok){
    t.textContent = "Fikk ikke lest nøkkeltilstanden";
    t.dataset.t = "ulagret";
    return;
  }
  delete t.dataset.t;
  t.textContent =
      r.kilde === "egen"  ? "Nøkkel satt" + (r.hale ? " · ····" + r.hale : "")
                            + (r.satt ? " · " + siden(r.satt) : "")
    : r.kilde === "miljø" ? "Serverens nøkkel brukes"
    :                       "Ingen nøkkel, importen er slått av";
  /* Bare en nøkkel du har satt selv kan fjernes. Serverens egen tilhører
     den som startet serveren. */
  const fjern = $("#fjernNokkel");
  if(fjern) fjern.hidden = r.kilde !== "egen";
}

function visNokkelfeil(melding){
  const el = $("#nokkelFeil");
  if(!el) return;
  el.textContent = melding;
  el.hidden = false;
}

async function lagreNokkel(){
  const inn = $("#apiNokkelInn"), knapp = $("#lagreNokkel");
  if(!inn) return;
  const verdi = inn.value.trim();
  if(!verdi){ visNokkelfeil("Lim inn API-nøkkelen først."); inn.focus(); return; }

  const feilEl = $("#nokkelFeil");
  if(feilEl) feilEl.hidden = true;
  if(knapp) knapp.disabled = true;
  const r = await Økt.settNokkel(verdi);
  if(knapp && knapp.isConnected) knapp.disabled = false;

  if(!r.ok){
    if(r.feil === "utlogget") return;        /* porten tar over */
    visNokkelfeil(r.melding || "Nøkkelen ble ikke lagret.");
    inn.focus();
    return;
  }
  inn.value = "";
  visNokkel();
  varsle("Nøkkelen er lagret");
}

function fjernNokkel(){
  spor("Nøkkelen slettes fra katalogen din. Importen slutter å virke med mindre "
     + "serveren har sin egen.", "Fjern nøkkel", true, async () => {
    const r = await Økt.fjernNokkel();
    if(!r.ok){
      if(r.feil !== "utlogget") varsle(r.melding || "Nøkkelen ble ikke fjernet");
      return;
    }
    /* Resultatet er bare synlig i skuffen, så den åpnes igjen. */
    apneSkuff("innstillinger");
    varsle("Nøkkelen er fjernet");
  });
}

/* Fristvarselet. Innstillingen ligger i profilens katalog, ikke i
   nettleseren: bakgrunnsjobben i Mac-appen må kunne lese den når appen
   er lukket. Hva som varsles, står i src/fristvarsel.mjs. */
let varselnr = 0;
async function visVarsel(){
  const nr = ++varselnr;
  const r = await Varsling.hentInnstilling();
  const på = $("#varselPa"), dager = $("#varselDager");
  if(!på || skuffModus !== "innstillinger" || nr !== varselnr) return;
  if(!r.ok){ visVarselhjelp(r.melding); return; }
  /* En verdi skrevet for hånd i filen, som 4, skal vises som den er. */
  if(!DAGVALG.includes(r.dagerFør))
    dager.insertAdjacentHTML("beforeend", '<option value="' + r.dagerFør + '">' + antall(r.dagerFør, "dag", "dager") + " før</option>");
  på.checked = r.på;
  dager.value = String(r.dagerFør);
  på.disabled = false;
  dager.disabled = !r.på;
  visVarselhjelp();
}

function visVarselhjelp(feil){
  const el = $("#varselHjelp"), på = $("#varselPa");
  if(!el || !på) return;
  const t = Varsling.tillatelse();
  const tekst = feil ? feil
    : !på.checked      ? "Ingen varsler. Fristene står fortsatt øverst i listen."
    : t === "app"      ? "Varselet kommer øverst til høyre på skjermen, også når Hired er lukket. Første gang spør macOS om lov."
    : t === "granted"  ? "Varselet kommer øverst til høyre mens Hired er åpen i nettleseren. Med Mac-appen installert kommer det også når den er lukket."
    : t === "denied"   ? "Nettleseren har blokkert varsler fra denne siden. Slå dem på i nettleserens innstillinger for nettstedet."
    : t === "ustøttet" ? "Denne nettleseren kan ikke vise varsler."
    :                    "Nettleseren må gi lov før den kan vise varsler.";
  el.textContent = tekst;
  /* Lov må gis med et klikk: nettlesere avviser en forespørsel som
     ikke kommer fra brukeren selv. */
  const tillat = $("#varselTillat");
  if(tillat) tillat.hidden = !!feil || !på.checked || t !== "default";
}

async function lagreVarsel(){
  const på = $("#varselPa"), dager = $("#varselDager");
  if(!på || på.disabled) return;
  const ønsket = { på: på.checked, dagerFør: Number(dager.value) };
  dager.disabled = !ønsket.på;
  if(ønsket.på && Varsling.tillatelse() === "default") await Varsling.beOmTillatelse();
  på.disabled = true;
  const r = await Varsling.settInnstilling(ønsket);
  if(!på.isConnected) return;
  på.disabled = false;
  if(!r.ok){ varsle(r.melding); visVarsel(); return; }
  visVarselhjelp();
  if(r.på) Varsling.sjekk();
}

/* Etter en lagring kan en ny frist ha kommet innenfor rekkevidde. Flere
   lagringer på rad gir én sjekk. */
let sjekkTid = null;
function sjekkSnart(){
  clearTimeout(sjekkTid);
  sjekkTid = setTimeout(() => Varsling.sjekk(), 1500);
}
/* Står appen åpen over natten, fanger døgnskiftet det nye døgnet. En
   sjekk i timen tar resten, som en Mac som har sovet. */
setInterval(() => Varsling.sjekk(), 60 * 60 * 1000);

/* ============================================================
   13. Hendelser
   ============================================================ */

/* I appen finnes ingen «ny fane»: target="_blank" gjør ingen ting, og
   utlysningslenkene ville vært døde. Systemets egen nettleser er dit de
   hører hjemme uansett — appvinduet skal ikke navigere bort fra lista. */
if(Lagring.I_APP){
  document.addEventListener("click", e => {
    const a = e.target.closest && e.target.closest('a[href^="http"]');
    if(!a) return;
    e.preventDefault();
    window.__TAURI__.opener.openUrl(a.href).catch(f => console.warn("Fikk ikke åpnet lenken:", f));
  });
}

/* Raden åpner detaljpanelet. Knapper, lenker og menyen i raden gjør
   sitt eget, og den som drar for å merke tekst, skal få merke den.
   Selskapsnavnet er en ekte lenke: et vanlig klikk tas her, så panelet
   får styre historikken selv, mens midtklikk og Cmd-klikk åpner en
   direktelenke i ny fane som før. */
document.addEventListener("click", e => {
  const rad = e.target.closest && e.target.closest("#innhold .rad");
  if(!rad || e.defaultPrevented) return;
  const lenke = e.target.closest("a");
  if(lenke && !lenke.classList.contains("rad__selskap")) return;
  if(e.target.closest("button,input,select,textarea,summary")) return;
  if(lenke && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)) return;
  if(!lenke && String(getSelection?.() || "").trim() && rad.contains(getSelection().anchorNode)) return;
  e.preventDefault();
  panel.åpne(rad.dataset.id, { fra: rad.querySelector(".rad__selskap") });
});

document.addEventListener("click", e => {
  const t = e.target.closest("[data-gjor],[data-modus],[data-visning],#neste,#apneNy,#lukkSkuff,#apneEksport,#apneInnstillinger,#nullstill,#lagreSkjema,#hentLenke,#loggUt");
  if(!t) return;

  if(t.id === "loggUt"){ loggUt(); return; }

  if(t.id === "apneNy"){ apneSkuff("ny"); return; }
  if(t.id === "apneEksport"){ apneSkuff("eksport"); return; }
  if(t.id === "apneInnstillinger"){ apneSkuff("innstillinger"); return; }
  if(t.id === "lukkSkuff"){ lukkSkuff(); return; }
  if(t.id === "nullstill"){ sok = ""; filtSektor = ""; filtSted = ""; $("#sok").value = ""; tegn(); return; }
  if(t.id === "lagreSkjema"){ lagreSkjema(); return; }
  if(t.id === "hentLenke"){ hentFraLenke(); return; }
  if(t.id === "neste"){ if(t.dataset.id) hoppTilSoknad(t.dataset.id); return; }

  if(t.dataset.visning){
    visning = t.dataset.visning;
    settNav(); tegn();
    window.scrollTo({ top: 0, behavior: "auto" });
    return;
  }
  if(t.dataset.modus){ skuffModus = nyModus = t.dataset.modus; hentenr++; tegnSkuff(); const f = $("#skuff input,#skuff textarea"); if(f) f.focus(); return; }

  const g = t.dataset.gjor, id = t.dataset.id;
  if(g === "lukk") lukkSkuff();
  else if(g === "brev") panel.åpne(id, { fane: "brev", fra: t });
  else if(g === "brevFraSkjema"){
    lagreSkjema();
    if(!$("#skuff").classList.contains("er-apen")){
      const profil = brukeren?.id;
      Lagring.nåMedEnGang().then(() => {
        if(profil !== brukeren?.id || $("#skuff").classList.contains("er-apen")) return;
        if(Lagring.harUlagret()) return varsle("Jobbendringene er ikke lagret ennå. Prøv igjen når lagringen er ferdig.");
        panel.åpne(id, { fane: "brev" });
      });
    }
  }
  else if(g === "hentManglende") hentManglende();
  else if(g === "rediger") apneSkuff("rediger", id);
  else if(g === "slett") slett(id);
  else if(g === "arkiverUtgatte") arkiverUtgatte();
  else if(g === "nyFraTom") apneSkuff("ny");
  else if(g === "nullstillFilter"){ sok = ""; filtSektor = ""; filtSted = ""; $("#sok").value = ""; tegn(); }
  else if(g === "tilbakestill"){
    const fra = data;
    spor("Startlisten på 55 søknader erstatter alt som ligger her nå. Du kan angre etterpå.",
         "Tilbakestill", true, () => {
           data = fraStart(); lagre(); tegn();
           varsle("Tilbakestilt til startlisten", () => { data = fra; lagre(); tegn(); });
         });
  }
  else if(g === "lagreNokkel") lagreNokkel();
  else if(g === "fjernNokkel") fjernNokkel();
  else if(g === "tillatVarsler") Varsling.beOmTillatelse().then(() => { visVarselhjelp(); Varsling.sjekk(); });
  else if(g === "flyttHit") flyttHit();
  else if(g === "gjenopprettKopi") gjenopprettKopi();
  else if(g === "brukStartliste"){ data = silt(fraStart().concat(data)); taValget(); lagre(); tegn(); lukkSkuff(); varsle("Startet med startlisten"); }
  else if(g === "apneValget") apneSkuff(venterValg || "flytt");
  else if(g === "bekreftJa"){ const bk = bekreftelse; lukkSkuff(); if(bk) bk.gjor(); }
  else if(g === "prøvLagring") Lagring.prøvIgjen();
  else if(g === "hentPåNytt") hentData();
  else if(g && STATUSER[g]) settStatus(id, g);
});

function settNav(){
  $$("#faner .nav__post").forEach(f => f.setAttribute("aria-selected", String(f.dataset.visning === visning)));
  /* På smal skjerm ruller toppstripa sidelengs; den valgte fanen skal stå synlig. */
  $('#faner [aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  oppdaterFlyt($(".side"));
}

/* Sørger for at raden til en søknad står i listen: bytter til visningen
   den hører til, og tar bort filtrene bare hvis de skjuler den. */
function visRad(id){
  const p = data.find(x => x.id === id);
  if(!p || $('#innhold .rad[data-id="' + id + '"]')) return;
  const hjem = ["frister", "sendt", "arkiv"].find(v => iVisning(p, v));
  if(hjem && hjem !== visning){ visning = hjem; settNav(); }
  if(!passererFilter(p)){ sok = ""; filtSektor = ""; filtSted = ""; $("#sok").value = ""; }
  if(p.status === "todo" && erUtgatt(p)) utgattApen = true;
  tegn();
}

/* «Neste frist» i sidepanelet regnes ut uten filtre — det er den
   faktiske neste fristen din, ikke den neste blant det du ser på nå.
   Ligger raden derfor utenfor det som vises, ryddes veien fram til
   den før vi hopper. */
function hoppTilSoknad(id){
  const finn = () => $('.rad[data-id="' + id + '"]');
  let mal = finn();
  if(!mal){
    if(visning !== "frister"){ visning = "frister"; settNav(); }
    if(sok || filtSektor || filtSted){ sok = ""; filtSektor = ""; filtSted = ""; $("#sok").value = ""; }
    tegn();
    mal = finn();
  }
  if(!mal) return;
  mal.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion:reduce)").matches ? "auto" : "smooth", block: "center" });
  mal.classList.remove("er-truffet"); void mal.offsetWidth; mal.classList.add("er-truffet");
}

$("#slor").addEventListener("click", lukkSkuff);
/* toggle bobler ikke, så den fanges på vei ned. */
document.addEventListener("toggle", e => { if(e.target.id === "utgatt" && e.target.isConnected) utgattApen = e.target.open; }, true);
$("#sok").addEventListener("input", e => { sok = e.target.value; tegn(); });
$("#filtSektor").addEventListener("change", e => { filtSektor = e.target.value; tegn(); });
$("#filtSted").addEventListener("change", e => { filtSted = e.target.value; tegn(); });
document.addEventListener("change", e => {
  if(e.target.name === "tema") settTema(e.target.value);
  else if(e.target.id === "varselPa" || e.target.id === "varselDager") lagreVarsel();
});

document.addEventListener("keydown", fokusfelle);
document.addEventListener("keydown", e => {
  /* Porten eier tastaturet mens den står. Uten dette ville «n» åpnet
     skuffen og «/» flyttet fokus ut i en app brukeren ikke er inne i. */
  if(portenStår()) return;
  /* Esc lukker det øverste laget og bare det: menyen tar sin egen
     (se radmeny.js), så skuffen, og til sist detaljpanelet. */
  if(e.key === "Escape"){
    if(e.defaultPrevented) return;
    if($("#skuff").classList.contains("er-apen")) lukkSkuff();
    else if(panel.erÅpen()) panel.lukk();
    return;
  }
  const iFelt = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if(iFelt){
    /* Enter gjør det modusen handler om. Uten dette ville Enter i
       lenkefeltet forsøkt å lagre et tomt skjema. */
    if(e.key === "Enter" && e.target.closest("#skuff") && e.target.tagName !== "TEXTAREA"){
      e.preventDefault();
      if(skuffModus === "lenke") hentFraLenke();
      else lagreSkjema();
    }
    return;
  }
  if(e.metaKey || e.ctrlKey || e.altKey) return;
  if($("#skuff").classList.contains("er-apen")) return;   /* dialogen eier tastaturet */
  if(e.key === "n"){ e.preventDefault(); apneSkuff("ny"); }
  /* Søkefeltet ligger bak arket på smal skjerm. */
  if(e.key === "/" && !panel.erModal() && visning !== "radar"){ e.preventDefault(); $("#sok").focus(); }
});

/* ============================================================
   14. Fargetema
   ============================================================ */
/* Temaet er en innstilling for denne nettleseren, ikke data. Det går
   utenom Lagring og havner aldri i jobber.json. Selve
   påføringen skjer allerede i <head> — se index.html — så det ikke
   blinker lyst før app.js rekker å kjøre; her holdes bare valget,
   knappene og nettleserflaten i takt. */
const TEMA_NOKKEL = "jobbsoknader-tema";
const morktSystem = matchMedia("(prefers-color-scheme:dark)");

/* Listen over temaer står i src/tema-tidlig.js, som har kjørt før dette. */
const erTema = t => t !== "system" && window.TEMAER.some(v => v.id === t);

function lestTema(){
  try{
    const t = localStorage.getItem(TEMA_NOKKEL);
    return erTema(t) ? t : "system";
  }catch(e){ return "system"; }
}

function settTema(valg){
  if(valg === "system") document.documentElement.removeAttribute("data-tema");
  else document.documentElement.setAttribute("data-tema", valg);
  try{
    if(valg === "system") localStorage.removeItem(TEMA_NOKKEL);
    else localStorage.setItem(TEMA_NOKKEL, valg);
  }catch(e){}   /* privat vindu eller full lagring: temaet gjelder økta ut */
  $$('#skuff input[name="tema"]').forEach(r => { r.checked = r.value === valg; });
  følgTemafarge();
}

/* Nettleserens egen flate rundt siden. Leses av den beregnede
   bakgrunnen, ikke av tokenet: light-dark() står uoppløst i en
   egendefinert egenskap. */
function følgTemafarge(){
  const f = getComputedStyle(document.body).backgroundColor;
  if(f) $("#temafarge").setAttribute("content", f);
}
morktSystem.addEventListener("change", () => { if(lestTema() === "system") følgTemafarge(); });
settTema(lestTema());

/* ============================================================
   15. Oppstart, lagringstilstand og døgnskifte
   ============================================================ */

const elLagret = $("#lagringstilstand");
const elStripe = $("#stripe");

const klokke = d => String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");

function visStripe(tekst, knapp, gjor){
  elStripe.innerHTML = '<span class="stripe__tekst">' + esc(tekst) + "</span>"
    + (knapp ? '<button class="stripe__knapp" type="button" data-gjor="' + gjor + '">' + esc(knapp) + "</button>" : "");
  elStripe.hidden = false;
}
function skjulStripe(){ elStripe.hidden = true; elStripe.innerHTML = ""; }

const LAGRETEKST = {
  lagret:    t => (t.tid ? "Lagret " + klokke(t.tid) : "Lagret"),
  lagrer:    () => "Lagrer…",
  ulagret:   () => "Ikke lagret",
  blokkert:  () => "Ikke lagret",
  utlogget:  () => "Ikke lagret",
  frakoblet: () => "Ikke lagret",
  konflikt:  () => "Endret et annet sted"
};

Lagring.påTilstand(t => {
  if(t.navn === "lagret") sjekkSnart();
  elLagret.dataset.t = t.navn;
  elLagret.textContent = (LAGRETEKST[t.navn] || (() => ""))(t);

  if(t.navn === "frakoblet")
    visStripe("Ingen kontakt med lagringen. Endringene ligger her, men er ikke skrevet til disk.",
              "Prøv igjen", "prøvLagring");
  else if(t.navn === "ulagret")
    visStripe(t.melding || "Lagringen avviste endringen.", "Prøv igjen", "prøvLagring");
  /* Ingen «Prøv igjen» her: et nytt forsøk ville feilet like sikkert.
     Veien tilbake går gjennom porten, og den står allerede. */
  else if(t.navn === "utlogget")
    visStripe(t.melding || "Du er logget ut. Endringen ligger her til du er inne igjen.");
  else if(t.navn === "konflikt")
    visStripe("Dataene ble endret et annet sted, antakelig i en annen fane. "
      + "Endringen din er ikke skrevet, og blir det ikke før du henter på nytt.",
      "Hent på nytt", "hentPåNytt");
  else if(t.navn === "blokkert")
    visStripe(t.melding || "Ingenting lagres før du har valgt hva som skal skje med dataene.",
      venterValg === "gjenopprett" ? "Gjenopprett sikkerhetskopien"
        : venterValg === "flytt"   ? "Velg nå"
        : "Prøv igjen",
      venterValg ? "apneValget" : "hentPåNytt");
  else
    skjulStripe();
});

/* Bekreftelse i skuffen i stedet for nettleserens confirm(). */
function spor(tekst, knapp, fare, gjor){
  bekreftelse = { tekst, knapp, fare, gjor };
  apneSkuff("bekreft");
}

/* Tar bare med rader som holder mål — resten ville uansett blitt
   avvist av serveren, og da er det bedre å si fra med en gang. */
function silt(rader){
  const gyldige = [], sett = new Set();
  (rader || []).forEach(rad => {
    /* En usikker lenke skal ikke koste hele raden. Den fjernes, og
       selskapet, fristen og statusen blir med videre. */
    const l = sjekkLenke(rad && rad.lenke);
    if(!l.ok) rad = Object.assign({}, rad, { lenke: "" });
    const r = validerSoknad(rad, { lagId: nyId });
    if(!r.ok || sett.has(r.verdi.id)) return;
    sett.add(r.verdi.id);
    gyldige.push(r.verdi);
  });
  return gyldige;
}

let sisteKopi = null;
let venterValg = null;        /* "flytt" | "gjenopprett" | null */
let filErOdelagt = false;

/* Brukeren har tatt valget: sperren løftes, og en ødelagt fil ryddes
   til side i samme skriving — aldri overskrives. */
function taValget(){
  venterValg = null;
  Lagring.settVersjon(0);
  Lagring.frigi(filErOdelagt);
  filErOdelagt = false;
}

function minnOmValg(){
  if(!venterValg) return;
  Lagring.blokker(venterValg === "gjenopprett"
    ? "Sikkerhetskopien er ikke hentet inn ennå. Ingenting lagres før du har valgt."
    : "Søknadene i nettleseren er ikke flyttet ennå. Ingenting lagres før du har valgt.");
}

const kortTid = iso => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.getDate() + ". " + MND[d.getMonth()] + " " + klokke(d);
};

function gjenopprettKopi(){
  if(!sisteKopi) return;
  /* Har brukeren rukket å legge inn noe mens valget sto åpent, blir det
     med videre i stedet for å forsvinne. */
  data = silt(sisteKopi.jobber.concat(data));
  taValget();
  lagre(); tegn(); lukkSkuff();
  varsle("Gjenopprettet " + antall(data.length, "søknad", "søknader") + " fra sikkerhetskopien");
}

function flyttHit(){
  const gamle = fraNettleser() || [];
  const lagtTilImens = data;
  const gyldige = silt(gamle.concat(lagtTilImens));
  const tapt = gamle.length + lagtTilImens.length - gyldige.length;
  data = gyldige;
  taValget();
  lagre(); tegn(); lukkSkuff();
  varsle("Flyttet " + antall(gyldige.length, "søknad", "søknader") + " til datafilen"
    + (tapt > 0 ? " · " + tapt + " kunne ikke leses" : ""));
}

/* En fane som blir stående over midnatt skal ikke fortsette å vise
   gårsdagens «i dag». Datoen hentes på nytt, og bare da tegnes det om. */
function sjekkDøgn(){
  const nå = new Date(new Date().toDateString());
  if(nå.getTime() === I_DAG.getTime()) return;
  I_DAG = nå;
  tegn();
  Varsling.sjekk();
}
addEventListener("visibilitychange", () => { if(document.visibilityState === "visible") sjekkDøgn(); });
addEventListener("focus", sjekkDøgn);
setInterval(sjekkDøgn, 60000);

/* ============================================================
   17. Porten, brukeren og økten
   ============================================================ */

/* Porten avgjøres før noe hentes. Uten det ville en 401 kommet
   forkledd som «Ingen kontakt med lagringen. Kjører serveren?» —
   riktig stripe, feil forklaring, og ingen vei videre. */
async function start(){
  skjulStripe();
  const økt = await krevØkt();
  brukeren = økt.bruker;
  erFørste = !!økt.erFørste;
  visBruker();
  if(økt.migreringsfeil)
    varsle("Fikk ikke flyttet inn det som lå i datakatalogen fra før");
  await hentData();
  Varsling.sjekk();
  radar.start(brukeren?.id);
  if(økt.migrert && økt.migrert.includes("jobber.json") && data.length)
    varsle("Tok med " + antall(data.length, "søknad", "søknader") + " som lå her fra før");
}

function visBruker(){
  const el = $("#bruker");
  if(!el) return;
  if(!brukeren){ el.hidden = true; return; }
  const navn = brukeren.navn || brukeren.epost;
  $("#brukerTegn").textContent = monogram(navn);
  $("#brukerNavn").textContent = navn;
  /* Knappen bærer bare et ikon. Navnet på handlingen — og hvem den
     gjelder — må da stå i det tilgjengelige navnet. */
  $("#loggUt").setAttribute("aria-label", "Logg ut " + navn);
  el.title = brukeren.epost;
  el.hidden = false;
}

function loggUt(){
  const gjør = async () => {
    await Økt.loggUt();
    /* app.js har modultilstand overalt. Å nullstille den for hånd er
       en feilkilde uten gevinst — siden lastes i stedet. */
    location.reload();
  };
  if(!Lagring.harUlagret()) return gjør();
  spor("Endringen din er ikke lagret ennå. Logger du ut nå, blir den borte.",
       "Logg ut likevel", true, gjør);
}

/* Serveren har svart 401 på noe som krevde en økt. Kalles én gang per
   bortfall, ikke én gang per kall — det er okt.js som passer på det. */
Økt.påUtlogget(async melding => {
  if(portenStår()) return;
  radar.stopp();
  lukkSkuff();
  panel.lukk({ tvang: true });
  /* Et varsel med «Angre» skal ikke bli stående bak låsen: knappen er
     inert, og en handling du ikke kan ta er verre enn ingen. */
  clearTimeout(angreTid);
  $("#varsel").classList.remove("er-apen");
  $("#varsel").setAttribute("inert", "");
  const før = brukeren;
  const økt = await krevØktIgjen({ melding, forrigeBruker: før,
                                   ulagret: Lagring.harUlagret() });
  /* En annen bruker er en annen liste. Da er det ingenting å ta med
     videre, og en omlasting er både enklere og sikrere. */
  if(!før || økt.bruker.id !== før.id){ location.reload(); return; }
  brukeren = økt.bruker;
  erFørste = !!økt.erFørste;
  visBruker();
  await gjenoppta();
  radar.start(brukeren?.id);
});

/* Samme bruker er tilbake. Lå det noe ulagret, skal det overleve
   hentingen og skrives mot den ferske versjonen. */
async function gjenoppta(){
  /* Sto et engangsvalg — flytt hit, eller gjenopprett sikkerhetskopien —
     ubesvart da økten røk, er tilstanden for sammensatt til å plukkes
     opp midt i. Da lastes siden på nytt og valget stilles forfra. */
  if(venterValg || filErOdelagt){ location.reload(); return; }
  const ulagret = Lagring.harUlagret();
  try{
    const svar = await Lagring.hent({ beholdVentende: ulagret });
    if(!ulagret) data = svar.jobber || [];
    Lagring.frigi();
    if(ulagret) Lagring.prøvIgjen();
    else skjulStripe();
    tegn();
  }catch(e){
    if(e.utlogget) return;          /* porten kommer opp igjen av seg selv */
    await hentData();
  }
}

async function hentData(){
  skjulStripe();
  try{
    const svar = await Lagring.hent();

    if(svar.tom){
      /* En sikkerhetskopi veier tyngre enn både nettleserkopien og
         startlisten: den er det siste vi vet var riktig. */
      if(svar.sikkerhetskopi && svar.sikkerhetskopi.jobber.length){
        sisteKopi = svar.sikkerhetskopi;
        venterValg = "gjenopprett";
        Lagring.blokker();
        data = []; tegn(); apneSkuff("gjenopprett"); return;
      }
      /* Ingen datafil ennå. Har nettleseren data fra før, skal brukeren
         få velge — vi flytter ikke noe uten å spørre. */
      const gamle = erFørste ? fraNettleser() : null;
      if(gamle && gamle.length){
        venterValg = "flytt";
        Lagring.blokker();
        data = []; tegn(); apneSkuff("flytt"); return;
      }
      /* Bare den første brukeren arver det som lå i datakatalogen fra
         før. Alle andre starter tomt — en ny bruker skal ikke få en
         annens jobbsøknader som «sine». Startlisten ligger fortsatt
         under «Dataene dine» for den som vil ha den. */
      if(erFørste){ data = fraStart(); lagre(); }
      else data = [];
    }else{
      data = svar.jobber || [];
      if(svar.advarsel) varsle(svar.advarsel);
    }
    /* Først nå vet panelet om en direktelenke peker på noe som finnes. */
    lastet = true;
  }catch(e){
    data = [];
    /* I begge tilfellene vet vi ikke hva som ligger på disk. Da skal
       ingenting skrives — ellers kunne en tom liste blitt lagret oppå
       ekte data. Sperren løftes av et bevisst valg eller en ny henting. */
    if(e.ødelagt){
      sisteKopi = e.sikkerhetskopi || null;
      filErOdelagt = true;
      const harKopi = !!(sisteKopi && sisteKopi.jobber.length);
      venterValg = harKopi ? "gjenopprett" : null;
      Lagring.blokker("Datafilen kan ikke leses. Den ligger urørt som "
        + (e.sti || "jobber.json") + ", og ingenting lagres før du har valgt hva som skal skje."
        + (harKopi ? "" : " Rett opp filen, og hent så på nytt."));
    }else{
      venterValg = null;
      Lagring.blokker(Lagring.I_APP
        ? (e.message || "Fikk ikke lest datafilen.") + " Ingenting lagres før den er lest."
        : "Ingen kontakt med lagringen. Kjører serveren? Start den med «npm start».");
    }
  }
  tegn();
}

start();
