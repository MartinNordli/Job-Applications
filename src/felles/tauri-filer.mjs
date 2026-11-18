/* ============================================================
   Tauri-filer — filsystemet under lagerlogikken, i appmodus.

   Motstykket til server/lager.mjs: samme fire operasjoner, men
   utført av Rust i stedet for Node. Alt ligger i appens egen
   datakatalog, som Rust-siden er alene om å kjenne stien til.

   `bruker` velger hvilken katalog operasjonene gjelder. Uten den
   er det datakatalogen selv — der brukere.json og den gamle
   enbrukerfilen ligger. Med den er det <datakatalog>/brukere/<id>.
   Id-en settes aldri sammen med noe her: den sendes videre som en
   verdi, og Rust er fortsatt eneste sted en sti blir til.

   ------------------------------------------------------------
   To ærlige asymmetrier mot nettlesermodus
   ------------------------------------------------------------

   `modus` (0600 på nøkkelfilen) ignoreres. server/lager.mjs setter
   den fordi serveren kan kjøre på en maskin med flere OS-brukere;
   ~/Library/Application Support/ er allerede privat for OS-brukeren
   på macOS, og en ekstra Rust-parameter for å sette noe filsystemet
   allerede har gitt oss, er en operasjon til å ta feil av. Kallere
   kan sende `modus` uten at noe brekker — det er bare ingen som
   leser den her. Asymmetrien er et valg, ikke en glipp.

   `slett` finnes ikke. Rust har ingen slette-operasjon, og skal
   ikke få en for dette ene tilfellet: «fjern API-nøkkelen» skriver
   i stedet en tom fil, og Rust regner en tom nokkel.txt som ingen
   nøkkel (se les_nokkel i src-tauri/src/lib.rs).

   ------------------------------------------------------------
   Og den viktigste: nøkkelen
   ------------------------------------------------------------

   I nettlesermodus er «API-nøkkelen går aldri tilbake til
   klienten» en ekte grense: serveren leser filen, klienten har
   ingen vei til den. I appmodus ER webviewet klienten, og det har
   `lesTekst`. Flaten følger samme kontrakt — nøkkelen vises aldri,
   bare en hale på fire tegn — men her er det disiplin, ikke en
   grense. Den som leter etter grensen skal finne dette avsnittet
   i stedet for å tro at den finnes.
   ============================================================ */

const invoke = (navn, arg) => window.__TAURI__.core.invoke(navn, arg);

export async function lagTauriFiler({ bruker = null } = {}){
  const katalog = await invoke("data_katalog", { bruker });

  return {
    katalog,
    bruker,
    /* Bare til meldinger på skjermen. Den ekte sammensettingen av
       sti skjer i Rust, som eneste sted som får røre filsystemet. */
    stiTil: navn => katalog + "/" + navn,

    lesTekst: navn => invoke("les_tekst", { navn, bruker }),
    flytt:    (fra, til) => invoke("flytt_fil", { fra, til, bruker }),

    skrivAtomisk: (navn, tekst, valg = {}) =>
      invoke("skriv_atomisk", { navn, tekst, kopiTil: valg.kopiTil ?? null, bruker })
  };
}
