export const MAKS = {
  epost: 254,
  navn: 100,
  passord: 200,
  hash: 512,
  token: 1024
};

export const MIN_PASSORD = 10;

export const ITERASJONER = 600_000;
export const ALGORITME   = "sha256";
export const SALT_BYTES  = 16;
export const NOKKEL_BYTES = 32;

export const ID_BYTES = 8;

export const OKT_LEVETID = 30 * 24 * 60 * 60;

export const REGISTER_VERSJON = 1;

export const REGISTERFIL      = "brukere.json";
export const REGISTER_FORRIGE = "brukere.forrige.json";
export const BRUKERKATALOG    = "brukere";
export const NOKKELFIL        = "nokkel.txt";

export const MAKS_BRUKERE = 20;

export const MIN_NOKKEL = 20;
export const MAKS_NOKKEL = 500;

export const MIN_FOR_HALE = 12;

export function validerNokkel(v){
  if(typeof v !== "string") return { ok: false, melding: "Lim inn API-nøkkelen." };
  const n = v.trim();
  if(!n) return { ok: false, melding: "Lim inn API-nøkkelen." };
  if(n.length < MIN_NOKKEL || n.length > MAKS_NOKKEL)
    return { ok: false, melding: `Nøkkelen må være mellom ${MIN_NOKKEL} og ${MAKS_NOKKEL} tegn.` };
  for(let i = 0; i < n.length; i++){
    const k = n.charCodeAt(i);
    if(k < 0x21 || k > 0x7e)
      return { ok: false, melding: "Nøkkelen inneholder tegn som ikke hører hjemme i en API-nøkkel." };
  }
  return { ok: true, verdi: n };
}

export const hale = n =>
  (typeof n === "string" && n.length >= MIN_FOR_HALE) ? n.slice(-4) : null;

const ALFABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function tilBase64url(bytes){
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes ?? []);
  let ut = "";
  for(let i = 0; i < b.length; i += 3){
    const igjen = b.length - i;
    const n = (b[i] << 16) | ((igjen > 1 ? b[i + 1] : 0) << 8) | (igjen > 2 ? b[i + 2] : 0);
    ut += ALFABET[(n >> 18) & 63] + ALFABET[(n >> 12) & 63];
    if(igjen > 1) ut += ALFABET[(n >> 6) & 63];
    if(igjen > 2) ut += ALFABET[n & 63];
  }
  return ut;
}

export function fraBase64url(s){
  if(typeof s !== "string") return null;
  if(s.length % 4 === 1) return null;
  let buf = 0, bits = 0, j = 0;
  const ut = new Uint8Array(Math.floor((s.length * 6) / 8));
  for(let i = 0; i < s.length; i++){
    const v = ALFABET.indexOf(s[i]);
    if(v < 0) return null;
    buf = (buf << 6) | v;
    bits += 6;
    if(bits >= 8){ bits -= 8; ut[j++] = (buf >> bits) & 255; }
  }
  return ut.subarray(0, j);
}

const koder = new TextEncoder();
const dekoder = new TextDecoder("utf-8", { fatal: false });

export const tilBytes = s => koder.encode(String(s ?? ""));
export const fraBytes = b => dekoder.decode(b);

export function likeBytes(a, b){
  const x = a instanceof Uint8Array ? a : Uint8Array.from(a ?? []);
  const y = b instanceof Uint8Array ? b : Uint8Array.from(b ?? []);
  if(x.length !== y.length) return false;
  let ulik = 0;
  for(let i = 0; i < x.length; i++) ulik |= x[i] ^ y[i];
  return ulik === 0;
}

export function lagBrukerId(bytes){
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes ?? []);
  if(b.length !== ID_BYTES) throw new Error(`bruker-id trenger ${ID_BYTES} byte`);
  let ut = "";
  for(const x of b) ut += x.toString(16).padStart(2, "0");
  return ut;
}

export const erGyldigBrukerId = v => typeof v === "string" && /^[0-9a-f]{16}$/.test(v);

export function formaterHash({ iterasjoner, salt, nøkkel, algoritme = ALGORITME }){
  return ["pbkdf2", algoritme, String(iterasjoner),
          tilBase64url(salt), tilBase64url(nøkkel)].join("$");
}

