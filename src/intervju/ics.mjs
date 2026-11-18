/* ============================================================
   Kalenderfil (.ics) for intervjuer, uten I/O.

   Én VEVENT per intervju, så brukeren kan legge dem i Kalender-appen
   eller en annen kalender. Filen er en kopi, ikke en abonnement:
   endres intervjuet, lastes en ny fil ned, og UID-en (<iid>@hired.local)
   gjør at kalenderen erstatter den gamle hendelsen i stedet for å lage
   en til.

   Reglene som lett går galt, og derfor er samlet her:
     • Linjeskift er CRLF, også etter siste linje.
     • Linjer brytes ved 75 oktetter (ikke tegn), og aldri midt i et
       UTF-8-tegn, for «æøå» er to oktetter. Fortsettelser starter med
       ett mellomrom, som teller med i de 75.
     • , ; og \ escapes, og linjeskift i tekst blir \n. Uten dette kan et
       notat med semikolon eller linjeskift lage en ugyldig eller
       kapret fil. Styretegn fjernes.
     • Tidspunkter skrives i UTC («Z») regnet fra klokken i lokal sone,
       fordi filen ellers trenger en VTIMEZONE. Sommertid er dermed
       Date sitt ansvar, ikke vårt.
     • Et intervju uten klokkeslett blir en heldagshendelse
       (VALUE=DATE, slutt neste dag).
     • Påminnelse (VALARM) 2 timer før. For heldag, der «2 timer før»
       ville falt på kvelden dagen før, brukes 15 timer: kl. 09 dagen før.
   ============================================================ */

const CRLF = "\r\n";
const MAKS_OKTETTER = 75;
const STANDARD_VARIGHET = 60;
const koder = new TextEncoder();

const to = n => String(n).padStart(2, "0");

/* Text-verdi etter RFC 5545 §3.3.11. */
export function escapeTekst(t){
  return String(t ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/* Bryter én linje i biter på høyst 75 oktetter, uten å dele et tegn. */
export function brytLinje(linje){
  const biter = [];
  let nåværende = "", oktetter = 0;
  for(const tegn of linje){
    const n = koder.encode(tegn).length;
    /* Fortsettelseslinjer har ett mellomrom først, og det teller. */
    const tak = biter.length ? MAKS_OKTETTER - 1 : MAKS_OKTETTER;
    if(oktetter + n > tak){ biter.push(nåværende); nåværende = ""; oktetter = 0; }
    nåværende += tegn; oktetter += n;
  }
  biter.push(nåværende);
  return biter.map((b, i) => (i ? " " + b : b)).join(CRLF);
}

const utc = d => d.getUTCFullYear() + to(d.getUTCMonth() + 1) + to(d.getUTCDate())
               + "T" + to(d.getUTCHours()) + to(d.getUTCMinutes()) + to(d.getUTCSeconds()) + "Z";
const dagKode = iso => iso.replaceAll("-", "");

function nesteDag(iso){
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + 1));
  return d.getUTCFullYear() + to(d.getUTCMonth() + 1) + to(d.getUTCDate());
}

/* Klokkeslett og dato er lokale; Date gjør om til UTC. */
function lokalTilDate(dato, tid){
  return new Date(+dato.slice(0, 4), +dato.slice(5, 7) - 1, +dato.slice(8, 10), +tid.slice(0, 2), +tid.slice(3, 5));
}

function hendelse({ jobb, intervju: iv }, stempel){
  const rader = ["BEGIN:VEVENT", `UID:${iv.id}@hired.local`, `DTSTAMP:${stempel}`];
  if(iv.tid){
    const start = lokalTilDate(iv.dato, iv.tid);
    const slutt = new Date(start.getTime() + (iv.varighet || STANDARD_VARIGHET) * 60000);
    rader.push(`DTSTART:${utc(start)}`, `DTEND:${utc(slutt)}`);
  }else{
    rader.push(`DTSTART;VALUE=DATE:${dagKode(iv.dato)}`, `DTEND;VALUE=DATE:${nesteDag(iv.dato)}`);
  }
  const selskap = String(jobb.selskap || "").trim();
  rader.push(`SUMMARY:${escapeTekst(selskap ? "Intervju: " + selskap : "Intervju")}`);
  const sted = String(iv.sted || "").trim() || String(iv.lenke || "").trim();
  if(sted) rader.push(`LOCATION:${escapeTekst(sted)}`);

  const beskrivelse = [
    jobb.stilling && `Stilling: ${String(jobb.stilling).trim()}`,
    iv.runde && `Runde: ${iv.runde}`,
    iv.lenke && `Lenke: ${iv.lenke}`,
    iv.notat && `Notat: ${iv.notat}`
  ].filter(Boolean).join("\n");
  if(beskrivelse) rader.push(`DESCRIPTION:${escapeTekst(beskrivelse)}`);

  rader.push("BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER:${iv.tid ? "-PT2H" : "-PT15H"}`,
             `DESCRIPTION:${escapeTekst(selskap ? "Intervju: " + selskap : "Intervju")}`, "END:VALARM", "END:VEVENT");
  return rader;
}

/* `poster` er [{ jobb, intervju }]. `nå` setter DTSTAMP (testbar klokke). */
export function lagIcs(poster, { nå = new Date() } = {}){
  const stempel = utc(nå instanceof Date ? nå : new Date(nå));
  const rader = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Hired//Intervjuer//NO",
                 "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for(const p of poster) rader.push(...hendelse(p, stempel));
  rader.push("END:VCALENDAR");
  return rader.map(brytLinje).join(CRLF) + CRLF;
}

/* «Intervju - Aker BP - 2026-10-08.ics», trygt som filnavn. */
export function icsFilnavn({ jobb, intervju }){
  const selskap = String(jobb?.selskap || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim().slice(0, 80);
  return ["Intervju", selskap, intervju.dato].filter(Boolean).join(" - ") + ".ics";
}
