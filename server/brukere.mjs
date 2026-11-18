import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { lagFiler, lagLager as lagJobblager } from "./lager.mjs";
import { FILNAVN, FORRIGE } from "../src/soknader/lagerlogikk.mjs";
import { LOGGFIL } from "../src/import/importlogg.mjs";
import { NOKKELFIL } from "./nokkel.mjs";
import {
  ITERASJONER, ALGORITME, SALT_BYTES, NOKKEL_BYTES, ID_BYTES, OKT_LEVETID,
  MAKS, formaterHash, tolkHash, måHashesPåNytt, lagBrukerId, erGyldigBrukerId,
  validerRegistrering, validerInnlogging, validerPassord, offentligBruker,
  migrerRegister, tomtRegister, tilBase64url, fraBase64url,
  lagNyttelast, kodNyttelast, tolkNyttelast, delToken, erUtløpt,
  REGISTERFIL, REGISTER_FORRIGE, BRUKERKATALOG, MAKS_BRUKERE
} from "../src/konto/brukerlogikk.mjs";

const pbkdf2 = promisify(crypto.pbkdf2);

export { REGISTERFIL, REGISTER_FORRIGE, BRUKERKATALOG } from "../src/konto/brukerlogikk.mjs";
export const HEMMELIGHETSFIL  = "okthemmelighet.txt";

export const COOKIE = "okt";

export { MAKS_BRUKERE } from "../src/konto/brukerlogikk.mjs";

