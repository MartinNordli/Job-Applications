/* Brevets arbeidsflate i detaljpanelets Brev-fane. DOM-en blir stående
   mens teksten lagres, slik at markør, tekstvalg og nettleserens
   angrehistorikk overlever hvert tastetrykk.

   Flaten er stablet, ikke delt i to kolonner: panelet er aldri bredere
   enn 580 px. Fremdriftsraden og statuslinjen står fast øverst. Under
   dem ruller grunnlaget (CV, annonse, språk, én linje hver) og papiret
   som ett dokument: papiret vokser med brevet i stedet for å rulle inni
   seg selv, så det finnes bare én rullefelt å forholde seg til.
   Innstillingene bytter ut grunnlaget og papiret når de er åpne, og
   legger seg ikke oppå dem. */
import * as Brev from "./brev.js";
import * as Jobbdokumenter from "./jobbdokumenter.js";
import * as Økt from "./okt.js";
import { lesCvFil, eksporterBrev, lagreFil } from "./brev-dokumenter.mjs";
import { MAKS_STIL } from "./brevdata.mjs";
import { FASE } from "./brevlogikk.mjs";
import { feilmelding } from "./annonseflate.js";
import { esc, tilIso, datoMedÅr, vert } from "./formater.js";

const tidspunkt = verdi => {
  const dato = new Date(verdi);
  return Number.isNaN(dato.getTime()) ? "" : dato.toLocaleString("nb-NO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};
const tall = n => n.toLocaleString("nb-NO");
/* Kjøringer som står og venter på neste trinn, kan fortsettes. De som
   står midt i et trinn, eies av et annet vindu eller et brutt kall. */
const VENTENDE = new Set(["klar", "venter", "skrevet"]);
const I_ARBEID = new Set(Object.values(FASE));
const TEKSTER = { analyse: "Leser annonsen og CV-en…", skriv: "Skriver utkastet…", kontroller: "Leser gjennom utkastet…" };
const GJENOPPRETTBAR = ["odelagt", "gjenoppretting", "versjon"];

export function åpneBrevflate({ jobb: førsteJobb, navn = "", kropp, bunn, ktx = {}, påLukk,
  åpneFane = () => {}, settDokument = () => {}, lastDokument = () => {} }) {
  const liv = new AbortController();
  const profil = Økt.nåværendeBruker()?.id;
  const leverandørnøkkel = profil ? `jobbsoknader-brev-leverandor-${profil}` : null;
  const huskLeverandør = verdi => { try { if (leverandørnøkkel) localStorage.setItem(leverandørnøkkel, verdi); } catch {} };
  const husketLeverandør = () => { try { return leverandørnøkkel && localStorage.getItem(leverandørnøkkel) === "openai" ? "openai" : "anthropic"; } catch { return "anthropic"; } };
  const id = førsteJobb.id;
  let k = { ...ktx, jobb: ktx.jobb || førsteJobb };
  const jobb = () => k.jobb;
  let dokument = null, cv = null, aktiv = true, opptatt = false, blokkert = false;
  let endring = 0, lagret = 0, cvEndring = 0, cvLagret = 0, lagring = null, ventetid;
  let forespørsel = null, arbeidsnr = 0, modellarbeid = false;
  let gjenoppretting = null, arbeid = null;
  let annonseHenter = false, annonseFokus = false;
  let stil = null, stilEndret = false, stilLastes = null;
  /* En annen fane kan sende hit for å få lagt inn CV-en («cv») eller
     nøkkelen («nokkel»). Feltene er låst til grunnlaget er hentet, så
     hensikten brukes først da. */
  let hensikt = ["cv", "nokkel"].includes(ktx.hensikt) ? ktx.hensikt : null;
  function brukHensikt() {
    if (!hensikt || !dokument || !aktiv) return;
    const h = hensikt; hensikt = null;
    if (h === "cv") visCvTekst(true);
    else visInnstillinger(true, "nøkkel");
  }
  const finn = velger => kropp.querySelector(velger) || bunn.querySelector(velger);
  const lytt = (element, type, funksjon) => element.addEventListener(type, funksjon, { signal: liv.signal });

  kropp.classList.add("skuff__kropp--brev");
  bunn.classList.add("skuff__bunn--brev");
  kropp.innerHTML = `
    <div class="brev__flytrad">
      <ol class="brev__flyt" id="brevFlyt" aria-label="Slik blir utkastet til">
        <li class="brev__steg" data-steg="analyse" data-tilstand="kommende"><span class="brev__steg__navn">Leser annonsen og CV-en</span><span class="brev__steg__mikro"><span class="skjult">Gjenstår</span></span></li>
        <li class="brev__steg" data-steg="skriv" data-tilstand="kommende"><span class="brev__steg__navn">Skriver</span><span class="brev__steg__mikro"><span class="skjult">Gjenstår</span></span></li>
        <li class="brev__steg" data-steg="kontroll" data-tilstand="kommende"><span class="brev__steg__navn">Leser gjennom</span><span class="brev__steg__mikro"><span class="skjult">Gjenstår</span></span></li>
      </ol>
    </div>
    <div class="brev__statusrad">
      <p class="brev__tilbakemelding" role="status" aria-live="polite"><span id="brevStatus">Henter grunnlaget…</span></p>
      <button class="knapp knapp--stille brev__avbryt" type="button" data-brev="stopp" hidden>Avbryt</button>
    </div>
    <div class="brev__feil" id="brevFeil" role="alert" hidden></div>
    <div class="brev__gjenoppretting" id="brevGjenoppretting" hidden><button class="knapp" type="button" data-brev="gjenopprett">Gjenopprett forrige lagring</button><p class="felt__hjelp">Den forrige lokale sikkerhetskopien brukes. Originalfilen blir bevart.</p></div>
    <div class="brev__lukkevalg" id="brevLukkevalg" hidden><p>Endringene er ikke lagret. Prøv igjen, eller kopier brevet før du lukker.</p><div class="brev__småhandlinger"><button class="knapp" type="button" data-brev="prøv">Prøv å lagre</button><button class="knapp" type="button" data-brev="hentLagret">Hent lagret versjon</button><button class="knapp knapp--fare" type="button" data-brev="forkast">Lukk uten å lagre</button></div></div>
    <div class="brev" data-panel="kilder" aria-busy="true">
      <section class="brev__kilder" id="brevGrunnlag" aria-label="Grunnlaget for brevet">
        <div class="brev__kilde" id="brevCvRad">
          <span class="brev__kildenavn">CV</span>
          <span class="brev__kildeverdi" id="brevCvNavn">Henter…</span>
          <span class="brev__kildehandlinger">
            <label class="knapp knapp--stille brev__lenkeknapp brev__filknapp er-av"><span id="brevCvFilTekst" aria-hidden="true">Velg fil</span><input id="brevCvFil" type="file" aria-label="Velg CV-fil" aria-describedby="brevCvHjelp" disabled accept=".pdf,.docx,.txt,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"></label>
            <button class="knapp knapp--stille brev__lenkeknapp" type="button" data-brev="cvTekst" aria-expanded="false" aria-controls="brevCvPanel" disabled>Lim inn</button>
          </span>
        </div>
        <div class="brev__cvpanel" id="brevCvPanel" hidden>
          <label class="skjult" for="brevCvTekst">CV-tekst</label>
          <textarea class="felt__omr brev__kildetekst" id="brevCvTekst" maxlength="100000" placeholder="Lim inn teksten fra CV-en din" disabled></textarea>
          <p class="felt__hjelp" id="brevCvHjelp">PDF, Word eller tekst. Du kan også slippe filen på CV-linjen. Skannede dokumenter må limes inn som tekst.</p>
        </div>
        <div class="brev__kilde" id="brevAnnonseRad">
          <span class="brev__kildenavn">Annonse</span>
          <span class="brev__kildeverdi" id="brevAnnonseVerdi">Henter…</span>
          <span class="brev__kildehandlinger" id="brevAnnonseHandlinger"></span>
        </div>
        <div class="brev__kilde">
          <label class="brev__kildenavn" for="brevSprak">Språk</label>
          <span class="brev__kildeverdi"><select class="brev__velger" id="brevSprak" disabled><option value="auto">Som annonsen</option><option value="nb">Norsk bokmål</option><option value="nn">Norsk nynorsk</option><option value="en">Engelsk</option><option value="sv">Svensk</option><option value="da">Dansk</option><option value="de">Tysk</option><option value="fr">Fransk</option></select></span>
          <span class="brev__kildehandlinger"><button class="knapp knapp--stille brev__lenkeknapp" type="button" data-brev="innstillinger" aria-expanded="false" aria-controls="brevInnstillinger">Innstillinger</button></span>
        </div>
        <div class="brev__kilde" id="brevNokkelvarsel" hidden>
          <span class="brev__kildenavn">Nøkkel</span>
          <span class="brev__kildeverdi er-tom" id="brevNokkelmangel">Mangler</span>
          <span class="brev__kildehandlinger"><button class="knapp knapp--stille brev__lenkeknapp" type="button" data-brev="tilNøkkel">Legg til nøkkel</button></span>
        </div>
      </section>
      <section class="brev__skriveflate" id="brevSkriveflate" aria-label="Søknadsbrevet">
        <div class="brev__verktoylinje"><label class="skjult" for="brevVersjon">Brevversjon</label><select class="brev__versjon" id="brevVersjon" disabled><option>Første utkast</option></select><span class="brev__lagret" id="brevLagret" role="status" aria-live="polite"></span></div>
        <p class="brev__endret" id="brevEndret" hidden>Grunnlaget er endret siden denne versjonen.</p>
        <div class="brev__papir">
          <label class="skjult" for="brevTekst">Søknadsbrevet ditt</label>
          <textarea class="brev__tekst" id="brevTekst" maxlength="16000" spellcheck="true" disabled placeholder="Brevet vises her.\n\nLegg til CV og stillingsannonse, så skriver vi et utkast du kan gjøre til ditt eget."></textarea>
          <div class="brev__strom" id="brevStrom" aria-hidden="true" hidden><span id="brevStromTekst"></span><span class="brev__markor"></span></div>
        </div>
        <div class="brev__forbedring" id="brevForbedring" hidden><label class="felt__merke" for="brevInstruks">Hva vil du forbedre?</label><div class="brev__forbedringsrad"><textarea class="felt__omr" id="brevInstruks" maxlength="2000" rows="1" placeholder="For eksempel: Gjør åpningen mer konkret" aria-describedby="brevInstruksHjelp"></textarea><button class="knapp" type="button" data-brev="forbedre">Lag ny versjon</button></div><p class="skjult" id="brevInstruksHjelp">Tar utgangspunkt i teksten du ser nå. Tidligere versjoner beholdes i versjonslisten.</p></div>
      </section>
      <section class="brev__innstillinger" id="brevInnstillinger" aria-labelledby="brevInnstillingerTittel" hidden>
        <div class="brev__innstillingstopp"><h3 id="brevInnstillingerTittel">Innstillinger</h3><button class="knapp knapp--stille brev__lenkeknapp" type="button" data-brev="lukkInnstillinger">Lukk innstillinger</button></div>
        <section class="brev__avsnitt brev__avsnitt--smal">
          <label class="felt__merke" for="brevLeverandor">Skriv med</label>
          <select class="felt__inn" id="brevLeverandor"><option value="anthropic">Claude</option><option value="openai">OpenAI</option></select>
          <p class="felt__hjelp">Valget huskes på profilen din, og hver leverandør har sin egen nøkkel. CV-en, annonsen og stilreferansen sendes dit når et utkast skrives.</p>
        </section>
        <section class="brev__avsnitt">
          <label class="felt__merke" for="brevNokkel">API-nøkkel for valgt leverandør</label>
          <input class="felt__inn" id="brevNokkel" type="password" autocomplete="off" spellcheck="false">
          <p class="felt__hjelp" id="brevNokkelstatus">Henter nøkkelstatus…</p>
          <div class="brev__småhandlinger"><button class="knapp" type="button" data-brev="nøkkel">Lagre nøkkel</button><button class="knapp knapp--stille" type="button" data-brev="fjernNøkkel" hidden>Fjern nøkkel</button></div>
        </section>
        <section class="brev__avsnitt brev__stil">
          <label class="felt__merke" for="brevStil">Stilreferanse</label>
          <p class="felt__hjelp brev__stilhjelp" id="brevStilHjelp">Et søknadsbrev du har skrevet selv og er fornøyd med. Nye utkast får samme tone og form, men ingenting av innholdet brukes som fakta. Det lagres bare på denne maskinen.</p>
          <textarea class="felt__omr brev__kildetekst" id="brevStil" maxlength="${MAKS_STIL}" aria-describedby="brevStilHjelp brevStilTeller" placeholder="Lim inn brevet her" disabled></textarea>
          <div class="brev__stilrad"><span class="brev__lagret" id="brevStilStatus" role="status" aria-live="polite"></span><span class="brev__teller" id="brevStilTeller"></span></div>
          <div class="brev__småhandlinger"><button class="knapp" type="button" data-brev="lagreStil" disabled>Lagre stilreferansen</button><button class="knapp knapp--stille knapp--fare" type="button" data-brev="slettStil" hidden>Slett</button></div>
        </section>
        <section class="brev__datahandlinger">
          <h4>Dataene dine</h4>
          <button class="knapp knapp--stille" type="button" data-brev="backup">Last ned sikkerhetskopi</button>
          <label class="brev__importvalg">Gjenopprett fra sikkerhetskopi<input id="brevImporter" type="file" accept=".json,application/json"></label>
          <p class="felt__hjelp">Sikkerhetskopien har med CV-en, stilreferansen, brevene, det som er lagret om hver søknad (annonse, vurdering og forberedelser) og Radar. API-nøkler følger ikke med.</p>
          <button class="knapp knapp--stille knapp--fare" type="button" data-brev="slettCv">Slett CV fra profilen</button>
          <button class="knapp knapp--stille knapp--fare" type="button" data-brev="slettBrev">Slett brevet og versjonene</button>
        </section>
      </section>
    </div>`;
  bunn.innerHTML = `<button class="knapp knapp--primar brev__generer" type="button" data-brev="skriv" aria-describedby="brevSkrivGrunn" disabled>Skriv utkast</button><span class="brev__grunn" id="brevSkrivGrunn"></span><span class="brev__ord" id="brevOrd"></span><span class="brev__kopistatus" id="brevKopistatus" role="status" aria-live="polite"></span><button class="knapp" type="button" data-brev="kopier" disabled>Kopier brev</button><details class="brev__nedlasting"><summary class="knapp knapp--primar">Last ned <span aria-hidden="true">⌄</span></summary><div class="brev__meny"><button type="button" data-brev="docx" disabled>Word (.docx)</button><button type="button" data-brev="pdf" disabled>PDF (.pdf)</button></div></details>`;

  function melding(tekst = "") { if (aktiv) finn("#brevStatus").textContent = tekst; }
  function feil(feilen) {
    if (!aktiv || feilen?.name === "AbortError") return;
    finn("#brevFeil").textContent = typeof feilen === "string" ? feilen : feilen?.melding || feilen?.message || String(feilen);
    finn("#brevFeil").hidden = false;
  }
  function ryddFeil() { finn("#brevFeil").hidden = true; }

  /* ---- fremdriftsraden ----
     Raden er modellens tre faser, med navn på det som faktisk skjer:
     den leser annonsen og CV-en, skriver, og leser gjennom det den skrev.
     Mikrolinjen under hvert navn sier om steget gjenstår, pågår, er
     ferdig eller ble gjenbrukt fra en tidligere versjon. */
  const STEG = ["analyse", "skriv", "kontroll"];
  const steget = steg => finn(`[data-steg="${steg}"]`);
  const tilstand = steg => steget(steg)?.dataset.tilstand;
  function settSteg(steg, ny, mikro = "") {
    const element = steget(steg); if (!element) return;
    element.dataset.tilstand = ny;
    element.querySelector(".brev__steg__mikro").innerHTML = mikro ? esc(mikro) : '<span class="skjult">Gjenstår</span>';
  }
  function flytKlar() { STEG.forEach(steg => settSteg(steg, "kommende")); }
  /* Et avbrudd eller en feil skal etterlate raden ærlig: steget som var i
     arbeid sier at det stoppet, resten står som de sto. */
  function flytStoppet() { STEG.forEach(steg => { if (tilstand(steg) === "aktiv") settSteg(steg, "stoppet", "stoppet"); }); }
  /* Ble analysen gjenbrukt, fyrte fasen aldri. Raden sier det rett ut i
     stedet for å late som steget ikke fantes. */
  function analyseForbi() { if (tilstand("analyse") !== "ferdig") settSteg("analyse", "ferdig", tilstand("analyse") === "kommende" ? "gjenbrukt" : "ferdig"); }
  function påFase({ trinn, nullstill }) {
    if (nullstill) strømTøm();
    if (trinn === "analyse") settSteg("analyse", "aktiv", "pågår");
    else if (trinn === "skriv") { analyseForbi(); settSteg("skriv", "aktiv", "pågår"); }
    else if (trinn === "kontroller") { analyseForbi(); settSteg("skriv", "ferdig", "ferdig"); settSteg("kontroll", "aktiv", "pågår"); }
    melding(TEKSTER[trinn] || "");
  }

  /* ---- strømmeflaten ----
     Teksten modellen skriver er provisorisk: kontrollen kan forkaste den
     etterpå, og et manuelt tastetrykk går alltid foran. Den legges derfor
     som et eget lag over papiret, aldri i #brevTekst, med nøyaktig samme
     typografi og innrykk, slik at ingen linje flytter seg når det ferdige
     brevet lander. Laget er utenfor aria-live med vilje: fasene annonseres,
     ikke tegnene. */
  let strømAv = false, strømFølger = true;
  function strømTøm() { finn("#brevStromTekst").textContent = ""; finn("#brevStrom").hidden = true; strømFølger = true; }
  function strømSkjul() { finn("#brevStrom").hidden = true; }
  function strømTillegg(tekst) {
    if (strømAv || !tekst) return;
    const flate = finn("#brevStrom");
    /* Et gjenopptatt trinn gir fase uten deltaer. Flaten avsløres derfor
       først når det finnes noe å vise. */
    if (flate.hidden) { flate.hidden = false; flate.scrollTop = 0; strømFølger = true; visPapiret(); }
    finn("#brevStromTekst").textContent += tekst;
    if (strømFølger) flate.scrollTop = flate.scrollHeight;
  }
  /* Står man nede i et langt brev når et nytt utkast begynner, rulles
     toppen av papiret fram, der teksten kommer. */
  function visPapiret() {
    const rulle = finn(".brev"), papir = finn(".brev__papir");
    if (papir.getBoundingClientRect().top < rulle.getBoundingClientRect().top) papir.scrollIntoView({ block: "start" });
  }
  /* Papiret vokser med teksten. Feltet måles uten høyde, og høyden settes
     som minstehøyde, så det også fyller papiret når brevet er kort.
     Rulleposisjonen holdes fast, ellers hopper flaten mens man skriver. */
  function tilpassPapir() {
    const felt = finn("#brevTekst"), rulle = finn(".brev");
    if (!felt || !rulle) return;
    const topp = rulle.scrollTop;
    felt.style.minHeight = "0px"; felt.style.height = "0px";
    const høyde = felt.scrollHeight;
    felt.style.height = ""; felt.style.minHeight = høyde + "px";
    rulle.scrollTop = topp;
  }
  /* Papiret tilhører brukeren. Rører hen teksten sin mens modellen skriver,
     trekker forhåndsvisningen seg for resten av kjøringen. */
  function strømOverta() { if (!finn("#brevStrom").hidden) { strømAv = true; strømSkjul(); } }
  function lagMelder(nummer) {
    return {
      påFase: fase => { if (nummer === arbeidsnr) påFase(fase); },
      påDelta: tekst => { if (nummer === arbeidsnr) strømTillegg(tekst); }
    };
  }

  /* ---- grunnlaget ---- */
  const annonsen = () => k.dok?.annonse || null;
  const harAnnonse = () => !!annonsen()?.tekst?.trim();
  const harCv = () => !!finn("#brevCvTekst").value.trim();
  const lenke = () => (jobb()?.lenke || "").trim();
  const dokVenter = () => !k.dok && !k.dokFeil;
  /* Hvorfor «Skriv utkast» ikke kan trykkes. Står ved knappen, og er
     knappens beskrivelse for skjermlesere. Tom når alt er på plass. */
  function skrivGrunn() {
    if (!dokument || dokVenter()) return "";
    if (!harCv() && !harAnnonse()) return "Legg til CV og annonse først";
    if (!harCv()) return "Legg til CV-en først";
    if (!harAnnonse()) return "Legg til annonsen først";
    return "";
  }
  function tegnAnnonse() {
    if (!aktiv) return;
    const verdi = finn("#brevAnnonseVerdi"), handlinger = finn("#brevAnnonseHandlinger");
    const av = annonseHenter || opptatt || !dokument;
    const knapp = (hva, tekst) => `<button class="knapp knapp--stille brev__lenkeknapp" type="button" data-brev="${hva}"${av && hva !== "seAnnonse" ? " disabled" : ""}>${tekst}</button>`;
    let tekst, html = "", mangler = false;
    if (annonseHenter) {
      const v = vert(lenke());
      tekst = "Henter" + (v ? " fra " + v : "") + "…";
      html = knapp("hentAnnonse", "Hent") + knapp("limAnnonse", "Lim inn");
    } else if (dokVenter()) tekst = "Henter…";
    else if (!k.dok) { tekst = "Fikk ikke lest annonsen"; mangler = true; html = knapp("seAnnonse", "Se annonsen"); }
    else if (harAnnonse()) {
      const dato = annonsen().hentet ? new Date(annonsen().hentet) : null;
      tekst = "Lagret" + (dato && !Number.isNaN(dato.getTime()) ? " " + datoMedÅr(tilIso(dato), k.iDag || new Date()) : "");
      html = knapp("seAnnonse", "Se annonsen");
    } else {
      tekst = "Mangler"; mangler = true;
      /* Uten lenke er det ingenting å hente fra. Annonse-fanen sier
         hvordan lenken legges inn. */
      html = (lenke() ? knapp("hentAnnonse", "Hent") : "") + knapp("limAnnonse", "Lim inn");
    }
    verdi.textContent = tekst;
    verdi.classList.toggle("er-tom", mangler);
    const fokusInne = handlinger.contains(document.activeElement);
    handlinger.innerHTML = html;
    /* Knappen man trykket på, kan ha byttet navn eller blitt borte.
       Fokus blir i raden i stedet for å falle ut til dokumentet. */
    if ((fokusInne || annonseFokus) && !annonseHenter) { annonseFokus = false; handlinger.querySelector("button:not(:disabled)")?.focus({ preventScroll: true }); }
  }
  function oppdaterKnapper() {
    const tekst = finn("#brevTekst").value.trim();
    const grunn = skrivGrunn();
    bunn.classList.toggle("har-brev", !!tekst);
    const skriv = finn('[data-brev="skriv"]');
    skriv.textContent = tekst ? "Skriv nytt utkast" : "Skriv utkast";
    skriv.classList.toggle("knapp--primar", !tekst);
    skriv.disabled = opptatt || blokkert || !dokument || dokVenter() || !!grunn;
    finn("#brevSkrivGrunn").textContent = opptatt ? "" : grunn;
    finn('[data-brev="forbedre"]').disabled = opptatt || blokkert || !dokument;
    finn("#brevOrd").textContent = tekst ? `${tekst.split(/\s+/u).length} ord` : "";
    ["kopier", "docx", "pdf"].forEach(handling => finn(`[data-brev="${handling}"]`).disabled = !tekst || (opptatt && handling !== "kopier"));
    finn("#brevForbedring").hidden = !tekst;
    tilpassPapir();
  }
  function settOpptatt(verdi, tekst = "") {
    if (!aktiv) return;
    opptatt = verdi; melding(tekst);
    const låst = verdi || !dokument;
    finn(".brev").setAttribute("aria-busy", String(verdi));
    ["#brevCvFil", "#brevCvTekst", '[data-brev="cvTekst"]', "#brevSprak"].forEach(velger => finn(velger).disabled = låst);
    finn(".brev__filknapp").classList.toggle("er-av", låst);
    /* Leverandøren kan ikke byttes mens et kall er underveis. */
    finn("#brevLeverandor").disabled = låst;
    finn("#brevTekst").disabled = !dokument;
    finn("#brevInstruks").disabled = verdi;
    finn("#brevVersjon").disabled = låst || !dokument?.versjoner?.length;
    finn('[data-brev="stopp"]').hidden = !(verdi && forespørsel) && !blokkert;
    tegnAnnonse(); oppdaterKnapper();
  }
  function fyllVersjoner() {
    const versjoner = dokument.versjoner || [];
    finn("#brevVersjon").innerHTML = versjoner.length
      ? [...versjoner].reverse().map((versjon, indeks) => `<option value="${esc(versjon.id)}">Versjon ${versjoner.length - indeks}${versjon.manuell ? " (din redigering)" : ""}${versjon.opprettet ? " · " + esc(tidspunkt(versjon.opprettet)) : ""}</option>`).join("")
      : '<option value="">Første utkast</option>';
    finn("#brevVersjon").value = dokument.aktivVersjon || "";
    finn("#brevVersjon").disabled = opptatt || !versjoner.length;
  }
  function fyllDokument() {
    const språk = dokument.sprak || "auto";
    if (![...finn("#brevSprak").options].some(valg => valg.value === språk)) finn("#brevSprak").add(new Option(språk, språk));
    finn("#brevSprak").value = språk;
    finn("#brevLeverandor").value = dokument.leverandor || "anthropic";
    finn("#brevTekst").value = dokument.tekst || "";
    finn("#brevTekst").lang = dokument.versjoner?.find(v => v.id === dokument.aktivVersjon)?.sprak || (språk === "auto" ? "" : språk);
    fyllVersjoner(); oppdaterKnapper();
  }
  function fyllCv() {
    finn("#brevCvTekst").value = cv?.tekst || "";
    tegnCv();
  }
  function tegnCv() {
    const har = harCv(), åpen = !finn("#brevCvPanel").hidden;
    const verdi = finn("#brevCvNavn");
    verdi.textContent = har ? (cv?.navn && cv.navn !== "CV" ? cv.navn : "Lagt inn som tekst") : "Mangler";
    verdi.classList.toggle("er-tom", !har);
    finn("#brevCvFilTekst").textContent = har ? "Bytt fil" : "Velg fil";
    finn('[data-brev="cvTekst"]').textContent = åpen ? "Skjul teksten" : har ? "Se teksten" : "Lim inn";
    oppdaterKnapper();
  }
  function visCvTekst(åpen) {
    finn("#brevCvPanel").hidden = !åpen;
    finn('[data-brev="cvTekst"]').setAttribute("aria-expanded", String(åpen));
    tegnCv();
    if (åpen) finn("#brevCvTekst").focus();
  }
  const leverandørnavn = () => finn("#brevLeverandor").selectedOptions[0]?.textContent || "leverandøren";
  /* Nøkkelen bor i innstillingene, men mangler den, stopper skrivingen.
     Grunnlaget sier det derfor rett ut og peker dit, i stedet for at
     brukeren skal finne fram selv. */
  function visNøkkelmangel(mangler) {
    finn("#brevNokkelvarsel").hidden = !mangler;
    if (mangler) finn("#brevNokkelmangel").textContent = `Mangler for ${leverandørnavn()}`;
  }
  async function visNøkkel() {
    const leverandør = finn("#brevLeverandor").value;
    finn("#brevNokkelstatus").textContent = "Henter nøkkelstatus…";
    try {
      const status = await Brev.nokkelStatus(leverandør);
      if (!aktiv || leverandør !== finn("#brevLeverandor").value) return;
      finn("#brevNokkelstatus").textContent = status.finnes ? `Nøkkel satt${status.hale ? " · ····" + status.hale : ""}` : `Legg til en API-nøkkel for å skrive med ${leverandørnavn()}.`;
      finn('[data-brev="fjernNøkkel"]').hidden = !status.finnes;
      visNøkkelmangel(!status.finnes);
    } catch (e) { if (aktiv) { finn("#brevNokkelstatus").textContent = e.message || "Kunne ikke lese nøkkelstatus"; visNøkkelmangel(false); } }
  }

  /* ---- innstillingene ----
     Panelet heter data-panel og ikke data-visning med vilje: app.js har
     en delegert lytter på [data-visning] for hovednavigasjonen. */
  function visInnstillinger(åpen, fokus = "felt") {
    const knapp = finn('[data-brev="innstillinger"]');
    finn(".brev").dataset.panel = åpen ? "innstillinger" : "kilder";
    finn("#brevInnstillinger").hidden = !åpen;
    knapp.setAttribute("aria-expanded", String(åpen));
    if (åpen && !stil && !stilLastes) lastStil();
    if (!åpen) knapp.focus();
    else if (fokus === "nøkkel") finn("#brevNokkel").focus();
    else finn("#brevLeverandor").focus();
  }
  function tegnStil() {
    if (!aktiv) return;
    const felt = finn("#brevStil");
    felt.disabled = !stil;
    finn("#brevStilTeller").textContent = `${tall(felt.value.length)} av ${tall(MAKS_STIL)} tegn`;
    finn('[data-brev="lagreStil"]').disabled = !stil || !stilEndret;
    finn('[data-brev="slettStil"]').hidden = !stil?.tekst;
    finn("#brevStilStatus").textContent = !stil ? (stilLastes ? "Henter…" : "") : stilEndret ? "Ikke lagret" : stil.tekst ? "Lagret" : "";
  }
  async function lastStil() {
    stilLastes = Brev.hentStil();
    tegnStil();
    try {
      const svar = await stilLastes; if (!aktiv) return;
      stil = svar; stilEndret = false; finn("#brevStil").value = stil.tekst || "";
    } catch (e) {
      if (!aktiv) return;
      feil(e);
      if (GJENOPPRETTBAR.includes(e.code)) { gjenoppretting = "stil"; finn("#brevGjenoppretting").hidden = false; }
    } finally { stilLastes = null; tegnStil(); }
  }
  /* Revisjonen er den som ble hentet. Har et annet vindu lagret i
     mellomtiden, hentes den ferske revisjonen, teksten i feltet blir
     stående, og et nytt trykk erstatter den andre. */
  async function stilKonflikt(e) {
    if (e?.code !== "konflikt") throw e;
    stil = await Brev.hentStil(); if (!aktiv) return;
    stilEndret = true; tegnStil();
    feil("Stilreferansen ble endret i et annet vindu. Teksten din står fortsatt i feltet. Lagre igjen for å erstatte den.");
  }
  async function lagreStil() {
    if (!stil || !stilEndret) return;
    const tekst = finn("#brevStil").value;
    finn("#brevStilStatus").textContent = "Lagrer…";
    ryddFeil();
    try {
      const svar = await Brev.lagreStil({ revisjon: stil.revisjon, tekst }); if (!aktiv) return;
      stil = svar; stilEndret = finn("#brevStil").value !== (stil.tekst || "");
      tegnStil(); melding(tekst.trim() ? "Stilreferansen er lagret. Nye utkast skrives i samme tone." : "Stilreferansen er tømt.");
    } catch (e) { if (!aktiv) return; tegnStil(); await stilKonflikt(e); }
  }

  function endret(erGrunnlag = false) {
    endring++;
    if (erGrunnlag && dokument?.tekst) finn("#brevEndret").hidden = false;
    finn("#brevLagret").textContent = "Ikke lagret";
    clearTimeout(ventetid);
    if (!modellarbeid) ventetid = setTimeout(() => lagre().catch(feil), 700);
  }
  function lesDokument() {
    return { ...dokument, sprak: finn("#brevSprak").value, leverandor: finn("#brevLeverandor").value, tekst: finn("#brevTekst").value };
  }
  async function lagre() {
    clearTimeout(ventetid);
    if (!aktiv || !dokument) return;
    if (lagring) { await lagring; if (aktiv && (endring !== lagret || cvEndring !== cvLagret)) return lagre(); return; }
    lagring = (async () => {
      while (aktiv && (endring !== lagret || cvEndring !== cvLagret)) {
        finn("#brevLagret").textContent = "Lagrer…";
        if (cvEndring !== cvLagret) {
          const mitt = cvEndring;
          const svar = await Brev.lagreCv({ ...cv, tekst: finn("#brevCvTekst").value, navn: cv?.navn || "CV", format: cv?.format || "tekst" });
          if (!aktiv) return;
          cv = cvEndring === mitt ? svar : { ...cv, revisjon: svar.revisjon }; cvLagret = mitt;
        }
        if (endring !== lagret) {
          const mitt = endring;
          const svar = await Brev.lagreBrev(id, lesDokument());
          if (!aktiv) return;
          dokument = endring === mitt ? svar : { ...dokument, revisjon: svar.revisjon }; lagret = mitt;
        }
      }
      if (aktiv) { finn("#brevLagret").textContent = "Lagret"; finn("#brevLukkevalg").hidden = true; }
    })();
    try { await lagring; }
    catch (e) { if (aktiv) { finn("#brevLagret").textContent = "Ikke lagret"; finn("#brevLukkevalg").hidden = false; } throw e; }
    finally { lagring = null; }
  }
  /* Modelltrinn øker også revisjonen. Ta imot metadata og historikk,
     men behold tekst som brukeren skrev mens modellen arbeidet. */
  async function taImot(resultat) {
    const manuelt = endring !== lagret;
    const tekst = finn("#brevTekst").value;
    const forrige = dokument.versjoner?.find(v => v.id === dokument.aktivVersjon);
    dokument = resultat;
    if (manuelt) {
      dokument.tekst = tekst;
      const finnes = dokument.versjoner.find(v => v.tekst === tekst);
      if (finnes) dokument.aktivVersjon = finnes.id;
      else if (dokument.versjoner.length < 100) {
        const manuell = { ...forrige, id: crypto.randomUUID(), tekst, opprettet: new Date().toISOString(), manuell: true };
        dokument.versjoner.push(manuell); dokument.aktivVersjon = manuell.id;
      } else dokument.aktivVersjon = forrige?.id || null;
      finn("#brevLagret").textContent = "Lagrer…";
    } else {
      finn("#brevTekst").value = resultat.tekst || "";
      finn("#brevLagret").textContent = "Lagret";
    }
    fyllVersjoner();
    finn("#brevTekst").lang = resultat.versjoner?.find(v => v.id === resultat.aktivVersjon)?.sprak || "";
    oppdaterKnapper();
    if (manuelt) await lagre();
    return manuelt || resultat.kjoring?.nyttForslag;
  }
  async function ferskRevisjon() {
    try {
      const fersk = await Brev.hentBrev(id);
      if (aktiv) dokument = { ...dokument, revisjon: fersk.revisjon, kjoring: fersk.kjoring, versjoner: fersk.versjoner };
    } catch (e) { feil(e); }
  }
  async function lesFil(fil) {
    if (!fil || opptatt) return;
    settOpptatt(true, "Leser CV-en…"); ryddFeil();
    try {
      const lest = await lesCvFil(fil);
      if (!aktiv) return;
      cv = { ...cv, ...lest }; fyllCv(); cvEndring++; endret(true); await lagre(); melding("CV-en er klar. Se gjerne over teksten.");
    } catch (e) { feil(e); }
    finally { if (aktiv) settOpptatt(false, finn("#brevStatus").textContent === "Leser CV-en…" ? "" : finn("#brevStatus").textContent); }
  }
  async function avbryt() {
    arbeidsnr++; forespørsel?.abort();
    strømSkjul(); flytStoppet();
    /* En kjøring fra et annet vindu eller et brutt kall har ingen
       forespørsel her å avbryte. Den stoppes hos tjenesten. */
    if (blokkert && dokument?.kjoring?.id) { try { await Brev.avbryt(id, dokument.kjoring.id); } catch (e) { if (aktiv) feil(e); } }
    if (arbeid) await arbeid.catch(() => {});
    if (aktiv) await ferskRevisjon();
    blokkert = false; modellarbeid = false; forespørsel = null;
    if (!aktiv) return;
    finn('[data-brev="stopp"]').textContent = "Avbryt";
    settOpptatt(false, "Skrivingen er avbrutt. Grunnlaget og tidligere brev er beholdt.");
  }
  /* Utkast og forbedring går gjennom samme kjede. kjør() eier tilstanden
     rundt kallet: fremdriften, strømmen, avbruddet og hva som står igjen
     når det er over. */
  async function kjør({ start, kall, ferdig, stoppet, lagreFørst }) {
    const nummer = ++arbeidsnr;
    forespørsel = new AbortController(); modellarbeid = true; strømAv = false;
    flytKlar(); settOpptatt(true, start);
    try {
      if (lagreFørst) { await lagre(); if (!aktiv || nummer !== arbeidsnr) return false; }
      const resultat = await kall({ signal: forespørsel.signal, ...lagMelder(nummer) });
      if (!aktiv || nummer !== arbeidsnr) return false;
      const beholdt = await taImot(resultat);
      if (!aktiv || nummer !== arbeidsnr) return false;
      /* Først når den ferdige teksten står i feltet trekkes laget over den
         bort. Typografien er den samme, så ingen linje flytter seg. */
      strømSkjul(); analyseForbi(); settSteg("skriv", "ferdig", "ferdig"); settSteg("kontroll", "ferdig", "ferdig");
      finn("#brevEndret").hidden = true;
      melding(beholdt ? "Endringene dine er beholdt. Det nye forslaget ligger i versjonslisten." : ferdig);
      return true;
    } catch (e) {
      if (nummer === arbeidsnr) { strømSkjul(); flytStoppet(); feil(e); await ferskRevisjon(); melding(stoppet); }
      return false;
    } finally { if (nummer === arbeidsnr) { modellarbeid = false; forespørsel = null; if (aktiv) { settOpptatt(false, finn("#brevStatus").textContent); if (endring !== lagret) lagre().catch(feil); } } }
  }
  function lagUtkast({ gjenoppta = false } = {}) {
    if (opptatt) return;
    ryddFeil();
    if (!gjenoppta) { const grunn = skrivGrunn(); if (grunn) { feil(grunn + "."); return; } endring++; }
    return kjør({
      start: gjenoppta ? "Fortsetter utkastet som ble avbrutt…" : TEKSTER.analyse,
      kall: valg => Brev.lagUtkast(id, valg),
      ferdig: "Utkastet er klart. Les gjennom og gjør teksten til din egen.",
      stoppet: "Skrivingen stoppet. Grunnlaget og tidligere brev er beholdt.",
      lagreFørst: !gjenoppta
    });
  }
  async function forbedre(gjenopptatt = "") {
    if (opptatt) return;
    const instruks = gjenopptatt || finn("#brevInstruks").value.trim();
    if (!instruks) { feil("Skriv hva du vil forbedre først."); finn("#brevInstruks").focus(); return; }
    ryddFeil();
    const ok = await kjør({
      start: gjenopptatt ? "Fortsetter den nye versjonen som ble avbrutt…" : "Lager en ny versjon…",
      kall: valg => Brev.forbedre(id, instruks, valg),
      ferdig: "En ny versjon er klar. Den forrige ligger i versjonslisten.",
      stoppet: "Skrivingen stoppet. Teksten din er beholdt.",
      lagreFørst: !gjenopptatt
    });
    if (ok && aktiv && !gjenopptatt) finn("#brevInstruks").value = "";
  }
  async function hentAnnonse() {
    if (annonseHenter || opptatt) return;
    annonseHenter = true; annonseFokus = true; ryddFeil(); tegnAnnonse();
    const v = vert(lenke());
    melding("Henter annonsen" + (v ? " fra " + v : "") + "…");
    try {
      const dok = await Jobbdokumenter.hentAnnonse(id);
      if (!aktiv) return;
      annonseHenter = false;
      /* Panelet gir dokumentet tilbake gjennom oppdater(), så raden og
         Annonse-fanen viser det samme. */
      settDokument(id, dok);
      melding("Annonsen er hentet.");
    } catch (e) {
      if (!aktiv) return;
      annonseHenter = false; tegnAnnonse(); oppdaterKnapper(); melding("");
      if (e?.code === "utlogget") return;
      const f = feilmelding(e);
      const område = finn("#brevFeil"); område.hidden = false;
      område.innerHTML = `<p>${esc(f.tittel)}</p>${f.hjelp ? `<p>${esc(f.hjelp)}</p>` : ""}`;
    }
  }
  async function bekreft(tekst, handling) {
    const område = finn("#brevFeil"); område.hidden = false;
    område.innerHTML = `<p>${esc(tekst)}</p><div class="brev__småhandlinger"><button class="knapp knapp--fare" type="button" id="brevBekreft">Bekreft</button><button class="knapp knapp--stille" type="button" id="brevAvstå">Avbryt</button></div>`;
    finn("#brevBekreft").onclick = async () => { ryddFeil(); try { await handling(); } catch (e) { feil(e); } };
    finn("#brevAvstå").onclick = ryddFeil;
    finn("#brevAvstå").focus();
  }
  async function handle(handling) {
    if (handling === "stopp") return avbryt();
    if (handling === "forkast") { rydd(); påLukk(); return; }
    if (handling === "innstillinger") { visInnstillinger(finn(".brev").dataset.panel !== "innstillinger"); return; }
    if (handling === "lukkInnstillinger") { visInnstillinger(false); return; }
    if (handling === "tilNøkkel") { visInnstillinger(true, "nøkkel"); return; }
    if (handling === "seAnnonse") { åpneFane("annonse"); return; }
    if (handling === "limAnnonse") { åpneFane("annonse", "lim"); return; }
    if (handling === "gjenopprett") {
      if (!gjenoppretting) return;
      return bekreft("Bruk forrige lokale lagring av dette dokumentet? Den uleselige originalen blir bevart.", async () => {
        const hva = gjenoppretting;
        if (hva === "cv") await Brev.gjenopprettCv();
        else if (hva === "stil") await Brev.gjenopprettStil();
        else await Brev.gjenopprettBrev(id);
        if (!aktiv) return;
        gjenoppretting = null; finn("#brevGjenoppretting").hidden = true;
        if (hva === "stil") await lastStil(); else await hentGrunnlag();
      });
    }
    if (handling === "lagreStil") return lagreStil();
    if (handling === "slettStil") {
      return bekreft("Slett stilreferansen? Nye utkast skrives da uten den. Brev du allerede har, endres ikke.", async () => {
        try { await Brev.slettStil(stil.revisjon); } catch (e) { return stilKonflikt(e); }
        stil = await Brev.hentStil(); if (!aktiv) return;
        stilEndret = false; finn("#brevStil").value = stil.tekst || ""; tegnStil(); melding("Stilreferansen er slettet.");
      });
    }
    if (!dokument) return;
    if (handling === "prøv") { ryddFeil(); await lagre(); return; }
    if (handling === "hentLagret") {
      return bekreft("Hent den lagrede CV-en og brevet på nytt? Ulagrede endringer i denne flaten går tapt. Kopier teksten først hvis du vil beholde den.", async () => {
        clearTimeout(ventetid);
        const svar = await Promise.all([Brev.hentCv(), Brev.hentBrev(id)]);
        if (!aktiv) return;
        [cv, dokument] = svar; endring = lagret = cvEndring = cvLagret = 0;
        fyllCv(); fyllDokument(); finn("#brevLukkevalg").hidden = true;
        finn("#brevLagret").textContent = "Lagret"; melding("Den lagrede versjonen er hentet.");
      });
    }
    if (handling === "skriv") { arbeid = lagUtkast(); return arbeid; }
    if (handling === "forbedre") { arbeid = forbedre(); return arbeid; }
    if (opptatt && handling !== "kopier") return;
    if (handling === "hentAnnonse") return hentAnnonse();
    if (handling === "cvTekst") { visCvTekst(finn("#brevCvPanel").hidden); return; }
    ryddFeil();
    if (handling === "nøkkel") {
      const nøkkel = finn("#brevNokkel").value.trim();
      if (!nøkkel) { feil("Lim inn API-nøkkelen først."); finn("#brevNokkel").focus(); return; }
      await Brev.settNokkel(finn("#brevLeverandor").value, nøkkel); if (!aktiv) return; finn("#brevNokkel").value = ""; await visNøkkel();
    } else if (handling === "fjernNøkkel") {
      await bekreft("Fjern API-nøkkelen for valgt leverandør?", async () => { await Brev.slettNokkel(finn("#brevLeverandor").value); if (aktiv) await visNøkkel(); });
    } else if (handling === "kopier") {
      const tekst = finn("#brevTekst").value;
      try { await navigator.clipboard.writeText(tekst); if (aktiv) finn("#brevKopistatus").textContent = "Kopiert"; }
      catch { finn("#brevTekst").focus(); finn("#brevTekst").select(); feil("Kopiering ble blokkert. Brevet er markert, så du kan kopiere med tastaturet."); }
    } else if (handling === "pdf" || handling === "docx") {
      await lagre(); if (!aktiv) return;
      await eksporterBrev({ tekst: finn("#brevTekst").value, stilling: jobb().stilling, selskap: jobb().selskap, navn }, handling);
      if (aktiv) finn(".brev__nedlasting").open = false;
    } else if (handling === "backup") {
      await lagre(); if (!aktiv) return;
      if (stilEndret) { await lagreStil(); if (!aktiv) return; }
      const data = await Brev.eksporterData(); if (!aktiv) return;
      await lagreFil({ bytes: new TextEncoder().encode(JSON.stringify(data, null, 2)), mime: "application/json", navn: "soknadsbrev-sikkerhetskopi.json" });
    } else if (handling === "slettCv") {
      await bekreft("Slett CV-en fra profilen? Tidligere brev og kildegrunnlaget i versjonene blir beholdt.", async () => { await lagre(); await Brev.slettCv(cv?.revisjon); if (!aktiv) return; cv = await Brev.hentCv(); if (!aktiv) return; cvEndring = cvLagret = 0; fyllCv(); melding("CV-en er slettet fra profilen."); });
    } else if (handling === "slettBrev") {
      await bekreft("Slett brevet og alle versjonene for denne jobben? Dette kan ikke angres. CV-en og annonsen beholdes.", async () => { await lagre(); await Brev.slettBrev(id, dokument.revisjon); if (!aktiv) return; dokument = await Brev.hentBrev(id); if (!aktiv) return; endring = lagret = 0; fyllDokument(); melding("Brevet og versjonene er slettet."); });
    }
  }
  for (const område of [kropp, bunn]) lytt(område, "click", hendelse => {
    const knapp = hendelse.target.closest("[data-brev]");
    if (!knapp || knapp.disabled) return;
    handle(knapp.dataset.brev).catch(feil);
  });
  /* Esc lukker innstillingene før den lukker panelet. */
  lytt(kropp, "keydown", hendelse => {
    if (hendelse.key !== "Escape" || hendelse.defaultPrevented || finn(".brev").dataset.panel !== "innstillinger") return;
    hendelse.preventDefault(); visInnstillinger(false);
  });
  lytt(kropp, "input", hendelse => {
    const felt = hendelse.target.id;
    if (felt === "brevStil") { stilEndret = hendelse.target.value !== (stil?.tekst || ""); tegnStil(); return; }
    if (!dokument || (opptatt && felt !== "brevTekst")) return;
    if (felt === "brevCvTekst") { cvEndring++; if (!cv?.navn) cv = { ...cv, navn: "CV", format: "tekst" }; tegnCv(); endret(true); }
    else if (felt === "brevTekst") { strømOverta(); endret(); oppdaterKnapper(); finn("#brevKopistatus").textContent = ""; }
  });
  /* Fokus i brevfeltet er brukerens krav på papiret, uansett om det kommer
     fra tastaturet, et klikk eller et skjermleserkall. */
  lytt(finn("#brevTekst"), "focus", strømOverta);
  lytt(finn("#brevStrom"), "scroll", () => {
    const flate = finn("#brevStrom");
    strømFølger = flate.scrollHeight - flate.scrollTop - flate.clientHeight < 24;
  });
  /* Laget tar hjulet, så teksten kan leses bakover mens den skrives, men
     gir fra seg klikket: da vil brukeren redigere, ikke lese. */
  lytt(finn("#brevStrom"), "pointerdown", hendelse => { hendelse.preventDefault(); strømOverta(); finn("#brevTekst").focus(); });
  lytt(kropp, "change", hendelse => {
    const felt = hendelse.target.id;
    if (felt === "brevCvFil") { lesFil(hendelse.target.files?.[0]); hendelse.target.value = ""; }
    if (felt === "brevLeverandor" || felt === "brevSprak") { endret(true); if (felt === "brevLeverandor") { huskLeverandør(hendelse.target.value); finn("#brevNokkel").value = ""; visNøkkel(); } }
    if (felt === "brevVersjon") {
      const valgt = hendelse.target.value;
      lagre().then(() => {
        if (!aktiv) return;
        const versjon = dokument.versjoner?.find(v => v.id === valgt); if (!versjon) return;
        if (dokument.tekst && !dokument.versjoner.some(v => v.tekst === dokument.tekst)) {
          if (dokument.versjoner.length >= 100) throw new Error("Historikken er full. Ta en sikkerhetskopi før du bytter versjon.");
          const forrige = dokument.versjoner.find(v => v.id === dokument.aktivVersjon);
          dokument.versjoner.push({ ...forrige, id: crypto.randomUUID(), tekst: dokument.tekst, opprettet: new Date().toISOString(), manuell: true });
        }
        dokument.aktivVersjon = valgt; finn("#brevTekst").value = versjon.tekst; finn("#brevTekst").lang = versjon.sprak || ""; endret(); oppdaterKnapper();
        fyllVersjoner();
      }).catch(feil);
    }
    if (felt === "brevImporter") {
      const fil = hendelse.target.files?.[0]; hendelse.target.value = ""; if (!fil) return;
      if (fil.size > 30 * 1024 * 1024) { feil("Sikkerhetskopien er for stor. Velg en JSON-fil under 30 MB."); return; }
      fil.text().then(tekst => {
        const data = JSON.parse(tekst); if (!aktiv) return;
        return bekreft("Legg tilbake dokumentene fra denne sikkerhetskopien? Bare dokumenter som ikke allerede finnes, kan gjenopprettes.", async () => {
          await lagre(); await Brev.importerData(data); if (!aktiv) return;
          const svar = await Promise.all([Brev.hentCv(), Brev.hentBrev(id)]); if (!aktiv) return;
          [cv, dokument] = svar; endring = lagret = cvEndring = cvLagret = 0; fyllCv(); fyllDokument();
          stil = null; await lastStil(); lastDokument();
          melding("Sikkerhetskopien er gjenopprettet.");
        });
      }).catch(e => feil(e instanceof SyntaxError ? "Filen inneholder ikke gyldig JSON." : e));
    }
  });
  const slipp = finn("#brevCvRad");
  lytt(slipp, "dragover", hendelse => { hendelse.preventDefault(); if (!opptatt && dokument) slipp.classList.add("er-over"); });
  lytt(slipp, "dragleave", () => slipp.classList.remove("er-over"));
  lytt(slipp, "drop", hendelse => { hendelse.preventDefault(); slipp.classList.remove("er-over"); if (!opptatt && dokument) lesFil(hendelse.dataTransfer?.files?.[0]); });
  const førAvreise = hendelse => { if (endring !== lagret || cvEndring !== cvLagret || stilEndret) { hendelse.preventDefault(); hendelse.returnValue = ""; } };
  window.addEventListener("beforeunload", førAvreise, { signal: liv.signal });
  /* Ny bredde gir nye linjeskift, og dermed ny høyde på papiret. */
  let papirbredde = 0;
  const måler = new ResizeObserver(([måling]) => {
    const bredde = Math.round(måling.contentRect.width);
    if (bredde !== papirbredde) { papirbredde = bredde; tilpassPapir(); }
  });
  måler.observe(finn(".brev__papir"));
  liv.signal.addEventListener("abort", () => måler.disconnect());

  const avmeldØkt = Økt.påUtlogget(() => { rydd(); påLukk(); });
  function rydd() {
    if (!aktiv) return;
    aktiv = false; arbeidsnr++; clearTimeout(ventetid); forespørsel?.abort(); liv.abort(); avmeldØkt();
    dokument = null; cv = null; stil = null;
    kropp.replaceChildren(); bunn.replaceChildren();
    kropp.classList.remove("skuff__kropp--brev"); bunn.classList.remove("skuff__bunn--brev", "har-brev");
  }
  /* Før fanen forlates: et kall som pågår avbrytes, brevet lagres, og en
     stilreferanse som er skrevet inn men ikke lagret, lagres også. */
  async function lukk() {
    if (!aktiv) return true;
    if (forespørsel) await avbryt();
    try {
      await lagre();
      if (stilEndret) { await lagreStil(); if (stilEndret) return false; }
      rydd(); return true;
    } catch (e) { feil(e); if (aktiv) finn("#brevLukkevalg").hidden = false; return false; }
  }
  /* Ny søknadstilstand eller nytt jobbdokument fra panelet, for eksempel
     når annonsen er hentet eller limt inn i Annonse-fanen. */
  function oppdater(ny) {
    if (!aktiv) return;
    const merke = () => harAnnonse() ? (annonsen().sjekksum || annonsen().tekst) : null;
    const før = merke();
    k = { ...ny, jobb: ny.jobb || k.jobb };
    const nå = merke();
    if (før && nå && før !== nå && dokument?.tekst) finn("#brevEndret").hidden = false;
    tegnAnnonse(); oppdaterKnapper();
  }
  async function hentGrunnlag() {
    const svar = await Promise.allSettled([Brev.hentCv(), Brev.hentBrev(id)]);
    if (!aktiv) return;
    const feilindeks = svar.findIndex(r => r.status === "rejected");
    if (feilindeks >= 0) {
      const e = svar[feilindeks].reason; feil(e); melding("Kunne ikke hente grunnlaget.");
      if (GJENOPPRETTBAR.includes(e.code)) { gjenoppretting = feilindeks === 0 ? "cv" : "brev"; finn("#brevGjenoppretting").hidden = false; }
      return;
    }
    [cv, dokument] = svar.map(r => r.value);
    if (!dokument.revisjon) dokument.leverandor = husketLeverandør();
    fyllCv(); fyllDokument(); settOpptatt(false);
    brukHensikt();
    const kjøring = dokument.kjoring;
    /* Et utkast som ble avbrutt mellom trinnene, fortsetter der det
       stoppet. Trinn som er gjort, koster ikke et nytt modellkall. */
    if (kjøring && VENTENDE.has(kjøring.status)) {
      arbeid = kjøring.instruks ? forbedre(kjøring.instruks) : lagUtkast({ gjenoppta: true });
    } else if (kjøring && I_ARBEID.has(kjøring.status)) {
      blokkert = true;
      finn('[data-brev="stopp"]').textContent = "Avbryt forrige kjøring";
      settOpptatt(false, "Et tidligere utkast er under arbeid. Avbryt det før du skriver på nytt.");
    }
    visNøkkel();
  }
  tegnAnnonse(); tegnStil();
  hentGrunnlag().catch(feil);
  return { lukk, rydd, oppdater, fokuser: brukHensikt };
}
