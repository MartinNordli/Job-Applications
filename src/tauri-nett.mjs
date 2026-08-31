/* ============================================================
   Tauri-nett — de to utgående operasjonene, i appmodus.

   Motstykket til server/nett.mjs: samme to operasjoner, men
   utført av Rust i stedet for Node. Webviewet får aldri se
   API-nøkkelen — Rust leser den selv, og CSP-en kan derfor stå
   urørt med connect-src 'self' ipc:.
   ============================================================ */

const invoke = (navn, arg) => window.__TAURI__.core.invoke(navn, arg);

export const tauriNett = {
  hentSide: url => invoke("hent_side", { url }),

  /* Kroppen sendes som tekst. Rust kjenner adressen til modellen
     selv, så en fiendtlig utlysning kan ikke omdirigere nøkkelen. */
  spørModell: async kropp => JSON.parse(await invoke("spor_modell", { kropp: JSON.stringify(kropp) }))
};
