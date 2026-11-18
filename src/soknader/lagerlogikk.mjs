import { validerSamling, validerHendelser } from "../felles/felles.mjs";
import { lagHendelse, lokalDato } from "./hendelser.mjs";

export const FILNAVN = "jobber.json";
export const FORRIGE = "jobber.forrige.json";

const INNHOLD = ["id", "selskap", "stilling", "lenke", "sted",
                 "frist", "status", "sektor", "jobbtype", "notat", "sendtDato",
                 "hendelser", "intervjuer"];

const likVerdi = (a, b) => a === b
  || (typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));
const likeRader = (a, b) => !!a && !!b && INNHOLD.every(f => likVerdi(a[f], b[f]));

const BEVARES_NÅR_DE_MANGLER = ["hendelser", "intervjuer"];

function sikreHendelser(gammel, rad, { iDag, tid, listeIBruk }){
  const hendelser = rad.hendelser;
  const ny = til => [...hendelser, lagHendelse(til, { iDag, nå: tid, kilde: "lager" })];

  if(!gammel) return !hendelser.length && listeIBruk ? ny(rad.status) : hendelser;

  const før = gammel.hendelser || [];
  if(likVerdi(hendelser, før))
    return rad.status !== gammel.status ? ny(rad.status) : hendelser;

  if(rad.status === gammel.status && hendelser.length < før.length
     && likVerdi(hendelser, før.slice(0, hendelser.length))
     && før.slice(hendelser.length).every(h => h.kilde === "lager"))
    return før;

  return hendelser;
}

export function lagLager({ filer, lagId, nå: klokke = () => new Date() }){
  const sti        = filer.stiTil(FILNAVN);
  const forrigeSti = filer.stiTil(FORRIGE);

  let kø = Promise.resolve();

  async function meldOdelagt(grunn){
    return { ødelagt: true, sti, grunn, ...(await sikkerhetskopi()) };
  }

  async function settIKarantene(){
    const merke = new Date().toISOString().replaceAll(":", "-");
    const navn  = `jobber.ødelagt-${merke}.json`;
    await filer.flytt(FILNAVN, navn);
    return filer.stiTil(navn);
  }

  async function sikkerhetskopi(){
    try{
      const rå = await filer.lesTekst(FORRIGE);
      if(rå == null) return {};
      const dok = JSON.parse(rå);
      const liste = Array.isArray(dok) ? dok
                  : (dok && Array.isArray(dok.jobber) ? dok.jobber : null);
      if(!liste) return {};
      const { gyldige } = validerSamling(liste, { lagId });
      if(!gyldige.length) return {};
      return { sikkerhetskopi: { jobber: gyldige, oppdatert: (dok && dok.oppdatert) || null } };
    }catch{ return {}; }
  }

  async function les(){
    const rå = await filer.lesTekst(FILNAVN);
    if(rå == null) return { tom: true, versjon: 0, jobber: null, ...(await sikkerhetskopi()) };

    let dok;
    try{ dok = JSON.parse(rå); }
    catch{ return meldOdelagt("Filen er ikke gyldig JSON."); }

    let versjon = 0, liste;
    if(Array.isArray(dok)){
      liste = dok;
    }else if(dok && typeof dok === "object" && Array.isArray(dok.jobber)){
      liste   = dok.jobber;
      versjon = Number.isInteger(dok.versjon) && dok.versjon >= 0 ? dok.versjon : 0;
    }else{
      return meldOdelagt("Filen har ikke forventet form.");
    }

    const { gyldige, forkastet } = validerSamling(liste, { lagId });
    const svar = { versjon, jobber: gyldige };
    if(forkastet.length){
      svar.forkastet = forkastet;
      svar.ugyldige = forkastet.map(f => liste[f.indeks]).filter(r => r !== undefined);
      svar.advarsel  = forkastet.length === 1
        ? "Én rad i datafilen var ugyldig og ble hoppet over."
        : `${forkastet.length} rader i datafilen var ugyldige og ble hoppet over.`;
    }
    return svar;
  }

  async function utfør(jobber, forventetVersjon, valg2 = {}){
    let nå = await les();

    if(nå.ødelagt){
      if(!valg2.overstyrOdelagt) return { ok: false, feil: "ødelagt", sti: nå.sti };
      const karantene = await settIKarantene();
      nå = { versjon: 0, jobber: [], karantene };
      forventetVersjon = undefined;
    }

    const versjon = nå.versjon;
    if(typeof forventetVersjon === "number" && forventetVersjon !== versjon)
      return { ok: false, feil: "konflikt", versjon, jobber: nå.jobber ?? [] };

    const { gyldige, forkastet } = validerSamling(jobber, { lagId });
    if(forkastet.length) return { ok: false, feil: "ugyldig", detaljer: forkastet };

    const før = new Map((nå.jobber ?? []).map(r => [r.id, r]));
    const øyeblikk = klokke();
    const tid = øyeblikk.toISOString();
    const iDag = lokalDato(øyeblikk);
    const listeIBruk = versjon > 0 && !nå.karantene;

    const rader = gyldige.map((validert, i) => {
      const gammel = før.get(validert.id);
      const rå = jobber[i];
      let rad = validert;
      if(gammel){
        for(const felt of BEVARES_NÅR_DE_MANGLER)
          if(!Array.isArray(rå[felt])) rad = { ...rad, [felt]: gammel[felt] ?? [] };
      }
      rad = { ...rad, hendelser: validerHendelser(sikreHendelser(gammel, rad, { iDag, tid, listeIBruk })) };
      if(!gammel)               return { ...rad, opprettet: tid, oppdatert: tid };
      if(likeRader(gammel, rad)) return { ...rad, opprettet: gammel.opprettet ?? tid,
                                                  oppdatert: gammel.oppdatert ?? tid };
      return { ...rad, opprettet: gammel.opprettet ?? tid, oppdatert: tid };
    });

    const dok = { versjon: versjon + 1, oppdatert: tid, jobber: rader };
    if(nå.ugyldige && nå.ugyldige.length) dok.ugyldige = nå.ugyldige;

    await filer.skrivAtomisk(FILNAVN, JSON.stringify(dok, null, 2) + "\n", { kopiTil: FORRIGE });
    return { ok: true, versjon: dok.versjon, jobber: rader,
             ...(nå.karantene ? { karantene: nå.karantene } : {}) };
  }

  function skriv(jobber, forventetVersjon, valg2){
    const oppgave = kø.then(() => utfør(jobber, forventetVersjon, valg2));
    kø = oppgave.then(() => {}, () => {});
    return oppgave;
  }

  return { les, skriv, katalog: filer.katalog, sti, forrigeSti };
}

export default lagLager;
