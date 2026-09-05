/* ============================================================
   Porten — låsen foran appen.

   Ikke skuffen. Skuffen er et panel inne i appen, med en app rundt
   seg; porten står i stedet for appen. Derfor er den en egen flate
   — men bygget av de samme delene: ordmerket fra sidepanelet,
   .modus som veksler, felt-mønsteret fra skjemaet, .feil med
   fokushopp, .henter for «noe pågår», .knapp--primar.

   To grunner til at den står:
     "oppstart" — vi vet ennå ikke hvem dette er. Ugjennomsiktig:
                  det finnes ingen app bak å se på ennå.
     "utlogget" — økten røk mens appen sto åpen. Halvgjennomsiktig,
                  som sløret foran skuffen, så listen bak synes.
                  Det er halve beskjeden: arbeidet ditt er der ennå.

   Ingenting herfra rører data. Modulen kan én ting: skaffe en økt.
   Den svarer med { bruker, erFørste } når den har det, og gir seg
   ikke før. app.js avgjør hva som skjer etterpå.

   Alle kall går gjennom okt.js, som aldri kaster. Feilnavnene er
   dens, ikke serverens.
   ============================================================ */
import * as Økt from "./okt.js";

const $ = (s, r) => (r || document).querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let el = null;
let modus = "inn";              /* "inn" | "ny" */
let grunn = "oppstart";         /* "oppstart" | "utlogget" */
let status = null;              /* siste svar fra hentØkt() */
let ingress = "";               /* linjen over skjemaet, når det er noe å si */
let ulagret = false;
let løs = null;                 /* resolve for den som ventet på en økt */
let hentenr = 0;                /* kappløpsvern: PBKDF2 tar 200–400 ms */
let sperretTil = 0, ur = null;  /* for-mange: når slipper vi inn igjen */
let feil = null;                /* { melding, hjelp?, felt?, teller? } */

/* ------------------------------------------------------------
   Det utadvendte
   ------------------------------------------------------------ */

/* Kalles av app.js før alt annet. Er økten i orden, faller porten
   aldri på skjermen — den vises og skjules innenfor samme tegning. */
export async function krevØkt(){
  reisPorten("oppstart");
  const inne = await sjekk();
  if(inne) return inne;
  return new Promise(r => { løs = r; });
}

/* Økten røk mens appen sto åpen. Porten kommer opp over listen. */
export function krevØktIgjen({ melding, forrigeBruker, ulagret: u } = {}){
  ulagret = !!u;
  ingress = melding || "Du er logget ut. Logg inn på nytt.";
  modus = "inn";
  status = { innlogget: false, harBrukere: true };
  feil = null;
  reisPorten("utlogget");
  tegn();
  if(forrigeBruker && forrigeBruker.epost) settVerdi("portEpost", forrigeBruker.epost);
  fokusFørste();
  return new Promise(r => { løs = r; });
}

export const portenStår = () => !!el && !el.hidden;

/* ------------------------------------------------------------
   Flaten
   ------------------------------------------------------------ */

function reisPorten(hvorfor){
  grunn = hvorfor;
  el = $("#port");
  el.className = "port" + (hvorfor === "utlogget" ? " port--over" : "");
  el.hidden = false;
  baksiden(true);
}

function senkPorten(){
  stoppUret();
  sperretTil = 0;
  if(el){ el.hidden = true; el.innerHTML = ""; }
  baksiden(false);
}

/* Alt utenom porten settes inert mens den står. Da trengs ingen
   fokusfelle: det finnes ikke noe annet å tabbe til. Varselet får
   beholde sin egen inert når det er lukket — ellers kunne en
   usynlig angreknapp stjålet fokus. */
function baksiden(på){
  Array.from(document.body.children).forEach(e => {
    if(e.id === "port") return;
    if(på) e.setAttribute("inert", "");
    else if(e.id === "varsel"){ if(e.classList.contains("er-apen")) e.removeAttribute("inert"); }
    else e.removeAttribute("inert");
  });
}

const nyKonto = () => modus === "ny";

function tegn(){
  if(!el) return;
  const verdier = lesFeltene();
  stoppUret();

  el.innerHTML = '<div class="port__ramme">' + kroppen(verdier) + '</div>';

  if(verdier) fyllFeltene(verdier);
  if(feil && feil.teller && erSperret()){ tegnUret(); startUret(); }
}

