/* ============================================================
   Hendelser: statusloggen på en søknad, uten I/O.

   Før denne modulen lå reglene for et statusskift spredt: settStatus
   og lagreSkjema i app.js satte hver sin sendtDato, og intervjumerket
   ble satt to steder. medStatus samler dem, så hvert sted som flytter
   en søknad (raden, skjemaet, senere arkivflyttingen, intervjuene og
   Radar) gjør det likt og legger igjen den samme hendelsen.

   `sendtDato` forblir datoen brukeren kan redigere. Hendelsen «sendt»
   følger den, og ikke omvendt: synkSendt flytter den siste sendt-
   hendelsen når brukeren retter datoen.

   Gamle søknader har ingen hendelser, og de skrives ikke om i filen.
   tidslinje() lager i stedet anslåtte steg fra `opprettet` og
   `sendtDato` når den viser dem, og merker dem som anslått.

   Datoene er lokale («YYYY-MM-DD» i brukerens sone), fordi «i dag»
   betyr kalenderdagen brukeren ser, ikke UTC. Klokken sendes inn
   (`iDag`, `nå`), så testene kan styre den.
   ============================================================ */

import { STATUSER, ER_SENDT, FIKK_INTERVJU, validerHendelser } from "./felles.mjs";

/* Statusene som betyr at arbeidsgiveren har svart. */
export const SVARSTATUSER = ["interview", "rejected", "accepted"];

const to = n => String(n).padStart(2, "0");

/* Kalenderdagen i lokal tid, ikke toISOString(), som gir UTC og ville
   datert alt etter midnatt UTC til gårsdagen i Norge om sommeren. */
export function lokalDato(dt){
  return dt.getFullYear() + "-" + to(dt.getMonth() + 1) + "-" + to(dt.getDate());
}

const somDato = v => (v instanceof Date ? lokalDato(v) : v);
const somTid  = v => (v instanceof Date ? v : new Date(v ?? Date.now())).toISOString();

/* Hele dager mellom to kalenderdatoer. Regnet i UTC, så overgangen til
   sommertid ikke gjør et døgn til 23 timer og runder feil. */
export function dagerMellom(fra, til){
  const ms = s => { const [a, m, d] = s.split("-").map(Number); return Date.UTC(a, m - 1, d); };
  return Math.round((ms(til) - ms(fra)) / 86400000);
}

/* `iDag` er en lokal dato («YYYY-MM-DD») eller en Date; mangler den,
   brukes kalenderdagen til `nå`. `nå` er en Date eller et ISO-tidspunkt. */
function klokke({ iDag, nå } = {}){
  const øyeblikk = nå instanceof Date ? nå : new Date(nå ?? Date.now());
  return { iDag: iDag != null ? somDato(iDag) : lokalDato(øyeblikk), tid: somTid(øyeblikk) };
}

export function lagHendelse(til, { iDag, nå, kilde = "bruker" } = {}){
  const k = klokke({ iDag, nå });
  return { til, dato: k.iDag, tid: k.tid, kilde };
}

/* Holder sendtDato, intervjumerket og sendt-hendelsen i takt med
   statusen, uten å legge til noen hendelse. Brukes av medStatus, og
   alene når skjemaet lagres uten at statusen er endret.

   - «Å søke på» har ingen sendtdato.
   - Sendt eller intervju uten sendtdato får datoen fra sendt-hendelsen,
     eller dagens dato om den heller ikke finnes.
   - Den siste sendt-hendelsen etter siste gjenåpning flyttes til
     sendtDato. Tiden fjernes da, fordi den hørte til den gamle datoen. */
export function synkSendt(jobb, valg = {}){
  const { iDag } = klokke(valg);
  const status = jobb.status;
  let hendelser = validerHendelser(jobb.hendelser);

  let fraTodo = -1;
  hendelser.forEach((h, i) => { if(h.til === "todo") fraTodo = i; });
  let sendtI = -1;
  hendelser.forEach((h, i) => { if(i > fraTodo && h.til === "sent") sendtI = i; });

  let sendtDato = jobb.sendtDato || null;
  if(status === "todo") sendtDato = null;
  else if(ER_SENDT(status) && !sendtDato)
    sendtDato = sendtI >= 0 ? hendelser[sendtI].dato : iDag;

  if(sendtDato && sendtI >= 0 && hendelser[sendtI].dato !== sendtDato){
    const { tid, ...uten } = hendelser[sendtI];
    hendelser = hendelser.slice();
    hendelser[sendtI] = { ...uten, dato: sendtDato };
    hendelser = validerHendelser(hendelser);
  }

  return { ...jobb, sendtDato, hendelser,
           intervju: jobb.intervju === true || FIKK_INTERVJU(status) };
}

