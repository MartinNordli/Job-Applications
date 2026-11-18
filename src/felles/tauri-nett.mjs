const invoke = (navn, arg) => window.__TAURI__.core.invoke(navn, arg);

export const tauriNett = {
  hentSide: url => invoke("hent_side", { url }),

  spørModell: async (kropp, { bruker = null } = {}) =>
    JSON.parse(await invoke("spor_modell", { kropp: JSON.stringify(kropp), bruker }))
};
