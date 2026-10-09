/* ============================================================
   De automatiske sjekkene i evalueringen. Rene funksjoner uten
   nettverk, så de kan prøves i den vanlige testpakken.

   De fanger det som kan måles: språk, ordtall, hilsen og avslutning,
   antall avsnitt, kjente stilbrudd, lånte fakta og forbudte ord. De
   sier ingenting om brevet er godt. Det avgjør den menneskelige
   vurderingen (se evals/README.md).
   ============================================================ */
import { finnStilbrudd, finnStrukturbrudd, finnLånteFakta, innholdsavsnitt, ordtall, validerGrunnlag } from "../src/brevlogikk.mjs";

const SPRÅK = { norsk: "nb", bokmål: "nb", nynorsk: "nn", engelsk: "en", english: "en" };
const kode = s => SPRÅK[String(s).trim().toLowerCase()] || String(s).trim().toLowerCase();

/* Tom liste betyr at alle sjekkene er bestått. */
export function sjekkBrev(tilfelle, brev){
  const funn = [], tekst = String(brev?.tekst ?? "");
  if(!tekst.trim()) return ["Brevet er tomt."];
  if(kode(brev.sprak) !== tilfelle.forventetSprak) funn.push(`Språket er ${brev.sprak}, ventet ${tilfelle.forventetSprak}.`);
  const n = ordtall(tekst), [min, maks] = tilfelle.ord;
  if(n < min || n > maks) funn.push(`Brevet har ${n} ord, ventet ${min} til ${maks}.`);
  const avsnitt = innholdsavsnitt(tekst).length, [fra, til] = tilfelle.avsnitt;
  if(avsnitt < fra || avsnitt > til) funn.push(`Brevet har ${avsnitt} innholdsavsnitt, ventet ${fra} til ${til}.`);
  funn.push(...finnStrukturbrudd(tekst, tilfelle.forventetSprak), ...finnStilbrudd(tekst));
  if(tilfelle.kontaktperson && !tekst.trim().split(/\r?\n/u)[0].includes(tilfelle.kontaktperson))
    funn.push(`Hilsenen bruker ikke kontaktpersonen ${tilfelle.kontaktperson}.`);
  const lånt = finnLånteFakta(tekst, validerGrunnlag(tilfelle.grunnlag));
  if(lånt.length) funn.push(`Brevet bruker særord som ikke står i grunnlaget: ${lånt.join(", ")}.`);
  if(tilfelle.forbudt && new RegExp(tilfelle.forbudt, "iu").test(tekst)) funn.push("Brevet inneholder noe det ikke skal.");
  return funn;
}