export function tolkHash(streng){
  if(typeof streng !== "string" || !streng || streng.length > MAKS.hash) return { ok: false };
  const d = streng.split("$");
  if(d.length !== 5 || d[0] !== "pbkdf2") return { ok: false };
  if(d[1] !== "sha256" && d[1] !== "sha512") return { ok: false };

  const iterasjoner = Number(d[2]);
  if(!Number.isInteger(iterasjoner) || iterasjoner < 1 || iterasjoner > 5_000_000) return { ok: false };

  const salt = fraBase64url(d[3]);
  const nøkkel = fraBase64url(d[4]);
  if(!salt || !nøkkel) return { ok: false };
  if(salt.length < 8 || salt.length > 64) return { ok: false };
  if(nøkkel.length < 16 || nøkkel.length > 64) return { ok: false };

  return { ok: true, algoritme: d[1], iterasjoner, salt, nøkkel };
}

export function måHashesPåNytt(streng){
  const h = tolkHash(streng);
  if(!h.ok) return false;
  return h.algoritme !== ALGORITME
      || h.iterasjoner < ITERASJONER
      || h.salt.length < SALT_BYTES
      || h.nøkkel.length < NOKKEL_BYTES;
}

const tekst = v => (v == null ? "" : String(v)).trim();

const harKontrolltegn = s => /[\u0000-\u001f\u007f]/.test(s);

export function normaliserEpost(v){
  return tekst(v).toLowerCase();
}

export function validerEpost(v){
  const e = normaliserEpost(v);
  if(!e) return { ok: false, melding: "Skriv inn e-postadressen din." };
  if(e.length > MAKS.epost) return { ok: false, melding: `Adressen er for lang (maks ${MAKS.epost} tegn).` };
  if(harKontrolltegn(e)) return { ok: false, melding: "Adressen inneholder ugyldige tegn." };
  if(!/^[^\s@,;:<>"'\\]+@[^\s@,;:<>"'\\]+\.[^\s@.,;:<>"'\\]{2,}$/.test(e))
    return { ok: false, melding: "Det ser ikke ut som en e-postadresse." };
  return { ok: true, verdi: e };
}

export function validerNavn(v){
  const n = tekst(v);
  if(!n) return { ok: true, verdi: "" };
  if(n.length > MAKS.navn) return { ok: false, melding: `Navnet er for langt (maks ${MAKS.navn} tegn).` };
  if(harKontrolltegn(n)) return { ok: false, melding: "Navnet inneholder ugyldige tegn." };
  return { ok: true, verdi: n };
}

export function validerPassord(v){
  if(typeof v !== "string" || v === "")
    return { ok: false, melding: "Skriv inn et passord." };
  if(v.length < MIN_PASSORD)
    return { ok: false, melding: `Passordet må ha minst ${MIN_PASSORD} tegn.` };
  if(v.length > MAKS.passord)
    return { ok: false, melding: `Passordet kan ha høyst ${MAKS.passord} tegn.` };
  if(/[\u0000]/.test(v))
    return { ok: false, melding: "Passordet inneholder ugyldige tegn." };
  return { ok: true, verdi: v };
}

export function validerRegistrering(inn){
  const o = (inn && typeof inn === "object" && !Array.isArray(inn)) ? inn : null;
  if(!o) return { ok: false, feil: [{ felt: null, melding: "Forventet {epost, navn, passord}." }], verdi: null };

  const feil = [];
  const e = validerEpost(o.epost);
  if(!e.ok) feil.push({ felt: "epost", melding: e.melding });
  const n = validerNavn(o.navn);
  if(!n.ok) feil.push({ felt: "navn", melding: n.melding });
  const p = validerPassord(o.passord);
  if(!p.ok) feil.push({ felt: "passord", melding: p.melding });

  if(feil.length) return { ok: false, feil, verdi: null };
  return { ok: true, feil: [], verdi: { epost: e.verdi, navn: n.verdi, passord: p.verdi } };
}

