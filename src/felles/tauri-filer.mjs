const invoke = (navn, arg) => window.__TAURI__.core.invoke(navn, arg);

export async function lagTauriFiler({ bruker = null } = {}){
  const katalog = await invoke("data_katalog", { bruker });

  return {
    katalog,
    bruker,
    stiTil: navn => katalog + "/" + navn,

    lesTekst: navn => invoke("les_tekst", { navn, bruker }),
    flytt:    (fra, til) => invoke("flytt_fil", { fra, til, bruker }),

    skrivAtomisk: (navn, tekst, valg = {}) =>
      invoke("skriv_atomisk", { navn, tekst, kopiTil: valg.kopiTil ?? null, bruker })
  };
}
