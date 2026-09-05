/* ============================================================
   Brukerlogikk — reglene for kontoer og økter, uten et filsystem
   og uten et nett.

   Speiler felles.mjs: Node-serveren, nettleseren og appmodus skal
   behandle en konto likt, så reglene ligger ett sted og den som
   kaller sender inn det som må komme utenfra (tilfeldige byte,
   klokken, og selve utledningen av hashen).

   Derfor ingen node:-import, ingen Buffer, ingen atob. Alt som
   trengs av koding er skrevet for hånd her nede, og modulen kan
   lastes rett inn i et Tauri-webview i Fase 4.

   Passordreglene følger NIST 800-63B: lengde, ikke tegnklasser.
   Maksgrensen er ikke kosmetikk — den binder kostnaden av det
   PBKDF2-kallet som gjøres på hvert innloggingsforsøk.
   ============================================================ */

/* ---------- grenser ---------- */

export const MAKS = {
  epost: 254,          /* RFC 5321s grense for en adresse */
  navn: 100,
  passord: 200,
  hash: 512,
  token: 1024
};

export const MIN_PASSORD = 10;

/* Hashen er selvbeskrivende, så tallet kan heves senere uten å låse
   gamle kontoer ute: måHashesPåNytt() sier fra, og innloggingen som
   nettopp lyktes vet passordet og kan skrive en ny hash. */
export const ITERASJONER = 600_000;
export const ALGORITME   = "sha256";
export const SALT_BYTES  = 16;
export const NOKKEL_BYTES = 32;

/* Én bruker-id er 16 heksadesimale tegn. Ikke UUID med bindestreker:
   id-en blir et katalognavn, og heksadesimalt er allerede lovlig i
   trygt_navn() på Rust-siden, som dermed slipper å utvides. */
export const ID_BYTES = 8;

/* Tretti dager. Ingen øktfil på disk, så prisen for lang levetid er
   null skrivinger — og motstykket er at en enkelt økt ikke kan
   tilbakekalles, bare alle på én gang via generasjonen. */
export const OKT_LEVETID = 30 * 24 * 60 * 60;

/* Registerets skjemaversjon. Leses en nyere fil, nekter vi å røre
   den: å skrive v1 oppå v2 ville stille kastet felt vi ikke kjenner. */
export const REGISTER_VERSJON = 1;

/* ---------- filnavnene rundt registeret ---------- */
/*
   Her, og ikke i server/brukere.mjs, fordi appmodus trenger de
   samme navnene og ikke kan importere noe som rører node:. Node
   reeksporterer dem derfra, så det finnes fortsatt ett sted å
   endre dem. Selve sammensettingen av stier skjer hos den som har
   et filsystem: server/lager.mjs i nettlesermodus, Rust i appen.
*/
export const REGISTERFIL      = "brukere.json";
export const REGISTER_FORRIGE = "brukere.forrige.json";
export const BRUKERKATALOG    = "brukere";
export const NOKKELFIL        = "nokkel.txt";

/* Hardt tak på antall kontoer. Registrering er åpen, og uten et tak
   er «opprett konto» en måte å fylle disken på. */
export const MAKS_BRUKERE = 20;

/* ---------- API-nøkkelens form ---------- */
/*
   Dette er en sikkerhetsregel, ikke høflighet: nøkkelen havner rett
   i x-api-key. Derfor 20–500 tegn etter trimming og bare tegn i
   0x21–0x7E, som avviser CR, LF, tab, mellomrom og alle kontrolltegn
   og lukker hodeinjeksjon før verdien når noe som sender den.
   Formatet forøvrig valideres IKKE — «sk-ant-»-prefikset kan endre
   seg, og vi skal ikke være grunnen til at en gyldig nøkkel avvises.

   Regelen ligger her, og ikke bare i server/nokkel.mjs, fordi
   appmodus skriver nøkkelfilen selv og må holde nøyaktig samme krav.
*/
export const MIN_NOKKEL = 20;
export const MAKS_NOKKEL = 500;

/* Fire siste tegn er nok til å kjenne igjen hvilken nøkkel som ligger
   der, og for lite til å være verdt noe. Under tolv tegn er det en
   for stor andel av hemmeligheten, og da sier vi ingenting. */
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

/* ---------- base64url ---------- */
/*
   Skrevet for hånd fordi modulen skal virke tre steder: Node har
   Buffer, nettleseren har atob, og ingen av dem har begge deler i
   samme form. Ingen «=»-fyll — det er url-varianten.
*/
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

/* null, ikke unntak, ved ugyldig inndata: dette kalles på tekst som
   kommer rett fra en cookie, og en kaster er ikke et bedre svar. */
export function fraBase64url(s){
  if(typeof s !== "string") return null;
  if(s.length % 4 === 1) return null;                 /* umulig lengde */
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

/* Sammenlikning uten tidslekkasje. Node bruker timingSafeEqual;
   denne finnes for nettleseren og appmodus, som ikke har den. */
export function likeBytes(a, b){
  const x = a instanceof Uint8Array ? a : Uint8Array.from(a ?? []);
  const y = b instanceof Uint8Array ? b : Uint8Array.from(b ?? []);
  if(x.length !== y.length) return false;
  let ulik = 0;
  for(let i = 0; i < x.length; i++) ulik |= x[i] ^ y[i];
  return ulik === 0;
}

/* ---------- bruker-id ---------- */

export function lagBrukerId(bytes){
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes ?? []);
  if(b.length !== ID_BYTES) throw new Error(`bruker-id trenger ${ID_BYTES} byte`);
  let ut = "";
  for(const x of b) ut += x.toString(16).padStart(2, "0");
  return ut;
}