export function validerInnlogging(inn){
  const o = (inn && typeof inn === "object" && !Array.isArray(inn)) ? inn : null;
  if(!o) return { ok: false };
  const epost = normaliserEpost(o.epost);
  const passord = typeof o.passord === "string" ? o.passord : "";
  if(!epost || epost.length > MAKS.epost) return { ok: false };
  if(!passord || passord.length > MAKS.passord) return { ok: false };
  return { ok: true, verdi: { epost, passord } };
}

export function offentligBruker(b){
  return b ? { id: b.id, epost: b.epost, navn: b.navn || "" } : null;
}

function validerRad(rad){
  const o = (rad && typeof rad === "object" && !Array.isArray(rad)) ? rad : null;
  if(!o) return null;
  if(!erGyldigBrukerId(o.id)) return null;

  const e = validerEpost(o.epost);
  if(!e.ok) return null;
  if(!tolkHash(o.hash).ok) return null;

  const generasjon = Number.isInteger(o.generasjon) && o.generasjon >= 1 ? o.generasjon : 1;
  const n = validerNavn(o.navn);

  return {
    id: o.id,
    epost: e.verdi,
    navn: n.ok ? n.verdi : "",
    hash: o.hash,
    generasjon,
    opprettet: typeof o.opprettet === "string" && o.opprettet.length <= 40 ? o.opprettet : null,
    sistInnlogget: typeof o.sistInnlogget === "string" && o.sistInnlogget.length <= 40 ? o.sistInnlogget : null
  };
}

export function validerRegister(dok){
  if(!dok || typeof dok !== "object" || Array.isArray(dok) || !Array.isArray(dok.brukere))
    return { ok: false, grunn: "Registeret har ikke forventet form." };

  const versjon = Number.isInteger(dok.versjon) && dok.versjon >= 1 ? dok.versjon : 0;
  if(!versjon) return { ok: false, grunn: "Registeret mangler versjonsnummer." };

  const brukere = [], idSett = new Set(), epostSett = new Set(), forkastet = [];
  dok.brukere.forEach((rad, indeks) => {
    const r = validerRad(rad);
    if(!r){ forkastet.push(indeks); return; }
    if(idSett.has(r.id) || epostSett.has(r.epost)){ forkastet.push(indeks); return; }
    idSett.add(r.id); epostSett.add(r.epost);
    brukere.push(r);
  });

  return { ok: true, versjon, brukere, forkastet };
}

export function migrerRegister(dok){
  const r = validerRegister(dok);
  if(!r.ok) return r;
  if(r.versjon > REGISTER_VERSJON)
    return { ok: false, grunn: `Registeret er skrevet av en nyere versjon (${r.versjon}).` };
  return { ok: true, register: { versjon: REGISTER_VERSJON, brukere: r.brukere }, forkastet: r.forkastet };
}

export const tomtRegister = () => ({ versjon: REGISTER_VERSJON, brukere: [] });

export function lagNyttelast({ id, generasjon, utstedt, levetid = OKT_LEVETID }){
  return { b: id, g: generasjon, u: utstedt, e: utstedt + levetid };
}

export const kodNyttelast = n => tilBase64url(tilBytes(JSON.stringify(n)));

export function tolkNyttelast(kropp){
  const bytes = fraBase64url(kropp);
  if(!bytes || bytes.length > MAKS.token) return null;
  let o;
  try{ o = JSON.parse(fraBytes(bytes)); }catch{ return null; }
  if(!o || typeof o !== "object" || Array.isArray(o)) return null;
  if(!erGyldigBrukerId(o.b)) return null;
  if(!Number.isInteger(o.g) || o.g < 1) return null;
  if(!Number.isInteger(o.u) || !Number.isInteger(o.e)) return null;
  if(o.e <= o.u) return null;
  return { b: o.b, g: o.g, u: o.u, e: o.e };
}

export function delToken(token){
  if(typeof token !== "string" || !token || token.length > MAKS.token) return null;
  const d = token.split(".");
  if(d.length !== 2 || !d[0] || !d[1]) return null;
  return { kropp: d[0], signatur: d[1] };
}

export const erUtløpt = (n, nåSekunder) => !n || n.e <= nåSekunder;

export default { validerRegistrering, validerRegister, migrerRegister };
