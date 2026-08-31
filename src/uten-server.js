/* ============================================================
   Åpnes index.html rett fra disk i stedet for gjennom serveren,
   blokkerer nettleseren ES-moduler, og siden blir stående tom
   uten å si hvorfor. Denne sier hvorfor.

   Gjelder bare nettlesermodus. I appen leverer Tauri selv filene,
   og modulene lastes alltid.
   ============================================================ */
addEventListener("DOMContentLoaded", () => setTimeout(() => {
  if(window.__jobbsoknaderKjorer || window.__TAURI__) return;
  const el = document.getElementById("innhold");
  if(!el) return;
  el.innerHTML = '<div class="tomt"><p class="tomt__tittel">Appen trenger serveren</p>'
    + '<p class="tomt__tekst">Kjør <code>npm start</code> i prosjektmappa og åpne '
    + '<a href="http://127.0.0.1:4173">127.0.0.1:4173</a>. Søknadene ligger i '
    + '<code>data/jobber.json</code>, og siden når dem bare gjennom serveren.</p></div>';
}, 1500));
