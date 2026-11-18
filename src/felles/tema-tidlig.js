window.TEMAER = [
  { id: "system",  navn: "System",          om: "Lin eller Sot, som Macen",
    prøve: ["#EBE8E1", "#3D52D5", "#16130F", "#7391A8"] },
  { id: "lys",     navn: "Lin",             om: "Lys, varm og nøytral",
    prøve: ["#EBE8E1", "#17181A", "#3D52D5", "#E6E3DA"] },
  { id: "mork",    navn: "Sot",             om: "Mørk, varm og nøytral",
    prøve: ["#16130F", "#F2EEE8", "#7391A8", "#2E271C"] },
  { id: "ink",     navn: "Ink og elfenben", om: "Lys, blått blekk",
    prøve: ["#F7F5F0", "#1A2232", "#1A2232", "#E9E3D8"] },
  { id: "blush",   navn: "Blush",           om: "Babyrosa, clean",
    prøve: ["#FBF5F6", "#2B2226", "#A84D62", "#F4D6DC"] },
  { id: "midnatt", navn: "Midnatt",         om: "Mørk, blå og sand",
    prøve: ["#0F1520", "#F5F2EC", "#D8C3A1", "#2A3344"] }
];

(function(){
  try{
    var t = localStorage.getItem("jobbsoknader-tema");
    var gyldig = window.TEMAER.some(function(v){ return v.id === t && t !== "system"; });
    if(gyldig) document.documentElement.setAttribute("data-tema", t);
  }catch(e){}
})();
