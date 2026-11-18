/* Bundles isolert av bygg-dokumenter. Innhold leses lokalt, aldri som HTML. */
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import mammoth from "mammoth/mammoth.browser.js";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { Unzip, UnzipInflate, zipSync } from "fflate";

const MAKS_TEKST = 100_000;
const MAKS_FIL = 10 * 1024 * 1024;
const MAKS_UTPAKKET = 25 * 1024 * 1024;

/* Avvis krypterte/uvanlig store ZIP-er før Mammoth pakker dem ut. */
export function sjekkDocx(bytes){
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if(bytes.length < 22 || v.getUint32(0, true) !== 0x04034b50) throw new Error("Filen er ikke et gyldig DOCX-dokument.");
  let slutt = -1;
  for(let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--){
    if(v.getUint32(i, true) === 0x06054b50){ slutt = i; break; }
  }
  if(slutt < 0) throw new Error("DOCX-filen er ufullstendig.");
  const antall = v.getUint16(slutt + 10, true), sentralStorrelse = v.getUint32(slutt + 12, true);
  let p = v.getUint32(slutt + 16, true), sum = 0, dokument = false;
  if(antall > 2000 || p + sentralStorrelse > slutt) throw new Error("DOCX-filen er for omfattende.");
  for(let n = 0; n < antall; n++){
    if(p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw new Error("DOCX-filen har et ugyldig filregister.");
    if(v.getUint16(p + 8, true) & 1) throw new Error("Passordbeskyttede DOCX-filer støttes ikke.");
    const storrelse = v.getUint32(p + 24, true), navnLengde = v.getUint16(p + 28, true);
    sum += storrelse;
    if(sum > MAKS_UTPAKKET) throw new Error("DOCX-filen blir for stor når den åpnes (maks 25 MB).");
    const neste = p + 46 + navnLengde + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    if(neste > bytes.length) throw new Error("DOCX-filen er ufullstendig.");
    const navn = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + navnLengde));
    if(navn === "word/document.xml") dokument = true;
    p = neste;
  }
  if(!dokument) throw new Error("Filen inneholder ikke et Word-dokument.");
}

/* Grensen håndheves også på faktisk utpakket tekst, ikke bare ZIP-registerets
   oppgitte størrelse. Bilder og andre binærvedlegg behøver ikke pakkes ut. */
function avgrensDocx(bytes){
  const xml = new Set(["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/numbering.xml", "word/footnotes.xml", "word/endnotes.xml", "word/comments.xml", "word/_rels/document.xml.rels"]);
  const filer = {}; let sum = 0, feil;
  const leser = new Unzip(fil => {
    if(!xml.has(fil.name)) return;
    const biter = []; let lengde = 0;
    fil.ondata = (e, bit, ferdig) => {
      if(e){ feil = new Error("DOCX-filen kunne ikke pakkes ut."); return; }
      sum += bit.byteLength; lengde += bit.byteLength;
      if(sum > MAKS_UTPAKKET){ feil = new Error("DOCX-filen blir for stor når den åpnes (maks 25 MB)."); fil.terminate(); return; }
      biter.push(bit);
      if(ferdig){
        const inn = new Uint8Array(lengde); let p = 0;
        for(const bit of biter){ inn.set(bit, p); p += bit.byteLength; }
        filer[fil.name] = inn;
      }
    };
    fil.start();
  });
  leser.register(UnzipInflate);
  for(let p = 0; p < bytes.length; p += 1024){
    leser.push(bytes.subarray(p, Math.min(p + 1024, bytes.length)), p + 1024 >= bytes.length);
    if(feil) throw feil;
  }
  return zipSync(filer, { level: 0 });
}

