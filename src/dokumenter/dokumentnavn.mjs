export const ID = /^[A-Za-z0-9_-]{1,64}$/;

const MED_ID = { brev: "brev-", jobb: "jobb-" };
const FASTE = { "cv.json": "cv", "stil.json": "stil", "radar.json": "radar" };

export const erId = id => typeof id === "string" && ID.test(id);

export function dokumenttype(navn){
  if(typeof navn !== "string") return null;
  if(Object.hasOwn(FASTE, navn)) return FASTE[navn];
  for(const [type, prefiks] of Object.entries(MED_ID)){
    if(navn.startsWith(prefiks) && navn.endsWith(".json") && erId(navn.slice(prefiks.length, -5))) return type;
  }
  return null;
}

export function dokumentId(navn){
  const type = dokumenttype(navn);
  return type && Object.hasOwn(MED_ID, type) ? navn.slice(MED_ID[type].length, -5) : null;
}

export const navnFor = (type, id) => {
  if(!Object.hasOwn(MED_ID, type) || !erId(id)) return null;
  return `${MED_ID[type]}${id}.json`;
};

export const PREFIKSER = Object.values(MED_ID);
