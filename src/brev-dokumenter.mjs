/* Små innganger; parserne og eksportbibliotekene lastes bare når de trengs. */
const MAKS_FIL = 10 * 1024 * 1024;
let motor;
const hentMotor = () => motor ||= import("./vendor/brev-dokumentmotor.js");

export async function lesCvFil(file){
  if(!file || typeof file.arrayBuffer !== "function") throw new Error("Velg en CV-fil først.");
  if(!file.size || file.size > MAKS_FIL) throw new Error("CV-en må være mellom 1 byte og 10 MB.");
  const navn = String(file.name || "CV");
  const format = navn.split(".").pop().toLowerCase();
  if(!["pdf", "docx", "txt"].includes(format)) throw new Error("Velg PDF, DOCX eller en tekstfil (.txt).");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { lesCvBytes } = await hentMotor();
  return { navn, format, tekst: await lesCvBytes(bytes, format) };
}

export async function lagreFil({ navn, bytes, mime = "application/octet-stream" }){
  let data;
  if(typeof bytes === "string") data = new TextEncoder().encode(bytes);
  else if(bytes instanceof Blob) data = new Uint8Array(await bytes.arrayBuffer());
  else if(bytes instanceof ArrayBuffer) data = new Uint8Array(bytes);
  else if(ArrayBuffer.isView(bytes)) data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  else throw new Error("Filen mangler innhold.");
  if(data.byteLength > 25 * 1024 * 1024) throw new Error("Eksporten er for stor (maks 25 MB).");
  const filnavn = String(navn || "soknadsbrev.pdf").replace(/[\\/\u0000-\u001f]/g, "-").slice(0, 180);
  if(typeof window !== "undefined" && window.__TAURI__){
    try{
      const lagret = await window.__TAURI__.core.invoke("brev_lagre_fil", { navn: filnavn, bytes: Array.from(data) });
      return { lagret };
    }catch{ throw new Error("Fikk ikke lagret filen. Prøv en annen plassering."); }
  }
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement("a"); a.href = url; a.download = filnavn;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { lagret: true };
}

export async function eksporterBrev(inn, format){
  if(!["pdf", "docx"].includes(format)) throw new Error("Velg PDF eller DOCX.");
  if(typeof inn?.tekst !== "string" || !inn.tekst.trim()) throw new Error("Skriv et brev før du eksporterer.");
  const { byggEksport } = await hentMotor();
  const bytes = await byggEksport(inn, format);
  const del = [inn.selskap, inn.stilling].filter(Boolean).join(" - ").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").slice(0, 120);
  return lagreFil({ navn: `${del || "Soknadsbrev"}.${format}`, bytes,
    mime: format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}
