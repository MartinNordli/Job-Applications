addEventListener("DOMContentLoaded", () => setTimeout(() => {
  if(window.__jobbsoknaderKjorer || window.__TAURI__) return;
  const el = document.getElementById("innhold");
  if(!el) return;
  el.innerHTML = '<div class="tomt"><p class="tomt__tittel">Appen trenger serveren</p>'
    + '<p class="tomt__tekst">Kjør <code>npm start</code> i prosjektmappa og åpne '
    + '<a href="http://127.0.0.1:4173">127.0.0.1:4173</a>. Søknadene ligger i '
    + 'datakatalogen på maskinen, og siden når dem bare gjennom serveren.</p></div>';
}, 1500));
