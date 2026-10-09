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

   `nå` er klokken, injisert av samme grunn som `filer`: testene skal
   kunne styre hvilken dag sikkerhetsnettet for hendelser daterer med.
   ============================================================ */

import { validerSamling, validerHendelser } from "./felles.mjs";
import { lagHendelse, lokalDato } from "./hendelser.mjs";

export const FILNAVN = "jobber.json";
export const FORRIGE = "jobber.forrige.json";

/* Feltene som avgjør om en rad faktisk er endret. Tidsstemplene
   teller ikke med — ellers ville hver lagring sett ut som en endring. */
const INNHOLD = ["id", "selskap", "stilling", "lenke", "sted",
                 "frist", "status", "sektor", "jobbtype", "notat", "sendtDato",
                 "hendelser", "intervjuer"];

/* Listene sammenlignes som JSON. Begge er allerede normalisert av
   validatoren (faste nøkler i fast rekkefølge, sortert), så lik JSON
   betyr likt innhold. */
const likVerdi = (a, b) => a === b
  || (typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));
const likeRader = (a, b) => !!a && !!b && INNHOLD.every(f => likVerdi(a[f], b[f]));

/* Listene på raden som en eldre klient ikke kjenner. Mangler nøkkelen
   helt i det som kommer inn, er det ikke et ønske om å tømme listen:
   det er en fane eller app fra før feltet fantes. Da beholdes det som
   står i filen, i stedet for at historikken forsvinner stille. */
const BEVARES_NÅR_DE_MANGLER = ["hendelser", "intervjuer"];

/* Sikkerhetsnettet for hendelsesloggen.

   Klienten logger selv statusskift med medStatus. Gjør den ikke det
   (en vei som ikke er koblet til ennå, eller en eldre klient), legger
   lageret til hendelsen med kilde «lager», så loggen ikke får hull.

   - Ny rad uten hendelser får én, men bare i en liste som er i bruk
     (versjon over 0). Første lagring i en tom fil og en gjenoppretting
     er hele lister med ukjent historikk. Å datere dem til i dag ville
     vært feil, og tidslinje() anslår dem bedre fra opprettet og
     sendtDato.
   - Statusen er endret, og klienten sendte de samme hendelsene som
     står i filen: klienten har ikke logget skiftet, så lageret gjør det.
   - Klienten har endret hendelsene: den har logget selv, eller den
     angrer. Da stoles det på den. Det er dette som gjør at angre ikke
     etterlater en hendelse om gjenåpning.
   - Unntak: statusen er den samme, og klienten mangler bare hendelser
     lageret selv la til på slutten. Klienten får ikke radene tilbake
     etter lagring, så den kjenner dem ikke, og neste lagring av noe
     annet skal ikke viske dem ut. */
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

  /* Versjonssjekken under er hele vernet mot at to skrivinger tar
     livet av hverandre — og siden appen og npm start nå deler
     datakatalog, er de to ikke lenger bare to faner, men to
     prosesser mot samme fil.

     Det den er: filen leses på nytt her inne, i køen, rett før den
     skrives. Sammenlikningen går derfor mot versjonen på disk, ikke
     mot noe vi husker fra sist. Har en annen prosess skrevet i
     mellomtiden, har disken et høyere tall, og skrivingen avvises
     med «konflikt» — som blir 409, konfliktsperre og «Hent på nytt».
     Ingen tilstand i minnet kan bli foreldet, fordi ingen holdes.

     Det den ikke er: en lås. Mellom les() og skrivAtomisk her er det
     et vindu på noen millisekunder der en annen prosess kan rekke
     hele sin egen les-og-skriv, og da vinner den som byttet filen
     sist. Én bruker med to vinduer treffer ikke det vinduet, og
     taperen ligger uansett i jobber.forrige.json.

     En fillås (O_EXCL eller flock rundt les-og-skriv) ville lukket
     det. Vurdert og valgt bort: den koster en opprydding av låser
     etter en krasj, den må virke likt i Node og i Rust, og den løser
     et kappløp på millisekunder for en app med én bruker. Står det
     her fordi det er et bevisst valg, ikke noe ingen tenkte på. */
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
    const øyeblikk = klokke();
    const tid = øyeblikk.toISOString();
    const iDag = lokalDato(øyeblikk);
    const listeIBruk = versjon > 0 && !nå.karantene;

    /* Ingen rad ble forkastet, så gyldige[i] er jobber[i] validert. */
    const rader = gyldige.map((validert, i) => {
      const gammel = før.get(validert.id);
      const rå = jobber[i];
      let rad = validert;
      if(gammel){
        for(const felt of BEVARES_NÅR_DE_MANGLER)
          if(!Object.hasOwn(rå, felt)) rad = { ...rad, [felt]: gammel[felt] ?? [] };
      }
      rad = { ...rad, hendelser: validerHendelser(sikreHendelser(gammel, rad, { iDag, tid, listeIBruk })) };
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