function kroppen(verdier){
  const merke = '<div class="merke merke--port">'
    + '<h2 class="merke__navn" id="portTittel">Jobbsøknader</h2>'
    + '<span class="merke__ar">2027</span></div>';

  /* Registeret finnes, men kan ikke leses. Da skal flaten ikke tilby
     å opprette den første kontoen over noe som allerede står der. */
  if(status && status.ødelagt)
    return '<div class="port__kort">' + merke
      + '<p class="port__ingress">' + esc(status.melding
          || "Brukerregisteret kan ikke leses. Rett opp brukere.json før du logger inn.") + '</p>'
      + '<p class="felt__hjelp" style="margin:0 0 18px">Filen ligger i datakatalogen. '
      + 'Søknadene er urørt — det er bare registeret over hvem som eier dem som er skadet.</p>'
      + '<button class="knapp knapp--bred" type="button" data-port="påNytt">Sjekk på nytt</button>'
      + '</div>' + foten();

  if(status && status.frakoblet)
    return '<div class="port__kort">' + merke
      + '<p class="port__ingress">' + esc(status.melding || "Ingen kontakt med serveren.") + '</p>'
      + '<p class="felt__hjelp" style="margin:0 0 18px">Kjør <code>npm start</code> i prosjektmappa, '
      + 'og prøv igjen.</p>'
      + '<button class="knapp knapp--bred" type="button" data-port="påNytt">Prøv igjen</button>'
      + '</div>' + foten();

  const ny = nyKonto();
  const førstegang = status && status.harBrukere === false;

  return '<form class="port__kort" id="portSkjema" novalidate>' + merke
    + (ingress || førstegang
        ? '<p class="port__ingress">'
          + esc(ingress || "Ingen konto på denne maskinen ennå. Opprett den første.")
          + (ulagret ? '<span class="port__ingress-2">Endringen din ligger her og skrives '
                       + 'når du er inne igjen.</span>' : "")
          + '</p>'
        : "")
    + '<div class="modus modus--port" role="tablist" aria-label="Logg inn eller opprett konto">'
      + '<button class="modus__knapp" type="button" role="tab" data-port="inn" aria-selected="'
        + (!ny) + '">Logg inn</button>'
      + '<button class="modus__knapp" type="button" role="tab" data-port="ny" aria-selected="'
        + ny + '">Opprett konto</button></div>'
    + feilHtml()
    + '<div class="felt"><label class="felt__merke" for="portEpost">E-post</label>'
      + '<input class="felt__inn" id="portEpost" type="email" inputmode="email" spellcheck="false"'
      + ' autocomplete="username" aria-describedby="portFeil" autocapitalize="off"></div>'
    + (ny
        ? '<div class="felt"><label class="felt__merke" for="portNavn">Navn</label>'
          + '<input class="felt__inn" id="portNavn" type="text" autocomplete="name"'
          + ' aria-describedby="portFeil">'
          + '<p class="felt__hjelp">Valgfritt. Vises i sidepanelet.</p></div>'
        : "")
    + '<div class="felt"><label class="felt__merke" for="portPassord">Passord</label>'
      + '<input class="felt__inn" id="portPassord" type="password" aria-describedby="portFeil"'
      + ' autocomplete="' + (ny ? "new-password" : "current-password") + '">'
      + (ny ? '<p class="felt__hjelp">Minst ' + Økt.MIN_PASSORD + ' tegn.</p>' : "")
    + '</div>'
    + '<button class="knapp knapp--primar knapp--bred" type="submit" id="portSend"'
      + ' aria-describedby="portFeil">' + (ny ? "Opprett konto" : "Logg inn") + '</button>'
    + '<p class="henter" id="portVenter" role="status" aria-live="polite"></p>'
    + '</form>' + foten();
}

/* Den ene linjen som handler om dette produktet og ikke om
   innlogging: hvor tingene ligger. */
function foten(){
  return '<p class="port__fot">Kontoen og søknadene ligger på denne maskinen.</p>';
}

function feilHtml(){
  return '<p class="feil" id="portFeil"' + (feil ? "" : " hidden") + '>'
    + (feil ? feilInnmat(feil) : "") + '</p>';
}
function feilInnmat(f){
  return esc(f.melding)
    + (f.hjelp ? '<span class="feil__felt">' + f.hjelp + '</span>' : "")
    + (f.teller ? '<span class="feil__felt">Prøv igjen om '
                  + '<span class="port__ur" id="portUr">–</span></span>' : "");
}

