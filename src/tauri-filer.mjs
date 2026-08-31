/* ============================================================
   Tauri-filer — filsystemet under lagerlogikken, i appmodus.

   Motstykket til server/lager.mjs: samme fire operasjoner, men
   utført av Rust i stedet for Node. Alt ligger i appens egen
   datakatalog, som Rust-siden er alene om å kjenne stien til.
   ============================================================ */

const invoke = (navn, arg) => window.__TAURI__.core.invoke(navn, arg);

export async function lagTauriFiler(){
  const katalog = await invoke("data_katalog");

  return {
    katalog,
    /* Bare til meldinger på skjermen. Den ekte sammensettingen av
       sti skjer i Rust, som eneste sted som får røre filsystemet. */
    stiTil: navn => katalog + "/" + navn,

    lesTekst: navn => invoke("les_tekst", { navn }),
    flytt:    (fra, til) => invoke("flytt_fil", { fra, til }),

    skrivAtomisk: (navn, tekst, valg = {}) =>
      invoke("skriv_atomisk", { navn, tekst, kopiTil: valg.kopiTil ?? null })
  };
}
