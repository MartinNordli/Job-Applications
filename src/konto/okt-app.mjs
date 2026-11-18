import {
  ITERASJONER, ALGORITME, SALT_BYTES, NOKKEL_BYTES, ID_BYTES,
  OKT_LEVETID, MAKS_BRUKERE, REGISTERFIL, REGISTER_FORRIGE, NOKKELFIL,
  formaterHash, tolkHash, måHashesPåNytt, likeBytes, tilBytes,
  lagBrukerId, erGyldigBrukerId, offentligBruker,
  validerRegistrering, validerInnlogging, validerPassord,
  validerNokkel, hale, migrerRegister, tomtRegister
} from "./brukerlogikk.mjs";

import { FILNAVN, FORRIGE } from "../soknader/lagerlogikk.mjs";
import { LOGGFIL } from "../import/importlogg.mjs";

export const ØKTNØKKEL = "jobbsoknader-okt";

const MIGRERES = [FILNAVN, FORRIGE, LOGGFIL, NOKKELFIL];

export function lagAppØkt({ filerFor, minne, nå = () => new Date(),
                            iterasjoner = ITERASJONER,
                            krypto = globalThis.crypto } = {}){
  if(typeof filerFor !== "function") throw new Error("lagAppØkt trenger filerFor");
  if(!minne) throw new Error("lagAppØkt trenger et minne");

  const filerCache = new Map();
  function filer(bruker){
    const nøkkel = bruker ?? "";
    if(!filerCache.has(nøkkel)){
      const løfte = Promise.resolve().then(() => filerFor(bruker ?? null));
      løfte.catch(() => filerCache.delete(nøkkel));
      filerCache.set(nøkkel, løfte);
    }
    return filerCache.get(nøkkel);
  }
  const rot = () => filer(null);

  let kø = Promise.resolve();
  function iKø(fn){
    const oppgave = kø.then(fn);
    kø = oppgave.then(() => {}, () => {});
    return oppgave;
  }

  async function lesRegister(){
    const rå = await (await rot()).lesTekst(REGISTERFIL);
    if(rå == null) return tomtRegister();

    let dok;
    try{ dok = JSON.parse(rå); }
    catch{ return { ødelagt: true, grunn: "Brukerregisteret er ikke gyldig JSON." }; }

    const m = migrerRegister(dok);
    if(!m.ok) return { ødelagt: true, grunn: m.grunn };
    return m.register;
  }

  async function skrivRegister(reg){
    const dok = { versjon: reg.versjon, oppdatert: nå().toISOString(), brukere: reg.brukere };
    await (await rot()).skrivAtomisk(REGISTERFIL, JSON.stringify(dok, null, 2) + "\n",
                                     { kopiTil: REGISTER_FORRIGE });
  }

  const hashNavn = a => (a === "sha512" ? "SHA-512" : "SHA-256");

  async function utled(passord, salt, iter, bytes, algoritme){
    const materiale = await krypto.subtle.importKey(
      "raw", tilBytes(passord), "PBKDF2", false, ["deriveBits"]);
    const bits = await krypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: iter, hash: hashNavn(algoritme) },
      materiale, bytes * 8);
    return new Uint8Array(bits);
  }

  async function hashPassord(passord){
    const salt = krypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const nøkkel = await utled(passord, salt, iterasjoner, NOKKEL_BYTES, ALGORITME);
    return formaterHash({ iterasjoner, salt, nøkkel, algoritme: ALGORITME });
  }

  async function sjekkPassord(passord, hash){
    const h = tolkHash(hash);
    if(!h.ok) return false;
    const utledet = await utled(passord, h.salt, h.iterasjoner, h.nøkkel.length, h.algoritme);
    return likeBytes(utledet, h.nøkkel);
  }

  const nåSekunder = () => Math.floor(nå().getTime() / 1000);

  function lesØkt(){
    let o;
    try{ o = JSON.parse(minne.getItem(ØKTNØKKEL)); }
    catch{ return null; }
    if(!o || typeof o !== "object") return null;
    if(!erGyldigBrukerId(o.id)) return null;
    if(!Number.isInteger(o.utløper) || o.utløper <= nåSekunder()) return null;
    return { id: o.id, utløper: o.utløper };
  }

  function settØkt(id){
    try{ minne.setItem(ØKTNØKKEL, JSON.stringify({ id, utløper: nåSekunder() + OKT_LEVETID })); }
    catch{}
  }

  function glemØkt(){
    try{ minne.removeItem(ØKTNØKKEL); }catch{}
  }

  async function lesNokkel(id){
    const t = await (await filer(id)).lesTekst(NOKKELFIL);
    return (typeof t === "string" && t.trim()) || null;
  }

  async function migrerTil(id){
    const fra = await rot();
    const til = await filer(id);
    const flyttet = [];
    for(const navn of MIGRERES){
      const rå = await fra.lesTekst(navn);
      if(rå == null) continue;
      await til.skrivAtomisk(navn, rå);
      flyttet.push(navn);
    }
    return flyttet;
  }

  const frakoblet = e => ({
    innlogget: false, harBrukere: false, frakoblet: true,
    melding: "Fikk ikke lest profilene fra datakatalogen. " + tekstFra(e)
  });

  async function hentØkt(){
    let reg;
    try{ reg = await lesRegister(); }
    catch(e){ return frakoblet(e); }

    if(reg.ødelagt)
      return { innlogget: false, harBrukere: true, ødelagt: true,
               melding: reg.grunn + " Rett opp " + REGISTERFIL + " før du logger inn." };

    const harBrukere = reg.brukere.length > 0;
    const økt = lesØkt();
    if(!økt) return { innlogget: false, harBrukere };

    const bruker = reg.brukere.find(b => b.id === økt.id);
    if(!bruker){ glemØkt(); return { innlogget: false, harBrukere }; }

    let harNokkel = false;
    try{ harNokkel = !!(await lesNokkel(bruker.id)); }
    catch{}

    return { innlogget: true, bruker: offentligBruker(bruker),
             erFørste: reg.brukere[0].id === bruker.id, harNokkel };
  }

  function registrer(inn){
    return iKø(async () => {
      const v = validerRegistrering(inn);
      if(!v.ok) return { ok: false, feil: "ugyldig", detaljer: v.feil, melding: "Se over feltene." };

      let reg;
      try{ reg = await lesRegister(); }
      catch(e){ return feilsvar(e); }

      if(reg.ødelagt)
        return { ok: false, feil: "ødelagt-register", melding: "Brukerregisteret kan ikke leses." };
      if(reg.brukere.length >= MAKS_BRUKERE)
        return { ok: false, feil: "stengt", melding: "Det er ikke plass til flere profiler." };
      if(reg.brukere.some(b => b.epost === v.verdi.epost))
        return { ok: false, feil: "finnes", melding: "Det finnes allerede en profil med den adressen." };

      const først = reg.brukere.length === 0;
      const tid = nå().toISOString();

      let hash, id;
      try{
        hash = await hashPassord(v.verdi.passord);
        do{ id = lagBrukerId(krypto.getRandomValues(new Uint8Array(ID_BYTES))); }
        while(reg.brukere.some(b => b.id === id));
      }catch(e){ return feilsvar(e); }

      const bruker = { id, epost: v.verdi.epost, navn: v.verdi.navn, hash,
                       generasjon: 1, opprettet: tid, sistInnlogget: tid };

      let migrert = null, migreringsfeil = null;
      if(først){
        try{ migrert = await migrerTil(id); }
        catch(e){ migreringsfeil = tekstFra(e); }
      }

      try{ await skrivRegister({ versjon: reg.versjon, brukere: [...reg.brukere, bruker] }); }
      catch(e){ return feilsvar(e); }

      settØkt(id);
      return { ok: true, bruker: offentligBruker(bruker), erFørste: først,
               ...(migrert && migrert.length ? { migrert } : {}),
               ...(migreringsfeil ? { migreringsfeil } : {}) };
    });
  }

  async function loggInn(inn){
    const v = validerInnlogging(inn);

    let reg;
    try{ reg = await lesRegister(); }
    catch(e){ return feilsvar(e); }
    if(reg.ødelagt)
      return { ok: false, feil: "ødelagt-register", melding: "Brukerregisteret kan ikke leses." };

    const bruker = v.ok ? reg.brukere.find(b => b.epost === v.verdi.epost) : null;
    if(!bruker || !(await sjekkPassord(v.verdi.passord, bruker.hash).catch(() => false)))
      return { ok: false, feil: "feil-innlogging", melding: "Feil e-postadresse eller passord." };

    settØkt(bruker.id);

    iKø(async () => {
      const fersk = await lesRegister();
      if(fersk.ødelagt) return;
      const i = fersk.brukere.findIndex(b => b.id === bruker.id);
      if(i < 0) return;
      const rad = { ...fersk.brukere[i], sistInnlogget: nå().toISOString() };
      if(måHashesPåNytt(rad.hash)) rad.hash = await hashPassord(v.verdi.passord);
      fersk.brukere[i] = rad;
      await skrivRegister(fersk);
    }).catch(() => {});

    return { ok: true, bruker: offentligBruker(bruker),
             erFørste: reg.brukere[0].id === bruker.id };
  }

  async function loggUt(){
    glemØkt();
    return { ok: true };
  }

  function byttPassord({ gammelt, nytt } = {}){
    return iKø(async () => {
      const p = validerPassord(nytt);
      if(!p.ok) return { ok: false, feil: "ugyldig",
                         detaljer: [{ felt: "nytt", melding: p.melding }], melding: p.melding };

      const økt = lesØkt();
      if(!økt) return { ok: false, feil: "utlogget", melding: "Du er logget ut. Logg inn på nytt." };

      let reg;
      try{ reg = await lesRegister(); }
      catch(e){ return feilsvar(e); }
      if(reg.ødelagt)
        return { ok: false, feil: "ødelagt-register", melding: "Brukerregisteret kan ikke leses." };

      const i = reg.brukere.findIndex(b => b.id === økt.id);
      if(i < 0) return { ok: false, feil: "utlogget", melding: "Du er logget ut. Logg inn på nytt." };

      if(!(await sjekkPassord(typeof gammelt === "string" ? gammelt : "",
                              reg.brukere[i].hash).catch(() => false)))
        return { ok: false, feil: "feil-passord", melding: "Det gamle passordet stemmer ikke." };

      try{
        reg.brukere[i] = { ...reg.brukere[i], hash: await hashPassord(p.verdi),
                           generasjon: reg.brukere[i].generasjon + 1 };
        await skrivRegister(reg);
      }catch(e){ return feilsvar(e); }

      settØkt(reg.brukere[i].id);
      return { ok: true };
    });
  }

  async function hentNokkel(){
    const økt = lesØkt();
    if(!økt) return utlogget();
    let n;
    try{ n = await lesNokkel(økt.id); }
    catch(e){ return feilsvar(e); }
    if(!n) return { ok: true, finnes: false, kilde: "ingen" };
    const h = hale(n);
    return { ok: true, finnes: true, kilde: "egen", ...(h ? { hale: h } : {}) };
  }

  async function settNokkel(nokkel){
    const økt = lesØkt();
    if(!økt) return utlogget();
    const v = validerNokkel(nokkel);
    if(!v.ok) return { ok: false, feil: "ugyldig", melding: v.melding };
    try{ await (await filer(økt.id)).skrivAtomisk(NOKKELFIL, v.verdi + "\n"); }
    catch(e){ return feilsvar(e); }
    return { ok: true };
  }

  async function fjernNokkel(){
    const økt = lesØkt();
    if(!økt) return utlogget();
    try{ await (await filer(økt.id)).skrivAtomisk(NOKKELFIL, ""); }
    catch(e){ return feilsvar(e); }
    return { ok: true };
  }

  return { hentØkt, registrer, loggInn, loggUt, byttPassord,
           hentNokkel, settNokkel, fjernNokkel,
           innloggetId: () => (lesØkt()?.id ?? null) };
}

const tekstFra = e => (typeof e === "string" ? e : String(e?.message || e || "Ukjent feil."));

const utlogget = () => ({ ok: false, feil: "utlogget", melding: "Du er logget ut. Logg inn på nytt." });

const feilsvar = e => ({ ok: false, feil: "frakoblet",
                         melding: "Fikk ikke skrevet til datakatalogen. " + tekstFra(e) });

export default lagAppØkt;
