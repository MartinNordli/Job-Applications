/* ============================================================
   Lagerlogikk — reglene for datafilen, uten et filsystem.

   Node-serveren og Tauri-appen har hvert sitt filsystem, men skal
   behandle dataene likt. Derfor ligger reglene her, og den som
   kaller sender inn fire filoperasjoner. Endres en regel, endres
   den ett sted.

   Filen er den eneste kopien av dataene. Derfor tre regler: aldri
   overskrive noe vi ikke forstår, alltid bytte filen atomisk, og
   la all skriving gå gjennom én kø slik at to samtidige lagringer
   ikke fletter seg inn i hverandre.

   `filer` må tilby:
     lesTekst(navn)                     → innholdet, eller null
     skrivAtomisk(navn, tekst, {kopiTil}) → kopi av forrige, så bytt
     flytt(fra, til)                    → gi filen et nytt navn
     stiTil(navn)                       → full sti, kun til meldinger
     katalog                            → full sti til mappa
   ============================================================ */

import { validerSamling } from "./felles.mjs";

export const FILNAVN = "jobber.json";
export const FORRIGE = "jobber.forrige.json";

/* Feltene som avgjør om en rad faktisk er endret. Tidsstemplene
   teller ikke med — ellers ville hver lagring sett ut som en endring. */
const INNHOLD = ["id", "selskap", "stilling", "lenke", "sted",
                 "frist", "status", "sektor", "notat", "sendtDato"];

const likeRader = (a, b) => !!a && !!b && INNHOLD.every(f => a[f] === b[f]);

export function lagLager({ filer, lagId }){
  const sti        = filer.stiTil(FILNAVN);
  const forrigeSti = filer.stiTil(FORRIGE);

  let kø = Promise.resolve();      /* all skriving serialiseres her */

  /* En uforståelig fil blir liggende. Å flytte den bort under lesing
     ville etterlatt katalogen tom, og da ville neste lagring blitt
     godtatt og skrevet over sikkerhetskopien. Filen ryddes først når
     brukeren har valgt hva som skal skje — se overstyrOdelagt. */
  async function meldOdelagt(grunn){
    return { ødelagt: true, sti, grunn, ...(await sikkerhetskopi()) };
  }

  async function settIKarantene(){
    const merke = new Date().toISOString().replaceAll(":", "-");
    const navn  = `jobber.ødelagt-${merke}.json`;
    await filer.flytt(FILNAVN, navn);
    return filer.stiTil(navn);
  }

  /* Er hovedfilen borte, men sikkerhetskopien der, skal den tilbys før
     noe annet. Ellers ser en karantene ut som en tom app, og det neste
     lagringen gjør er å bekrefte tomheten. */
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
      liste = dok;                                   /* eldre format: bar liste */
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
      /* Rådataene tas vare på og skrives tilbake urørt, ellers ville
         første lagring slettet en rad brukeren selv har skrevet inn. */
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
      /* Bare et bevisst valg fra brukeren får rydde bort en fil vi ikke
         forstår — og da flyttes den til side, aldri over. */
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

    /* Tidsstempler settes her, ikke av den som ber om lagringen. */
    const før = new Map((nå.jobber ?? []).map(r => [r.id, r]));
    const tid = new Date().toISOString();
    const rader = gyldige.map(rad => {
      const gammel = før.get(rad.id);
      if(!gammel)               return { ...rad, opprettet: tid, oppdatert: tid };
      if(likeRader(gammel, rad)) return { ...rad, opprettet: gammel.opprettet ?? tid,
                                                  oppdatert: gammel.oppdatert ?? tid };
      return { ...rad, opprettet: gammel.opprettet ?? tid, oppdatert: tid };
    });

    const dok = { versjon: versjon + 1, oppdatert: tid, jobber: rader };
    /* Rader vi ikke forsto ved lesing skrives tilbake urørt. De vises
       ikke i appen, men de skal heller ikke forsvinne fordi noen
       lagret noe annet. */
    if(nå.ugyldige && nå.ugyldige.length) dok.ugyldige = nå.ugyldige;

    await filer.skrivAtomisk(FILNAVN, JSON.stringify(dok, null, 2) + "\n", { kopiTil: FORRIGE });
    return { ok: true, versjon: dok.versjon, jobber: rader,
             ...(nå.karantene ? { karantene: nå.karantene } : {}) };
  }

  function skriv(jobber, forventetVersjon, valg2){
    const oppgave = kø.then(() => utfør(jobber, forventetVersjon, valg2));
    kø = oppgave.then(() => {}, () => {});   /* en feilet skriving skal ikke låse køen */
    return oppgave;
  }

  return { les, skriv, katalog: filer.katalog, sti, forrigeSti };
}

export default lagLager;
