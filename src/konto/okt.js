import {
  validerEpost, validerNavn, validerPassord, validerRegistrering,
  normaliserEpost, MIN_PASSORD, MAKS
} from "./brukerlogikk.mjs";

export const I_APP = typeof window !== "undefined" && !!window.__TAURI__;

let bruker = null;
let varslet = false;
const lyttere = new Set();

let appLøfte = null;
function app(){
  if(!appLøfte){
    appLøfte = Promise.all([
      import("./okt-app.mjs"),
      import("../felles/tauri-filer.mjs")
    ]).then(([{ lagAppØkt }, { lagTauriFiler }]) => lagAppØkt({
      filerFor: b => lagTauriFiler({ bruker: b }),
      minne: window.localStorage
    }));
    appLøfte.catch(() => { appLøfte = null; });
  }
  return appLøfte;
}

export function nåværendeBruker(){ return bruker; }

export function settBakgrunnsbruker(id){ husk({ id: String(id) }); }

export function påUtlogget(fn){
  lyttere.add(fn);
  return () => lyttere.delete(fn);
}

export function meldUtlogget(melding){
  bruker = null;
  if(varslet) return;
  varslet = true;
  const m = melding || "Du er logget ut. Logg inn på nytt.";
  lyttere.forEach(fn => { try{ fn(m); }catch{} });
}

function husk(b){ bruker = b || null; varslet = false; }

async function kall(sti, valg = {}){
  let svar;
  try{
    svar = await fetch(sti, {
      ...valg,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(valg.headers || {}) }
    });
  }catch{
    return { ok: false, feil: "frakoblet", melding: "Ingen kontakt med serveren." };
  }

  let kropp = null;
  if(svar.status !== 204){
    try{ kropp = await svar.json(); }catch{}
  }

  if(svar.ok) return { ok: true, status: svar.status, kropp: kropp || {} };

  if(svar.status === 401 && kropp?.feil === "utlogget"){
    meldUtlogget(kropp.melding);
    return { ok: false, feil: "utlogget", melding: kropp.melding || "Du er logget ut." };
  }

  return {
    ok: false,
    feil: kropp?.feil || "ukjent",
    melding: kropp?.melding || `Serveren svarte ${svar.status}.`,
    ...(kropp?.detaljer ? { detaljer: kropp.detaljer } : {}),
    ...(typeof kropp?.retryEtter === "number" ? { retryEtter: kropp.retryEtter } : {})
  };
}

async function iApp(fn){
  try{ return await fn(await app()); }
  catch(e){
    return { ok: false, feil: "frakoblet",
             melding: "Noe gikk galt lokalt. " + String(e?.message || e) };
  }
}

function husket(r){
  if(r.ok && r.bruker) husk(r.bruker);
  return r;
}

const somJson = (metode, data) => ({
  method: metode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(data ?? {})
});

export async function hentØkt(){
  if(I_APP){
    let r;
    try{ r = await (await app()).hentØkt(); }
    catch(e){
      bruker = null;
      return { innlogget: false, harBrukere: false, frakoblet: true,
               melding: "Fikk ikke lest profilene. " + String(e?.message || e) };
    }
    if(r.innlogget) husk(r.bruker); else bruker = null;
    return r;
  }

  const r = await kall("/api/okt");
  if(!r.ok){
    bruker = null;
    return { innlogget: false, harBrukere: false, frakoblet: true,
             melding: "Ingen kontakt med serveren. Kjører den? Start den med «npm start»." };
  }

  const k = r.kropp;
  if(k.innlogget){
    husk(k.bruker);
    return { innlogget: true, bruker: k.bruker, erFørste: !!k.erFørste, harNokkel: !!k.harNokkel };
  }

  bruker = null;
  return { innlogget: false, harBrukere: !!k.harBrukere,
           ...(k.ødelagt ? { ødelagt: true, melding: k.melding } : {}) };
}

export async function registrer({ epost, navn, passord } = {}){
  const v = validerRegistrering({ epost, navn, passord });
  if(!v.ok) return { ok: false, feil: "ugyldig", detaljer: v.feil,
                     melding: "Se over feltene." };

  if(I_APP) return husket(await iApp(a => a.registrer({ epost, navn, passord })));

  const r = await kall("/api/registrer", somJson("POST", { epost, navn, passord }));
  if(!r.ok) return r;
  husk(r.kropp.bruker);
  return { ok: true, bruker: r.kropp.bruker, erFørste: !!r.kropp.erFørste,
           ...(r.kropp.migrert ? { migrert: r.kropp.migrert } : {}),
           ...(r.kropp.migreringsfeil ? { migreringsfeil: r.kropp.migreringsfeil } : {}) };
}

export async function loggInn({ epost, passord } = {}){
  if(I_APP) return husket(await iApp(a => a.loggInn({ epost, passord })));

  const r = await kall("/api/logg-inn", somJson("POST", { epost, passord }));
  if(!r.ok) return r;
  husk(r.kropp.bruker);
  return { ok: true, bruker: r.kropp.bruker, erFørste: !!r.kropp.erFørste };
}

export async function loggUt({ allePlasser = false } = {}){
  const r = I_APP ? await iApp(a => a.loggUt({ allePlasser }))
                  : await kall("/api/logg-ut", somJson("POST", { allePlasser }));
  bruker = null;
  varslet = false;
  return r.ok ? { ok: true } : r;
}

export async function byttPassord({ gammelt, nytt } = {}){
  const p = validerPassord(nytt);
  if(!p.ok) return { ok: false, feil: "ugyldig",
                     detaljer: [{ felt: "nytt", melding: p.melding }], melding: p.melding };
  if(I_APP) return iApp(a => a.byttPassord({ gammelt, nytt }));

  const r = await kall("/api/passord", somJson("POST", { gammelt, nytt }));
  return r.ok ? { ok: true } : r;
}

export async function hentNokkel(){
  if(I_APP) return iApp(a => a.hentNokkel());
  const r = await kall("/api/nokkel");
  return r.ok ? { ok: true, ...r.kropp } : r;
}

export async function settNokkel(nokkel){
  if(I_APP) return iApp(a => a.settNokkel(nokkel));
  const r = await kall("/api/nokkel", somJson("PUT", { nokkel }));
  return r.ok ? { ok: true } : r;
}

export async function fjernNokkel(){
  if(I_APP) return iApp(a => a.fjernNokkel());
  const r = await kall("/api/nokkel", { method: "DELETE" });
  return r.ok ? { ok: true } : r;
}

export { validerEpost, validerNavn, validerPassord, validerRegistrering,
         normaliserEpost, MIN_PASSORD, MAKS };
