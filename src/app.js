/* ============================================================
   1. Data
   ============================================================ */
import { STATUSER, SEKTORER, ER_SENDT, ER_ARKIV, validerSoknad, sjekkLenke } from "./felles.mjs";
import { START } from "./startliste.js";
import * as Lagring from "./lagring.js";

const NOKKEL = "jobbsoknader-2027";
window.__jobbsoknaderKjorer = true;   /* se fallback-skriptet i index.html */

/* Midnatt i dag. Ikke const: en fane som blir stående over midnatt
   må få ny dato, ellers viser den «i dag» om gårsdagen. Se seksjon 16. */
let I_DAG = new Date(new Date().toDateString());

const SEKTOR_FOR = {
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


/* ============================================================
   2. Tilstand og lagring
   ============================================================ */
let data = [];
let visning = "frister";
let sok = "", filtSektor = "", filtSted = "";
let angre = null, angreTid = null;

const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
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
   opp raske endringer og skriver hele dokumentet til data/jobber.json. */
function lagre(){ Lagring.lagre(data); }

/* ============================================================
   3. Datohjelpere
   ============================================================ */
const DAGER  = ["søn.","man.","tir.","ons.","tor.","fre.","lør."];
const MND    = ["januar","februar","mars","april","mai","juni","juli","august","september","oktober","november","desember"];
const MND_K  = ["jan","feb","mar","apr","mai","jun","jul","aug","sep","okt","nov","des"];

const tilDato = iso => { const [a,m,d] = iso.split("-").map(Number); return new Date(a, m-1, d); };
const tilIso  = dt  => dt.getFullYear() + "-" + String(dt.getMonth()+1).padStart(2,"0") + "-" + String(dt.getDate()).padStart(2,"0");
const dagerTil = iso => Math.round((tilDato(iso) - I_DAG) / 86400000);

function hast(iso){
  if(!iso) return "ingen";
  const d = dagerTil(iso);
  if(d < 0)  return "forbi";
  if(d <= 7) return "naa";
  if(d <= 21) return "snart";
  return "senere";
}
function kortDato(iso){ const d = tilDato(iso); return String(d.getDate()).padStart(2,"0") + "." + String(d.getMonth()+1).padStart(2,"0"); }
function ukedag(iso){ return DAGER[tilDato(iso).getDay()]; }
function omTekst(iso){
  const d = dagerTil(iso);
  if(d === 0) return "i dag";
  if(d === 1) return "i morgen";
  if(d === -1) return "i går";
  if(d < 0) return Math.abs(d) + " dager siden";
  return "om " + d + " dager";
}
function langDato(iso){ const d = tilDato(iso); return d.getDate() + ". " + MND[d.getMonth()]; }

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
   5. Fristlinjen
   ============================================================ */
function tegnFristlinje(){
  const flate = $("#flFlate");
  const apne  = data.filter(p => p.status === "todo" && passererFilter(p));
  const medFrist = apne.filter(p => p.frist && dagerTil(p.frist) >= 0).sort(sorterFrist);
  const lopende  = apne.filter(p => !p.frist);

  $("#flLopendeTall").textContent = lopende.length;
  $("#flLopende").hidden = lopende.length === 0;

  if(!medFrist.length){
    flate.innerHTML = '<p class="fl__tom">Ingen frister framover. Legg til en søknad, eller se det som allerede er sendt.</p>';
    return;
  }

  const bunker = new Map();
  medFrist.forEach(p => { if(!bunker.has(p.frist)) bunker.set(p.frist, []); bunker.get(p.frist).push(p); });

  const sisteIso = medFrist[medFrist.length - 1].frist;
  const spenn = Math.max(dagerTil(sisteIso), 7) + 3;
  const maks  = Math.max(...Array.from(bunker.values(), a => a.length));
  const pos   = d => (d / spenn) * 100;

  let h = '<div class="fl__akse"></div>'
        + '<div class="fl__idag" style="left:0"></div><span class="fl__idagEtikett" style="left:0">i dag</span>';

  const start = new Date(I_DAG);
  for(let i = 0; i <= spenn; i++){
    const d = new Date(start); d.setDate(d.getDate() + i);
    if(d.getDate() === 1 || i === 0){
      const x = pos(i);
      if(x > 96) continue;
      if(i !== 0) h += '<div class="fl__mndStrek" style="left:' + x + '%"></div>';
      h += '<span class="fl__mnd" style="left:' + x + '%;padding-left:' + (i === 0 ? 0 : 5) + 'px">' + MND_K[d.getMonth()] + '</span>';
    }
  }

  bunker.forEach((liste, iso) => {
    const d = dagerTil(iso);
    const hoyde = 14 + Math.round((liste.length / maks) * 48);
    const navn = liste.slice(0, 5).map(p => "<li>" + esc(p.selskap) + " — " + esc(p.stilling) + "</li>").join("");
    const mer  = liste.length > 5 ? "<li>+ " + (liste.length - 5) + " til</li>" : "";
    h += '<button class="fl__stolpe" type="button" data-hast="' + hast(iso) + '" data-iso="' + iso + '"'
       + ' style="left:' + pos(d) + '%;height:' + hoyde + 'px"'
       + ' data-tips="<b>' + esc(langDato(iso)) + ' · ' + esc(omTekst(iso)) + '</b><ul>' + navn + mer + '</ul>"'
       + ' aria-label="' + liste.length + ' frister ' + esc(langDato(iso)) + ', ' + esc(omTekst(iso)) + '"></button>';
  });

  flate.innerHTML = h;
}

/* ============================================================
   6. Jobbkortet — kalenderflis, innhold, handlinger
   ============================================================ */
function monogram(navn){
  const ord = navn.trim().split(/\s+/);
  if(ord.length > 1) return (ord[0][0] + ord[1][0]).toUpperCase();
  return navn.slice(0, 2).toUpperCase();
}

/* Flisen er ankeret hver rad starter med, og viser det som faktisk skiller
   radene i den visningen du står i: fristen under Frister, selskapet under
   Sendt og Arkiv — der har fristen gjort jobben sin. */
function flisHtml(p){
  if(visning === "frister"){
    if(!p.frist){
      return '<div class="flis flis--lopende"><span class="flis__dag">—</span>'
           + '<span class="flis__mnd">løpende</span></div>';
    }
    const d = tilDato(p.frist);
    return '<div class="flis" data-hast="' + hast(p.frist) + '">'
         + '<span class="flis__ukedag">' + ukedag(p.frist).replace(".", "") + '</span>'
         + '<span class="flis__dag">' + d.getDate() + '</span>'
         + '<span class="flis__mnd">' + MND_K[d.getMonth()] + '</span></div>';
  }
  const tone = (p.status === "interview" || p.status === "rejected" || p.status === "accepted") ? p.status : "";
  return '<div class="flis flis--merke"' + (tone ? ' data-s="' + tone + '"' : '')
       + ' aria-hidden="true"><span class="flis__monogram">' + esc(monogram(p.selskap)) + '</span></div>';
}

function radHtml(p, ankerId){
  const stilling = p.lenke
    ? '<a class="rad__stilling" href="' + esc(p.lenke) + '" target="_blank" rel="noopener noreferrer">' + esc(p.stilling) + '<span class="rad__pil">↗</span></a>'
    : '<span class="rad__stilling">' + esc(p.stilling) + '</span>';

  const meta = [];
  if(p.sted) meta.push('<span>' + esc(p.sted) + '</span>');
  meta.push('<span>' + esc(SEKTORER[p.sektor] || SEKTORER.annet) + '</span>');
  if(p.status === "sent" && p.sendtDato) meta.push('<span>sendt ' + esc(kortDato(p.sendtDato)) + '</span>');
  if(p.notat) meta.push('<span class="rad__notat">' + esc(p.notat) + '</span>');

  const underforstatt = (visning === "frister" && p.status === "todo") || (visning === "sendt" && p.status === "sent");
  const merke = (p.status !== "todo" && !underforstatt)
    ? '<span class="merkelapp" data-s="' + p.status + '">' + STATUSER[p.status] + '</span>' : "";

  let om = "";
  if(p.status === "todo" && p.frist){
    om = '<span class="rad__om" data-hast="' + hast(p.frist) + '">' + omTekst(p.frist) + '</span>';
  }else if(visning === "sendt" && p.sendtDato){
    const d = -dagerTil(p.sendtDato);
    om = '<span class="rad__om">' + (d === 0 ? "sendt i dag" : "venter " + d + (d === 1 ? " dag" : " dager")) + '</span>';
  }

  let hoved = "";
  if(p.status === "todo")           hoved = '<button class="handling" data-gjor="sent" data-id="' + p.id + '">Merk sendt</button>';
  else if(p.status === "sent")      hoved = '<button class="handling" data-gjor="interview" data-id="' + p.id + '">Fikk intervju</button>';
  else if(p.status === "interview") hoved = '<button class="handling" data-gjor="accepted" data-id="' + p.id + '">Fikk tilbud</button>';
  else                              hoved = '<button class="handling" data-gjor="todo" data-id="' + p.id + '">Gjenåpne</button>';

  /* Sideveier ut av løpet. Vises bare der de gir mening, så raden
     ikke fylles opp med knapper som ikke angår den. */
  const sidevei = [];
  if(p.status === "sent" || p.status === "interview"){
    sidevei.push('<button class="handling handling--stille handling--fare" data-gjor="rejected" data-id="' + p.id + '">Avslag</button>');
    sidevei.push('<button class="handling handling--stille" data-gjor="trukket" data-id="' + p.id + '">Trukket</button>');
  }
  if(p.status === "todo" && p.frist && dagerTil(p.frist) < 0){
    sidevei.push('<button class="handling handling--stille" data-gjor="expired" data-id="' + p.id + '">Marker som utløpt</button>');
  }
  const avslag = sidevei.join("");

  return '<article class="rad"' + (ankerId ? ' id="' + ankerId + '"' : '') + ' data-id="' + p.id + '">'
    + flisHtml(p)
    + '<div class="rad__hoved">'
      + '<div class="rad__selskap">' + esc(p.selskap) + '</div>' + stilling
      + '<div class="rad__meta">' + meta.join("") + '</div>'
    + '</div>'
    + '<div class="rad__hoyre">' + om + merke
      + '<div class="rad__verktoy">' + hoved
        + '<div class="rad__mer">' + avslag
          + '<button class="handling handling--stille" data-gjor="rediger" data-id="' + p.id + '">Rediger</button>'
          + '<button class="handling handling--stille handling--fare" data-gjor="slett" data-id="' + p.id + '">Slett</button>'
        + '</div>'
      + '</div>'
    + '</div></article>';
}

const antall = (n, ent, fl) => n + " " + (n === 1 ? ent : fl);

/* «Løpende» betyr opptak uten frist. En frist som har gått ut er noe
   helt annet, og skal ikke telles som løpende. */
const erLopende = p => !p.frist;
const erUtgatt  = p => !!p.frist && dagerTil(p.frist) < 0;

function fristOppdeling(apne){
  const medFrist = apne.filter(p => p.frist && dagerTil(p.frist) >= 0);
  const lopende  = apne.filter(erLopende);
  const utgatt   = apne.filter(erUtgatt);
  let t = medFrist.length + " med frist · " + lopende.length + " løpende";
  if(utgatt.length) t += " · " + utgatt.length + " gikk ut";
  return { medFrist, lopende, utgatt, tekst: t };
}

function baandHtml(navn, tall, rader, sett, id){
  return '<section class="baandblokk"' + (id ? ' id="' + id + '"' : '') + '>'
    + '<div class="baand"><h3 class="baand__navn">' + navn + '</h3><span class="baand__tall">' + tall + '</span></div>'
    + '<div class="stabel">' + rader.map(p => {
        let anker = null;
        if(p.frist && sett && !sett.has(p.frist)){ sett.add(p.frist); anker = "d-" + p.frist; }
        return radHtml(p, anker);
      }).join("") + '</div></section>';
}

/* ============================================================
   7. Visningene
   ============================================================ */
const BAAND = [
  { id:"forbi",  navn:"Gikk ut",              test:p => p.frist && dagerTil(p.frist) < 0 },
  { id:"naa",    navn:"Denne uka",            test:p => p.frist && dagerTil(p.frist) >= 0 && dagerTil(p.frist) <= 7 },
  { id:"snart",  navn:"De neste tre ukene",   test:p => p.frist && dagerTil(p.frist) > 7 && dagerTil(p.frist) <= 21 },
  { id:"senere", navn:"Senere",               test:p => p.frist && dagerTil(p.frist) > 21 },
  { id:"lopende",navn:"Løpende opptak",       test:p => !p.frist }
];

function visFrister(){
  const liste = data.filter(p => p.status === "todo" && passererFilter(p)).sort(sorterFrist);
  if(!liste.length) return tomHtml();
  const sett = new Set();
  let h = "";
  BAAND.forEach(b => {
    const rader = liste.filter(b.test);
    if(!rader.length) return;
    const tall = b.id === "lopende" ? rader.length + " uten frist" : antall(rader.length, "søknad", "søknader");
    h += baandHtml(b.navn, tall, rader, sett, "baand-" + b.id);
  });
  return h;
}

function visEtterSektor(filterFn, tomTekst){
  const liste = data.filter(p => filterFn(p.status) && passererFilter(p));
  if(!liste.length) return tomHtml(tomTekst);
  const grupper = new Map();
  liste.forEach(p => { if(!grupper.has(p.sektor)) grupper.set(p.sektor, []); grupper.get(p.sektor).push(p); });
  return Object.keys(SEKTORER).filter(k => grupper.has(k)).map(k => {
    const rader = grupper.get(k).sort((a, b) => a.selskap.localeCompare(b.selskap, "no"));
    return baandHtml(esc(SEKTORER[k]), antall(rader.length, "søknad", "søknader"), rader, null, null);
  }).join("");
}

function tomHtml(tekst){
  const filtrert = sok || filtSektor || filtSted;
  return '<div class="tomt">'
    + '<p class="tomt__tittel">' + (filtrert ? "Ingen treff" : "Ingenting her ennå") + '</p>'
    + '<p class="tomt__tekst">' + (filtrert
        ? "Ingen søknader passer filtrene. Nullstill dem for å se alt igjen."
        : (tekst || "Legg til den første søknaden, eller lim inn en hel liste rett fra notatet ditt.")) + '</p>'
    + (filtrert
        ? '<button class="knapp" data-gjor="nullstillFilter">Nullstill filtre</button>'
        : '<button class="knapp knapp--primar" data-gjor="nyFraTom">Legg til søknad</button>') + '</div>';
}

/* ============================================================
   8. Tall
   ============================================================ */
const TRAKT_FARGE = ["#A9B3EE", "#7C8AE4", "#3D52D5", "#2A3A9E"];

function liggendeStolper(rader, farge){
  const maks = Math.max(1, ...rader.map(r => r.verdi));
  return '<div class="stolper">' + rader.map(r =>
      '<div class="stolpe"><div class="stolpe__navn" title="' + esc(r.navn) + '">' + esc(r.navn) + '</div>'
    + '<div class="stolpe__spor"><div class="stolpe__fyll" style="width:' + ((r.verdi / maks) * 100) + '%'
    + (farge ? ';background:' + farge : '') + '"></div>'
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

function kortListe(navn){
  if(navn.length <= 3) return navn.join(", ");
  return navn.slice(0, 3).join(", ") + " og " + (navn.length - 3) + " til";
}

function nokkel(merke, verdi, under, varsel){
  return '<div class="nokkel' + (varsel ? " nokkel--varsel" : "") + '">'
    + '<p class="nokkel__merke">' + merke + '</p>'
    + '<p class="nokkel__verdi">' + verdi + '</p>'
    + '<p class="nokkel__under">' + under + '</p></div>';
}

function visTall(){
  const alle    = data.filter(passererFilter);
  const sendt   = alle.filter(p => ER_SENDT(p.status) || p.status === "accepted" || p.status === "rejected");
  const svar    = alle.filter(p => p.status === "interview" || p.status === "accepted" || p.status === "rejected");
  const videre  = alle.filter(p => p.status === "interview" || p.status === "accepted");
  const aSoke   = alle.filter(p => p.status === "todo");
  const medFrist = aSoke.filter(p => p.frist && dagerTil(p.frist) >= 0).sort(sorterFrist);
  const denneUka = medFrist.filter(p => dagerTil(p.frist) <= 7);
  const neste = medFrist[0];

  let h = '<div class="fliser">'
    + nokkel("Neste frist", neste ? omTekst(neste.frist).replace("om ", "") : "—",
        neste ? '<b>' + esc(neste.selskap) + '</b> · ' + esc(langDato(neste.frist)) : "Ingen frister framover",
        neste && dagerTil(neste.frist) <= 7)
    + nokkel("Å søke på", aSoke.length, fristOppdeling(aSoke).tekst, false)
    + nokkel("Sendt", sendt.length,
        sendt.length ? Math.round((svar.length / sendt.length) * 100) + " % har svart" : "Ingen sendt ennå", false)
    + nokkel("Frister denne uka", denneUka.length,
        denneUka.length ? kortListe(denneUka.map(p => p.selskap).filter((v, i, a) => a.indexOf(v) === i)) : "Pusterom",
        denneUka.length > 0)
    + '</div>';

  const trinn = [
    { navn:"Sporet",      verdi: alle.length },
    { navn:"Sendt",       verdi: sendt.length },
    { navn:"Fått svar",   verdi: svar.length },
    { navn:"Gått videre", verdi: videre.length }
  ];
  const tMaks = Math.max(1, trinn[0].verdi);
  h += '<div class="kort"><h3 class="kort__tittel">Fra liste til tilbud</h3>'
    + '<p class="kort__und">Hvert trinn er et utvalg av trinnet over. Andelen måles mot antallet du har sendt.</p>'
    + '<div class="trakt">' + trinn.map((t, i) =>
        '<div class="trakt__trinn"><div class="trakt__navn">' + t.navn + '</div>'
      + '<div class="trakt__spor"><div class="trakt__fyll" style="width:' + ((t.verdi / tMaks) * 100) + '%;background:' + TRAKT_FARGE[i] + '"></div>'
      + '<span class="trakt__verdi">' + t.verdi + '</span>'
      + (i > 1 && sendt.length ? '<span class="trakt__andel">' + Math.round((t.verdi / sendt.length) * 100) + ' % av sendt</span>' : "")
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
        '<div class="soyle">'
      + (u.verdi ? '<span class="soyle__topp" style="bottom:calc(' + ((u.verdi / uMaks) * 100) + '% + 7px)">' + u.verdi + '</span>' : "")
      + '<div class="soyle__fyll" style="height:' + (u.verdi ? (u.verdi / uMaks) * 100 : 0) + '%'
      + (u.verdi ? '' : ';background:transparent') + '"></div></div>').join("") + '</div>'
    + '<div class="akse">' + uker.map(u => '<span class="akse__hakk">' + u.nr + '</span>').join("") + '</div>'
    + '<p class="kort__und" style="margin:10px 0 0">Ukenummer</p></div>';

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
      + '<div class="tegn"><span class="tegn__post"><span class="tegn__pryd" style="background:#3D52D5"></span>Sendt</span>'
      + '<span class="tegn__post"><span class="tegn__pryd" style="background:#A9B3EE"></span>Å søke på</span></div>'
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
   9. Tegn opp
   ============================================================ */
const SIDER = {
  frister: { tittel:"Frister",  ingen:"Ingenting å søke på akkurat nå." },
  sendt:   { tittel:"Sendt",    ingen:"Ingen søknader venter på svar ennå. Merk en som sendt fra Frister." },
  arkiv:   { tittel:"Arkiv",    ingen:"Arkivet er tomt. Hit havner avslag, tilbud og frister som gikk ut." },
  tall:    { tittel:"Tall",     ingen:"" }
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

  $("#neste").innerHTML = neste
    ? '<p class="neste__merke">Neste frist</p>'
      + '<p class="neste__tall">' + esc(omTekst(neste.frist)) + '</p>'
      + '<p class="neste__hvem"><b>' + esc(neste.selskap) + '</b>' + esc(langDato(neste.frist)) + '</p>'
    : '<p class="neste__merke">Neste frist</p><p class="neste__tall">Ingen</p>'
      + '<p class="neste__hvem">Alt med frist er avklart.</p>';
  $("#neste").className = "neste" + (neste && dagerTil(neste.frist) <= 7 ? "" : " neste--rolig");

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
    : '<b>' + data.length + '</b> søknader sporet i alt';
  $("#sideUnder").innerHTML = und;

  $("#fristlinje").hidden = visning !== "frister";
  if(visning === "frister") tegnFristlinje();
  $("#nullstill").hidden = !(sok || filtSektor || filtSted);

  $("#innhold").innerHTML =
      visning === "frister" ? visFrister()
    : visning === "sendt"   ? visEtterSektor(ER_SENDT, SIDER.sendt.ingen)
    : visning === "arkiv"   ? visEtterSektor(ER_ARKIV, SIDER.arkiv.ingen)
    : visTall();

  fyllVelg("#filtSektor", Object.entries(SEKTORER).filter(([k]) => data.some(p => p.sektor === k)), filtSektor, "Alle sektorer");
  const steder = Array.from(new Set(data.flatMap(p => (p.sted || "").split("/").map(s => s.trim()).filter(Boolean))))
    .sort((a, b) => a.localeCompare(b, "no"));
  fyllVelg("#filtSted", steder.map(s => [s, s]), filtSted, "Alle steder");
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
   10. Skuffen — skjema, innliming, eksport
   ============================================================ */
let skuffModus = "skjema", redigerer = null;

const SKUFFTITTEL = {
  skjema:  "Legg til søknad",
  lim:     "Legg til søknad",
  eksport: "Dataene dine",
  flytt:   "Flytt dataene hit",
  gjenopprett: "Datafilen mangler",
  bekreft: "Er du sikker?"
};

/* Hva skuffen skal gjøre når den lukkes, og hvor fokus skal tilbake. */
let bekreftelse = null, fokusFor = null, fokusTid = null;

const FOKUSERBARE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/* Alt utenom dialogen og sløret settes inert mens skuffen står åpen.
   Det holder ikke å bare ta skallet: varselet ligger utenfor det, og
   angreknappen i det kunne ellers stjele fokus ut av dialogen. */
function baksideInert(pa){
  Array.from(document.body.children).forEach(el => {
    if(el.id === "skuff" || el.id === "slor" || el.id === "varsel") return;
    if(pa) el.setAttribute("inert", ""); else el.removeAttribute("inert");
  });
  const v = $("#varsel");
  if(pa) v.setAttribute("inert", "");
  else if(v.classList.contains("er-apen")) v.removeAttribute("inert");
}

function apneSkuff(hva, id){
  redigerer = id ? data.find(p => p.id === id) : null;
  if(hva === "rediger")   skuffModus = "skjema";
  else if(hva === "ny")   skuffModus = (skuffModus === "lim" ? "lim" : "skjema");
  else                    skuffModus = hva;

  $("#skuffTittel").textContent = redigerer ? "Rediger søknad" : (SKUFFTITTEL[skuffModus] || "Legg til søknad");
  tegnSkuff();

  if(!$("#skuff").classList.contains("er-apen")) fokusFor = document.activeElement;
  $("#skuff").classList.add("er-apen");
  $("#skuff").setAttribute("aria-hidden", "false");
  $("#slor").classList.add("er-apen");
  baksideInert(true);
  /* Lukkes skuffen før dette rekker å kjøre, skal fokus bli der
     brukeren satte det — ikke hoppe inn i en skjult dialog. */
  clearTimeout(fokusTid);
  fokusTid = setTimeout(() => {
    if(!$("#skuff").classList.contains("er-apen")) return;
    const f = $("#skuff input, #skuff textarea") || $("#skuff " + FOKUSERBARE) || $("#skuff");
    if(f) f.focus();
  }, 60);
}

function lukkSkuff(){
  if(!$("#skuff").classList.contains("er-apen")) return;
  clearTimeout(fokusTid);
  $("#skuff").classList.remove("er-apen");
  $("#skuff").setAttribute("aria-hidden", "true");
  $("#slor").classList.remove("er-apen");
  baksideInert(false);
  redigerer = null;
  bekreftelse = null;
  /* Fokus tilbake dit brukeren kom fra. */
  if(fokusFor && document.contains(fokusFor)) fokusFor.focus();
  fokusFor = null;
}

/* Tab skal gå rundt inni dialogen, ikke ut av den. */
function fokusfelle(e){
  if(e.key !== "Tab" || !$("#skuff").classList.contains("er-apen")) return;
  const f = $$("#skuff " + FOKUSERBARE).filter(el => el.offsetParent !== null || el === document.activeElement);
  if(!f.length) return;
  const forst = f[0], siste = f[f.length - 1];
  if(e.shiftKey && document.activeElement === forst){ e.preventDefault(); siste.focus(); }
  else if(!e.shiftKey && document.activeElement === siste){ e.preventDefault(); forst.focus(); }
}

function tegnSkuff(){
  const k = $("#skuffKropp"), b = $("#skuffBunn");
  if(skuffModus === "eksport"){
    k.innerHTML = '<p class="felt__hjelp" style="margin:0 0 16px">'
      + data.length + ' søknader ligger i <code>data/jobber.json</code>. Ta en kopi når du vil ha dem et annet sted.</p>'
      + '<div class="felt"><button class="knapp knapp--bred" data-gjor="kopiMd">Kopier som Markdown</button>'
      + '<p class="felt__hjelp">Samme oppsett som notatet ditt — grupper, lenker og datoer.</p></div>'
      + '<div class="felt"><button class="knapp knapp--bred" data-gjor="kopiJson">Kopier som JSON</button>'
      + '<p class="felt__hjelp">Alle feltene, klare til å limes inn igjen senere.</p></div>'
      + '<div class="felt" style="margin-top:26px;padding-top:20px;border-top:1px solid var(--linje)">'
      + '<label class="felt__merke" for="limJson">Lim inn JSON</label>'
      + '<textarea class="felt__omr" id="limJson" spellcheck="false" placeholder="[ { &quot;selskap&quot;: … } ]"></textarea>'
      + '<button class="knapp knapp--bred" data-gjor="importerJson" style="margin-top:10px">Erstatt listen med dette</button>'
      + '<p class="felt__hjelp">Bytter ut hele listen med det du limer inn. Du kan angre etterpå.</p></div>'
      + '<div class="felt" style="margin-top:26px;padding-top:20px;border-top:1px solid var(--linje)">'
      + '<button class="knapp knapp--bred knapp--fare" data-gjor="tilbakestill">Tilbakestill til startlisten</button>'
      + '<p class="felt__hjelp">Erstatter alt du har lagt inn med de 55 søknadene appen startet med.</p></div>';
    b.innerHTML = '<button class="knapp" data-gjor="lukk">Lukk</button>';
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
      + 'Flytt dem til <code>data/jobber.json</code>, så ligger de som en vanlig fil på maskinen din '
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
      + '<code>data/jobber.json</code> finnes ikke lenger, men <code>jobber.forrige.json</code> '
      + 'ligger igjen' + (sisteKopi.oppdatert ? ' fra ' + esc(kortTid(sisteKopi.oppdatert)) : '') + '.</p>'
      + '<p class="felt__hjelp">Ingenting skrives før du velger.</p>';
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
    + (skuffModus === "lim"
        ? '<button class="knapp knapp--primar" id="lagreLim">Legg til</button>'
        : '<button class="knapp knapp--primar" id="lagreSkjema">' + (redigerer ? "Lagre endringer" : "Legg til søknad") + '</button>');

  const bytter = redigerer ? "" :
      '<div class="modus" role="tablist">'
    + '<button class="modus__knapp" role="tab" data-modus="skjema" aria-selected="' + (skuffModus === "skjema") + '">Ett felt om gangen</button>'
    + '<button class="modus__knapp" role="tab" data-modus="lim" aria-selected="' + (skuffModus === "lim") + '">Lim inn fra notat</button></div>';

  if(skuffModus === "lim"){
    k.innerHTML = bytter
      + '<div class="felt"><label class="felt__merke" for="limInn">Linjer fra notatet</label>'
      + '<textarea class="felt__omr" id="limInn" spellcheck="false" placeholder="- [ ] **28.08** · **Aker BP** · [Graduate: Life Cycle Data Services](https://…) _Oslo / Trondheim_"></textarea>'
      + '<p class="felt__hjelp">Én søknad per linje. Frist leses fra <b>**DD.MM**</b>, stilling og lenke fra <b>[tekst](url)</b>, sted fra <b>_kursiv_</b>. Linjer uten frist blir løpende opptak.</p></div>'
      + '<div class="forhaand" id="limForhaand"></div>';
    tegnForhaand("");
    return;
  }

  const p = redigerer || {};
  k.innerHTML = bytter
    + '<p class="feil" id="skjemaFeil" hidden></p>'
    + felt("selskap", "Selskap", p.selskap, "text", "Aker BP")
    + felt("stilling", "Stilling", p.stilling, "text", "Graduate: Data Engineer")
    + felt("lenke", "Lenke til utlysningen", p.lenke, "url", "https://…")
    + '<div class="felt__rad">' + felt("frist", "Søknadsfrist", p.frist, "date", "") + felt("sted", "Sted", p.sted, "text", "Oslo") + '</div>'
    + '<label class="avkrys"><input type="checkbox" id="ingenFrist"' + (redigerer && !p.frist ? " checked" : "") + '> Løpende opptak — ingen frist</label>'
    + '<div class="felt__rad" style="margin-top:15px">'
      + '<div class="felt"><label class="felt__merke" for="fSektor">Sektor</label><select class="felt__inn" id="fSektor">'
        + Object.entries(SEKTORER).map(([k2,v]) => '<option value="' + k2 + '"' + (p.sektor === k2 ? " selected" : "") + '>' + v + '</option>').join("") + '</select></div>'
      + '<div class="felt"><label class="felt__merke" for="fStatus">Status</label><select class="felt__inn" id="fStatus">'
        + Object.entries(STATUSER).map(([k2,v]) => '<option value="' + k2 + '"' + ((p.status || "todo") === k2 ? " selected" : "") + '>' + v + '</option>').join("") + '</select></div>'
    + '</div>'
    + (redigerer
        ? '<div class="felt__rad" style="margin-top:15px">'
          + felt("sendtDato", "Sendt", p.sendtDato, "date", "")
          + '<div class="felt"><p class="felt__hjelp" style="margin-top:26px">Settes av seg selv når du merker en søknad som sendt. Fyll den inn her for eldre søknader.</p></div>'
          + '</div>'
        : "")
    + felt("notat", "Notat", p.notat, "text", "f.eks. frist kl. 12:00");
}

function felt(id, merke, verdi, type, plass){
  return '<div class="felt"><label class="felt__merke" for="f' + id + '">' + merke + '</label>'
    + '<input class="felt__inn" id="f' + id + '" type="' + type + '" value="' + esc(verdi || "") + '" placeholder="' + esc(plass) + '"></div>';
}

/* ---- innlimingsparser ---- */
function tolkLinje(linje){
  let t = linje.replace(/^\s*>?\s*[-*]\s*(\[[ xX]\]\s*)?/, "").trim();
  if(!t || /^#/.test(t) || /^\[!/.test(t) || /^-{3,}$/.test(t) || /^>/.test(t)) return null;

  let frist = null, lenke = "", stilling = "", sted = "", notat = "";

  const lm = t.match(/\[([^\]]+)\]\(([^)\s]+)\)/);
  if(lm){
    stilling = lm[1].trim();
    /* Lenken havner rett i href. Godtar bare http/https — en
       javascript:-lenke fra et innlimt notat skal ikke overleve hit. */
    const sl = sjekkLenke(lm[2].trim());
    lenke = sl.ok ? sl.verdi : "";
    t = t.replace(lm[0], " ");
  }

  const dm = t.match(/\*{0,2}(\d{1,2})\.(\d{1,2})\.?\*{0,2}(?=\s*[·|]|\s|$)/);
  if(dm){ frist = gjettAar(+dm[1], +dm[2]); t = t.replace(dm[0], " "); }

  const im = t.match(/_([^_]+)_/);
  if(im){
    t = t.replace(im[0], " ");
    const biter = im[1].split(",").map(x => x.trim()).filter(Boolean);
    const notatAktig = x => /frist|søkt|avslag|åpner|kl\.|ikke |opptak/i.test(x);
    sted  = biter.filter(x => !notatAktig(x)).join(", ");
    notat = biter.filter(notatAktig).join(", ");
  }

  let selskap = "";
  const bm = t.match(/\*\*([^*]+)\*\*/);
  if(bm){ selskap = bm[1].trim(); t = t.replace(bm[0], " "); }

  const rest = t.split(/[·|]/).map(s => s.replace(/[*_`]/g, "").trim()).filter(Boolean);
  if(!selskap) selskap = rest.shift() || "";
  if(!stilling) stilling = rest.shift() || "";
  if(rest.length) notat = [notat, rest.join(" · ")].filter(Boolean).join(" · ");
  if(!selskap) return null;

  return {
    id: nyId(), selskap, stilling: stilling || "Uten tittel", lenke, sted, frist,
    status: "todo", sektor: SEKTOR_FOR[selskap.toLowerCase()] || "annet", notat, sendtDato: null
  };
}
function gjettAar(dag, mnd){
  const na = I_DAG.getFullYear();
  let d = new Date(na, mnd - 1, dag);
  if((d - I_DAG) / 86400000 < -60) d = new Date(na + 1, mnd - 1, dag);
  return tilIso(d);
}
function tolkTekst(tekst){
  /* Samme validering som serveren, så det som forhåndsvises er det
     som faktisk blir lagret. */
  return tekst.split("\n").map(tolkLinje).filter(Boolean)
    .map(p => { const r = validerSoknad(p); return r.ok ? r.verdi : null; })
    .filter(Boolean);
}

function tegnForhaand(tekst){
  const el = $("#limForhaand");
  if(!el) return;
  const funn = tolkTekst(tekst);
  const lag = $("#lagreLim");
  if(lag) lag.textContent = funn.length ? "Legg til " + funn.length + (funn.length === 1 ? " søknad" : " søknader") : "Legg til";
  if(!funn.length){
    el.innerHTML = '<p class="forhaand__ingen">Ingenting tolket ennå. Lim inn linjene, så vises de her før de legges til.</p>';
    return;
  }
  el.innerHTML = '<div class="forhaand__topp">' + funn.length + ' tolket</div>'
    + funn.slice(0, 40).map(p => '<div class="forhaand__post"><b>' + esc(p.selskap) + '</b> — ' + esc(p.stilling)
      + '<br><em>' + (p.frist ? kortDato(p.frist) : "løpende") + (p.sted ? " · " + esc(p.sted) : "") + '</em></div>').join("");
}

/* ============================================================
   11. Eksport
   ============================================================ */
function tilMarkdown(){
  const L = [];
  const rad = p => "> - [ ] " + (p.frist ? "**" + kortDato(p.frist) + "** · " : "") + "**" + p.selskap + "** · "
    + (p.lenke ? "[" + p.stilling + "](" + p.lenke + ")" : p.stilling) + (p.sted ? " · _" + p.sted + "_" : "");

  const todo = data.filter(p => p.status === "todo").sort(sorterFrist);
  const uka  = todo.filter(p => p.frist && dagerTil(p.frist) >= 0 && dagerTil(p.frist) <= 7);
  const lop  = todo.filter(p => !p.frist);
  const sen  = todo.filter(p => p.frist && dagerTil(p.frist) > 7);

  L.push("# Jobbsøknader 2027", "", "> [!abstract] Status");
  L.push("> **" + data.filter(p => ER_SENDT(p.status)).length + "** sendt · **" + todo.length + "** igjen · **"
    + data.filter(p => p.status === "rejected").length + "** avslag · **"
    + data.filter(p => p.status === "expired").length + "** utløpt", "", "---", "", "## Å søke på", "");

  if(uka.length){ L.push("> [!danger]+ Denne uka · " + uka.length, ">"); uka.forEach(p => L.push(rad(p))); L.push(""); }
  if(lop.length){ L.push("> [!note]- Fortløpende · " + lop.length, ">"); lop.forEach(p => L.push(rad(p))); L.push(""); }

  const mnd = new Map();
  sen.forEach(p => { const n = MND[tilDato(p.frist).getMonth()]; if(!mnd.has(n)) mnd.set(n, []); mnd.get(n).push(p); });
  mnd.forEach((liste, navn) => {
    L.push("> [!todo]+ " + navn[0].toUpperCase() + navn.slice(1) + " · " + liste.length, ">");
    liste.forEach(p => L.push(rad(p))); L.push("");
  });

  const sendt = data.filter(p => ER_SENDT(p.status));
  L.push("---", "", "## Sendt", "", "> [!success]- Venter på svar · " + sendt.length, ">");
  Object.keys(SEKTORER).forEach(k => {
    const g = sendt.filter(p => p.sektor === k);
    if(!g.length) return;
    L.push("> **" + SEKTORER[k] + "**", ">");
    g.forEach(p => L.push("> - **" + p.selskap + "** · " + (p.lenke ? "[" + p.stilling + "](" + p.lenke + ")" : p.stilling) + (p.sted ? " · _" + p.sted + "_" : "")));
    L.push(">");
  });

  const ark = data.filter(p => ER_ARKIV(p.status));
  if(ark.length){
    L.push("", "---", "", "## Arkiv", "", "> [!failure]- Avsluttet · " + ark.length, ">");
    ark.forEach(p => L.push("> - **" + p.selskap + "** · " + (p.lenke ? "[" + p.stilling + "](" + p.lenke + ")" : p.stilling)
      + " · _" + (p.notat || STATUSER[p.status].toLowerCase()) + "_"));
  }
  return L.join("\n");
}

function kopier(tekst, hva){
  const ferdig = () => varsle(hva + " kopiert til utklippstavlen");
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(tekst).then(ferdig, () => reserveKopi(tekst, ferdig));
  } else reserveKopi(tekst, ferdig);
}
function reserveKopi(tekst, ferdig){
  const t = document.createElement("textarea");
  t.value = tekst; t.style.position = "fixed"; t.style.opacity = "0";
  document.body.appendChild(t); t.select();
  try{ document.execCommand("copy"); ferdig(); }
  catch(e){ varsle("Kopiering ble blokkert. Marker teksten manuelt."); }
  document.body.removeChild(t);
}

/* ============================================================
   12. Varsel med angremulighet
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
   13. Handlinger
   ============================================================ */
function settStatus(id, ny){
  const p = data.find(x => x.id === id);
  if(!p) return;
  const fra = { status: p.status, sendtDato: p.sendtDato };
  p.status = ny;
  if(ny === "sent" && !p.sendtDato) p.sendtDato = tilIso(I_DAG);
  if(ny === "todo") p.sendtDato = null;
  lagre(); tegn();
  varsle(p.selskap + " · " + STATUSER[ny].toLowerCase(), () => {
    p.status = fra.status; p.sendtDato = fra.sendtDato; lagre(); tegn();
  });
}
function slett(id){
  const i = data.findIndex(p => p.id === id);
  if(i < 0) return;
  const [p] = data.splice(i, 1);
  lagre(); tegn();
  varsle("Slettet " + p.selskap + " · " + p.stilling, () => { data.splice(i, 0, p); lagre(); tegn(); });
}
/* Hvilket felt en feilmelding hører til, så fokus havner riktig sted. */
const FELT_TIL_INN = {
  selskap: "#fselskap", stilling: "#fstilling", lenke: "#flenke", sted: "#fsted",
  frist: "#ffrist", sendtDato: "#fsendtDato", notat: "#fnotat",
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
    status:    $("#fStatus").value,
    sendtDato: redigerer ? (v("sendtDato") || null) : null,
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

  const verdi = sjekk.verdi;
  if(ER_SENDT(verdi.status) && !verdi.sendtDato) verdi.sendtDato = tilIso(I_DAG);
  if(verdi.status === "todo") verdi.sendtDato = null;

  if(redigerer){
    Object.assign(redigerer, verdi);
    varsle("Lagret " + verdi.selskap);
  }else{
    data.push(verdi);
    varsle("La til " + verdi.selskap + " · " + verdi.stilling);
  }
  lagre(); lukkSkuff(); tegn();
}
function lagreLim(){
  const funn = tolkTekst($("#limInn").value);
  if(!funn.length){ varsle("Fant ingen søknader i teksten"); return; }
  const fra = data.length;
  data = data.concat(funn);
  lagre(); lukkSkuff(); tegn();
  varsle("La til " + funn.length + (funn.length === 1 ? " søknad" : " søknader"),
    () => { data = data.slice(0, fra); lagre(); tegn(); });
}

/* ============================================================
   14. Hendelser
   ============================================================ */
document.addEventListener("click", e => {
  const t = e.target.closest("[data-gjor],[data-modus],[data-visning],.fl__stolpe,#flLopende,#apneNy,#lukkSkuff,#apneEksport,#nullstill,#lagreSkjema,#lagreLim");
  if(!t) return;

  if(t.id === "apneNy"){ apneSkuff("ny"); return; }
  if(t.id === "apneEksport"){ apneSkuff("eksport"); return; }
  if(t.id === "lukkSkuff"){ lukkSkuff(); return; }
  if(t.id === "nullstill"){ sok = ""; filtSektor = ""; filtSted = ""; $("#sok").value = ""; tegn(); return; }
  if(t.id === "lagreSkjema"){ lagreSkjema(); return; }
  if(t.id === "lagreLim"){ lagreLim(); return; }
  if(t.id === "flLopende"){ hoppTil("baand-lopende"); return; }

  if(t.dataset.visning){
    visning = t.dataset.visning;
    settNav(); tegn();
    window.scrollTo({ top: 0, behavior: "auto" });
    return;
  }
  if(t.dataset.modus){ skuffModus = t.dataset.modus; tegnSkuff(); const f = $("#skuff input,#skuff textarea"); if(f) f.focus(); return; }
  if(t.classList.contains("fl__stolpe")){ hoppTil("d-" + t.dataset.iso); return; }

  const g = t.dataset.gjor, id = t.dataset.id;
  if(g === "lukk") lukkSkuff();
  else if(g === "rediger") apneSkuff("rediger", id);
  else if(g === "slett") slett(id);
  else if(g === "nyFraTom"){ skuffModus = "skjema"; apneSkuff("ny"); }
  else if(g === "nullstillFilter"){ sok = ""; filtSektor = ""; filtSted = ""; $("#sok").value = ""; tegn(); }
  else if(g === "kopiMd") kopier(tilMarkdown(), "Markdown");
  else if(g === "kopiJson") kopier(JSON.stringify(data, null, 2), "JSON");
  else if(g === "tilbakestill"){
    const fra = data;
    spor("Startlisten på 55 søknader erstatter alt som ligger her nå. Du kan angre etterpå.",
         "Tilbakestill", true, () => {
           data = fraStart(); lagre(); tegn();
           varsle("Tilbakestilt til startlisten", () => { data = fra; lagre(); tegn(); });
         });
  }
  else if(g === "importerJson") importerJson();
  else if(g === "flyttHit") flyttHit();
  else if(g === "gjenopprettKopi") gjenopprettKopi();
  else if(g === "brukStartliste"){ data = fraStart(); lagre(); lukkSkuff(); tegn(); varsle("Startet med startlisten"); }
  else if(g === "bekreftJa"){ const bk = bekreftelse; lukkSkuff(); if(bk) bk.gjor(); }
  else if(g === "prøvLagring") Lagring.prøvIgjen();
  else if(g === "hentPåNytt") start();
  else if(g === "apneGjenopprett") apneSkuff("gjenopprett");
  else if(g && STATUSER[g]) settStatus(id, g);
});

function settNav(){
  $$("#faner .nav__post").forEach(f => f.setAttribute("aria-selected", String(f.dataset.visning === visning)));
}

function hoppTil(id){
  if(visning !== "frister"){ visning = "frister"; settNav(); tegn(); }
  const el = document.getElementById(id);
  if(!el) return;
  el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion:reduce)").matches ? "auto" : "smooth", block: "center" });
  const m = el.classList.contains("rad") ? el : $(".rad", el);
  if(m){ m.classList.remove("er-truffet"); void m.offsetWidth; m.classList.add("er-truffet"); }
}

$("#slor").addEventListener("click", lukkSkuff);
$("#sok").addEventListener("input", e => { sok = e.target.value; tegn(); });
$("#filtSektor").addEventListener("change", e => { filtSektor = e.target.value; tegn(); });
$("#filtSted").addEventListener("change", e => { filtSted = e.target.value; tegn(); });
document.addEventListener("input", e => { if(e.target.id === "limInn") tegnForhaand(e.target.value); });

document.addEventListener("keydown", fokusfelle);
document.addEventListener("keydown", e => {
  if(e.key === "Escape"){ lukkSkuff(); return; }
  const iFelt = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if(iFelt){
    if(e.key === "Enter" && e.target.closest("#skuff") && e.target.tagName !== "TEXTAREA"){ e.preventDefault(); lagreSkjema(); }
    return;
  }
  if(e.metaKey || e.ctrlKey || e.altKey) return;
  if(e.key === "n"){ e.preventDefault(); skuffModus = "skjema"; apneSkuff("ny"); }
  if(e.key === "/"){ e.preventDefault(); $("#sok").focus(); }
});

/* verktøytips på fristlinjen */
const tips = $("#tips");
document.addEventListener("pointerover", e => {
  const s = e.target.closest("[data-tips]");
  if(!s){ tips.classList.remove("er-apen"); return; }
  tips.innerHTML = s.dataset.tips;
  tips.classList.add("er-apen");
  const r = s.getBoundingClientRect(), tr = tips.getBoundingClientRect();
  tips.style.left = Math.max(10, Math.min(innerWidth - tr.width - 10, r.left + r.width / 2 - tr.width / 2)) + "px";
  tips.style.top  = Math.max(10, r.top - tr.height - 9) + "px";
});
document.addEventListener("focusin", e => {
  const s = e.target.closest("[data-tips]");
  if(!s){ tips.classList.remove("er-apen"); return; }
  s.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
});
addEventListener("resize", () => { if(visning === "frister") tegnFristlinje(); });

/* ============================================================
   15. I gang
   ============================================================ */
/* ============================================================
   16. Oppstart, lagringstilstand og døgnskifte
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
  frakoblet: () => "Ikke lagret",
  konflikt:  () => "Endret et annet sted"
};

Lagring.påTilstand(t => {
  elLagret.dataset.t = t.navn;
  elLagret.textContent = (LAGRETEKST[t.navn] || (() => ""))(t);

  if(t.navn === "frakoblet")
    visStripe("Ingen kontakt med lagringen. Endringene ligger her, men er ikke skrevet til disk.",
              "Prøv igjen", "prøvLagring");
  else if(t.navn === "ulagret")
    visStripe(t.melding || "Lagringen avviste endringen.", "Prøv igjen", "prøvLagring");
  else if(t.navn === "konflikt")
    visStripe("Dataene ble endret et annet sted — antakelig i en annen fane.", "Hent på nytt", "hentPåNytt");
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

const kortTid = iso => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.getDate() + ". " + MND[d.getMonth()] + " " + klokke(d);
};

function gjenopprettKopi(){
  if(!sisteKopi) return;
  data = silt(sisteKopi.jobber);
  Lagring.settVersjon(0);
  lagre(); lukkSkuff(); tegn();
  varsle("Gjenopprettet " + antall(data.length, "søknad", "søknader") + " fra sikkerhetskopien");
}

function flyttHit(){
  const gamle = fraNettleser() || [];
  const gyldige = silt(gamle);
  const tapt = gamle.length - gyldige.length;
  data = gyldige;
  lagre(); lukkSkuff(); tegn();
  varsle("Flyttet " + antall(gyldige.length, "søknad", "søknader") + " til datafilen"
    + (tapt > 0 ? " · " + tapt + " kunne ikke leses" : ""));
}

function importerJson(){
  const el = $("#limJson");
  if(!el) return;
  const raa = el.value.trim();
  if(!raa){ varsle("Lim inn JSON i feltet først"); return; }

  let inn;
  try{ inn = JSON.parse(raa); }
  catch{ varsle("Fant ingen gyldig JSON i feltet"); return; }

  /* Godtar både en ren liste og hele dokumentet fra datafilen. */
  const liste = Array.isArray(inn) ? inn : (inn && Array.isArray(inn.jobber) ? inn.jobber : null);
  if(!liste){ varsle("Forventet en liste med søknader"); return; }

  const gyldige = silt(liste);
  if(!gyldige.length){ varsle("Ingen gyldige søknader i det du limte inn"); return; }

  const fra = data, tapt = liste.length - gyldige.length;
  data = gyldige;
  lagre(); lukkSkuff(); tegn();
  varsle("Erstattet listen med " + antall(gyldige.length, "søknad", "søknader")
    + (tapt > 0 ? " · " + tapt + " forkastet" : ""),
    () => { data = fra; lagre(); tegn(); });
}

/* En fane som blir stående over midnatt skal ikke fortsette å vise
   gårsdagens «i dag». Datoen hentes på nytt, og bare da tegnes det om. */
function sjekkDøgn(){
  const nå = new Date(new Date().toDateString());
  if(nå.getTime() === I_DAG.getTime()) return;
  I_DAG = nå;
  tegn();
}
addEventListener("visibilitychange", () => { if(document.visibilityState === "visible") sjekkDøgn(); });
addEventListener("focus", sjekkDøgn);
setInterval(sjekkDøgn, 60000);

async function start(){
  skjulStripe();
  try{
    const svar = await Lagring.hent();

    if(svar.tom){
      /* En sikkerhetskopi veier tyngre enn både nettleserkopien og
         startlisten: den er det siste vi vet var riktig. */
      if(svar.sikkerhetskopi && svar.sikkerhetskopi.jobber.length){
        sisteKopi = svar.sikkerhetskopi;
        data = []; tegn(); apneSkuff("gjenopprett"); return;
      }
      /* Ingen datafil ennå. Har nettleseren data fra før, skal brukeren
         få velge — vi flytter ikke noe uten å spørre. */
      const gamle = fraNettleser();
      if(gamle && gamle.length){ data = []; tegn(); apneSkuff("flytt"); return; }
      data = fraStart();
      lagre();
    }else{
      data = svar.jobber || [];
      if(svar.advarsel) varsle(svar.advarsel);
    }
  }catch(e){
    data = [];
    if(e.ødelagt){
      sisteKopi = e.sikkerhetskopi || null;
      const harKopi = !!(sisteKopi && sisteKopi.jobber.length);
      visStripe("Datafilen kunne ikke leses og er lagt til side som " + (e.sti || "en kopi")
        + ". Ingenting er overskrevet.",
        harKopi ? "Gjenopprett sikkerhetskopien" : "Prøv igjen",
        harKopi ? "apneGjenopprett" : "hentPåNytt");
    }else{
      visStripe("Ingen kontakt med lagringen. Kjører serveren? Start den med «npm start».",
                "Prøv igjen", "hentPåNytt");
    }
  }
  tegn();
}

start();
