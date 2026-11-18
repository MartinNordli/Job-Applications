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
