/* ============================================================
   Tauri-nett — de to utgående operasjonene, i appmodus.

   Motstykket til server/nett.mjs: samme to operasjoner, men
   utført av Rust i stedet for Node. Nøkkelen leses av Rust, fra
   profilens egen katalog — `bruker` sier hvilken. Uten den ville
   én profil kunnet betale for en annens import.

   CSP-en kan stå urørt med connect-src 'self' ipc:, fordi
   webviewet ikke selv snakker med noen andre enn Rust.
   ============================================================ */

const invoke = (navn, arg) => window.__TAURI__.core.invoke(navn, arg);

export const tauriNett = {
  hentSide: url => invoke("hent_side", { url }),

  /* Kroppen sendes som tekst. Rust kjenner adressen til modellen
     selv, så en fiendtlig utlysning kan ikke omdirigere nøkkelen.
     `bruker` er valgfri av bakoverkompatible grunner; uten den
     leter Rust i rota, som ikke har noen nøkkel etter migreringen. */
  spørModell: async (kropp, { bruker = null } = {}) =>
    JSON.parse(await invoke("spor_modell", { kropp: JSON.stringify(kropp), bruker }))
};
