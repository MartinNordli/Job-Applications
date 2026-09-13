/* Bare dokumentmotoren trenger bundling. Resten av appen er vanlige ES-moduler. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const rot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(rot, "src/vendor");
await fs.mkdir(vendor, { recursive: true });
await build({ entryPoints: [path.join(rot, "src/brev-dokumentmotor.mjs")], bundle: true, format: "esm", platform: "browser", target: "es2022",
  outfile: path.join(vendor, "brev-dokumentmotor.js"), minify: true, legalComments: "linked" });
await fs.copyFile(path.join(rot, "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"), path.join(vendor, "pdf.worker.min.mjs"));
