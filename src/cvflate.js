/* ============================================================
   CV-en. Den er felles for profilen (cv.json) og legges inn to steder:
   på CV-linjen i Brev-fanen og under Innstillinger, der den også kan
   legges inn før det finnes en søknad. Begge flatene leser filen,
   lagrer og sletter gjennom denne modulen, og hver lagring meldes til
   de andre, så Brev-fanen og Radar ser den nye CV-en med en gang i
   stedet for ved neste oppslag.

   lagCvInnstilling(el, { varsle }) tegner delen under Innstillinger i
   el og gir { lukk, fokuser }. lukk() lagrer det som står igjen og
   slipper lytterne; fokuser() åpner tekstfeltet når CV-en mangler, og
   setter fokus på første vei inn.
   ============================================================ */
import * as Brev from "./brev.js";
import { lesCvFil } from "./brev-dokumenter.mjs";
import { esc, MND_K } from "./formater.js";

export const CV_FILTYPER = ".pdf,.docx,.txt,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const harCvTekst = tekst => !!String(tekst ?? "").trim();
/* Det som står på CV-linjen: filnavnet, eller at den er limt inn. */
export const cvNavn = (cv, tekst = cv?.tekst) => !harCvTekst(tekst) ? "Mangler"
  : cv?.navn && cv.navn !== "CV" ? cv.navn : "Lagt inn som tekst";
/* Tekst skrevet rett i feltet blir en tekst-CV, med mindre den var en fil. */
export const medTekst = (cv, tekst) => ({ ...cv, tekst, navn: cv?.navn || "CV", format: cv?.format || "tekst" });
export const lesFil = async (cv, fil) => ({ ...cv, ...(await lesCvFil(fil)) });

/* ---------- lagring og melding ---------- */

const lyttere = new Set();
/* fn(cv) kalles når CV-en er lagret eller slettet et annet sted i appen.
   Den som lagrer, oppgir sin egen lytter som fra, og får ikke sin egen
   lagring tilbake. */
export function påCvEndring(fn, signal){
  lyttere.add(fn);
  signal?.addEventListener("abort", () => lyttere.delete(fn), { once: true });
  return () => lyttere.delete(fn);
}
function meld(cv, fra){ for(const fn of [...lyttere]) if(fn !== fra) try{ fn(cv); }catch{ /* en lytter skal ikke stoppe de andre */ } }

export const hentCv = () => Brev.hentCv();
export async function lagreCv(cv, { fra } = {}){
  const svar = await Brev.lagreCv(cv);
  meld(svar, fra);
  return svar;
}
export async function slettCv(revisjon, { fra } = {}){
  await Brev.slettCv(revisjon);
  const tom = await Brev.hentCv();
  meld(tom, fra);
  return tom;
}

/* ---------- delen under Innstillinger ---------- */

/* Som lagringstilstanden i sidepanelet: klokkeslettet i dag, ellers datoen. */
const to = n => String(n).padStart(2, "0");
const tidspunkt = iso => {
  const d = new Date(iso);
  if(Number.isNaN(d.getTime())) return "";
  return d.toDateString() === new Date().toDateString() ? to(d.getHours()) + ":" + to(d.getMinutes())
    : d.getDate() + ". " + MND_K[d.getMonth()];
};

/* Tekst som ikke ble lagret da skuffen ble lukket, står i feltet neste
   gang Innstillinger åpnes. */
let igjen = null;

