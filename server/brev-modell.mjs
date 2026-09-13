/* Nett og profilnøkler for skriveverkstedet. Ingen rå leverandørfeil
   forlater transporten: de kan inneholde personopplysninger eller nøkler. */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validerNokkel, hale } from "../src/brukerlogikk.mjs";
import { leverandorFor, byggModellkropp, tolkModellsvar } from "../src/brev-provider.mjs";
import { delSse, lagSvarsamler, lagFeltstrøm } from "../src/brev-strom.mjs";

const TIDSGRENSE = 120_000;
const MAKS_SVAR = 2 * 1024 * 1024;

export class BrevModellfeil extends Error {
  constructor(navn, melding, status = 502){ super(melding); this.navn = navn; this.status = status; }
}

async function lesNokkel({ katalog, tillatMiljø = false }, leverandor){
  const valg = leverandorFor(leverandor);
  let egen;
  try{ egen = (await fs.readFile(path.join(katalog, valg.nokkelfil), "utf8")).trim(); }
  catch(e){ if(e.code !== "ENOENT") throw new BrevModellfeil("nokkel", "Fikk ikke lest API-nøkkelen.", 503); }
  if(egen) return { nokkel: egen, kilde: "egen" };
  const miljo = tillatMiljø && process.env[valg.miljo]?.trim();
  return miljo ? { nokkel: miljo, kilde: "miljø" } : null;
}

export async function brevNokkelStatus(valg, leverandor){
  const funn = await lesNokkel(valg, leverandor);
  if(!funn) return { finnes: false, kilde: "ingen" };
  const h = funn.kilde === "egen" ? hale(funn.nokkel) : null;
  return { finnes: true, kilde: funn.kilde, ...(h ? { hale: h } : {}) };
}

export async function settBrevNokkel({ katalog }, leverandor, nokkel){
  const { nokkelfil } = leverandorFor(leverandor);
  const v = validerNokkel(nokkel);
  if(!v.ok) return v;
  await fs.mkdir(katalog, { recursive: true });
  const temp = path.join(katalog, `.${nokkelfil}.${randomUUID()}.tmp`);
  let fil;
  try{
    fil = await fs.open(temp, "wx", 0o600);
    await fil.writeFile(v.verdi + "\n", "utf8");
    await fil.sync(); await fil.close(); fil = null;
    await fs.rename(temp, path.join(katalog, nokkelfil));
  }finally{ await fil?.close(); await fs.rm(temp, { force: true }); }
  return { ok: true };
}

export async function fjernBrevNokkel({ katalog }, leverandor){
  const { nokkelfil } = leverandorFor(leverandor);
  await fs.rm(path.join(katalog, nokkelfil), { force: true });
}

export function lagBrevModell({ katalog, tillatMiljø = false, fetch: hent = globalThis.fetch }){
  return async ({ leverandor, system, innhold, skjema, trinn, signal, felt, påDelta }) => {
    const valg = leverandorFor(leverandor);
    const kropp = byggModellkropp({ leverandor, system, innhold, skjema, trinn });
    const funn = await lesNokkel({ katalog, tillatMiljø }, leverandor);
    if(!funn) throw new BrevModellfeil("mangler-nokkel", "Legg til API-nøkkelen for valgt leverandør.", 503);
    if(!validerNokkel(funn.nokkel).ok) throw new BrevModellfeil("nokkel", "API-nøkkelen har ugyldig format. Legg den inn på nytt.", 503);
    const avbryt = new AbortController();
    const avbrytFraBruker = () => avbryt.abort();
    signal?.addEventListener("abort", avbrytFraBruker, { once: true });
    if(signal?.aborted) avbryt.abort();
    const timer = setTimeout(() => avbryt.abort(), TIDSGRENSE);
    /* Forhåndsvisningen slutter i samme øyeblikk kallet er over eller avbrutt:
       en delta som kommer etter at svaret har satt seg, ville vist tekst som
       ikke lenger er sann. En feil i mottakeren skal heller ikke rive kallet. */
    let ferdig = false;
    const meld = typeof påDelta === "function"
      ? tekst => { if(ferdig || avbryt.signal.aborted) return; try{ påDelta(tekst); }catch{} }
      : null;
    try{
      const r = await hent(valg.url, {
        method: "POST", signal: avbryt.signal,
        headers: { "content-type": "application/json", ...(leverandor === "anthropic"
          ? { "x-api-key": funn.nokkel, "anthropic-version": "2023-06-01" }
          : { authorization: `Bearer ${funn.nokkel}` }) },
        body: JSON.stringify(kropp)
      });
      if(!r.ok){
        await r.body?.cancel();
        if(r.status === 401 || r.status === 403) throw new BrevModellfeil("nokkel", "Leverandøren avviste nøkkelen. Kontroller nøkkel og API-tilgang.", 503);
        if(r.status === 429) throw new BrevModellfeil("for-mange", "Leverandøren har nådd en grense. Vent litt og prøv igjen.", 429);
        throw new BrevModellfeil("modell", `Modelltjenesten svarte ${r.status}. Prøv igjen senere.`);
      }
      /* Svaret er en SSE-strøm. Rammene settes sammen til nøyaktig samme
         objekt et ikke-strømmet kall ga, og forhåndsvisningen dekodes ved
         siden av. Deltaene er provisoriske og brukes aldri til resultatet. */
      const del = delSse(), samler = lagSvarsamler(leverandor);
      const feltstrøm = meld && felt ? lagFeltstrøm(felt) : null;
      const mat = bit => {
        for(const ramme of del(bit)){
          const tillegg = samler.ta(ramme);
          if(tillegg && feltstrøm){
            const dekodet = feltstrøm.ta(tillegg);
            if(dekodet) meld(dekodet);
          }
        }
      };
      if(r.body){
        const reader = r.body.getReader();
        const decoder = new TextDecoder(); let storrelse = 0;
        try{
          for(;;){
            const bit = await reader.read(); if(bit.done) break;
            storrelse += bit.value.byteLength;
            if(storrelse > MAKS_SVAR){ await reader.cancel(); throw new BrevModellfeil("modellformat", "Modellen sendte et for stort svar."); }
            mat(decoder.decode(bit.value, { stream: true }));
          }
          mat(decoder.decode());
        }finally{ reader.releaseLock(); }
      }else mat(await r.text());
      const raa = samler.svar();
      // En strøm som slutter uten avsluttende hendelse er et halvt svar.
      if(!raa) throw new BrevModellfeil("modellformat", "Modellen svarte i feil format.");
      return tolkModellsvar(leverandor, raa);
    }catch(e){
      if(signal?.aborted) throw new BrevModellfeil("avbrutt", "Genereringen ble avbrutt.", 499);
      if(avbryt.signal.aborted) throw new BrevModellfeil("tidsavbrudd", "Modellen svarte ikke innen to minutter. Prøv igjen.", 504);
      if(e instanceof BrevModellfeil || e?.navn === "modellformat") throw e;
      throw new BrevModellfeil("modell", "Fikk ikke kontakt med modelltjenesten. Prøv igjen.");
    }finally{
      ferdig = true;
      clearTimeout(timer); signal?.removeEventListener("abort", avbrytFraBruker);
    }
  };
}
