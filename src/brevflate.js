/* Brevets arbeidsflate. DOM-en blir stående mens teksten lagres, slik at
   markør, tekstvalg og nettleserens angrehistorikk overlever hvert tastetrykk. */
import * as Brev from "./brev.js";
import * as Økt from "./okt.js";
import { lesCvFil, eksporterBrev, lagreFil } from "./brev-dokumenter.mjs";

const esc = verdi => String(verdi ?? "").replace(/[&<>"']/g, tegn => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[tegn]));
const tidspunkt = verdi => {
  const dato = new Date(verdi);
  return Number.isNaN(dato.getTime()) ? "" : dato.toLocaleString("nb-NO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

export function åpneBrevflate({ jobb, navn = "", kropp, bunn, påLukk }) {
  const liv = new AbortController();
  const profil = Økt.nåværendeBruker()?.id;
  const leverandørnøkkel = profil ? `jobbsoknader-brev-leverandor-${profil}` : null;
  const huskLeverandør = verdi => { try { if (leverandørnøkkel) localStorage.setItem(leverandørnøkkel, verdi); } catch {} };
  const husketLeverandør = () => { try { return leverandørnøkkel && localStorage.getItem(leverandørnøkkel) === "openai" ? "openai" : "anthropic"; } catch { return "anthropic"; } };
  let dokument = null, cv = null, aktiv = true, opptatt = false;
  let endring = 0, lagret = 0, cvEndring = 0, cvLagret = 0, lagring = null, ventetid;
  let forespørsel = null, kjøring = null, arbeidsnr = 0, modellarbeid = false;
  let gjenoppretting = null, arbeid = null;
  const finn = velger => kropp.querySelector(velger) || bunn.querySelector(velger);
  const lytt = (element, type, funksjon) => element.addEventListener(type, funksjon, { signal: liv.signal });

  kropp.classList.add("skuff__kropp--brev");
  bunn.classList.add("skuff__bunn--brev");
  kropp.innerHTML = `
    <div class="brev__topprad">
      <p class="brev__jobb">${esc(jobb.stilling)} <span>hos ${esc(jobb.selskap)}</span></p>
      <button class="knapp knapp--stille brev__panelknapp" type="button" data-brev="innstillinger" aria-expanded="false" aria-controls="brevInnstillinger">Innstillinger</button>
    </div>
    <div class="brev__flytrad">
      <ol class="brev__flyt" id="brevFlyt" aria-label="Slik blir brevet til">
        <li class="brev__steg" data-steg="analyse" data-tilstand="kommende"><span class="brev__steg__navn">Leser grunnlaget</span><span class="brev__steg__mikro"><span class="skjult">Gjenstår</span></span></li>
        <li class="brev__steg" data-steg="avklaring" data-tilstand="kommende"><span class="brev__steg__navn">Avklaring</span><span class="brev__steg__mikro"><span class="skjult">Gjenstår, hvis modellen har spørsmål</span></span></li>
        <li class="brev__steg" data-steg="skriv" data-tilstand="kommende"><span class="brev__steg__navn">Skriver brevet</span><span class="brev__steg__mikro"><span class="skjult">Gjenstår</span></span></li>
      </ol>
      <button class="knapp knapp--stille brev__avbryt" type="button" data-brev="stopp" hidden>Avbryt</button>
    </div>
    <p class="brev__tilbakemelding" role="status" aria-live="polite"><span id="brevStatus">Henter grunnlaget…</span></p>
    <div class="brev__feil" id="brevFeil" role="alert" hidden></div>
    <div class="brev__gjenoppretting" id="brevGjenoppretting" hidden><button class="knapp" type="button" data-brev="gjenopprett">Gjenopprett forrige lagring</button><p class="felt__hjelp">Den forrige lokale sikkerhetskopien brukes. Originalfilen blir bevart.</p></div>
    <div class="brev__lukkevalg" id="brevLukkevalg" hidden><p>Endringene er ikke lagret. Prøv igjen, eller kopier brevet før du lukker.</p><div class="brev__småhandlinger"><button class="knapp" type="button" data-brev="prøv">Prøv å lagre</button><button class="knapp" type="button" data-brev="hentLagret">Hent lagret versjon</button><button class="knapp knapp--fare" type="button" data-brev="forkast">Lukk uten å lagre</button></div></div>
    <div class="modus brev__faner" role="tablist" aria-label="Arbeidsflate">
      <button class="modus__knapp" id="brevGrunnlagFane" type="button" role="tab" aria-selected="true" aria-controls="brevGrunnlag" data-brev="fane" data-fane="grunnlag">Grunnlag</button>
      <button class="modus__knapp" id="brevTekstFane" type="button" role="tab" aria-selected="false" aria-controls="brevSkriveflate" data-brev="fane" data-fane="brev" tabindex="-1">Søknadsbrev</button>
    </div>
    <div class="brev" data-fane="grunnlag" data-panel="kilder" aria-busy="true">
      <section class="brev__grunnlag" id="brevGrunnlag" role="tabpanel" aria-labelledby="brevGrunnlagFane">
        <fieldset class="brev__felter" id="brevGrunnlagsfelter" disabled>
          <legend class="skjult">Grunnlag for søknadsbrevet</legend>
          <section class="brev__avsnitt">
            <div class="brev__seksjonsrad"><h3>Din CV</h3><span class="brev__sekundar">Gjenbrukes på profilen din</span></div>
            <label class="brev__filvalg" for="brevCvFil" id="brevCvSlipp"><span class="brev__filnavn" id="brevCvNavn">Velg CV</span><span class="brev__sekundar">PDF, Word eller tekst. Du kan også slippe filen her.</span><input id="brevCvFil" type="file" accept=".pdf,.docx,.txt,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"></label>
            <details class="brev__detaljer" id="brevCvDetaljer"><summary>Se eller lim inn CV-tekst</summary><label class="skjult" for="brevCvTekst">CV-tekst</label><textarea class="felt__omr brev__kildetekst" id="brevCvTekst" maxlength="100000" placeholder="Lim inn teksten fra CV-en din"></textarea><p class="felt__hjelp">Se over teksten før du bruker den. Skannede dokumenter må limes inn som tekst.</p></details>
          </section>
          <section class="brev__avsnitt">
            <h3>Stillingsannonse</h3>
            <label class="skjult" for="brevAnnonseUrl">Lenke til stillingsannonsen</label><div class="brev__lenkerad"><input class="felt__inn" id="brevAnnonseUrl" type="url" placeholder="Lenke til annonsen" autocomplete="off"><button class="knapp" type="button" data-brev="hent">Hent</button></div>
            <details class="brev__detaljer" id="brevAnnonseDetaljer"><summary id="brevAnnonseSammendrag">Lim inn annonsetekst</summary><label class="skjult" for="brevAnnonseTekst">Annonsetekst</label><textarea class="felt__omr brev__kildetekst" id="brevAnnonseTekst" maxlength="100000" placeholder="Lim inn hele annonsen"></textarea></details>
          </section>
          <section class="brev__avsnitt">
            <label class="brev__felttittel" for="brevKontekst">Litt om deg og denne jobben <span>Valgfritt</span></label>
            <textarea class="felt__omr brev__kontekst" id="brevKontekst" maxlength="10000" placeholder="Hva tiltrekker deg ved jobben? Er det erfaringer eller ønsker brevet bør ta hensyn til?"></textarea>
          </section>
          <section class="brev__avsnitt brev__avsnitt--smal">
            <label class="felt__merke" for="brevSprak">Språk</label>
            <select class="felt__inn" id="brevSprak"><option value="auto">Automatisk</option><option value="nb">Norsk bokmål</option><option value="nn">Norsk nynorsk</option><option value="en">Engelsk</option><option value="sv">Svensk</option><option value="da">Dansk</option><option value="de">Tysk</option><option value="fr">Fransk</option></select>
            <p class="felt__hjelp" id="brevSprakhjelp">Automatisk følger annonsens språk og eventuelle språkønsker du oppgir.</p>
          </section>
        </fieldset>
        <div class="brev__skriv">
          <div class="brev__mangler" id="brevNokkelvarsel" hidden><p id="brevNokkelmangel">Du mangler API-nøkkel.</p><button class="knapp" type="button" data-brev="tilNøkkel">Legg til nøkkel</button></div>
          <p class="felt__hjelp">CV-en, annonsen og konteksten sendes til leverandøren du har valgt.</p>
        </div>
      </section>
      <section class="brev__innstillinger" id="brevInnstillinger" aria-labelledby="brevInnstillingerTittel" hidden>
        <h3 id="brevInnstillingerTittel">Innstillinger</h3>
        <section class="brev__avsnitt brev__avsnitt--smal">
          <label class="felt__merke" for="brevLeverandor">Skriv med</label>
          <select class="felt__inn" id="brevLeverandor"><option value="anthropic">Claude</option><option value="openai">OpenAI</option></select>
          <p class="felt__hjelp">Valget huskes på profilen din. Hver leverandør har sin egen nøkkel.</p>
        </section>
        <section class="brev__avsnitt">
          <label class="felt__merke" for="brevNokkel">API-nøkkel for valgt leverandør</label>
          <input class="felt__inn" id="brevNokkel" type="password" autocomplete="off" spellcheck="false">
          <p class="felt__hjelp" id="brevNokkelstatus">Henter nøkkelstatus…</p>
          <div class="brev__småhandlinger"><button class="knapp" type="button" data-brev="nøkkel">Lagre nøkkel</button><button class="knapp knapp--stille" type="button" data-brev="fjernNøkkel" hidden>Fjern nøkkel</button></div>
        </section>
        <section class="brev__datahandlinger">
          <h4>Dataene dine</h4>
          <button class="knapp knapp--stille" type="button" data-brev="backup">Last ned sikkerhetskopi</button>
          <label class="brev__importvalg">Gjenopprett fra sikkerhetskopi<input id="brevImporter" type="file" accept=".json,application/json"></label>
          <p class="felt__hjelp">Sikkerhetskopien inneholder CV, brev og grunnlag. API-nøkler følger ikke med.</p>
          <button class="knapp knapp--stille knapp--fare" type="button" data-brev="slettCv">Slett CV fra profilen</button>
          <button class="knapp knapp--stille knapp--fare" type="button" data-brev="slettBrev">Slett brevet og versjonene</button>
        </section>
      </section>
      <section class="brev__skriveflate" id="brevSkriveflate" role="tabpanel" aria-labelledby="brevTekstFane">
        <div class="brev__verktoylinje"><label class="skjult" for="brevVersjon">Brevversjon</label><select class="brev__versjon" id="brevVersjon" disabled><option>Første utkast</option></select><span class="brev__lagret" id="brevLagret" role="status" aria-live="polite"></span></div>
        <p class="brev__endret" id="brevEndret" hidden>Grunnlaget er endret siden denne versjonen.</p>
        <div class="brev__papir">
          <label class="skjult" for="brevTekst">Søknadsbrevet ditt</label>
          <textarea class="brev__tekst" id="brevTekst" maxlength="16000" spellcheck="true" disabled placeholder="Brevet vises her.\n\nLegg til CV og stillingsannonse, så skriver vi et utkast du kan gjøre til ditt eget."></textarea>
          <div class="brev__strom" id="brevStrom" aria-hidden="true" hidden><span id="brevStromTekst"></span><span class="brev__markor"></span></div>
          <section class="brev__avklaring" id="brevSporsmal" aria-labelledby="brevAvklaringstittel" hidden>
            <h3 id="brevAvklaringstittel">Vil du legge til noe før brevet skrives?</h3>
            <p class="brev__begrunnelse" id="brevBegrunnelse" hidden></p>
            <p class="felt__hjelp">Svar på det du vil. Brevet blir skrevet uansett.</p>
            <div id="brevSporsmalsfelt"></div>
            <div class="brev__småhandlinger"><button class="knapp knapp--primar" type="button" data-brev="svar">Skriv med svarene</button><button class="knapp knapp--stille" type="button" data-brev="hopp">Hopp over og skriv</button></div>
          </section>
        </div>
        <div class="brev__forbedring" id="brevForbedring" hidden><label class="felt__merke" for="brevInstruks">Hva vil du forbedre?</label><div class="brev__forbedringsrad"><textarea class="felt__omr" id="brevInstruks" maxlength="2000" rows="2" placeholder="For eksempel: Gjør åpningen mer konkret"></textarea><button class="knapp" type="button" data-brev="forbedre">Lag ny versjon</button></div><p class="felt__hjelp">Tar utgangspunkt i teksten du ser nå. Tidligere versjoner beholdes.</p></div>
      </section>
    </div>`;
  bunn.innerHTML = `<button class="knapp knapp--primar brev__generer" type="button" data-brev="skriv" disabled>Skriv utkast</button><span class="brev__ord" id="brevOrd"></span><span class="brev__kopistatus" id="brevKopistatus" role="status" aria-live="polite"></span><button class="knapp" type="button" data-brev="kopier" disabled>Kopier brev</button><details class="brev__nedlasting"><summary class="knapp knapp--primar">Last ned <span aria-hidden="true">⌄</span></summary><div class="brev__meny"><button type="button" data-brev="docx" disabled>Word (.docx)</button><button type="button" data-brev="pdf" disabled>PDF (.pdf)</button></div></details>`;

  function melding(tekst = "") { if (aktiv) finn("#brevStatus").textContent = tekst; }
  function feil(feilen) {
    if (!aktiv || feilen?.name === "AbortError") return;
    finn("#brevFeil").textContent = feilen?.melding || feilen?.message || String(feilen);
    finn("#brevFeil").hidden = false;
  }
  function ryddFeil() { finn("#brevFeil").hidden = true; }

  /* ---- fremdriftsraden ----
     Modellens tre faser (analyse, skriv, kontroller) er ikke de tre stegene
     brukeren har et forhold til. Kontrollen er ikke et eget steg, den er
     slutten av skrivingen; avklaringen er ikke en modellfase, men den er
     det eneste steget som krever noe av brukeren. Raden viser derfor
     flyten slik den oppleves, og mikrolinjen under hvert navn sier hva
     som faktisk skjer der akkurat nå. */
  const STEG = ["analyse", "avklaring", "skriv"];
  const steget = steg => finn(`[data-steg="${steg}"]`);
  function settSteg(steg, tilstand, mikro = "") {
    const element = steget(steg); if (!element) return;
    element.dataset.tilstand = tilstand;
    element.querySelector(".brev__steg__mikro").innerHTML = mikro ? esc(mikro) : '<span class="skjult">Gjenstår</span>';
  }
  function flytKlar() { STEG.forEach(steg => settSteg(steg, "kommende")); }
  /* Et avbrudd eller en feil skal etterlate raden ærlig: steget som var i
     arbeid sier at det stoppet, resten står som de sto. */
  function flytStoppet() { STEG.forEach(steg => { if (steget(steg)?.dataset.tilstand === "aktiv") settSteg(steg, "stoppet", "stoppet"); }); }
  function påFase({ trinn, nullstill }, tekster = {}) {
    if (nullstill) strømTøm();
    if (trinn === "analyse") settSteg("analyse", "aktiv", "leser");
    else if (trinn === "skriv") {
      /* Ble analysen gjenbrukt, fyrte fasen aldri. Raden sier det rett ut
         i stedet for å late som steget ikke fantes. */
      settSteg("analyse", "ferdig", steget("analyse")?.dataset.tilstand === "kommende" ? "gjenbrukt" : "ferdig");
      if (steget("avklaring")?.dataset.tilstand === "kommende") settSteg("avklaring", "ferdig", "ingen spørsmål");
      settSteg("skriv", "aktiv", "skriver");
    } else if (trinn === "kontroller") settSteg("skriv", "aktiv", "leser gjennom");
    melding(tekster[trinn] || "");
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
    if (strømAv || !tekst || finn(".brev").classList.contains("avklarer")) return;
    const flate = finn("#brevStrom");
    /* Et gjenopptatt trinn gir fase uten deltaer. Flaten avsløres derfor
       først når det finnes noe å vise. */
    if (flate.hidden) { flate.hidden = false; flate.scrollTop = 0; strømFølger = true; }
    finn("#brevStromTekst").textContent += tekst;
    if (strømFølger) flate.scrollTop = flate.scrollHeight;
  }
  /* Papiret tilhører brukeren. Rører hen teksten sin mens modellen skriver,
     trekker forhåndsvisningen seg for resten av kjøringen. */
  function strømOverta() { if (!finn("#brevStrom").hidden) { strømAv = true; strømSkjul(); } }
  function lagMelder(nummer, tekster) {
    return {
      påFase: fase => { if (nummer === arbeidsnr) påFase(fase, tekster); },
      påDelta: tekst => { if (nummer === arbeidsnr) strømTillegg(tekst); }
    };
  }

  function settFane(fane, fokuser = false) {
    finn(".brev").dataset.fane = fane;
    kropp.querySelectorAll('[data-brev="fane"]').forEach(knapp => {
      const valgt = knapp.dataset.fane === fane;
      knapp.setAttribute("aria-selected", String(valgt)); knapp.tabIndex = valgt ? 0 : -1;
      if (fokuser && valgt) knapp.focus();
    });
  }
  function oppdaterOrd() {
    const tekst = finn("#brevTekst").value.trim();
    bunn.classList.toggle("har-brev", !!tekst);
    finn('[data-brev="skriv"]').textContent = tekst ? "Skriv nytt utkast" : "Skriv utkast";
    finn('[data-brev="skriv"]').classList.toggle("knapp--primar", !tekst);
    finn("#brevOrd").textContent = tekst ? `${tekst.split(/\s+/u).length} ord` : "";
    ["kopier", "docx", "pdf"].forEach(handling => finn(`[data-brev="${handling}"]`).disabled = !tekst || (opptatt && handling !== "kopier"));
    finn("#brevForbedring").hidden = !tekst;
  }
  function settOpptatt(verdi, tekst = "") {
    if (!aktiv) return;
    opptatt = verdi; melding(tekst);
    finn(".brev").setAttribute("aria-busy", String(verdi));
    finn("#brevGrunnlagsfelter").disabled = verdi || !dokument;
    /* Leverandøren ligger i innstillingspanelet og er utenfor feltgruppa,
       men den kan ikke byttes mens et kall er underveis. */
    finn("#brevLeverandor").disabled = verdi || !dokument;
    finn("#brevTekst").disabled = !dokument;
    finn("#brevInstruks").disabled = verdi;
    finn("#brevVersjon").disabled = verdi || !dokument?.versjoner?.length;
    ["skriv", "forbedre", "svar", "hopp"].forEach(handling => finn(`[data-brev="${handling}"]`).disabled = verdi || !dokument);
    finn('[data-brev="stopp"]').hidden = !verdi || !forespørsel;
    oppdaterOrd();
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
    finn("#brevAnnonseUrl").value = dokument.annonse?.url || jobb.lenke || "";
    finn("#brevAnnonseTekst").value = dokument.annonse?.tekst || "";
    finn("#brevAnnonseSammendrag").textContent = dokument.annonse?.tekst ? "Se eller endre annonseteksten" : "Lim inn annonsetekst";
    finn("#brevKontekst").value = dokument.kontekst || "";
    const språk = dokument.sprak || "auto";
    if (![...finn("#brevSprak").options].some(valg => valg.value === språk)) finn("#brevSprak").add(new Option(språk, språk));
    finn("#brevSprak").value = språk;
    finn("#brevLeverandor").value = dokument.leverandor || "anthropic";
    finn("#brevTekst").value = dokument.tekst || "";
    finn("#brevTekst").lang = dokument.versjoner?.find(v => v.id === dokument.aktivVersjon)?.sprak || (språk === "auto" ? "" : språk);
    fyllVersjoner(); oppdaterOrd();
  }
  function fyllCv() {
    finn("#brevCvTekst").value = cv?.tekst || "";
    finn("#brevCvNavn").textContent = cv?.tekst ? (cv.navn || "CV lagt inn som tekst") : "Velg CV";
  }
  const leverandørnavn = () => finn("#brevLeverandor").selectedOptions[0]?.textContent || "leverandøren";
  /* Nøkkelen bor i innstillingspanelet, men mangler den, stopper skrivingen.
     Kildekolonnen sier det derfor rett ut og peker på panelet, i stedet for
     at brukeren skal finne fram til det selv. */
  function visNøkkelmangel(mangler) {
    finn("#brevNokkelvarsel").hidden = !mangler;
    if (mangler) finn("#brevNokkelmangel").textContent = `Du mangler API-nøkkel for ${leverandørnavn()}. Brevet kan ikke skrives uten.`;
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
  /* Panelet heter data-panel og ikke data-visning med vilje: app.js har en
     delegert lytter på [data-visning] for hovednavigasjonen, og et hvilket
     som helst klikk inne i skuffen ville boblet opp og byttet side. */
  function visInnstillinger(åpen, fokuser = true) {
    const knapp = finn('[data-brev="innstillinger"]');
    finn(".brev").dataset.panel = åpen ? "innstillinger" : "kilder";
    finn("#brevInnstillinger").hidden = !åpen;
    knapp.setAttribute("aria-expanded", String(åpen));
    knapp.textContent = åpen ? "Lukk innstillinger" : "Innstillinger";
    if (!fokuser) return;
    if (åpen) finn("#brevLeverandor").focus(); else knapp.focus();
  }
  function endret(erGrunnlag = false) {
    endring++;
    if (erGrunnlag && dokument?.tekst) finn("#brevEndret").hidden = false;
    finn("#brevLagret").textContent = "Ikke lagret";
    clearTimeout(ventetid);
    if (!modellarbeid) ventetid = setTimeout(() => lagre().catch(feil), 700);
  }
  function lesDokument() {
    return { ...dokument, annonse: { ...dokument.annonse, url: finn("#brevAnnonseUrl").value.trim(), tekst: finn("#brevAnnonseTekst").value }, kontekst: finn("#brevKontekst").value, sprak: finn("#brevSprak").value, leverandor: finn("#brevLeverandor").value, tekst: finn("#brevTekst").value };
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
          const svar = await Brev.lagreBrev(jobb.id, lesDokument());
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
    oppdaterOrd();
    if (manuelt) await lagre();
    return manuelt || resultat.kjoring?.nyttForslag;
  }
  async function ferskRevisjon() {
    try {
      const fersk = await Brev.hentBrev(jobb.id);
      if (aktiv) dokument = { ...dokument, revisjon: fersk.revisjon, kjoring: fersk.kjoring, versjoner: fersk.versjoner };
    } catch (e) { feil(e); }
  }
  async function lesFil(fil) {
    if (!fil || opptatt) return;
    settOpptatt(true, "Leser CV-en…"); ryddFeil();
    try {
      const lest = await lesCvFil(fil);
      if (!aktiv) return;
      cv = { ...cv, ...lest }; fyllCv(); cvEndring++; endret(true); await lagre(); melding("CV-en er klar. Se gjerne over den innleste teksten.");
    } catch (e) { feil(e); }
    finally { if (aktiv) settOpptatt(false, finn("#brevStatus").textContent === "Leser CV-en…" ? "" : finn("#brevStatus").textContent); }
  }
  function svarene() {
    return Object.fromEntries([...kropp.querySelectorAll("[data-sporsmal]")].map(felt => [felt.dataset.sporsmal, felt.value.trim()]));
  }
  /* Avklaringen dekker papiret. Brevfeltet under er fortsatt et felt, så
     det tas ut av fokusrekken mens laget står der; ellers kunne tabulator
     føre markøren inn i en tekst ingen ser. */
  function lukkAvklaring() {
    finn("#brevSporsmal").hidden = true;
    finn(".brev").classList.remove("avklarer");
    finn("#brevTekst").removeAttribute("inert");
  }
  async function avbryt() {
    arbeidsnr++; forespørsel?.abort();
    const id = kjøring; kjøring = null;
    lukkAvklaring(); strømSkjul(); flytStoppet();
    if (id) { try { await Brev.avbryt(jobb.id, id); } catch (e) { if (aktiv) feil(e); } }
    if (arbeid) await arbeid.catch(() => {});
    if (aktiv) await ferskRevisjon();
    modellarbeid = false;
    if (aktiv) settOpptatt(false, "Skrivingen er avbrutt. Grunnlaget og tidligere brev er beholdt.");
  }
  async function skriv(svar = {}) {
    if (!kjøring) return;
    const nummer = arbeidsnr;
    modellarbeid = true; strømAv = false;
    if (steget("avklaring")?.dataset.tilstand === "aktiv") settSteg("avklaring", "ferdig", Object.values(svar).some(Boolean) ? "besvart" : "hoppet over");
    lukkAvklaring();
    settOpptatt(true, "Skriver teksten…");
    const mitt = kjøring;
    try {
      const resultat = await Brev.skriv(jobb.id, mitt, svar,
        { signal: forespørsel.signal, ...lagMelder(nummer, { skriv: "Skriver teksten…", kontroller: "Leser gjennom teksten…" }) });
      if (!aktiv || nummer !== arbeidsnr) return;
      const beholdt = await taImot(resultat);
      if (!aktiv || nummer !== arbeidsnr) return;
      /* Først når den ferdige teksten står i feltet trekkes laget over den
         bort. Typografien er den samme, så ingen linje flytter seg. */
      strømSkjul(); settSteg("skriv", "ferdig", "ferdig");
      finn("#brevEndret").hidden = true;
      settFane("brev");
      melding(beholdt ? "Endringene dine er beholdt. Det nye forslaget ligger i versjonslisten." : "Utkastet er klart. Les gjennom og gjør teksten til din egen.");
    } catch (e) { if (nummer === arbeidsnr) { strømSkjul(); flytStoppet(); feil(e); await ferskRevisjon(); melding("Skrivingen stoppet. Grunnlaget og tidligere brev er beholdt."); } }
    finally { if (nummer === arbeidsnr) { kjøring = null; modellarbeid = false; forespørsel = null; if (aktiv) { settOpptatt(false, finn("#brevStatus").textContent); if (endring !== lagret) lagre().catch(feil); } } }
  }
  async function start() {
    if (opptatt) return;
    ryddFeil();
    if (!finn("#brevCvTekst").value.trim()) { finn("#brevCvDetaljer").open = true; feil("Legg til CV-en din først."); settFane("grunnlag"); finn("#brevCvTekst").focus(); return; }
    if (!finn("#brevAnnonseTekst").value.trim()) { finn("#brevAnnonseDetaljer").open = true; feil("Hent annonsen eller lim inn annonseteksten først."); settFane("grunnlag"); finn("#brevAnnonseTekst").focus(); return; }
    const nummer = ++arbeidsnr;
    forespørsel = new AbortController(); modellarbeid = true; strømAv = false;
    flytKlar(); settFane("brev");
    settOpptatt(true, "Leser grunnlaget…");
    try {
      endring++; await lagre();
      if (!aktiv || nummer !== arbeidsnr) return;
      const resultat = await Brev.analyser(jobb.id, { signal: forespørsel.signal, ...lagMelder(nummer, { analyse: "Leser grunnlaget…" }) });
      if (!aktiv || nummer !== arbeidsnr) return;
      kjøring = resultat.id;
      if (resultat.dokument) dokument = { ...dokument, revisjon: resultat.dokument.revisjon, kjoring: resultat.dokument.kjoring };
      else await ferskRevisjon();
      if (!aktiv || nummer !== arbeidsnr) return;
      const analyse = resultat.analyse || {};
      if ((analyse.sporsmal || []).length) visSpørsmål(analyse);
      else await skriv();
    } catch (e) { if (nummer === arbeidsnr) { strømSkjul(); flytStoppet(); feil(e); await ferskRevisjon(); modellarbeid = false; if (aktiv) { settOpptatt(false); if (endring !== lagret) lagre().catch(feil); } } }
  }
  /* Avklaringen legger seg på papiret, der brevet ellers kommer. Steget står
     mellom brukeren og teksten, og skal stå der blikket allerede er. */
  function visSpørsmål(analyse, svar = {}, fokuser = true) {
    const spørsmål = (analyse.sporsmal || []).slice(0, 3);
    finn("#brevSporsmalsfelt").innerHTML = spørsmål.map((s, indeks) => `<div class="felt"><label class="felt__merke" for="brevSvar${indeks}">${esc(s.tekst)}</label><textarea class="felt__omr brev__svar" id="brevSvar${indeks}" data-sporsmal="${esc(s.id)}" maxlength="3000">${esc(svar[s.id] || "")}</textarea></div>`).join("");
    finn("#brevBegrunnelse").textContent = analyse.begrunnelse || "";
    finn("#brevBegrunnelse").hidden = !analyse.begrunnelse;
    strømSkjul();
    settSteg("analyse", "ferdig", "ferdig");
    settSteg("avklaring", "aktiv", spørsmål.length === 1 ? "1 spørsmål" : `${spørsmål.length} spørsmål`);
    finn(".brev").classList.add("avklarer");
    finn("#brevTekst").setAttribute("inert", "");
    finn("#brevSporsmal").hidden = false; settOpptatt(false, "Du kan legge til noen detaljer før brevet skrives.");
    settFane("brev");
    finn("#brevGrunnlagsfelter").disabled = true;
    finn("#brevVersjon").disabled = true;
    finn('[data-brev="forbedre"]').disabled = true;
    finn('[data-brev="stopp"]').hidden = false;
    finn('[data-brev="skriv"]').disabled = true;
    if (fokuser) finn("#brevSporsmalsfelt textarea")?.focus();
  }
  async function forbedre() {
    const instruks = finn("#brevInstruks").value.trim();
    if (!instruks) { feil("Skriv hva du vil forbedre først."); finn("#brevInstruks").focus(); return; }
    const nummer = ++arbeidsnr;
    forespørsel = new AbortController(); modellarbeid = true; strømAv = false;
    flytKlar(); settOpptatt(true, "Lager en ny versjon…");
    try {
      await lagre(); if (!aktiv || nummer !== arbeidsnr) return;
      const resultat = await Brev.forbedre(jobb.id, instruks,
        { signal: forespørsel.signal, ...lagMelder(nummer, { analyse: "Leser grunnlaget…", skriv: "Lager en ny versjon…", kontroller: "Leser gjennom teksten…" }) });
      if (!aktiv || nummer !== arbeidsnr) return;
      const beholdt = await taImot(resultat);
      if (!aktiv || nummer !== arbeidsnr) return;
      strømSkjul(); settSteg("skriv", "ferdig", "ferdig");
      finn("#brevInstruks").value = "";
      melding(beholdt ? "Endringene dine er beholdt. Det nye forslaget ligger i versjonslisten." : "En ny versjon er klar. Den forrige ligger i versjonslisten.");
    } catch (e) { if (nummer === arbeidsnr) { strømSkjul(); flytStoppet(); feil(e); await ferskRevisjon(); melding("Skrivingen stoppet. Teksten din er beholdt."); } }
    finally { if (nummer === arbeidsnr) { modellarbeid = false; forespørsel = null; if (aktiv) { settOpptatt(false, finn("#brevStatus").textContent); if (endring !== lagret) lagre().catch(feil); } } }
  }
  async function bekreft(tekst, handling) {
    const område = finn("#brevFeil"); område.hidden = false;
    område.innerHTML = `<p>${esc(tekst)}</p><div class="brev__småhandlinger"><button class="knapp knapp--fare" type="button" id="brevBekreft">Bekreft</button><button class="knapp knapp--stille" type="button" id="brevAvstå">Avbryt</button></div>`;
    finn("#brevBekreft").onclick = async () => { ryddFeil(); try { await handling(); } catch (e) { feil(e); } };
    finn("#brevAvstå").onclick = ryddFeil;
    finn("#brevAvstå").focus();
  }
  async function handle(handling) {
    if (handling === "fane") return;
    if (handling === "stopp") return avbryt();
    if (handling === "forkast") { rydd(); påLukk(); return; }
    if (handling === "innstillinger") { visInnstillinger(finn(".brev").dataset.panel !== "innstillinger"); return; }
    if (handling === "tilNøkkel") { visInnstillinger(true, false); finn("#brevNokkel").focus(); return; }
    if (handling === "gjenopprett") {
      if (!gjenoppretting) return;
      return bekreft("Bruk forrige lokale lagring av dette dokumentet? Den uleselige originalen blir bevart.", async () => {
        if (gjenoppretting === "cv") await Brev.gjenopprettCv(); else await Brev.gjenopprettBrev(jobb.id);
        if (!aktiv) return; finn("#brevGjenoppretting").hidden = true; await hentGrunnlag();
      });
    }
    if (!dokument) return;
    if (handling === "prøv") { ryddFeil(); await lagre(); return; }
    if (handling === "hentLagret") {
      return bekreft("Hent den lagrede CV-en og brevet på nytt? Ulagrede endringer i denne flaten går tapt. Kopier teksten først hvis du vil beholde den.", async () => {
        clearTimeout(ventetid);
        const svar = await Promise.all([Brev.hentCv(), Brev.hentBrev(jobb.id)]);
        if (!aktiv) return;
        [cv, dokument] = svar; endring = lagret = cvEndring = cvLagret = 0;
        fyllCv(); fyllDokument(); finn("#brevLukkevalg").hidden = true;
        finn("#brevLagret").textContent = "Lagret"; melding("Den lagrede versjonen er hentet.");
      });
    }
    if (handling === "skriv") { arbeid = start(); return arbeid; }
    if (handling === "svar") { arbeid = skriv(svarene()); return arbeid; }
    if (handling === "hopp") { arbeid = skriv(); return arbeid; }
    if (handling === "forbedre") { arbeid = forbedre(); return arbeid; }
    if (opptatt && handling !== "kopier") return;
    ryddFeil();
    if (handling === "hent") {
      const url = finn("#brevAnnonseUrl").value.trim();
      if (!url) { feil("Lim inn lenken til annonsen først."); finn("#brevAnnonseUrl").focus(); return; }
      settOpptatt(true, "Henter stillingsannonsen…");
      try { const annonse = await Brev.hentAnnonse(url); if (!aktiv) return; dokument.annonse = annonse; finn("#brevAnnonseTekst").value = annonse.tekst; finn("#brevAnnonseSammendrag").textContent = "Se eller endre annonseteksten"; endret(true); await lagre(); }
      finally { if (aktiv) settOpptatt(false); }
    } else if (handling === "nøkkel") {
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
      await eksporterBrev({ tekst: finn("#brevTekst").value, stilling: jobb.stilling, selskap: jobb.selskap, navn }, handling);
      if (aktiv) finn(".brev__nedlasting").open = false;
    } else if (handling === "backup") {
      await lagre(); if (!aktiv) return;
      const data = await Brev.eksporterData(); if (!aktiv) return;
      await lagreFil({ bytes: new TextEncoder().encode(JSON.stringify(data, null, 2)), mime: "application/json", navn: "soknadsbrev-sikkerhetskopi.json" });
    } else if (handling === "slettCv") {
      await bekreft("Slett CV-en fra profilen? Tidligere brev og kildegrunnlaget i versjonene blir beholdt.", async () => { await lagre(); await Brev.slettCv(cv?.revisjon); if (!aktiv) return; cv = await Brev.hentCv(); if (!aktiv) return; cvEndring = cvLagret = 0; fyllCv(); melding("CV-en er slettet fra profilen."); });
    } else if (handling === "slettBrev") {
      await bekreft("Slett brevet, alle versjoner og grunnlaget for denne jobben? Dette kan ikke angres. CV-en på profilen beholdes.", async () => { await lagre(); await Brev.slettBrev(jobb.id, dokument.revisjon); if (!aktiv) return; dokument = await Brev.hentBrev(jobb.id); if (!aktiv) return; endring = lagret = 0; fyllDokument(); melding("Brevet og versjonene er slettet."); });
    }
  }
  for (const område of [kropp, bunn]) lytt(område, "click", hendelse => {
    const knapp = hendelse.target.closest("[data-brev]");
    if (!knapp || knapp.disabled) return;
    if (knapp.dataset.brev === "fane") { settFane(knapp.dataset.fane); return; }
    handle(knapp.dataset.brev).catch(feil);
  });
  lytt(kropp, "keydown", hendelse => {
    const fane = hendelse.target.closest('[data-brev="fane"]');
    if (!fane || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(hendelse.key)) return;
    hendelse.preventDefault(); settFane(hendelse.key === "Home" ? "grunnlag" : hendelse.key === "End" ? "brev" : fane.dataset.fane === "brev" ? "grunnlag" : "brev", true);
  });
  lytt(kropp, "input", hendelse => {
    if (!dokument || (opptatt && hendelse.target.id !== "brevTekst")) return;
    const id = hendelse.target.id;
    if (id === "brevCvTekst") { cvEndring++; if (!cv?.navn) cv = { ...cv, navn: "CV", format: "tekst" }; finn("#brevCvNavn").textContent = "CV lagt inn som tekst"; endret(true); }
    else if (["brevAnnonseUrl", "brevAnnonseTekst", "brevKontekst"].includes(id)) endret(true);
    else if (id === "brevTekst") { strømOverta(); endret(); oppdaterOrd(); finn("#brevKopistatus").textContent = ""; }
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
    const id = hendelse.target.id;
    if (id === "brevCvFil") { lesFil(hendelse.target.files?.[0]); hendelse.target.value = ""; }
    if (id === "brevLeverandor" || id === "brevSprak") { endret(true); if (id === "brevLeverandor") { huskLeverandør(hendelse.target.value); finn("#brevNokkel").value = ""; visNøkkel(); } }
    if (id === "brevVersjon") {
      const valgt = hendelse.target.value;
      lagre().then(() => {
        if (!aktiv) return;
        const versjon = dokument.versjoner?.find(v => v.id === valgt); if (!versjon) return;
        if (dokument.tekst && !dokument.versjoner.some(v => v.tekst === dokument.tekst)) {
          if (dokument.versjoner.length >= 100) throw new Error("Historikken er full. Ta en sikkerhetskopi før du bytter versjon.");
          const forrige = dokument.versjoner.find(v => v.id === dokument.aktivVersjon);
          dokument.versjoner.push({ ...forrige, id: crypto.randomUUID(), tekst: dokument.tekst, opprettet: new Date().toISOString(), manuell: true });
        }
        dokument.aktivVersjon = valgt; finn("#brevTekst").value = versjon.tekst; finn("#brevTekst").lang = versjon.sprak || ""; endret(); oppdaterOrd();
        fyllVersjoner();
      }).catch(feil);
    }
    if (id === "brevImporter") {
      const fil = hendelse.target.files?.[0]; hendelse.target.value = ""; if (!fil) return;
      if (fil.size > 30 * 1024 * 1024) { feil("Sikkerhetskopien er for stor. Velg en JSON-fil under 30 MB."); return; }
      fil.text().then(tekst => {
        const data = JSON.parse(tekst); if (!aktiv) return;
        return bekreft("Legg tilbake CV og søknadsbrev fra denne sikkerhetskopien? Bare dokumenter som ikke allerede finnes, kan gjenopprettes.", async () => {
          await lagre(); await Brev.importerData(data); if (!aktiv) return;
          const svar = await Promise.all([Brev.hentCv(), Brev.hentBrev(jobb.id)]); if (!aktiv) return;
          [cv, dokument] = svar; endring = lagret = cvEndring = cvLagret = 0; fyllCv(); fyllDokument(); melding("Sikkerhetskopien er gjenopprettet.");
        });
      }).catch(e => feil(e instanceof SyntaxError ? "Filen inneholder ikke gyldig JSON." : e));
    }
  });
  const slipp = finn("#brevCvSlipp");
  lytt(slipp, "dragover", hendelse => { hendelse.preventDefault(); if (!opptatt) slipp.classList.add("er-over"); });
  lytt(slipp, "dragleave", () => slipp.classList.remove("er-over"));
  lytt(slipp, "drop", hendelse => { hendelse.preventDefault(); slipp.classList.remove("er-over"); if (!opptatt) lesFil(hendelse.dataTransfer?.files?.[0]); });
  const førAvreise = hendelse => { if (endring !== lagret || cvEndring !== cvLagret) { hendelse.preventDefault(); hendelse.returnValue = ""; } };
  window.addEventListener("beforeunload", førAvreise, { signal: liv.signal });

  const avmeldØkt = Økt.påUtlogget(() => { rydd(); påLukk(); });
  function rydd() {
    if (!aktiv) return;
    aktiv = false; arbeidsnr++; clearTimeout(ventetid); forespørsel?.abort(); liv.abort(); avmeldØkt();
    dokument = null; cv = null; kjøring = null;
    kropp.replaceChildren(); bunn.replaceChildren();
    kropp.classList.remove("skuff__kropp--brev"); bunn.classList.remove("skuff__bunn--brev");
  }
  async function lukk() {
    if (!aktiv) return true;
    if (forespørsel || kjøring) await avbryt();
    try { await lagre(); rydd(); return true; }
    catch (e) { feil(e); if (aktiv) finn("#brevLukkevalg").hidden = false; return false; }
  }
  async function hentGrunnlag() {
    const svar = await Promise.allSettled([Brev.hentCv(), Brev.hentBrev(jobb.id)]);
    if (!aktiv) return;
    const feilindeks = svar.findIndex(r => r.status === "rejected");
    if (feilindeks >= 0) {
      const e = svar[feilindeks].reason; feil(e); melding("Kunne ikke hente grunnlaget.");
      if (["odelagt", "gjenoppretting", "versjon"].includes(e.code)) { gjenoppretting = feilindeks === 0 ? "cv" : "brev"; finn("#brevGjenoppretting").hidden = false; }
      return;
    }
    [cv, dokument] = svar.map(r => r.value);
    if (!dokument.revisjon) dokument.leverandor = husketLeverandør();
    fyllCv(); fyllDokument(); settOpptatt(false);
    if (dokument.tekst) settFane("brev");
    if (dokument.kjoring && ["klar", "venter", "analyserer", "skriver", "kontrollerer", "skrevet"].includes(dokument.kjoring.status)) {
      kjøring = dokument.kjoring.id;
      if (dokument.kjoring.status === "venter" && dokument.kjoring.analyse) {
        forespørsel = new AbortController(); modellarbeid = true;
        /* Skuffen ble nettopp åpnet, og app.js flytter selv fokus inn i den.
           Avklaringen skal gjenoppstå synlig, men ikke rykke fokus til seg. */
        visSpørsmål(dokument.kjoring.analyse, dokument.kjoring.svar, false);
      } else {
        melding("Et tidligere utkast er under arbeid. Avbryt det før du skriver på nytt.");
        finn('[data-brev="stopp"]').hidden = false; finn('[data-brev="stopp"]').textContent = "Avbryt forrige kjøring";
        finn('[data-brev="skriv"]').disabled = true; finn('[data-brev="forbedre"]').disabled = true;
      }
    }
    visNøkkel();
  }
  hentGrunnlag().catch(feil);
  return { lukk, rydd };
}
