/* ============================================================
   Sidelengs rulling som synes. En stripe med klassen .flyt som er
   bredere enn plassen sin, får data-flyt-start når noe er skjult til
   venstre og data-flyt-slutt når noe er skjult til høyre. CSS-en tegner
   en fade på den siden, så et klippet ord leses som «det er mer her»
   og ikke som en feil.

   Én lytter fanger rullingen for alle stripene, også de som tegnes på
   nytt, og vinduets størrelse. Den som tegner en stripe, kaller
   oppdaterFlyt() etterpå, så tilstanden stemmer før første rulling.
   ============================================================ */
function sjekk(el){
  const over = el.scrollWidth - el.clientWidth;
  el.toggleAttribute("data-flyt-start", over > 1 && el.scrollLeft > 1);
  el.toggleAttribute("data-flyt-slutt", over > 1 && el.scrollLeft < over - 1);
}

export function oppdaterFlyt(rot = document){
  if(rot.classList?.contains("flyt")) sjekk(rot);
  rot.querySelectorAll(".flyt").forEach(sjekk);
}

document.addEventListener("scroll", e => {
  if(e.target instanceof Element && e.target.classList.contains("flyt")) sjekk(e.target);
}, true);
addEventListener("resize", () => oppdaterFlyt());