function ryddTekst(tekst){
  const ren = String(tekst || "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  if(ren.length > MAKS_TEKST) throw new Error("CV-teksten er for lang (maks 100 000 tegn). Bruk et kortere dokument eller lim inn relevant tekst.");
  if(!ren) throw new Error("Fant ingen tekst i CV-en. Lim inn teksten i stedet.");
  return ren;
}

export async function lesCvBytes(bytes, format, { workerSrc } = {}){
  if(!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAKS_FIL) throw new Error("CV-filen må være mindre enn 10 MB.");
  if(format === "txt"){
    try{ return ryddTekst(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch(e){ if(e instanceof TypeError) throw new Error("Tekstfilen må være lagret som UTF-8. Du kan også lime inn teksten."); throw e; }
  }
  if(format === "docx"){
    sjekkDocx(bytes);
    try{
      const trygg = avgrensDocx(bytes);
      const r = await mammoth.extractRawText({ arrayBuffer: trygg.buffer.slice(trygg.byteOffset, trygg.byteOffset + trygg.byteLength) });
      return ryddTekst(r.value);
    }catch(e){ if(e?.message?.startsWith("CV-teksten") || e?.message?.startsWith("Fant ingen")) throw e; throw new Error("Fikk ikke lest DOCX-filen. Prøv en annen fil eller lim inn teksten."); }
  }
  if(format !== "pdf") throw new Error("Filformatet støttes ikke.");
  if(new TextDecoder().decode(bytes.subarray(0, 1024)).indexOf("%PDF-") < 0) throw new Error("Filen er ikke et gyldig PDF-dokument.");
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc || new URL("./pdf.worker.min.mjs", import.meta.url).href;
  let oppgave, pdf;
  try{
    oppgave = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false });
    pdf = await oppgave.promise;
    if(pdf.numPages > 50) throw new Error("CV-en har mer enn 50 sider. Bruk et kortere dokument.");
    let tekst = "";
    for(let n = 1; n <= pdf.numPages; n++){
      const side = await pdf.getPage(n), innhold = await side.getTextContent();
      tekst += innhold.items.map(t => typeof t.str === "string" ? t.str + (t.hasEOL ? "\n" : " ") : "").join("") + "\n\n";
      side.cleanup();
      if(tekst.length > MAKS_TEKST) throw new Error("CV-teksten er for lang (maks 100 000 tegn). Bruk et kortere dokument.");
    }
    if(!tekst.trim()) throw new Error("PDF-en har ikke et lesbart tekstlag. Skannede CV-er støttes ikke. Lim inn CV-teksten i stedet.");
    return ryddTekst(tekst);
  }catch(e){
    if(e?.name === "PasswordException") throw new Error("PDF-en er passordbeskyttet. Bruk en ulåst fil eller lim inn teksten.");
    if(/CV-|CV-en|tekstlag|Skannede/.test(e?.message || "")) throw e;
    throw new Error("Fikk ikke lest PDF-filen. Prøv en annen fil eller lim inn teksten.");
  }finally{ if(pdf) await pdf.destroy(); else if(oppgave) await oppgave.destroy(); }
}

export function dokumentmodell({ tekst, stilling = "", selskap = "", navn = "" }){
  if(typeof tekst !== "string" || !tekst.trim() || tekst.length > MAKS_TEKST) throw new Error("Brevet mangler tekst eller er for langt.");
  return { avsnitt: tekst.replace(/\r\n?/g, "\n").trim().split(/\n{2,}/), tittel: [stilling, selskap].filter(Boolean).join(" - "), forfatter: navn,
    overskrift: stilling, selskap,
    bredde: 595.28, hoyde: 841.89, marg: 70.866, skrift: 11, linje: 15.4, avsnittsavstand: 11 };
}

async function docxBytes(m, fonter){
  const heading = (tekst, size, after) => new Paragraph({ keepNext: true, spacing: { after: after * 20 }, children: [new TextRun({ text: tekst, font: "Noto Sans", size: size * 2, color: "000000" })] });
  const barn = [
    ...(m.forfatter ? [heading(m.forfatter, 10, 18)] : []),
    ...(m.overskrift ? [heading(m.overskrift, 16, m.selskap ? 4 : 20)] : []),
    ...(m.selskap ? [heading(m.selskap, 11, 20)] : []),
    ...m.avsnitt.map(tekst => new Paragraph({
    spacing: { after: Math.round(m.avsnittsavstand * 20), line: Math.round(m.linje / m.skrift * 240) },
    widowControl: true,
    children: tekst.split("\n").map((text, i) => new TextRun({ text, ...(i ? { break: 1 } : {}), font: "Noto Sans", size: m.skrift * 2, color: "111111" }))
  }))];
  const dok = new Document({ creator: m.forfatter, title: m.tittel, description: "", fonts: [{ name: "Noto Sans", data: fonter[0] }], styles: { default: { document: { run: { font: "Noto Sans", size: 22, color: "111111" } } } },
    sections: [{ properties: { page: { size: { width: Math.round(m.bredde * 20), height: Math.round(m.hoyde * 20) }, margin: { top: m.marg * 20, bottom: m.marg * 20, left: m.marg * 20, right: m.marg * 20 } } }, children: barn }] });
  return new Uint8Array(await Packer.toArrayBuffer(dok));
}

async function standardfonter(){
  const navn = ["noto-sans-regular.ttf"];
  return Promise.all(navn.map(async n => {
    const r = await fetch(new URL(`../skrifter/${n}`, import.meta.url));
    if(!r.ok) throw new Error("Fikk ikke lastet skrifttypen til PDF-en.");
    return new Uint8Array(await r.arrayBuffer());
  }));
}

async function pdfBytes(m, fontBytes){
  const pdf = await PDFDocument.create(); pdf.registerFontkit(fontkit);
  pdf.setTitle(m.tittel); if(m.forfatter) pdf.setAuthor(m.forfatter);
  const skrifter = await Promise.all(fontBytes.map(b => pdf.embedFont(b, { subset: true })));
  const tegnsett = skrifter.map(f => new Set(f.getCharacterSet()));
  const velg = tegn => {
    const n = tegn.codePointAt(0), i = tegnsett.findIndex(s => s.has(n));
    if(i < 0) throw new Error(`PDF-skriften mangler tegnet «${tegn}». Bruk DOCX for denne teksten.`);
    return skrifter[i];
  };
  let skrift = m.skrift, linjehoyde = m.linje;
  const bredde = tekst => [...tekst].reduce((sum, t) => sum + velg(t).widthOfTextAtSize(t, skrift), 0);
  let side, y;
  const nySide = () => { side = pdf.addPage([m.bredde, m.hoyde]); y = m.hoyde - m.marg - m.skrift; };
  const tegnLinje = tekst => {
    if(y < m.marg + skrift) nySide();
    let x = m.marg, font = null, del = "";
    const tegnDel = () => { if(!del) return; side.drawText(del, { x, y, size: skrift, font, color: rgb(.067, .067, .067) }); x += font.widthOfTextAtSize(del, skrift); del = ""; };
    for(const t of tekst){ const ny = velg(t); if(font && ny !== font) tegnDel(); font = ny; del += t; }
    tegnDel(); y -= linjehoyde;
  };
  const tilgjengelig = m.bredde - 2 * m.marg;
  nySide();
  const blokker = [
    ...(m.forfatter ? [{tekst:m.forfatter,size:10,etter:18}] : []),
    ...(m.overskrift ? [{tekst:m.overskrift,size:16,etter:m.selskap?4:20}] : []),
    ...(m.selskap ? [{tekst:m.selskap,size:11,etter:20}] : []),
    ...m.avsnitt.map(tekst=>({tekst,size:m.skrift,etter:m.avsnittsavstand}))
  ];
  for(const blokk of blokker){
    skrift = blokk.size; linjehoyde = skrift === m.skrift ? m.linje : skrift * 1.4;
    const linjer = [];
    const avsnitt = blokk.tekst;
    for(const rad of avsnitt.split("\n")){
      let linje = "";
      for(const ord of rad.replace(/\t/g, "    ").split(/ +/)){
        if(linje && bredde(linje + " " + ord) > tilgjengelig){ linjer.push(linje); linje = ""; }
        if(bredde(ord) > tilgjengelig){
          if(linje){ linjer.push(linje); linje = ""; }
          for(const t of ord){ if(bredde(linje + t) > tilgjengelig){ linjer.push(linje); linje = ""; } linje += t; }
        }else linje += (linje ? " " : "") + ord;
      }
      linjer.push(linje);
    }
    // Flytt korte avsnitt samlet; del lange uten en enslig første/siste linje.
    if(linjer.length <= 4 && y - (linjer.length - 1) * linjehoyde < m.marg + skrift) nySide();
    for(let n = 0; n < linjer.length; n++){
      const ledige = Math.floor((y - m.marg - skrift) / linjehoyde) + 1;
      if((n === 0 && linjer.length > 1 && ledige < 2) || (linjer.length - n === 2 && ledige === 1)) nySide();
      tegnLinje(linjer[n]);
    }
    y -= blokk.etter;
  }
  return pdf.save();
}

export async function byggEksport(inn, format, { fontBytes } = {}){
  const m = dokumentmodell(inn);
  const fonter = fontBytes || await standardfonter();
  if(format === "docx") return docxBytes(m, fonter);
  if(format === "pdf") return pdfBytes(m, fonter);
  throw new Error("Eksportformatet støttes ikke.");
}
