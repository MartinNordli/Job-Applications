import { STATUSER, ER_SENDT, FIKK_INTERVJU, validerHendelser } from "../felles/felles.mjs";

const SVARSTATUSER = ["interview", "rejected", "accepted"];

const to = n => String(n).padStart(2, "0");

export function lokalDato(dt){
  return dt.getFullYear() + "-" + to(dt.getMonth() + 1) + "-" + to(dt.getDate());
}

const somDato = v => (v instanceof Date ? lokalDato(v) : v);
const somTid  = v => (v instanceof Date ? v : new Date(v ?? Date.now())).toISOString();

export function dagerMellom(fra, til){
  const ms = s => { const [a, m, d] = s.split("-").map(Number); return Date.UTC(a, m - 1, d); };
  return Math.round((ms(til) - ms(fra)) / 86400000);
}

function klokke({ iDag, nå } = {}){
  const øyeblikk = nå instanceof Date ? nå : new Date(nå ?? Date.now());
  return { iDag: iDag != null ? somDato(iDag) : lokalDato(øyeblikk), tid: somTid(øyeblikk) };
}

export function lagHendelse(til, { iDag, nå, kilde = "bruker" } = {}){
  const k = klokke({ iDag, nå });
  return { til, dato: k.iDag, tid: k.tid, kilde };
}

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

export function medStatus(jobb, ny, valg = {}){
  if(!Object.hasOwn(STATUSER, ny)) throw new Error(`Ukjent status «${ny}».`);
  const hendelser = validerHendelser(jobb.hendelser);
  const siste = hendelser[hendelser.length - 1];
  const neste = !siste || siste.til !== ny
    ? validerHendelser([...hendelser, lagHendelse(ny, valg)])
    : hendelser;
  return synkSendt({ ...jobb, status: ny, hendelser: neste }, valg);
}

const RANG = s => (s === "todo" ? 0 : s === "sent" ? 1 : 2);

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

export function dagerSidenSendt(jobb, iDag){
  if(!jobb.sendtDato || iDag == null) return null;
  return dagerMellom(jobb.sendtDato, somDato(iDag));
}

export function svartidDager(jobb){
  let sendt = null;
  for(const h of validerHendelser(jobb.hendelser)){
    if(h.til === "todo") sendt = null;
    else if(h.til === "sent") sendt = h;
    else if(sendt && SVARSTATUSER.includes(h.til)) return Math.max(0, dagerMellom(sendt.dato, h.dato));
  }
  return null;
}

export function medianSvartid(jobber){
  const tall = (jobber || []).map(svartidDager).filter(n => n !== null).sort((a, b) => a - b);
  if(!tall.length) return null;
  const m = Math.floor(tall.length / 2);
  return tall.length % 2 ? tall[m] : (tall[m - 1] + tall[m]) / 2;
}

export function utenSvarOver(jobber, dager, iDag){
  return (jobber || []).filter(j => j.status === "sent" && (dagerSidenSendt(j, iDag) ?? -1) > dager);
}
