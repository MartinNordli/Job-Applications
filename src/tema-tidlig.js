/* ============================================================
   Temaet må stå på <html> før første maling. Leses det først når
   app.js kjører, blinker den lyse flaten fram i et mørkt vindu.
   Derfor en vanlig, blokkerende <script src> høyt i <head>.

   localStorage kan kaste — da faller vi tilbake på systemvalget,
   som uansett er riktig standard. Nøkkelen er egen: dette er en
   innstilling for denne maskinen, ikke data, og skal aldri innom
   datafilen.
   ============================================================ */
(function(){
  try{
    var t = localStorage.getItem("jobbsoknader-tema");
    if(t === "lys" || t === "mork") document.documentElement.setAttribute("data-tema", t);
  }catch(e){}
})();