/* ---- feltene overlever en ny tegning ---- */

function lesFeltene(){
  if(!$("#portEpost")) return null;
  return {
    epost:   $("#portEpost").value,
    navn:    $("#portNavn") ? $("#portNavn").value : "",
    passord: $("#portPassord") ? $("#portPassord").value : ""
  };
}
function fyllFeltene(v){
  settVerdi("portEpost", v.epost);
  settVerdi("portNavn", v.navn);
  settVerdi("portPassord", v.passord);
}
function settVerdi(id, verdi){
  const e = $("#" + id);
  if(e && verdi) e.value = verdi;
}

function fokusFørste(){
  const e = $("#portEpost"), p = $("#portPassord");
  /* Er e-posten allerede fylt ut — den kommer forhåndsutfylt når økten
     røk — er passordet det eneste som mangler. */
  const mål = (e && !e.value) ? e : (p || e || $("[data-port='påNytt']"));
  if(mål) mål.focus();
}

/* ------------------------------------------------------------
   Tilstandene
   ------------------------------------------------------------ */

async function sjekk(){
  const mitt = ++hentenr;
  const sen = setTimeout(() => {
    if(mitt === hentenr && el && !$("#portSkjema"))
      el.innerHTML = '<div class="port__ramme"><p class="henter port__laster">Sjekker innlogging…</p></div>';
  }, 400);

  const st = await Økt.hentØkt();
  clearTimeout(sen);
  if(mitt !== hentenr) return null;

  if(st.innlogget){
    senkPorten();
    return { bruker: st.bruker, erFørste: st.erFørste };
  }

  status = st;
  /* Finnes det ingen konto ennå, er «Opprett konto» den eneste
     handlingen som kan lykkes — så den står valgt. */
  modus = st.harBrukere ? "inn" : "ny";
  tegn();
  fokusFørste();
  return null;
}

/* Bare feilblokken byttes ut, ikke hele kortet: et helt nytt kort ved
   hver feil ville blinket og kastet skrivemerket. Feltene og knappen
   peker på den med aria-describedby, så fokushoppet leser den opp. */
function visFeil(f){
  feil = f;
  const e = $("#portFeil");
  if(!e){ tegn(); return; }
  e.innerHTML = feilInnmat(f);
  e.hidden = false;
  if(f.teller) tegnUret();
  const mål = f.felt ? $("#port" + f.felt[0].toUpperCase() + f.felt.slice(1)) : null;
  const fokus = mål || $("#portSend") || $("#portEpost");
  if(fokus) fokus.focus();
}

function tømFeil(){
  if(!feil) return;
  feil = null;
  stoppUret();
  sperretTil = 0;
  const e = $("#portFeil");
  if(e){ e.hidden = true; e.innerHTML = ""; }
}

/* ---- for-mange: klokka teller ned, knappen står låst ---- */

/* Klokka står i mono og er aria-hidden: den teller hvert sekund, og
   en opplesning i sekundet er ingen hjelp. Meldingen over den er lest
   opp én gang allerede, da fokus hoppet hit. */
function startUret(){ stoppUret(); ur = setInterval(tegnUret, 1000); }
function stoppUret(){ if(ur){ clearInterval(ur); ur = null; } }
function tegnUret(){
  const igjen = Math.max(0, Math.ceil((sperretTil - Date.now()) / 1000));
  const e = $("#portUr");
  if(e) e.textContent = Math.floor(igjen / 60) + ":" + String(igjen % 60).padStart(2, "0");
  const knapp = $("#portSend");
  if(knapp) knapp.disabled = igjen > 0;
  if(igjen <= 0 && ur){ stoppUret(); tømFeil(); }
}

const erSperret = () => sperretTil > Date.now();

/* ------------------------------------------------------------
   Innsendingen
   ------------------------------------------------------------ */

