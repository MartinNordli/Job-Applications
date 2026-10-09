/* ============================================================
   Hvilke dokumenter en profil kan ha, og hva de heter.

   Fire typer, og ingen andre: cv.json, brev-<id>.json,
   jobb-<id>.json og radar.json. Navnet er hele adressen til en fil
   i profilkatalogen, så regelen er også vernet mot å gå ut av den:
   en id har bare bokstaver, sifre, bindestrek og understrek, aldri
   punktum eller skråstrek. Det holder også kopiene utenfor, for
   brev-x.forrige.json har et punktum i id-en.

   Regelen står her og i dokumentnavn() i src-tauri/src/brev.rs,
   og testdata/dokumenter.json holder de to like. Lageret, listen,
   sikkerhetskopien og ruten bruker bare denne.
   ============================================================ */

export const ID = /^[A-Za-z0-9_-]{1,64}$/;

/* Rekkefølgen er bare for lesbarhet. Prefiksene overlapper ikke. */
const MED_ID = { brev: "brev-", jobb: "jobb-" };
const FASTE = { "cv.json": "cv", "radar.json": "radar" };

export const erId = id => typeof id === "string" && ID.test(id);

/* "cv" | "brev" | "jobb" | "radar", eller null for alt annet. */
export function dokumenttype(navn){
  if(typeof navn !== "string") return null;
  if(Object.hasOwn(FASTE, navn)) return FASTE[navn];
  for(const [type, prefiks] of Object.entries(MED_ID)){
    if(navn.startsWith(prefiks) && navn.endsWith(".json") && erId(navn.slice(prefiks.length, -5))) return type;
  }
  return null;
}

/* Id-en i brev-<id>.json og jobb-<id>.json, ellers null. */
export function dokumentId(navn){
  const type = dokumenttype(navn);
  return type && Object.hasOwn(MED_ID, type) ? navn.slice(MED_ID[type].length, -5) : null;
}

export const navnFor = (type, id) => {
  if(!Object.hasOwn(MED_ID, type) || !erId(id)) return null;
  return `${MED_ID[type]}${id}.json`;
};

/* Prefiksene utdraget kan be om. Faste navn har ingen samling å gå over. */
export const PREFIKSER = Object.values(MED_ID);