/* Setter ny status og logger skiftet. Returnerer en ny søknad; den
   gamle røres ikke, så den kan brukes som angre-øyeblikksbilde.

   Hendelsen legges bare til når den siste hendelsen har en annen
   status. Dermed er medStatus idempotent: to klikk på «Merk sendt»
   gir én hendelse. */
export function medStatus(jobb, ny, valg = {}){
  if(!Object.hasOwn(STATUSER, ny)) throw new Error(`Ukjent status «${ny}».`);
  const hendelser = validerHendelser(jobb.hendelser);
  const siste = hendelser[hendelser.length - 1];
  const neste = !siste || siste.til !== ny
    ? validerHendelser([...hendelser, lagHendelse(ny, valg)])
    : hendelser;
  return synkSendt({ ...jobb, status: ny, hendelser: neste }, valg);
}

/* ---------- visning ---------- */

const RANG = s => (s === "todo" ? 0 : s === "sent" ? 1 : 2);

/* Hendelsene slik de skal vises, eldste først:
   [{ til, dato, tid?, kilde?, anslått?, dagerSiden }]

   Uten ekte hendelser lages stegene av det raden vet: «lagt til» fra
   `opprettet`, «sendt» fra `sendtDato`, og statusen nå hvis den er
   kommet lenger. Datoen for den siste er ukjent og står som null.

   Med ekte hendelser legges anslåtte steg bare til foran den første,
   og bare for steg som kommer før den. «Lagt til» samme dag som første
   hendelse er den hendelsen, og tas ikke med to ganger. */
export function tidslinje(jobb, iDag){
  const dag = iDag != null ? somDato(iDag) : null;
  const ekte = validerHendelser(jobb.hendelser);
  const lagtTil = typeof jobb.opprettet === "string" && !Number.isNaN(Date.parse(jobb.opprettet))
    ? lokalDato(new Date(jobb.opprettet)) : null;
  const sendt = jobb.sendtDato || null;

  const anslått = [];
  if(!ekte.length){
    if(lagtTil && (!sendt || lagtTil <= sendt)) anslått.push({ til: "todo", dato: lagtTil });
    if(sendt) anslått.push({ til: "sent", dato: sendt });
    if(jobb.status !== "todo" && !(jobb.status === "sent" && sendt))
      anslått.push({ til: jobb.status, dato: null });
  }else{
    const første = ekte[0];
    const sendtFør = RANG(første.til) === 2 && sendt && sendt <= første.dato;
    const grense = sendtFør ? sendt : første.dato;
    if(lagtTil && RANG(første.til) > 0 && lagtTil < første.dato && lagtTil <= grense)
      anslått.push({ til: "todo", dato: lagtTil });
    if(sendtFør) anslått.push({ til: "sent", dato: sendt });
  }

  return [...anslått.map(h => ({ ...h, anslått: true })), ...ekte].map(h => ({
    ...h,
    dagerSiden: h.dato && dag ? dagerMellom(h.dato, dag) : null
  }));
}

/* Hvor lenge en sendt søknad har ventet. Null uten sendtdato. */
export function dagerSidenSendt(jobb, iDag){
  if(!jobb.sendtDato || iDag == null) return null;
  return dagerMellom(jobb.sendtDato, somDato(iDag));
}

/* Dager fra søknaden ble sendt til første svar (intervju, avslag eller
   videre). Bare ekte hendelser teller: et anslag ville gjort tallet
   til en gjetning. En gjenåpning nullstiller, fordi den neste sendingen
   er en ny søknad. */
export function svartidDager(jobb){
  let sendt = null;
  for(const h of validerHendelser(jobb.hendelser)){
    if(h.til === "todo") sendt = null;
    else if(h.til === "sent") sendt = h;
    else if(sendt && SVARSTATUSER.includes(h.til)) return Math.max(0, dagerMellom(sendt.dato, h.dato));
  }
  return null;
}

/* Median svartid over søknadene som har en. Null når ingen har det. */
export function medianSvartid(jobber){
  const tall = (jobber || []).map(svartidDager).filter(n => n !== null).sort((a, b) => a - b);
  if(!tall.length) return null;
  const m = Math.floor(tall.length / 2);
  return tall.length % 2 ? tall[m] : (tall[m - 1] + tall[m]) / 2;
}

/* Søknader som står på «Sendt» og har ventet i mer enn `dager` dager. */
export function utenSvarOver(jobber, dager, iDag){
  return (jobber || []).filter(j => j.status === "sent" && (dagerSidenSendt(j, iDag) ?? -1) > dager);
}
