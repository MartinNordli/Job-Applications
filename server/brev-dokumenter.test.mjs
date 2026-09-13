import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { lesCvBytes, byggEksport, sjekkDocx, dokumentmodell } from "../src/brev-dokumentmotor.mjs";
const fontBytes = [await fs.readFile(new URL("../src/skrifter/noto-sans-regular.ttf",import.meta.url))];
const workerSrc = new URL("../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",import.meta.url).href;
const brev = {tekst:"Jeg søker fordi arbeidet med kundene interesserer meg. Ærlig og konkret.\n\nJeg har fulgt opp kunder og lært å finne løsninger sammen med dem.\n\nVennlig hilsen\nÅse Ødegård",stilling:"Rådgiver",selskap:"Eksempel AS"};

test("tekst-CV bevarer norske tegn og avviser tom/stor/ugyldig input",async()=>{
  assert.equal(await lesCvBytes(new TextEncoder().encode("Ærlig CV\r\nErfaring"),"txt"),"Ærlig CV\nErfaring");
  await assert.rejects(lesCvBytes(new Uint8Array([0xff]),"txt"),/UTF-8/);
  await assert.rejects(lesCvBytes(new Uint8Array(10*1024*1024+1),"txt"),/10 MB/);
  await assert.rejects(lesCvBytes(new TextEncoder().encode("x".repeat(100001)),"txt"),/100 000/);
});
test("DOCX inneholder aktiv brevtekst og innebygd skrifttype; kan leses tilbake som CV",async()=>{
  const bytes=await byggEksport(brev,"docx",{fontBytes});const zip=unzipSync(bytes);
  assert.ok(zip["word/fonts/font1.odttf"]);const xml=strFromU8(zip["word/document.xml"]);
  assert.match(xml,/Noto Sans/);assert.match(xml,/Rådgiver/);assert.match(xml,/Åse Ødegård/);assert.match(xml,/w:widowControl/);
  const tekst=await lesCvBytes(bytes,"docx");assert.match(tekst,/Jeg søker fordi/);assert.match(tekst,/Åse Ødegård/);
});
test("PDF med statisk Unicode-font kan leses tilbake uten tap av norske tegn",async()=>{
  const bytes=await byggEksport(brev,"pdf",{fontBytes});
  const pdf=await PDFDocument.load(bytes);assert.equal(pdf.getPageCount(),1);
  const tekst=await lesCvBytes(bytes,"pdf",{workerSrc});assert.match(tekst,/Åse Ødegård/);assert.match(tekst,/Ærlig og konkret/);assert.match(tekst,/Rådgiver/);
});
test("lang PDF går over flere sider og beholder siste avsnitt",async()=>{
  const tekst=Array.from({length:30},(_,i)=>`Avsnitt ${i+1}. ${brev.tekst.split("\n\n")[0].repeat(3)}`).join("\n\n");
  const bytes=await byggEksport({...brev,tekst},"pdf",{fontBytes});const pdf=await PDFDocument.load(bytes);assert.ok(pdf.getPageCount()>1);
  assert.match(await lesCvBytes(bytes,"pdf",{workerSrc}),/Avsnitt 30/);
});
test("skannet/tom PDF får tydelig tekstlagfeil og feil filtype avvises",async()=>{
  const pdf=await PDFDocument.create();pdf.addPage();
  await assert.rejects(lesCvBytes(await pdf.save(),"pdf",{workerSrc}),/tekstlag/);
  await assert.rejects(lesCvBytes(strToU8("dette er ikke pdf"),"pdf"),/gyldig PDF/);
});
test("DOCX-filregister har størrelsesgrense og krever faktisk Word-innhold",()=>{
  assert.throws(()=>sjekkDocx(zipSync({"not-a-doc.txt":strToU8("hei")})),/Word-dokument/);
  const bytes=zipSync({"word/document.xml":strToU8("<doc/>")});
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(let p=0;p<bytes.length-46;p++)if(v.getUint32(p,true)===0x02014b50){v.setUint32(p+24,26*1024*1024,true);break;}
  assert.throws(()=>sjekkDocx(bytes),/25 MB/);
});
test("eksportmodellen har A4,25mm marg og inneholder ingen oppdiktet avslutning",()=>{
  const m=dokumentmodell(brev);assert.equal(m.marg,70.866);assert.equal(m.avsnitt.join("\n\n"),brev.tekst);
});