async function send(){
  if(erSperret()) return;
  const v = lesFeltene();
  if(!v) return;
  const ny = nyKonto();

  /* Tomme felt stoppes her. Ikke for høflighetens skyld: et tomt
     forsøk teller like mye i ratebegrenseren som et ekte. */
  if(!v.epost.trim()) return visFeil({ melding: "Skriv inn e-postadressen din.", felt: "epost" });
  if(!v.passord)      return visFeil({ melding: "Skriv inn et passord.", felt: "passord" });

  tømFeil();
  const mitt = ++hentenr;
  const knapp = $("#portSend"), venter = $("#portVenter");
  if(knapp) knapp.disabled = true;
  if(venter) venter.textContent = ny ? "Oppretter konto…" : "Logger inn…";

  const svar = ny
    ? await Økt.registrer({ epost: v.epost, navn: v.navn, passord: v.passord })
    : await Økt.loggInn({ epost: v.epost, passord: v.passord });

  /* Dobbeltklikk sender to kall. Bare det siste får svare. */
  if(mitt !== hentenr) return;
  if($("#portVenter")) $("#portVenter").textContent = "";
  if($("#portSend")) $("#portSend").disabled = false;

  if(svar.ok){
    const ferdig = løs;
    løs = null;
    senkPorten();
    ingress = ""; ulagret = false; feil = null;
    if(ferdig) ferdig({ bruker: svar.bruker, erFørste: !!svar.erFørste,
                        migrert: svar.migrert, migreringsfeil: svar.migreringsfeil });
    return;
  }

  /* Sperretiden settes før meldingen tegnes, ellers ville klokka blitt
     lest som utløpt i samme øyeblikk den kom på skjermen. */
  if(svar.feil === "for-mange")
    sperretTil = Date.now() + Math.max(1, svar.retryEtter || 60) * 1000;
  visFeil(tolkFeil(svar, ny));
  if(svar.feil === "for-mange") startUret();
}

/* Ett sted for hva hver feil betyr for den som står foran skjemaet. */
function tolkFeil(svar, ny){
  if(svar.feil === "ugyldig" && svar.detaljer && svar.detaljer.length){
    const f = svar.detaljer[0];
    return {
      melding: f.melding,
      felt: f.felt,
      hjelp: svar.detaljer.length > 1
        ? svar.detaljer.slice(1).map(d => esc(d.melding)).join("<br>") : null
    };
  }
  if(svar.feil === "feil-innlogging")
    return { melding: "Feil e-postadresse eller passord.", felt: "passord" };
  if(svar.feil === "finnes")
    return { melding: "Det finnes allerede en konto med den adressen.",
             hjelp: "Velg «Logg inn» over.", felt: "epost" };
  if(svar.feil === "stengt")
    return { melding: "Det er ikke plass til flere kontoer på denne maskinen." };
  if(svar.feil === "for-mange")
    return { melding: "For mange forsøk.", teller: true };
  if(svar.feil === "frakoblet")
    return { melding: "Ingen kontakt med serveren.",
             hjelp: "Kjør <code>npm start</code> i prosjektmappa, og prøv igjen." };
  if(svar.feil === "ødelagt-register")
    return { melding: "Brukerregisteret kan ikke leses.",
             hjelp: "Rett opp <code>brukere.json</code> i datakatalogen." };
  return { melding: svar.melding || (ny ? "Kontoen ble ikke opprettet." : "Innloggingen stoppet."),
           hjelp: "Prøv igjen." };
}

/* ------------------------------------------------------------
   Hendelser — én lytter, delegert, som i resten av appen
   ------------------------------------------------------------ */

document.addEventListener("click", e => {
  if(!portenStår()) return;
  const t = e.target.closest("[data-port]");
  if(!t || !t.closest("#port")) return;
  const hva = t.dataset.port;

  /* Kortet blir stående mens vi spør på nytt — å tegne et tomt skjema
     i mellomtiden ville blinket. Tar spørringen tid, bytter sjekk()
     selv innholdet mot «Sjekker innlogging…». */
  if(hva === "påNytt"){
    feil = null;
    t.disabled = true;
    sjekk().then(inne => {
      if(inne && løs){ const f = løs; løs = null; f(inne); }
      else if(t.isConnected) t.disabled = false;
    });
    return;
  }

  if(hva === "inn" || hva === "ny"){
    if(modus === hva) return;
    modus = hva;
    tømFeil();
    tegn();
    fokusFørste();
  }
});

document.addEventListener("submit", e => {
  if(!portenStår() || e.target.id !== "portSkjema") return;
  e.preventDefault();
  send();
});
