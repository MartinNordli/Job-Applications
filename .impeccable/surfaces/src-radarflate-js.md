---
version: 1
slug: "src-radarflate-js"
primary_target: "src/radarflate.js"
related_targets: ["src/stiler.css"]
---

# Radar

Modus: Operate.
Omfang: Radar-visningen i `src/radarflate.js` og reglene for den i `src/stiler.css`.
Resten av Hired beholder sitt uttrykk; bare Radar får treff-fargen.

Jobben: se på sekunder om noe nytt er verdt å søke på, legge det til, og avvise resten.
Klagen på dagens side: for lite farge, for mye tekst, tilfeldig rekkefølge, for lite å se på.
Brukeren valgte retning B fra `specs/radar/designforslag.html` (branch docs/radar-designforslag), med trakten fra C og fanene fra D, i petrol.
Det som skal sees uten å leses: hvor godt en stilling passer, og fristen.

## Direction contract

THESIS: Innboksen er en rangering, ikke en logg. Funnene står i bånd etter treffskalaen, best først, og fargen betyr bare hvor godt noe passer. Siden nekter den kronologiske tekststabelen der 96 % og 53 % ser like ut.

OWN-WORLD: Hireds flater, Familjen Grotesk og Geist Mono, pluss en petrol-skala i fire trinn (--treff-1 til 4, --treff-vask). Treff er en fylt måler og en farget prikk ved båndnavnet; toppfunnet ligger på petrol-vask med prosenten i display-størrelse. Ild og rav er fortsatt bare frist.

STORY: Brukeren ser trakten (alle aktive, passet søkeordene, vurdert, nådde terskelen) og forstår at Radar har gjort jobben. Så ser brukeren det som er midt i blinken, leser grunnene og legger det til. Resten skummes på prosent og frist, og «Hvorfor» åpnes bare ved behov.

FIRST VIEWPORT: Tittel, tellingen og «Søk nå» øverst. Trakten som én rad med fire store tall i mono og pil mellom, med siste og neste søk over. Fanene Innboks, Under terskelen, Lagt til, Kjøringer, Innstillinger. Så toppkortet i full bredde: prosent på rundt 80 px til venstre, stilling og selskap, alle grunnene, og «Legg til» som eneste primærknapp til høyre. Første bånd begynner under.

FORM: B med trakt og faner, valgt av brukeren blant fire retninger i designforslaget (B var anbefalingen, nummer én). seed: none (skipped: retningen ble valgt av brukeren i designforslaget før denne økten, så ingen trekning ble gjort)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Uavklart

Ingenting.
