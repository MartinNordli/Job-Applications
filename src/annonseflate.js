/* ============================================================
   Annonse-fanen i detaljpanelet.

   Annonsen er den lagrede teksten fra jobb-<id>.json, ikke siden slik
   den ser ut nå. Den står igjen når utlysningen er tatt ned, og den er
   grunnlaget brevet og vurderingen bygger på. Derfor står kilden og
   datoen øverst, og originalen er én lenke unna.

   Teksten kommer som ren tekst med linjeskift (se annonsetekst.mjs).
   Avsnitt, punktlister og korte mellomtitler gjenskapes av formen på
   linjene, ikke av HTML, så ingenting fra siden kan sette inn markup.

   Hver vei inn som kan erstatte en lagret tekst («Hent på nytt» og
   «Lim inn»), kan angres fra varselet: den forrige annonsen skrives
   tilbake med sin egen kilde og dato.
   ============================================================ */

import * as Jobbdokumenter from "./jobbdokumenter.js";
import { esc, tilIso, datoMedÅr, vert } from "./formater.js";

const KILDE = {
  import: "Lagret da søknaden ble importert",
  hentet: "Hentet fra lenken",
  limt:   "Limt inn",
  brev:   "Flyttet fra søknadsbrevet",
  radar:  "Funnet av Radar"
};

/* Hva hver feil fra hentingen betyr, og hva man kan gjøre i stedet.
   `lim` gir en «Lim inn»-knapp ved meldingen, `rediger` en vei til
   skjemaet der lenken står. Meldingen fra tjenesten brukes der den er
   mer presis enn vår (statuskoden, ventetiden ved taket). */
const FEIL = {
  "mangler-lenke": { tittel: "Søknaden har ingen lenke.", hjelp: "Legg inn lenken under Rediger, eller lim inn annonsen.", lim: true, rediger: true },
  "dod-lenke":     { tittel: "Annonsen ligger ikke lenger på adressen.", hjelp: "Den er antakelig tatt ned. Har du teksten et annet sted, kan du lime den inn.", lim: true },
  "ikke-nettside": { tittel: "Lenken peker ikke til en nettside.", hjelp: "Den kan gå til en PDF eller en fil. Åpne originalen, kopier teksten og lim den inn.", lim: true },
  "tom-annonse":   { tittel: "Fant for lite tekst på siden.", hjelp: "Siden bygges antakelig med JavaScript. Åpne originalen, kopier annonsen og lim den inn.", lim: true },
  "for-lang":      { tittel: "Siden har mer enn 100 000 tegn tekst.", hjelp: "Lim inn bare selve annonsen i stedet.", lim: true },
  "henting":       { hjelp: "Prøv igjen om litt, eller lim inn annonsen.", lim: true },
  "for-mange":     { hjelp: "Du kan fortsatt lime inn annonsen.", lim: true },
  "finnes-ikke":   { tittel: "Søknaden finnes ikke lenger.", hjelp: "Den kan være slettet i et annet vindu." },
  "frakoblet":     { tittel: "Fikk ikke kontakt med appen.", hjelp: "Sjekk at serveren kjører, og prøv igjen." },
  "tom-tekst":     { tittel: "Lim inn teksten fra annonsen først." }
};
export function feilmelding(e){
  const kjent = FEIL[e?.code] || {};
  return {
    tittel: kjent.tittel || e?.melding || e?.message || "Fikk ikke hentet annonsen.",
    hjelp: kjent.hjelp || "",
    lim: !!kjent.lim, rediger: !!kjent.rediger
  };
}

/* ---------- teksten ---------- */

