import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lagServer } from "./server.mjs";
import { erIntern, lesNokkel, ManglerNokkel } from "./nett.mjs";
import { tolkStrukturert, renskTekst, byggForespørsel, tolkModellsvar,
         slåSammen, sektorForSelskap, avkod, tolkEtiketter, fristFraTekst,
         erLopende, jobbtypeFraTekst, tekstbehov, TEKSTBUDSJETT } from "../src/importlogikk.mjs";
import { validerSoknad, normaliserIsoDato } from "../src/felles.mjs";

/* ============================================================
   Nettet stubbes overalt. Ingen test her rører en ekte adresse —
   det er derfor de to operasjonene injiseres i lagServer.
   ============================================================ */

async function start(nett, jobber = []){
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "jobber-import-"));
  const tjener  = lagServer({ katalog, nett });
  if(jobber.length){
    await fs.writeFile(path.join(katalog, "jobber.json"),
      JSON.stringify({ versjon: 1, oppdatert: new Date().toISOString(), jobber }));
  }
  await new Promise(r => tjener.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${tjener.address().port}`,
    stopp: () => new Promise(r => tjener.close(r))
  };
}

const importer = (base, url) => fetch(`${base}/api/importer`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url })
});

const nettMed = (html, modellsvar = {}) => ({
  hentSide: async url => ({ status: 200, sluttUrl: url, html }),
  spørModell: async () => ({ content: [{ type: "text", text: JSON.stringify(modellsvar) }] })
});

const ldJson = o => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

const stilling = (o = {}) => ({
  "@context": "https://schema.org", "@type": "JobPosting",
  title: "Graduate: Data Engineer",
  hiringOrganization: { "@type": "Organization", name: "Aker BP" },
  validThrough: "2026-09-13T23:59:00+02:00",
  jobLocation: { "@type": "Place", address: { addressLocality: "Oslo" } },
  ...o
});

/* ---------- strukturerte data ---------- */

test("JobPosting leses ut av @graph", () => {
  const html = ldJson({ "@context": "https://schema.org",
    "@graph": [{ "@type": "WebPage" }, stilling()] });
  const s = tolkStrukturert(html);
  assert.equal(s.stilling, "Graduate: Data Engineer");
  assert.equal(s.selskap, "Aker BP");
});

test("JobPosting leses ut av en toppnivå-array", () => {
  const s = tolkStrukturert(ldJson([{ "@type": "Organization" }, stilling()]));
  assert.equal(s.selskap, "Aker BP");
});

test("validThrough med tidssone blir en ren ISO-dato", () => {
  assert.equal(tolkStrukturert(ldJson(stilling())).frist, "2026-09-13");
});

test("flere jobLocation blir til ett lesbart sted", () => {
  const html = ldJson(stilling({ jobLocation: [
    { address: { addressLocality: "Oslo" } },
    { address: { addressLocality: "Trondheim" } }] }));
  assert.equal(tolkStrukturert(html).sted, "Oslo / Trondheim");
});

test("employmentType oversettes fra schema.org", () => {
  const rolig = o => stilling({ title: "Analytiker", ...o });   /* tittel uten «graduate» */
  assert.equal(tolkStrukturert(ldJson(rolig({ employmentType: "INTERN" }))).jobbtype, "internship");
  assert.equal(tolkStrukturert(ldJson(rolig({ employmentType: ["FULL_TIME"] }))).jobbtype, "fulltid");
  assert.equal(tolkStrukturert(ldJson(rolig())).jobbtype, null);
});

test("«graduate» i tittelen presiserer fulltid fra schema.org", () => {
  /* Et graduateprogram står i schema.org som FULL_TIME. Tittelen er
     den eneste kilden til at det er et graduateløp. */
  assert.equal(tolkStrukturert(ldJson(stilling({ employmentType: "FULL_TIME" }))).jobbtype, "graduate");
});

test("én ødelagt ld+json-blokk velter ikke de andre", () => {
  const html = `<script type="application/ld+json">{ dette er ikke json </script>`
             + ldJson(stilling());
  assert.equal(tolkStrukturert(html).selskap, "Aker BP");
});

test("uten JSON-LD faller stillingen tilbake på og:title", () => {
  const html = `<meta property="og:title" content="Sommerjobb i Bekk">`;
  assert.equal(tolkStrukturert(html).stilling, "Sommerjobb i Bekk");
});

test("sidetittelen merkes som svak — den er ikke stillingens navn", () => {
  const s = tolkStrukturert(`<meta property="og:title" content="Graduate Logistikk - arbeidsplassen.no">`
                          + `<meta property="og:site_name" content="arbeidsplassen.no">`);
  assert.equal(s.stilling, "Graduate Logistikk - arbeidsplassen.no");
  assert.equal(s.svak.stilling, true);
  assert.equal(s.svak.selskap, true);
});

test("JSON-LD er aldri svak", () => {
  assert.deepEqual(tolkStrukturert(ldJson(stilling())).svak, {});
});

test("modellen slår en svak verdi, men ikke en sterk", () => {
  const svak = { stilling: "Graduate Logistikk - arbeidsplassen.no", svak: { stilling: true } };
  assert.equal(slåSammen(svak, { stilling: "Graduate Logistikk" }, "https://a.no/1").utkast.stilling,
               "Graduate Logistikk");

  const sterk = { stilling: "Graduate: Data Engineer", svak: {} };
  assert.equal(slåSammen(sterk, { stilling: "Noe annet" }, "https://a.no/1").utkast.stilling,
               "Graduate: Data Engineer");
});

test("en svak verdi taper ikke mot ingenting", () => {
  const svak = { stilling: "Sidetittel", svak: { stilling: true } };
  assert.equal(slåSammen(svak, {}, "https://a.no/1").utkast.stilling, "Sidetittel");
});

test("modellen får vite hvilken dag det er", () => {
  /* Norske annonser skriver «søk senest 13. september» uten år. Uten
     dagens dato gjettet modellen året, og to like annonser fikk hvert
     sitt svar. */
  const be = byggForespørsel("tekst", ["frist"], new Date("2026-09-03T10:00:00Z"));
  assert.match(be.messages[0].content, /^I dag er 2026-09-03\./);
});

test("tekstrensingen fjerner skript og entiteter", () => {
  const t = renskTekst(`<nav>meny</nav><script>alert(1)</script><p>Vi s&oslash;ker deg &amp; deg.</p>`);
  assert.equal(t.includes("alert"), false);
  assert.equal(t.includes("meny"), false);
  assert.match(t, /Vi søker deg & deg\./);
});

test("avkod tåller tallreferanser og lar ukjente stå", () => {
  assert.equal(avkod("&#65;&#x42;&ukjent;"), "AB&ukjent;");
});

/* ---------- etiketterte verdier ---------- */

const dl = par => "<dl>" + par.map(([d, v]) => `<dt>${d}</dt><dd>${v}</dd>`).join("") + "</dl>";

test("dt/dd med norske etiketter leses ut", () => {
  const e = tolkEtiketter(dl([
    ["Stillingstittel", "Graduate Skyplattform"],
    ["Type ansettelse", "Fast, heltid 100%"],
    ["Arbeidsgiver", "TINE SA"],
    ["Arbeidssted", "0187 Oslo"]
  ]));
  assert.equal(e.stilling, "Graduate Skyplattform");
  assert.equal(e.selskap, "TINE SA");
  assert.equal(e.jobbtype, "fulltid");    /* «Fast, heltid 100%» */
  assert.equal(e.sted, "Oslo");           /* postnummeret ryddes bort */
});

test("tittelen presiserer ansettelsesformen i tolkStrukturert", () => {
  /* tolkEtiketter leser bare etiketten; presiseringen hører hjemme
     der alle kildene ses under ett. */
  const s = tolkStrukturert(dl([["Stillingstittel", "Graduate Skyplattform"],
                                ["Type ansettelse", "Fast, heltid 100%"]]));
  assert.equal(s.jobbtype, "graduate");
});

test("th/td og engelske etiketter virker like godt", () => {
  const e = tolkEtiketter("<table><tr><th>Company</th><td>Bekk</td></tr>"
                        + "<tr><th>Deadline</th><td>2026-11-01</td></tr></table>");
  assert.equal(e.selskap, "Bekk");
  assert.equal(e.frist, "2026-11-01");
});

test("«Sektor» leses ikke — det er en annen akse enn appens", () => {
  /* arbeidsplassen.no mener eierskap («Privat»), ikke bransje. */
  const e = tolkEtiketter(dl([["Sektor", "Privat"], ["Stillingstittel", "Analytiker"]]));
  assert.equal("sektor" in e, false);
  assert.equal(e.stilling, "Analytiker");
});

test("et helt avsnitt er ikke en verdi", () => {
  assert.equal("selskap" in tolkEtiketter(dl([["Arbeidsgiver", "x".repeat(400)]])), false);
});

test("etiketterte verdier er sterke, ikke svake", () => {
  const s = tolkStrukturert(dl([["Stillingstittel", "Graduate Logistikk"]])
                          + `<title>Graduate Logistikk - arbeidsplassen.no</title>`);
  assert.equal(s.stilling, "Graduate Logistikk");
  assert.equal(s.svak.stilling, undefined);
});

test("h1 brukes når ingenting bedre finnes, men er svak", () => {
  const s = tolkStrukturert("<h1>Graduate Junior IT-utvikler</h1>");
  assert.equal(s.stilling, "Graduate Junior IT-utvikler");
  assert.equal(s.svak.stilling, true);
});

/* ---------- frist i fritekst ---------- */

const iDag = new Date("2026-09-03");

test("«Søk senest søndag 13. september» blir en dato", () => {
  assert.equal(fristFraTekst("Søk senest søndag 13. september", iDag), "2026-09-13");
  assert.equal(fristFraTekst("Søknadsfristen er 18. oktober", iDag), "2026-10-18");
  assert.equal(fristFraTekst("Søknadsfrist: 01.11.2026", iDag), "2026-11-01");
  assert.equal(fristFraTekst("Application deadline 2026-12-01", iDag), "2026-12-01");
});

test("året rulles til neste gang datoen inntreffer", () => {
  assert.equal(fristFraTekst("Frist 1. februar", iDag), "2027-02-01");
  assert.equal(fristFraTekst("Frist 30. september", iDag), "2026-09-30");
  /* Står året der, gjettes det ikke. */
  assert.equal(fristFraTekst("Søknadsfrist 13. september 2028", iDag), "2028-09-13");
});

test("en dato uten nøkkelord foran er ikke en frist", () => {
  assert.equal(fristFraTekst("Programmet starter 1. september 2027", iDag), null);
  assert.equal(fristFraTekst("Vi har holdt på siden 12. mai 1998", iDag), null);
  assert.equal(fristFraTekst("snarest", iDag), null);
});

test("løpende opptak kjennes igjen, men taper mot en frist", () => {
  assert.equal(erLopende("Vi vurderer søknader fortløpende"), true);
  assert.equal(erLopende("accepting applications on a rolling basis"), true);
  assert.equal(erLopende("Søk senest 13. september"), false);

  /* Annonser sier ofte begge deler. Fristen er den harde opplysningen. */
  const s = tolkStrukturert("<p>Søknadsfrist 13. september 2026. Vi intervjuer underveis.</p>");
  assert.equal(s.frist, "2026-09-13");
  assert.equal(s.lopende, false, "en frist slår løpende");
  assert.equal(slåSammen(s, null, "https://a.no/1").utkast.lopende, false);
});

test("uten frist noe sted er løpende et gyldig svar", () => {
  const s = tolkStrukturert("<p>Vi tar imot søknader fortløpende gjennom hele året.</p>");
  assert.equal(s.frist, null);
  assert.equal(s.lopende, true);
  assert.equal(slåSammen(s, null, "https://a.no/1").utkast.lopende, true);
});

/* ---------- tekstbudsjettet ---------- */

test("budsjettet følger av hva som gjenstår", () => {
  assert.equal(tekstbehov(["selskap", "sektor"]), TEKSTBUDSJETT.topp);
  assert.equal(tekstbehov(["frist", "selskap"]), TEKSTBUDSJETT.helt);
});

test("forespørselen skjæres til budsjettet", () => {
  const lang = "x".repeat(20_000);
  assert.ok(byggForespørsel(lang, ["selskap"]).messages[0].content.length < TEKSTBUDSJETT.topp + 400);
  assert.ok(byggForespørsel(lang, ["frist"]).messages[0].content.length > TEKSTBUDSJETT.topp);
});

test("sidekrom kastes ut av teksten", () => {
  const t = renskTekst("<p>Hopp til innhold</p><p>Del annonsen</p><p>Vi søker en analytiker.</p>");
  assert.equal(/Hopp til innhold|Del annonsen/.test(t), false);
  assert.match(t, /Vi søker en analytiker\./);
});

/* ---------- modellsvaret ---------- */

const svarMed = o => tolkModellsvar({ content: [{ type: "text", text: JSON.stringify(o) }] });

test("manglende frist gir aldri rolling av seg selv", () => {
  assert.equal(svarMed({ deadline: null, deadline_type: "not_specified" }).fristType, "not_specified");
  assert.equal(svarMed({}).fristType, "not_specified");
});

test("rolling beholdes når modellen faktisk sier det", () => {
  const r = svarMed({ deadline: null, deadline_type: "rolling" });
  assert.equal(r.fristType, "rolling");
  assert.equal(r.frist, null);
});

test("fixed uten gyldig dato faller til not_specified", () => {
  assert.equal(svarMed({ deadline: "snarest", deadline_type: "fixed" }).fristType, "not_specified");
});

test("ukjente enum-verdier forkastes felt for felt", () => {
  const r = svarMed({ sector: "romfart", job_type: "sesong", title: "Analytiker" });
  assert.equal(r.sektor, null);
  assert.equal(r.jobbtype, null);
  assert.equal(r.stilling, "Analytiker");     /* resten står */
});

test("feil type og søppel gir null, ikke en kastet feil", () => {
  assert.equal(svarMed({ title: 42, company: { navn: "x" } }).stilling, null);
  assert.deepEqual(tolkModellsvar({ content: [{ type: "text", text: "ikke json" }] }).selskap, null);
  assert.deepEqual(tolkModellsvar(null).selskap, null);
});

test("for lang tekst kuttes i stedet for å velte raden", () => {
  const r = svarMed({ title: "x".repeat(500) });
  assert.equal(r.stilling.length, 200);
});

/* ---------- sammenslåing ---------- */

test("deterministisk vinner over modellen", () => {
  const { utkast, kilder } = slåSammen(
    { selskap: "Aker BP", stilling: null }, { selskap: "Feil AS", stilling: "Analytiker" },
    "https://akerbp.com/1");
  assert.equal(utkast.selskap, "Aker BP");
  assert.equal(kilder.selskap, "strukturert");
  assert.equal(kilder.stilling, "modell");
});

test("graduate presiserer fulltid og får gå foran", () => {
  const { utkast } = slåSammen({ jobbtype: "fulltid" }, { jobbtype: "graduate" }, "https://a.no/1");
  assert.equal(utkast.jobbtype, "graduate");
});

test("lenken kommer alltid fra brukeren, aldri fra modellen", () => {
  const { utkast, kilder } = slåSammen({}, { lenke: "https://ond.example/" }, "https://ekte.no/jobb");
  assert.equal(utkast.lenke, "https://ekte.no/jobb");
  assert.equal(kilder.lenke, "bruker");
});

test("en javascript:-adresse gir tom lenke", () => {
  assert.equal(slåSammen({}, {}, "javascript:alert(1)").utkast.lenke, "");
});

test("byggForespørsel spør bare om det som mangler, og null om ingenting", () => {
  const be = byggForespørsel("tekst", ["sektor", "jobbtype"]);
  assert.deepEqual(be.output_config.format.schema.required, ["sector", "job_type"]);
  assert.equal(be.output_config.format.schema.additionalProperties, false);
  assert.equal(be.model, "claude-haiku-4-5");
  assert.equal(byggForespørsel("tekst", []), null);
});

/* ---------- sektor på selskapsnivå ---------- */

test("selskap i listen gir sektoren derfra", () => {
  assert.equal(sektorForSelskap("aker bp", {}, [{ selskap: "Aker BP", sektor: "energi" }]), "energi");
  assert.equal(sektorForSelskap("Ukjent AS", {}, []), null);
});

/* ---------- endepunktet ---------- */

test("strukturerte data alene: modellen blir aldri spurt", async t => {
  let spurt = false;
  const { base, stopp } = await start({
    hentSide: async url => ({ status: 200, sluttUrl: url,
      html: ldJson(stilling({ employmentType: "FULL_TIME" })) }),
    spørModell: async () => { spurt = true; return { content: [] }; }
  });
  t.after(stopp);

  const j = await (await importer(base, "https://akerbp.com/jobb/1")).json();
  assert.equal(spurt, false);
  assert.equal(j.utkast.stilling, "Graduate: Data Engineer");
  assert.equal(j.utkast.frist, "2026-09-13");
  assert.equal(j.kilder.stilling, "strukturert");
});

test("modellen fyller hullene når siden er tom for struktur", async t => {
  const { base, stopp } = await start(nettMed(
    "<h1>Analytiker</h1><p>Vi søker en analytiker til Trondheim, med oppstart til høsten.</p>",
    { title: "Analytiker", company: "Ukjent AS", deadline: "2026-11-01",
      deadline_type: "fixed", location: "Trondheim", sector: "finans", job_type: "fulltid" }));
  t.after(stopp);

  const j = await (await importer(base, "https://ukjent.no/jobb/2")).json();
  assert.equal(j.utkast.selskap, "Ukjent AS");
  assert.equal(j.utkast.frist, "2026-11-01");
  assert.equal(j.kilder.selskap, "modell");
});

test("kjent selskap gjenbruker sektoren og overstyrer modellen", async t => {
  const { base, stopp } = await start(
    nettMed("<h1>Konsulent</h1><p>Vi søker konsulenter til Oslo i høst.</p>",
            { title: "Konsulent", company: "Bekk", sector: "teknologi" }),
    [{ id: "a1", selskap: "Bekk", stilling: "Utvikler", sektor: "konsulent",
       lenke: "", sted: "", frist: null, status: "todo", notat: "", sendtDato: null }]);
  t.after(stopp);

  const j = await (await importer(base, "https://bekk.no/jobb/3")).json();
  assert.equal(j.utkast.sektor, "konsulent");
  assert.equal(j.kilder.sektor, "selskap");
});

test("en side uten noe å lese gir 422 med lenken i behold", async t => {
  const { base, stopp } = await start(nettMed("<div id='app'></div>", {}));
  t.after(stopp);

  const r = await importer(base, "https://js-tung.no/jobb/4");
  assert.equal(r.status, 422);
  const j = await r.json();
  assert.equal(j.feil, "tomt");
  assert.equal(j.utkast.lenke, "https://js-tung.no/jobb/4");
});

test("feil i hentingen blir 502 med meldingen, ikke en serverfeil", async t => {
  const { base, stopp } = await start({
    hentSide: async () => { throw new Error("Adressen peker til et internt nett."); },
    spørModell: async () => ({ content: [] })
  });
  t.after(stopp);

  const r = await importer(base, "http://127.0.0.1:4173/api/jobber");
  assert.equal(r.status, 502);
  assert.match((await r.json()).melding, /internt nett/);
});

test("manglende nøkkel er sin egen feil, ikke en generisk 500", async t => {
  const { base, stopp } = await start({
    hentSide: async url => ({ status: 200, sluttUrl: url, html: "<p>" + "tekst ".repeat(20) + "</p>" }),
    spørModell: async () => { const e = new Error("Ingen API-nøkkel."); e.navn = "mangler-nokkel"; throw e; }
  });
  t.after(stopp);

  const r = await importer(base, "https://a.no/jobb/5");
  assert.equal(r.status, 503);
  assert.equal((await r.json()).feil, "mangler-nokkel");
});

test("endepunktet tar bare POST, og krever en url", async t => {
  const { base, stopp } = await start(nettMed("<p>x</p>"));
  t.after(stopp);

  const g = await fetch(`${base}/api/importer`);
  assert.equal(g.status, 405);
  assert.equal(g.headers.get("allow"), "POST");

  const u = await fetch(`${base}/api/importer`, { method: "POST", body: "{}" });
  assert.equal(u.status, 400);
  assert.equal((await u.json()).feil, "mangler url");
});

/* ---------- vernet ---------- */

test("interne adresser kjennes igjen", () => {
  for(const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "169.254.169.254",
                   "172.16.0.1", "100.64.0.1", "0.0.0.0", "::1", "fe80::1",
                   "fd00::1", "::ffff:127.0.0.1"])
    assert.equal(erIntern(ip), true, `${ip} skulle vært avvist`);
});

test("utvendige adresser slipper gjennom", () => {
  for(const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1",
                   "2606:2800:220:1:248:1893:25c8:1946"])
    assert.equal(erIntern(ip), false, `${ip} skulle sluppet gjennom`);
});

/* ---------- nøkkelen ---------- */

/* Nøkkelen leses for seg, uten at noe kall går ut på nettet. */
async function medMiljø(verdi, fn){
  const før = process.env.ANTHROPIC_API_KEY;
  if(verdi === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = verdi;
  try{ return await fn(); }
  finally{
    if(før === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = før;
  }
}

const tomKatalog = () => fs.mkdtemp(path.join(os.tmpdir(), "jobber-nokkel-"));

test("uten nøkkel noe sted er det en egen feil", async () => {
  const katalog = await tomKatalog();
  const e = await medMiljø(undefined, () => lesNokkel(katalog).then(() => null, x => x));
  assert.ok(e instanceof ManglerNokkel);
  assert.equal(e.navn, "mangler-nokkel");
  assert.match(e.message, /nokkel\.txt/);
});

test("nokkel.txt leses, og trimmes", async () => {
  const katalog = await tomKatalog();
  await fs.writeFile(path.join(katalog, "nokkel.txt"), "  sk-ant-fra-fil\n");
  assert.equal(await medMiljø(undefined, () => lesNokkel(katalog)), "sk-ant-fra-fil");
});

test("miljøvariabelen går foran filen", async () => {
  const katalog = await tomKatalog();
  await fs.writeFile(path.join(katalog, "nokkel.txt"), "sk-ant-fra-fil");
  assert.equal(await medMiljø("sk-ant-fra-miljo", () => lesNokkel(katalog)), "sk-ant-fra-miljo");
});

test("tomme verdier teller som ingen nøkkel", async () => {
  const katalog = await tomKatalog();
  await fs.writeFile(path.join(katalog, "nokkel.txt"), "   \n");
  await assert.rejects(() => medMiljø("   ", () => lesNokkel(katalog)), ManglerNokkel);
});

/* ---------- feltet overlever lagringen ---------- */

test("jobbtype kommer helskinnet gjennom valideringen", () => {
  const r = validerSoknad({ selskap: "Aker BP", stilling: "Graduate", jobbtype: "graduate" },
                          { lagId: () => "a1" });
  assert.equal(r.ok, true);
  assert.equal(r.verdi.jobbtype, "graduate");
  assert.equal(validerSoknad({ selskap: "A", stilling: "B", jobbtype: "tull" },
                             { lagId: () => "a1" }).verdi.jobbtype, "");
});

test("datoer normaliseres fra de tre formene vi møter", () => {
  assert.equal(normaliserIsoDato("2026-09-13T23:59:00+02:00"), "2026-09-13");
  assert.equal(normaliserIsoDato("13.09.2026"), "2026-09-13");
  assert.equal(normaliserIsoDato("13.09", new Date("2026-08-31")), "2026-09-13");
  assert.equal(normaliserIsoDato("2026-02-31"), null);
  assert.equal(normaliserIsoDato("snarest"), null);
});