export const erGyldigBrukerId = v => typeof v === "string" && /^[0-9a-f]{16}$/.test(v);

/* ---------- hashformat ---------- */
/*
   pbkdf2$sha256$600000$<salt>$<nøkkel>, begge base64url.
   Selvbeskrivende med vilje: alt verifiseringen trenger står i
   strengen, så en hevet iterasjonsgrense ikke låser noen ute.
*/
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

/* Sant når hashen er gyldig, men svakere enn dagens innstilling.
   Kalles etter en vellykket innlogging, som er det ene tidspunktet
   passordet finnes i klartekst og en rehash er gratis for brukeren. */
export function måHashesPåNytt(streng){
  const h = tolkHash(streng);
  if(!h.ok) return false;                 /* ugyldig er ikke «gammel», det er ødelagt */
  return h.algoritme !== ALGORITME
      || h.iterasjoner < ITERASJONER
      || h.salt.length < SALT_BYTES
      || h.nøkkel.length < NOKKEL_BYTES;
}

/* ---------- validering ---------- */

const tekst = v => (v == null ? "" : String(v)).trim();

/* Kontrolltegn er aldri gyldige i noe av dette. De havner i JSON, i
   en katalog, eller i et HTTP-hode, og et \r er et helt eget problem. */
const harKontrolltegn = s => /[\u0000-\u001f\u007f]/.test(s);

/* Adressen er nøkkelen kontoen slås opp på. Vi normaliserer hele
   adressen til små bokstaver — teknisk sett er lokaldelen skiftfølsom,
   men ingen ekte tjeneste behandler den slik, og for en personlig app
   er «Ola@x.no» og «ola@x.no» samme menneske. */
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
  if(!n) return { ok: true, verdi: "" };          /* navn er valgfritt */
  if(n.length > MAKS.navn) return { ok: false, melding: `Navnet er for langt (maks ${MAKS.navn} tegn).` };
  if(harKontrolltegn(n)) return { ok: false, melding: "Navnet inneholder ugyldige tegn." };
  return { ok: true, verdi: n };
}

/* Passordet trimmes ikke — mellomrom er tegn som alle andre, og å
   fjerne dem stille ville endret et passord brukeren mente å skrive. */
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

/* Innlogging valideres løsere med vilje: et for kort passord skal gi
   samme «feil e-post eller passord» som et feil et. Sier vi «for
   kort», har vi røpet at kontoen ikke har det passordet. */
export function validerInnlogging(inn){
  const o = (inn && typeof inn === "object" && !Array.isArray(inn)) ? inn : null;
  if(!o) return { ok: false };
  const epost = normaliserEpost(o.epost);
  const passord = typeof o.passord === "string" ? o.passord : "";
  if(!epost || epost.length > MAKS.epost) return { ok: false };
  if(!passord || passord.length > MAKS.passord) return { ok: false };
  return { ok: true, verdi: { epost, passord } };
}

/* Det eneste flaten noen gang får se om en konto. Aldri hash, aldri
   salt, aldri generasjon — generasjonen er halve tilbakekallingen. */
export function offentligBruker(b){
  return b ? { id: b.id, epost: b.epost, navn: b.navn || "" } : null;
}

/* ---------- registeret ---------- */
/*
   Alt som kommer fra brukere.json er fiendtlig til det har vært her.
   Vi bygger nye objekter med bare kjente felt, så en «__proto__»-nøkkel
   i filen blir liggende i JSON-objektet uten å bli lest av noen.
*/
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
    /* Rekkefølgen bærer mening: første rad er første bruker, og det
       er den som arvet de gamle søknadene. Duplikater forkastes, og
       den første vinner — samme regel som validerSamling. */
    if(idSett.has(r.id) || epostSett.has(r.epost)){ forkastet.push(indeks); return; }
    idSett.add(r.id); epostSett.add(r.epost);
    brukere.push(r);
  });

  return { ok: true, versjon, brukere, forkastet };
}

/* Migreringer går forover og stopper foran en nyere fil. Det finnes
   bare én versjon i dag; stillaset står her fordi den dagen det blir
   to, skal endringen være ett sted og ha en test. */
export function migrerRegister(dok){
  const r = validerRegister(dok);
  if(!r.ok) return r;
  if(r.versjon > REGISTER_VERSJON)
    return { ok: false, grunn: `Registeret er skrevet av en nyere versjon (${r.versjon}).` };
  /* v1 er første format; ingen trinn å kjøre ennå. */
  return { ok: true, register: { versjon: REGISTER_VERSJON, brukere: r.brukere }, forkastet: r.forkastet };
}

export const tomtRegister = () => ({ versjon: REGISTER_VERSJON, brukere: [] });

/* ---------- øktens nyttelast ---------- */
/*
   Korte navn fordi den ligger i en cookie: b bruker, g generasjon,
   u utstedt, e utløper. Utstedt er med for å kunne se hvor gammel en
   økt er uten å regne baklengs fra utløpet.
*/
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

/* Token er nøyaktig to deler. Tre punktum er ikke «nesten riktig». */
export function delToken(token){
  if(typeof token !== "string" || !token || token.length > MAKS.token) return null;
  const d = token.split(".");
  if(d.length !== 2 || !d[0] || !d[1]) return null;
  return { kropp: d[0], signatur: d[1] };
}

export const erUtløpt = (n, nåSekunder) => !n || n.e <= nåSekunder;

export default { validerRegistrering, validerRegister, migrerRegister };