const PUNKT = /^\s*(?:[-*•·–▪◦]|\d{1,2}[.)])\s+/;
const erSetning = l => /[.!?;]["»)]?$/.test(l);

/* Én blokk (tekst mellom tomme linjer) blir avsnitt, liste eller
   mellomtittel. En linje med punkttegn er et listepunkt. Flere korte
   linjer på rad uten punktum er også en liste: det er slik <li> kommer
   ut av siden. En kort linje uten punktum foran mer tekst er en
   mellomtittel. Alt annet er avsnitt. */
export function annonseHtml(tekst){
  const ut = [];
  const blokker = String(tekst).replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for(const blokk of blokker){
    const linjer = blokk.split("\n").map(l => l.trim()).filter(Boolean);
    let i = 0;
    while(i < linjer.length){
      const l = linjer[i];
      if(PUNKT.test(l)){
        const punkter = [];
        while(i < linjer.length && PUNKT.test(linjer[i])) punkter.push(linjer[i++].replace(PUNKT, ""));
        ut.push(liste(punkter));
        continue;
      }
      const kort = x => x.length <= 90 && !erSetning(x);
      let j = i;
      while(j < linjer.length && kort(linjer[j]) && !PUNKT.test(linjer[j])) j++;
      const løp = j - i;
      if(løp >= 2){
        /* En første linje som slutter med kolon, er overskriften til listen. */
        if(/:$/.test(linjer[i])){ ut.push(tittel(linjer[i])); i++; }
        ut.push(liste(linjer.slice(i, j)));
        i = j;
        continue;
      }
      if(løp === 1 && l.length <= 60 && i + 1 < linjer.length){ ut.push(tittel(l)); i++; continue; }
      if(løp === 1 && l.length <= 60 && linjer.length === 1 && /:$/.test(l)){ ut.push(tittel(l)); i++; continue; }
      ut.push('<p>' + esc(l) + '</p>');
      i++;
    }
  }
  return ut.join("");
}
const liste = punkter => '<ul>' + punkter.map(p => '<li>' + esc(p) + '</li>').join("") + '</ul>';
const tittel = t => '<h4>' + esc(t.replace(/:$/, "")) + '</h4>';

/* ---------- fanen ---------- */

export function monterAnnonse(flate, ktx, api){
  let modus = "les";          /* "les" | "lim" */
  let opptatt = null;         /* tekst som sier hva som pågår, eller null */
  let feil = null;            /* { tittel, hjelp, lim, rediger } */
  let utkast = "";
  let aktiv = true;
  let k = ktx;

  const annonse = () => k.dok?.annonse || null;
  const harTekst = () => !!annonse()?.tekst?.trim();
  const lenke = () => (k.jobb.lenke || "").trim();
  const original = () => annonse()?.url || lenke();

  function kildelinje(a){
    const deler = [KILDE[a.kilde] || "Lagret"];
    if(a.hentet){
      const d = new Date(a.hentet);
      if(!Number.isNaN(d.getTime())) deler.push(datoMedÅr(tilIso(d), k.iDag));
    }
    const v = vert(a.url);
    return '<p class="annonse__kilde">' + esc(deler.join(" ")) + (v ? ' <span class="annonse__vert">' + esc(v) + '</span>' : "") + '</p>';
  }

  function feilHtml(){
    if(!feil) return "";
    return '<div class="detalj__feil" role="alert"><p class="detalj__feiltittel">' + esc(feil.tittel) + '</p>'
      + (feil.hjelp ? '<p>' + esc(feil.hjelp) + '</p>' : "")
      + ((feil.lim && modus !== "lim") || feil.rediger
          ? '<div class="detalj__handlinger">'
            + (feil.lim && modus !== "lim" ? '<button class="knapp knapp--liten" type="button" data-annonse="lim">Lim inn</button>' : "")
            + (feil.rediger ? '<button class="knapp knapp--liten knapp--stille" type="button" data-annonse="rediger">Rediger søknaden</button>' : "")
            + '</div>'
          : "")
      + '</div>';
  }

  const knapp = (hva, tekst, ekstra = "") => '<button class="knapp knapp--liten' + ekstra + '" type="button" data-annonse="' + hva + '"'
    + (opptatt ? " disabled" : "") + '>' + tekst + '</button>';
  const åpneOriginal = () => original()
    ? '<a class="knapp knapp--liten knapp--stille annonse__original" href="' + esc(original()) + '" target="_blank" rel="noopener noreferrer">Åpne originalen<span class="rad__pil" aria-hidden="true">↗</span></a>'
    : "";

  function tegn(){
    if(!aktiv) return;
    /* Synlig tilstand. Skjermlesere får den samme beskjeden gjennom
       panelets egen statuslinje, som ikke tegnes om. */
    const status = '<p class="henter annonse__status">' + esc(opptatt || "") + '</p>';

    if(modus === "lim"){
      flate.innerHTML = '<div class="annonse">'
        + '<div class="annonse__lim">'
        + '<label class="felt__merke" for="annonseLim">Annonseteksten</label>'
        + '<textarea class="felt__omr annonse__felt" id="annonseLim" maxlength="100000" placeholder="Lim inn hele annonsen, med krav og arbeidsoppgaver.">' + esc(utkast) + '</textarea>'
        + '<p class="felt__hjelp">' + (harTekst() ? "Erstatter annonsen som er lagret nå. Du kan angre etterpå." : "Teksten lagres sammen med søknaden.") + '</p>'
        + feilHtml()
        + '<div class="detalj__handlinger">' + knapp("lagre", "Lagre annonsen", " knapp--primar") + knapp("avbryt", "Avbryt", " knapp--stille") + '</div>'
        + status + '</div></div>';
      return;
    }

    if(!k.dok && !k.dokFeil){
      flate.innerHTML = '<div class="annonse"><p class="henter">Henter annonsen…</p></div>';
      return;
    }
    if(k.dokFeil && !k.dok){
      const f = feilmelding(k.dokFeil);
      flate.innerHTML = '<div class="annonse"><div class="detalj__feil" role="alert"><p class="detalj__feiltittel">Fikk ikke lest annonsen.</p>'
        + '<p>' + esc(f.tittel) + '</p><div class="detalj__handlinger"><button class="knapp knapp--liten" type="button" data-annonse="last">Prøv igjen</button></div></div></div>';
      return;
    }

    if(!harTekst()){
      flate.innerHTML = '<div class="annonse annonse--tom">'
        + '<p class="detalj__tomtittel">Ingen annonse lagret</p>'
        + '<p class="detalj__tomtekst">' + (lenke()
            ? "Hent teksten fra lenken, eller lim den inn. Den blir stående her også etter at utlysningen er tatt ned."
            : "Søknaden har ingen lenke å hente fra. Lim inn teksten, eller legg inn lenken under Rediger.") + '</p>'
        + feilHtml()
        + '<div class="detalj__handlinger">'
          + (lenke() ? knapp("hent", "Hent annonsen", " knapp--primar") : "")
          + knapp("lim", "Lim inn", lenke() ? "" : " knapp--primar")
          + (lenke() ? "" : knapp("rediger", "Rediger", " knapp--stille"))
        + '</div>' + status + '</div>';
      return;
    }

    const a = annonse();
    flate.innerHTML = '<div class="annonse">'
      + '<div class="annonse__topp">' + kildelinje(a)
        + '<div class="detalj__handlinger">'
          + (lenke() ? knapp("hent", "Hent på nytt", " knapp--stille") : "")
          + knapp("lim", "Lim inn", " knapp--stille") + åpneOriginal()
        + '</div></div>'
      + status + feilHtml()
      + '<article class="annonse__tekst" aria-label="Annonsen">' + annonseHtml(a.tekst) + '</article></div>';
  }

  /* Skriver den forrige annonsen tilbake med sin egen kilde og dato.
     Går gjennom lagre(), som tar alle kilder, mot ferskeste revisjon. */
  function angreTil(forrige){
    return async () => {
      try{
        const nå = await Jobbdokumenter.hent(k.jobb.id);
        const dok = await Jobbdokumenter.lagre(k.jobb.id, { ...nå, annonse: forrige });
        api.settDokument(k.jobb.id, dok);
        api.melde("Den forrige annonsen er lagt tilbake");
      }catch(e){
        if(e?.code !== "utlogget") api.varsle("Fikk ikke lagt tilbake den forrige annonsen");
      }
    };
  }

  async function utfør(tekst, arbeid, ferdig){
    const id = k.jobb.id;
    const forrige = harTekst() ? { ...annonse() } : null;
    opptatt = tekst; feil = null; tegn();
    api.melde(tekst);
    try{
      const dok = await arbeid();
      if(!aktiv || id !== k.jobb.id) return;
      opptatt = null; modus = "les"; utkast = "";
      api.settDokument(id, dok);
      api.varsle(ferdig, forrige ? angreTil(forrige) : null);
      api.melde(ferdig);
    }catch(e){
      if(!aktiv || id !== k.jobb.id) return;
      opptatt = null;
      if(e?.code === "utlogget"){ tegn(); return; }
      feil = feilmelding(e);
      tegn();
      api.melde(feil.tittel + " " + feil.hjelp);
      flate.querySelector(".detalj__feil")?.scrollIntoView({ block: "nearest" });
    }
  }

  async function handling(hva){
    if(opptatt && hva !== "avbryt") return;
    if(hva === "hent"){
      const v = vert(lenke());
      await utfør("Henter annonsen" + (v ? " fra " + v : "") + "…", () => Jobbdokumenter.hentAnnonse(k.jobb.id),
        harTekst() ? "Annonsen er hentet på nytt" : "Annonsen er hentet");
    }else if(hva === "lim"){
      modus = "lim"; feil = null; utkast = ""; tegn();
      flate.querySelector("#annonseLim")?.focus({ preventScroll: true });
    }else if(hva === "avbryt"){
      modus = "les"; feil = null; utkast = ""; tegn();
      flate.querySelector('[data-annonse="lim"]')?.focus({ preventScroll: true });
    }else if(hva === "lagre"){
      const felt = flate.querySelector("#annonseLim");
      utkast = felt ? felt.value : utkast;
      if(!utkast.trim()){ feil = feilmelding({ code: "tom-tekst" }); tegn(); flate.querySelector("#annonseLim")?.focus({ preventScroll: true }); return; }
      await utfør("Lagrer annonsen…", () => Jobbdokumenter.limInnAnnonse(k.jobb.id, utkast), "Annonsen er lagret");
      if(modus === "les") flate.querySelector('[data-annonse="lim"]')?.focus({ preventScroll: true });
    }else if(hva === "rediger") api.rediger();
    else if(hva === "last") api.lastDokument();
  }

  const lytt = new AbortController();
  flate.addEventListener("click", e => {
    const b = e.target.closest("[data-annonse]");
    if(b && !b.disabled) handling(b.dataset.annonse);
  }, { signal: lytt.signal });
  /* Esc i innlimingen avbryter den, i stedet for å lukke hele panelet. */
  flate.addEventListener("keydown", e => {
    if(e.key === "Escape" && modus === "lim" && !opptatt){ e.preventDefault(); handling("avbryt"); }
    if(e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.target.id === "annonseLim"){ e.preventDefault(); handling("lagre"); }
  }, { signal: lytt.signal });
  flate.addEventListener("input", e => { if(e.target.id === "annonseLim") utkast = e.target.value; }, { signal: lytt.signal });

  tegn();
  return {
    /* Ny søknadstilstand eller nytt dokument. Innlimingen tegnes ikke
       om, så teksten som limes inn, står. */
    oppdater(ny){
      const byttet = ny.jobb.id !== k.jobb.id;
      k = ny;
      if(byttet){ modus = "les"; feil = null; utkast = ""; opptatt = null; }
      if(modus === "lim" && !byttet) return;
      tegn();
    },
    rydd(){ aktiv = false; lytt.abort(); }
  };
}