export function byggØktcookie(token, maksAlder = OKT_LEVETID){
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maksAlder}`;
}

export function byggSlettcookie(){
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

const MAKS_COOKIEHODE = 8 * 1024;

export function tolkCookies(hode){
  const ut = Object.create(null);
  if(typeof hode !== "string" || !hode || hode.length > MAKS_COOKIEHODE) return ut;
  for(const bit of hode.split(";")){
    const i = bit.indexOf("=");
    if(i < 1) continue;
    const navn = bit.slice(0, i).trim();
    if(!navn || Object.hasOwn(ut, navn)) continue;
    ut[navn] = bit.slice(i + 1).trim();
  }
  return ut;
}

export function lagRatebegrenser({ tak, vindu, maksNøkler = 500 }){
  const kart = new Map();

  const friske = (nøkkel, nå) => {
    const t = (kart.get(nøkkel) ?? []).filter(x => nå - x < vindu);
    if(t.length) kart.set(nøkkel, t); else kart.delete(nøkkel);
    return t;
  };

  return {
    sjekk(nøkkel, nå = Date.now()){
      const t = friske(nøkkel, nå);
      if(t.length < tak) return { ok: true };
      return { ok: false, retryEtter: Math.max(1, Math.ceil((vindu - (nå - t[0])) / 1000)) };
    },
    tell(nøkkel, nå = Date.now()){
      const t = friske(nøkkel, nå);
      t.push(nå);
      kart.delete(nøkkel);
      kart.set(nøkkel, t);
      while(kart.size > maksNøkler) kart.delete(kart.keys().next().value);
    },
    nullstill(nøkkel){ kart.delete(nøkkel); },
    get størrelse(){ return kart.size; }
  };
}

export function lagBrukere({ katalog, nå = () => new Date(),
                             iterasjoner = ITERASJONER } = {}){
  if(!katalog) throw new Error("lagBrukere trenger en katalog");

  const rotFiler = lagFiler(katalog);

  let kø = Promise.resolve();
  function iKø(fn){
    const oppgave = kø.then(fn);
    kø = oppgave.then(() => {}, () => {});
    return oppgave;
  }

  let hemmeligLøfte = null;

  async function hemmelighet(){
    if(!hemmeligLøfte){
      hemmeligLøfte = lesEllerLagHemmelighet();
      hemmeligLøfte.catch(() => { hemmeligLøfte = null; });
    }
    return hemmeligLøfte;
  }

  async function lesEllerLagHemmelighet(){
    const sti = path.join(katalog, HEMMELIGHETSFIL);
    const les = async () => {
      try{ return (await fs.readFile(sti, "utf8")).trim(); }
      catch(e){ if(e.code === "ENOENT") return null; throw e; }
    };

    const finnes = await les();
    if(finnes){
      if(!/^[0-9a-f]{64}$/.test(finnes))
        throw new Error(`${HEMMELIGHETSFIL} har ikke forventet form.`);
      return Buffer.from(finnes, "hex");
    }

    await fs.mkdir(katalog, { recursive: true });
    const ny = crypto.randomBytes(32).toString("hex");
    let fh = null;
    try{
      fh = await fs.open(sti, "wx", 0o600);
      await fh.writeFile(ny + "\n", "utf8");
      await fh.sync();
      return Buffer.from(ny, "hex");
    }catch(e){
      if(e.code !== "EEXIST") throw e;
      const igjen = await les();
      if(!igjen || !/^[0-9a-f]{64}$/.test(igjen))
        throw new Error(`${HEMMELIGHETSFIL} har ikke forventet form.`);
      return Buffer.from(igjen, "hex");
    }finally{
      if(fh) await fh.close().catch(() => {});
    }
  }

  const registerSti = rotFiler.stiTil(REGISTERFIL);

  async function lesRegister(){
    const rå = await rotFiler.lesTekst(REGISTERFIL);
    if(rå == null) return tomtRegister();

    let dok;
    try{ dok = JSON.parse(rå); }
    catch{ return { ødelagt: true, grunn: "Brukerregisteret er ikke gyldig JSON.", sti: registerSti }; }

    const m = migrerRegister(dok);
    if(!m.ok) return { ødelagt: true, grunn: m.grunn, sti: registerSti };
    return m.register;
  }

  async function skrivRegister(reg){
    const dok = {
      versjon: reg.versjon,
      oppdatert: nå().toISOString(),
      brukere: reg.brukere
    };
    await rotFiler.skrivAtomisk(REGISTERFIL, JSON.stringify(dok, null, 2) + "\n",
                                { kopiTil: REGISTER_FORRIGE, modus: 0o600 });
  }

  async function hashPassord(passord, salt = crypto.randomBytes(SALT_BYTES)){
    const nøkkel = await pbkdf2(Buffer.from(passord, "utf8"), salt, iterasjoner, NOKKEL_BYTES, ALGORITME);
    return formaterHash({ iterasjoner, salt, nøkkel, algoritme: ALGORITME });
  }

  async function sjekkPassord(passord, hash){
    const h = tolkHash(hash);
    if(!h.ok) return false;
    const utledet = await pbkdf2(Buffer.from(passord, "utf8"), Buffer.from(h.salt),
                                 h.iterasjoner, h.nøkkel.length, h.algoritme);
    const fasit = Buffer.from(h.nøkkel);
    return utledet.length === fasit.length && crypto.timingSafeEqual(utledet, fasit);
  }

  const DUMMYHASH = formaterHash({
    iterasjoner,
    salt: crypto.randomBytes(SALT_BYTES),
    nøkkel: crypto.randomBytes(NOKKEL_BYTES),
    algoritme: ALGORITME
  });

  async function signer(kropp){
    const h = await hemmelighet();
    return tilBase64url(crypto.createHmac("sha256", h).update(kropp).digest());
  }

  async function lagToken(bruker, tid = nå()){
    const utstedt = Math.floor(tid.getTime() / 1000);
    const kropp = kodNyttelast(lagNyttelast({ id: bruker.id, generasjon: bruker.generasjon, utstedt }));
    return `${kropp}.${await signer(kropp)}`;
  }

  async function verifiserToken(token){
    const delt = delToken(token);
    if(!delt) return null;

    const fikk = fraBase64url(delt.signatur);
    if(!fikk) return null;
    const ventet = crypto.createHmac("sha256", await hemmelighet()).update(delt.kropp).digest();
    if(fikk.length !== ventet.length) return null;
    if(!crypto.timingSafeEqual(Buffer.from(fikk), ventet)) return null;

    const n = tolkNyttelast(delt.kropp);
    if(!n) return null;
    if(erUtløpt(n, Math.floor(nå().getTime() / 1000))) return null;

    const reg = await lesRegister();
    if(reg.ødelagt) return null;
    const bruker = reg.brukere.find(b => b.id === n.b);
    if(!bruker || bruker.generasjon !== n.g) return null;

    return { bruker, erFørste: reg.brukere[0]?.id === bruker.id, nyttelast: n };
  }

  const lagre = new Map();

  function lagerFor(id){
    if(!erGyldigBrukerId(id)) throw new Error("ugyldig bruker-id");

    let e = lagre.get(id);
    if(e){
      lagre.delete(id); lagre.set(id, e);
      return e;
    }

    const egenKatalog = path.join(katalog, BRUKERKATALOG, id);
    const filer  = lagFiler(egenKatalog);
    const indre  = lagJobblager({ katalog: egenKatalog });

    let ivente = 0;
    const lager = {
      ...indre,
      skriv(...a){
        ivente++;
        const p = indre.skriv(...a);
        const ferdig = () => { ivente--; };
        p.then(ferdig, ferdig);
        return p;
      }
    };

    e = { id, katalog: egenKatalog, filer, lager, get ledig(){ return ivente === 0; } };
    lagre.set(id, e);

    while(lagre.size > MAKS_BRUKERE){
      const offer = [...lagre.values()].find(x => x !== e && x.ledig);
      if(!offer) break;
      lagre.delete(offer.id);
    }
    return e;
  }

  const MIGRERES = [
    { fra: FILNAVN, til: FILNAVN },
    { fra: FORRIGE, til: FORRIGE },
    { fra: LOGGFIL, til: LOGGFIL },
    { fra: NOKKELFIL, til: NOKKELFIL, modus: 0o600 }
  ];

  async function migrerTil(id){
    const { filer } = lagerFor(id);
    const flyttet = [];
    for(const f of MIGRERES){
      const rå = await rotFiler.lesTekst(f.fra);
      if(rå == null) continue;
      await filer.skrivAtomisk(f.til, rå, f.modus ? { modus: f.modus } : {});
      flyttet.push(f.til);
    }
    return flyttet;
  }

  async function status(){
    const reg = await lesRegister();
    if(reg.ødelagt) return { ødelagt: true, grunn: reg.grunn };
    return { harBrukere: reg.brukere.length > 0, antall: reg.brukere.length };
  }

  async function erFørste(id){
    const reg = await lesRegister();
    if(reg.ødelagt) return false;
    return reg.brukere[0]?.id === id;
  }

  function registrer(inn){
    return iKø(async () => {
      const v = validerRegistrering(inn);
      if(!v.ok) return { ok: false, feil: "ugyldig", detaljer: v.feil };

      const reg = await lesRegister();
      if(reg.ødelagt) return { ok: false, feil: "ødelagt-register", grunn: reg.grunn };

      if(reg.brukere.length >= MAKS_BRUKERE)
        return { ok: false, feil: "stengt" };
      if(reg.brukere.some(b => b.epost === v.verdi.epost))
        return { ok: false, feil: "finnes" };

      const først = reg.brukere.length === 0;
      const hash  = await hashPassord(v.verdi.passord);
      const tid   = nå().toISOString();

      let id;
      do{ id = lagBrukerId(crypto.randomBytes(ID_BYTES)); }
      while(reg.brukere.some(b => b.id === id));

      const bruker = { id, epost: v.verdi.epost, navn: v.verdi.navn, hash,
                       generasjon: 1, opprettet: tid, sistInnlogget: tid };

      let migrert = null, migreringsfeil = null;
      if(først){
        try{ migrert = await migrerTil(id); }
        catch(e){ migreringsfeil = String(e?.message || e); }
      }

      await skrivRegister({ versjon: reg.versjon, brukere: [...reg.brukere, bruker] });

      return { ok: true, bruker, erFørste: først, token: await lagToken(bruker),
               ...(migrert && migrert.length ? { migrert } : {}),
               ...(migreringsfeil ? { migreringsfeil } : {}) };
    });
  }

  async function loggInn(inn){
    const v = validerInnlogging(inn);
    const reg = await lesRegister();
    if(reg.ødelagt) return { ok: false, feil: "ødelagt-register", grunn: reg.grunn };

    const bruker = v.ok ? reg.brukere.find(b => b.epost === v.verdi.epost) : null;
    const passord = v.ok ? v.verdi.passord : "";
    const treff = await sjekkPassord(passord, bruker ? bruker.hash : DUMMYHASH);

    if(!bruker || !treff) return { ok: false, feil: "feil-innlogging" };

    const oppdatert = { ...bruker, sistInnlogget: nå().toISOString() };
    if(måHashesPåNytt(bruker.hash)) oppdatert.hash = await hashPassord(passord);

    await iKø(async () => {
      const fersk = await lesRegister();
      if(fersk.ødelagt) return;
      const i = fersk.brukere.findIndex(b => b.id === bruker.id);
      if(i < 0) return;
      fersk.brukere[i] = { ...fersk.brukere[i],
                           hash: oppdatert.hash,
                           sistInnlogget: oppdatert.sistInnlogget };
      await skrivRegister(fersk);
      oppdatert.generasjon = fersk.brukere[i].generasjon;
    }).catch(() => {});

    return { ok: true, bruker: oppdatert,
             erFørste: reg.brukere[0]?.id === bruker.id,
             token: await lagToken(oppdatert) };
  }

  function loggUtAlle(id){
    return iKø(async () => {
      const reg = await lesRegister();
      if(reg.ødelagt) return { ok: false, feil: "ødelagt-register" };
      const i = reg.brukere.findIndex(b => b.id === id);
      if(i < 0) return { ok: false, feil: "ukjent" };
      reg.brukere[i] = { ...reg.brukere[i], generasjon: reg.brukere[i].generasjon + 1 };
      await skrivRegister(reg);
      return { ok: true, bruker: reg.brukere[i] };
    });
  }

  function byttPassord(id, gammelt, nytt){
    return iKø(async () => {
      const p = validerPassord(nytt);
      if(!p.ok) return { ok: false, feil: "ugyldig", detaljer: [{ felt: "nytt", melding: p.melding }] };

      const reg = await lesRegister();
      if(reg.ødelagt) return { ok: false, feil: "ødelagt-register" };
      const i = reg.brukere.findIndex(b => b.id === id);
      if(i < 0) return { ok: false, feil: "ukjent" };

      if(!(await sjekkPassord(typeof gammelt === "string" ? gammelt : "", reg.brukere[i].hash)))
        return { ok: false, feil: "feil-passord" };

      const oppdatert = { ...reg.brukere[i],
                          hash: await hashPassord(p.verdi),
                          generasjon: reg.brukere[i].generasjon + 1 };
      reg.brukere[i] = oppdatert;
      await skrivRegister(reg);
      return { ok: true, bruker: oppdatert, token: await lagToken(oppdatert) };
    });
  }

  return {
    katalog,
    rotFiler,
    registerSti,
    status, erFørste, lesRegister,
    registrer, loggInn, loggUtAlle, byttPassord,
    lagToken, verifiserToken,
    lagerFor,
    _hemmelighet: hemmelighet,
    get antallLagre(){ return lagre.size; }
  };
}

export { offentligBruker };
export default lagBrukere;