export function lagCvInnstilling(el, { varsle = () => {} } = {}){
  const liv = new AbortController();
  const lytt = (mål, type, fn) => mål.addEventListener(type, fn, { signal: liv.signal });
  let cv = null, lasteFeil = "", opptatt = "", konflikt = false, slettet = false;
  let endring = 0, lagret = 0, lagring = null, ventetid = null, ønsker = false;

  el.innerHTML = '<p class="merkelinje innst__tittel" id="cvTittel">CV</p>'
    + '<div class="cvinnst__fil">'
      + '<span class="cvinnst__navn er-tom" id="cvInnstNavn">Henter…</span>'
      + '<p class="lagret cvinnst__status" id="cvInnstStatus" role="status" aria-live="polite"></p></div>'
    + '<p class="felt__hjelp cvinnst__hjelp" id="cvInnstHjelp">Brevene, vurderingen av hver søknad og Radar bruker den. '
      + 'PDF, Word eller tekst, og du kan slippe filen her. Skannede dokumenter må limes inn som tekst.</p>'
    + '<div class="cvinnst__handlinger">'
      + '<label class="knapp knapp--liten filknapp er-av"><span id="cvInnstFilTekst" aria-hidden="true">Velg fil</span>'
        + '<input id="cvInnstFil" type="file" aria-label="Velg CV-fil" aria-describedby="cvInnstHjelp" accept="' + CV_FILTYPER + '" disabled></label>'
      + '<button class="knapp knapp--liten" type="button" id="cvInnstVis" data-cv="tekst" aria-expanded="false" aria-controls="cvInnstPanel" disabled>Lim inn</button>'
      + '<button class="knapp knapp--stille knapp--liten knapp--fare cvinnst__slett" type="button" data-cv="slett" aria-expanded="false" aria-controls="cvInnstBekreft" hidden>Slett CV</button></div>'
    + '<div class="cvinnst__panel" id="cvInnstPanel" hidden>'
      + '<label class="skjult" for="cvInnstTekst">CV-tekst</label>'
      + '<textarea class="felt__omr cvinnst__tekst" id="cvInnstTekst" maxlength="100000" placeholder="Lim inn teksten fra CV-en din" disabled></textarea></div>'
    + '<div class="cvinnst__bekreft" id="cvInnstBekreft" hidden>'
      + '<p id="cvInnstBekreftTekst">Slette CV-en fra profilen? Brevene du har skrevet, beholdes. Vurderingen og Radar stopper til en ny CV er lagt inn.</p>'
      + '<div class="cvinnst__valg"><button class="knapp knapp--liten knapp--fare" type="button" data-cv="slettJa" aria-describedby="cvInnstBekreftTekst">Slett CV</button>'
      + '<button class="knapp knapp--stille knapp--liten" type="button" data-cv="slettNei">Avbryt</button></div></div>'
    + '<div class="feil cvinnst__feil" id="cvInnstFeil" role="alert" hidden></div>';

  const $ = v => el.querySelector(v);
  const felt = $("#cvInnstTekst");
  const ulagret = () => endring !== lagret;

  function tegn(){
    const tekst = felt.value, har = harCvTekst(tekst), åpen = !$("#cvInnstPanel").hidden;
    const navn = $("#cvInnstNavn");
    navn.textContent = cv ? cvNavn(cv, tekst) : lasteFeil ? "Kunne ikke leses" : "Henter…";
    navn.classList.toggle("er-tom", !cv || !har);
    const status = $("#cvInnstStatus");
    status.textContent = opptatt || (konflikt || ulagret() ? "Ikke lagret"
      : cv && har && cv.oppdatert ? "Lagret " + tidspunkt(cv.oppdatert) : slettet && !har ? "Slettet" : "");
    if(!opptatt && (konflikt || ulagret())) status.dataset.t = "ulagret"; else delete status.dataset.t;
    const av = !cv || !!opptatt;
    $("#cvInnstFil").disabled = av;
    $(".filknapp").classList.toggle("er-av", av);
    $('[data-cv="tekst"]').disabled = av;
    felt.disabled = av;
    $("#cvInnstFilTekst").textContent = har ? "Bytt fil" : "Velg fil";
    $('[data-cv="tekst"]').textContent = åpen ? "Skjul teksten" : har ? "Se teksten" : "Lim inn";
    $('[data-cv="slett"]').hidden = !cv || !harCvTekst(cv.tekst) || ulagret();
    $('[data-cv="slett"]').disabled = av;
  }
  function visTekst(åpen, fokus = åpen){
    $("#cvInnstPanel").hidden = !åpen;
    $('[data-cv="tekst"]').setAttribute("aria-expanded", String(åpen));
    tegn();
    if(fokus && åpen && !felt.disabled) felt.focus();
  }
  function visFeil(tekst, knapper = ""){
    const f = $("#cvInnstFeil");
    f.innerHTML = '<p>' + esc(tekst) + '</p>' + knapper;
    f.hidden = !tekst;
  }
  const ryddFeil = () => { $("#cvInnstFeil").hidden = true; konflikt = false; };

  /* ---------- lagringen ----------
     Som brevet: et øyeblikk etter siste tastetrykk, og alltid før
     skuffen lukkes. Endres CV-en i et annet vindu i mellomtiden, står
     teksten her igjen, og brukeren velger hvilken som skal gjelde. */
  function endret(){
    endring++; slettet = false;
    clearTimeout(ventetid);
    ventetid = setTimeout(() => lagre().catch(() => {}), 700);
    tegn();
  }
  async function lagre(){
    clearTimeout(ventetid);
    if(!cv || konflikt) return;
    if(lagring){ await lagring; if(ulagret() && !konflikt) return lagre(); return; }
    lagring = (async () => {
      while(ulagret() && !konflikt){
        const mitt = endring;
        const svar = await lagreCv(medTekst(cv, felt.value), { fra: påEndring });
        cv = endring === mitt ? svar : { ...cv, revisjon: svar.revisjon };
        lagret = mitt;
        if(liv.signal.aborted) return;
        tegn();
      }
    })();
    try{ await lagring; igjen = null; }
    catch(e){
      if(e?.code === "konflikt") await taKonflikt();
      else if(e?.code !== "utlogget" && !liv.signal.aborted) visFeil("CV-en ble ikke lagret. " + (e?.message || ""), '<button class="knapp knapp--liten" type="button" data-cv="prov">Prøv igjen</button>');
      throw e;
    }finally{ lagring = null; if(!liv.signal.aborted) tegn(); }
  }
  async function taKonflikt(){
    konflikt = true;
    /* Revisjonen er den ferske, så «Lagre teksten her» skriver over den
       andre; navnet og formatet er fortsatt det som står her. */
    try{ const fersk = await hentCv(); cv = { ...cv, revisjon: fersk.revisjon }; }catch{ /* «Hent den lagrede» prøver igjen */ }
    if(liv.signal.aborted) return;
    visFeil("CV-en ble endret i et annet vindu. Teksten din står fortsatt i feltet.",
      '<div class="cvinnst__valg"><button class="knapp knapp--liten" type="button" data-cv="behold">Lagre teksten her</button>'
      + '<button class="knapp knapp--stille knapp--liten" type="button" data-cv="hentLagret">Hent den lagrede</button></div>');
    tegn();
  }

  /* ---------- det andre vinduer og flater gjør ---------- */

  function påEndring(ny){
    if(ulagret() || opptatt) return;      /* det som skrives her, går foran */
    cv = ny;
    felt.value = cv.tekst || "";
    tegn();
  }
  påCvEndring(påEndring, liv.signal);

  /* ---------- handlingene ---------- */

  async function taFil(fil){
    if(!fil || !cv || opptatt) return;
    ryddFeil();
    opptatt = "Leser CV-en…"; tegn();
    try{
      const lest = await lesFil(cv, fil);
      if(liv.signal.aborted) return;
      cv = lest; felt.value = lest.tekst || "";
      opptatt = ""; endring++;
      await lagre();
    }catch(e){
      opptatt = "";
      if(!liv.signal.aborted && e?.code !== "konflikt" && e?.code !== "utlogget" && $("#cvInnstFeil").hidden) visFeil(e?.message || "Filen kunne ikke leses.");
    }finally{ opptatt = ""; if(!liv.signal.aborted) tegn(); }
  }

  /* Slettingen bekreftes her i delen. Et varsel med Angre ville stått
     bak skuffen, der det ikke kan nås før skuffen er lukket. */
  function bekreftSlett(vis){
    $("#cvInnstBekreft").hidden = !vis;
    $('[data-cv="slett"]').setAttribute("aria-expanded", String(vis));
    if(vis) $('[data-cv="slettNei"]').focus();
    else $('[data-cv="slett"]').focus();
  }
  async function slett(){
    $("#cvInnstBekreft").hidden = true;
    if(!cv || opptatt || ulagret()) return;
    ryddFeil();
    opptatt = "Sletter…"; tegn();
    try{
      cv = await slettCv(cv.revisjon, { fra: påEndring });
      opptatt = "";
      if(liv.signal.aborted) return;
      felt.value = ""; endring = lagret = 0;
      visTekst(false, false);
      slettet = true;
      $('[data-cv="tekst"]').focus();
    }catch(e){
      opptatt = "";
      if(e?.code === "konflikt") await taKonflikt();
      else if(e?.code !== "utlogget") visFeil(e?.message || "CV-en ble ikke slettet.");
    }finally{ opptatt = ""; if(!liv.signal.aborted) tegn(); }
  }

  lytt(el, "click", async e => {
    const b = e.target.closest("[data-cv]");
    if(!b || b.disabled) return;
    const hva = b.dataset.cv;
    if(hva === "tekst") visTekst($("#cvInnstPanel").hidden);
    else if(hva === "slett") bekreftSlett($("#cvInnstBekreft").hidden);
    else if(hva === "slettNei") bekreftSlett(false);
    else if(hva === "slettJa") slett();
    else if(hva === "prov"){ ryddFeil(); lagre().catch(() => {}); felt.focus(); }
    else if(hva === "behold"){ ryddFeil(); endring++; await lagre().catch(() => {}); if(!ulagret()) felt.focus(); }
    else if(hva === "hentLagret"){
      ryddFeil();
      try{ cv = await hentCv(); }catch(e){ visFeil(e?.message || "Fikk ikke hentet CV-en."); return; }
      felt.value = cv.tekst || ""; endring = lagret = 0; igjen = null; tegn(); felt.focus();
    }
  });
  lytt(el, "input", e => { if(e.target === felt){ if(!cv.navn) cv = { ...cv, navn: "CV", format: "tekst" }; endret(); } });
  lytt(el, "change", e => { if(e.target.id === "cvInnstFil"){ taFil(e.target.files?.[0]); e.target.value = ""; } });
  lytt(el, "dragover", e => { e.preventDefault(); if(cv && !opptatt) el.classList.add("er-over"); });
  lytt(el, "dragleave", e => { if(!el.contains(e.relatedTarget)) el.classList.remove("er-over"); });
  lytt(el, "drop", e => { e.preventDefault(); el.classList.remove("er-over"); taFil(e.dataTransfer?.files?.[0]); });
  lytt(window, "beforeunload", e => { if(ulagret()){ e.preventDefault(); e.returnValue = ""; } });

  /* Feltene er låst til CV-en er hentet. Står det tekst igjen fra sist,
     legges den inn som ulagret, og lagres som om den var skrevet nå. */
  (async () => {
    try{ cv = await hentCv(); }
    catch(e){
      if(liv.signal.aborted) return;
      lasteFeil = e?.message || "Fikk ikke lest CV-en.";
      tegn();
      if(e?.code !== "utlogget") visFeil("CV-en kunne ikke leses. " + lasteFeil
        + (["odelagt", "gjenoppretting", "versjon"].includes(e?.code) ? " Den kan gjenopprettes fra innstillingene i Brev-fanen." : ""));
      return;
    }
    if(liv.signal.aborted) return;
    felt.value = cv.tekst || "";
    if(igjen != null && igjen !== felt.value){ felt.value = igjen; endret(); visTekst(true, false); }
    tegn();
    if(ønsker) fokuser();
  })();
  tegn();

  function fokuser(){
    if(!cv){ ønsker = true; return; }
    ønsker = false;
    el.scrollIntoView({ block: "nearest" });
    if(!harCvTekst(felt.value)) visTekst(true);
    else $("#cvInnstFil").focus();
  }

  async function lukk(){
    if(liv.signal.aborted) return;
    clearTimeout(ventetid);
    const tekst = felt.value;
    const hadde = ulagret() && !!cv;
    liv.abort();
    if(!hadde) return;
    if(konflikt){ igjen = tekst; varsle("CV-en ble ikke lagret. Teksten står igjen under Innstillinger."); return; }
    try{ await lagre(); igjen = null; }
    catch(e){
      if(e?.code === "utlogget") return;
      igjen = tekst;
      varsle("CV-en ble ikke lagret. Teksten står igjen under Innstillinger.");
    }
  }

  return { lukk, fokuser };
}
