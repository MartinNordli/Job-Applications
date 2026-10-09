/* ============================================================
   «⋯»-menyen på radene.

   Én meny for hele listen, ikke én per rad: listen tegnes på nytt ved
   hver endring, og en meny som bodde i raden, ville forsvunnet under
   musa. Denne ligger utenfor listen og plasseres ved knappen som
   åpnet den. Utløserne er knapper med data-meny="<id>",
   aria-haspopup="menu" og aria-expanded.

   Valgene er knapper med data-gjor og data-id, så den samme
   klikklytteren i app.js som tar radknappene, utfører dem. Menyen
   lukker seg og gir fokus tilbake til utløseren før klikket bobler
   videre dit, så en skuff som åpnes husker riktig sted å gå tilbake.

   Tastaturet følger WAI-ARIA-mønsteret for menyknapper: Enter,
   mellomrom og pil ned åpner på første valg, pil opp på siste. Inne
   i menyen går pilene rundt, Home og End til endene, en bokstav til
   neste valg som begynner med den, og Esc og Tab lukker.
   ============================================================ */

import { esc } from "./formater.js";

export function lagMeny({ valg }){
  const el = document.createElement("div");
  el.className = "meny";
  el.id = "radmeny";
  el.setAttribute("role", "menu");
  el.hidden = true;
  document.body.appendChild(el);

  let utløser = null, id = null;

  const punkter = () => Array.from(el.querySelectorAll('[role="menuitem"]'));
  const finnUtløser = () => (utløser && utløser.isConnected ? utløser
    : document.querySelector('[data-meny="' + CSS.escape(id || "") + '"]'));

  function åpne(knapp, fokus = "første"){
    const nyId = knapp.dataset.meny;
    const liste = valg(nyId);
    if(!liste.length) return;
    lukk({ fokus: false });
    utløser = knapp; id = nyId;
    el.innerHTML = liste.map(v =>
        (v.skille ? '<div class="meny__skille" role="separator"></div>' : "")
      + '<button class="meny__valg' + (v.fare ? " meny__valg--fare" : "") + '" type="button" role="menuitem" tabindex="-1"'
      + ' data-gjor="' + esc(v.gjor) + '" data-id="' + esc(nyId) + '">' + esc(v.tekst) + '</button>').join("");
    el.setAttribute("aria-label", knapp.getAttribute("aria-label") || "Flere valg");
    knapp.setAttribute("aria-expanded", "true");
    knapp.setAttribute("aria-controls", "radmeny");
    el.hidden = false;
    plasser();
    const p = punkter();
    (fokus === "siste" ? p[p.length - 1] : p[0]).focus();
  }

  /* Under knappen, høyrekanten mot høyrekanten. Er det ikke plass under,
     legger den seg over. */
  function plasser(){
    const k = utløser.getBoundingClientRect();
    const b = el.offsetWidth, h = el.offsetHeight, marg = 8;
    const venstre = Math.max(marg, Math.min(k.right - b, innerWidth - b - marg));
    const under = k.bottom + 6 + h <= innerHeight - marg;
    el.style.left = venstre + "px";
    el.style.top = (under ? k.bottom + 6 : Math.max(marg, k.top - 6 - h)) + "px";
  }

  function lukk({ fokus = true } = {}){
    if(el.hidden) return;
    el.hidden = true;
    const k = finnUtløser();
    if(utløser) utløser.setAttribute("aria-expanded", "false");
    if(k && k !== utløser) k.setAttribute("aria-expanded", "false");
    if(fokus && k) k.focus();
    utløser = null; id = null;
  }

  document.addEventListener("click", e => {
    const knapp = e.target.closest && e.target.closest("[data-meny]");
    if(knapp){
      if(!el.hidden && utløser === knapp) lukk();
      else åpne(knapp);
      return;
    }
    if(!el.hidden && !el.contains(e.target)) lukk({ fokus: false });
  });
  /* Valget lukker menyen først. Klikket bobler så videre til app.js. */
  el.addEventListener("click", e => { if(e.target.closest('[role="menuitem"]')) lukk(); });

  document.addEventListener("keydown", e => {
    const knapp = e.target.closest && e.target.closest("[data-meny]");
    if(knapp && (e.key === "ArrowDown" || e.key === "ArrowUp")){
      e.preventDefault();
      åpne(knapp, e.key === "ArrowUp" ? "siste" : "første");
    }
  });
  el.addEventListener("keydown", e => {
    const p = punkter(), i = p.indexOf(document.activeElement);
    const til = n => { e.preventDefault(); p[(n + p.length) % p.length].focus(); };
    if(e.key === "ArrowDown") til(i + 1);
    else if(e.key === "ArrowUp") til(i - 1);
    else if(e.key === "Home") til(0);
    else if(e.key === "End") til(p.length - 1);
    else if(e.key === "Escape"){ e.preventDefault(); lukk(); }
    else if(e.key === "Tab"){ e.preventDefault(); lukk(); }
    else if(e.key.length === 1 && /\p{L}/u.test(e.key)){
      const b = e.key.toLowerCase();
      const neste = p.slice(i + 1).concat(p.slice(0, i + 1)).find(x => x.textContent.trim().toLowerCase().startsWith(b));
      if(neste){ e.preventDefault(); neste.focus(); }
    }
  });

  /* En meny som henger igjen når listen ruller eller vinduet endres,
     peker på feil rad. Den lukkes heller enn å flyttes etter. */
  addEventListener("scroll", () => lukk({ fokus: false }), { passive: true, capture: true });
  addEventListener("resize", () => lukk({ fokus: false }));

  return { lukk: () => lukk({ fokus: false }), erÅpen: () => !el.hidden };
}
