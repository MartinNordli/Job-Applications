import { lagBrevlager } from "./brevlager.mjs";
import { lagBrevModell, brevNokkelStatus } from "./brev-modell.mjs";
import { lagRadarnett } from "../src/radar/radarnett.mjs";
import { Brevfeil } from "../src/dokumenter/dokumentfeil.mjs";
import { kjørRadar, søkNå, tilstandFra, lagreInnstillinger, ikkeInteressert, markerLagtTil,
         leggTilKarriereside, fjernKarriereside, slåPåKarriereside, foreslåFraProfil } from "../src/radar/radarlogikk.mjs";
import { deltMiljønokkel } from "./nokkel.mjs";
import { offentligFeil, send, kropp, objekt, metode } from "./brev-api.mjs";

export const TIME = 3600_000;
const LEVERANDORER = ["anthropic", "openai"];

export const erRadarbane = bane => bane === "/api/radar"
  || /^\/api\/radar\/(?:innstillinger|kjor|forslag|ikke-interessert|lagt-til|karrieresider(?:\/[A-Za-z0-9_-]{1,64})?)$/.test(bane);

export function lagRadartjeneste({ nett, modellFor, nå = () => new Date(), vent, kilder } = {}){
  const lagre = new Map();
  const dokumenter = katalog => {
    if(!lagre.has(katalog)) lagre.set(katalog, lagBrevlager(katalog));
    return lagre.get(katalog);
  };

  async function leverandorFor(ktx, ønsket){
    if(ønsket !== undefined){
      if(!LEVERANDORER.includes(ønsket)) throw new Brevfeil("ugyldig", "Velg en støttet leverandør.");
      return ønsket;
    }
    if(modellFor) return "anthropic";
    const { katalog, tillatMiljø } = ktx;
    if((await brevNokkelStatus({ katalog, tillatMiljø }, "anthropic")).finnes) return "anthropic";
    return (await brevNokkelStatus({ katalog, tillatMiljø }, "openai")).finnes ? "openai" : "anthropic";
  }

  async function kjør(ktx, { leverandor, signal, manuell = false } = {}){
    const { katalog, lager, tillatMiljø } = ktx;
    const args = {
      dokumenter: dokumenter(katalog),
      jobber: (await lager.les()).jobber ?? [],
      nett: lagRadarnett({ node: nett, katalog }),
      kallModell: modellFor ? modellFor(ktx) : lagBrevModell({ katalog, tillatMiljø }),
      leverandor: await leverandorFor(ktx, leverandor),
      nå, signal, ...(vent ? { vent } : {}), ...(kilder ? { kilder } : {})
    };
    return manuell ? søkNå(args) : kjørRadar(args);
  }

  async function foreslå(ktx, { leverandor, signal } = {}){
    const { katalog, tillatMiljø } = ktx;
    return foreslåFraProfil({ dokumenter: dokumenter(katalog),
      kallModell: modellFor ? modellFor(ktx) : lagBrevModell({ katalog, tillatMiljø }),
      leverandor: await leverandorFor(ktx, leverandor), nå, signal });
  }
  return { dokumenter, kjør, foreslå, nå, nett };
}

export function lagRadarRuter(tjeneste){
  const { nett } = tjeneste;
  return async function ruter(req, res, bane, ktx){
    const controller = new AbortController();
    const stopp = () => { if(!res.writableEnded) controller.abort(); };
    res.on("close", stopp);
    try{
      const d = tjeneste.dokumenter(ktx.katalog);
      const tilstand = async r => ({ tilstand: tilstandFra(r ?? await d.les("radar.json"), tjeneste.nå()) });
      let r;
      if(bane === "/api/radar"){
        metode(req, "GET");
        r = await tilstand();
      }else if(bane === "/api/radar/innstillinger"){
        metode(req, "PUT");
        r = await tilstand(await lagreInnstillinger(d, objekt(await kropp(req))));
      }else if(bane === "/api/radar/kjor"){
        metode(req, "POST");
        const inn = objekt(await kropp(req));
        const u = await tjeneste.kjør(ktx, { leverandor: inn.leverandor, signal: controller.signal, manuell: true });
        const { nye, ...rest } = u;
        r = { ...rest, antallNye: nye?.length ?? 0, ...await tilstand() };
      }else if(bane === "/api/radar/forslag"){
        metode(req, "POST");
        const inn = objekt(await kropp(req));
        r = { forslag: await tjeneste.foreslå(ktx, { leverandor: inn.leverandor, signal: controller.signal }) };
      }else if(bane === "/api/radar/ikke-interessert" || bane === "/api/radar/lagt-til"){
        metode(req, "POST");
        const { id } = objekt(await kropp(req));
        if(typeof id !== "string" || !id || id.length > 2000) throw new Brevfeil("ugyldig", "Stillingen mangler.");
        r = await tilstand(bane.endsWith("lagt-til") ? await markerLagtTil(d, id) : await ikkeInteressert(d, id, { nå: tjeneste.nå }));
      }else if(bane === "/api/radar/karrieresider"){
        metode(req, "POST");
        const { url, navn } = objekt(await kropp(req));
        if(typeof url !== "string" || !url.trim() || url.length > 2000) throw new Brevfeil("ugyldig", "Legg inn adressen til karrieresiden.");
        r = await tilstand(await leggTilKarriereside(d, { url, navn: typeof navn === "string" ? navn : "", nett: lagRadarnett({ node: nett, katalog: ktx.katalog }) }));
      }else if(req.method === "PUT"){
        r = await tilstand(await slåPåKarriereside(d, bane.split("/").at(-1)));
      }else{
        metode(req, "DELETE");
        r = await tilstand(await fjernKarriereside(d, bane.split("/").at(-1)));
      }
      if(!res.destroyed) send(res, 200, r);
    }catch(e){
      if(!res.destroyed){ const f = offentligFeil(e); send(res, f.status, { feil: f.feil, melding: f.melding }); }
    }finally{ res.off("close", stopp); }
  };
}

export function startRadartimer({ brukere, tjeneste, intervall = TIME, logg = console }){
  const avbryt = new AbortController();
  let pågår = null;

  async function pass({ bareGamle }){
    const reg = await brukere.lesRegister();
    if(reg.ødelagt) return;
    for(const [i, b] of reg.brukere.entries()){
      if(avbryt.signal.aborted) return;
      try{
        const { lager, filer, katalog } = brukere.lagerFor(b.id);
        const radar = await tjeneste.dokumenter(katalog).les("radar.json");
        if(!radar.innstillinger.pa) continue;
        const sist = Date.parse(radar.kjoringer[0]?.start) || 0;
        if(bareGamle && tjeneste.nå().getTime() - sist < intervall) continue;
        await tjeneste.kjør({ lager, filer, katalog, tillatMiljø: i === 0 || deltMiljønokkel() }, { signal: avbryt.signal });
      }catch(e){
        logg.error?.(`Radar kunne ikke kjøre for en profil: ${e?.melding || e?.code || "uventet feil"}`);
      }
    }
  }
  const start = opts => {
    if(pågår || avbryt.signal.aborted) return pågår;
    pågår = pass(opts).catch(e => logg.error?.(`Radar: ${e?.melding || "uventet feil"}`)).finally(() => { pågår = null; });
    return pågår;
  };

  const timer = setInterval(() => start({ bareGamle: false }), intervall);
  timer.unref?.();
  const første = start({ bareGamle: true });
  return {
    første,
    async stopp(){ clearInterval(timer); avbryt.abort(); await pågår; }
  };
}
