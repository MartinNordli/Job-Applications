---
name: Hired
description: Personlig oversikt over jobbsøknader, frister og nye stillinger, på brukerens egen maskin.
colors:
  bunn: "light-dark(#EBE8E1, #16130F)"
  kort: "light-dark(#FFFFFF, #1E1A15)"
  innfelt: "light-dark(#F3F1EB, #171410)"
  innfelt-2: "light-dark(#E6E3DA, #2E271C)"
  blekk: "light-dark(#17181A, #F2EEE8)"
  blekk-2: "light-dark(#4A4E54, #B8B0A5)"
  blekk-3: "light-dark(#5C6166, #968F84)"
  linje: "light-dark(#E3E0D8, #2A251E)"
  linje-2: "light-dark(#D2CEC4, #39322A)"
  ild: "light-dark(#C63A2E, #FF7A45)"
  ild-t: "light-dark(#B8342A, #FF8A5C)"
  ild-vask: "light-dark(#FAE7E4, #3A2118)"
  ild-trykk: "light-dark(#9E2C22, #E0602B)"
  rav: "light-dark(#B0790F, #CE8B3A)"
  rav-t: "light-dark(#8B600C, #DC9C4C)"
  rav-vask: "light-dark(#F7EEDA, #33260F)"
  mose: "light-dark(#2E7D57, #7D9E7A)"
  mose-t: "light-dark(#2B7652, #8CAE89)"
  mose-vask: "light-dark(#E1F0E8, #202A1F)"
  hav: "light-dark(#3D52D5, #7391A8)"
  hav-t: "light-dark(#3949C0, #8CAAC1)"
  hav-vask: "light-dark(#E6E9FB, #1E2830)"
  graf-1: "light-dark(#A7B0EC, #49575F)"
  graf-2: "light-dark(#7A8AE2, #5F7583)"
  graf-3: "light-dark(#3D52D5, #7391A8)"
  graf-4: "light-dark(#2A3A97, #9DBAD1)"
  treff-1: "light-dark(#76BFCB, #2A616C)"
  treff-2: "light-dark(#359BAE, #368794)"
  treff-3: "light-dark(#00778C, #50AEBA)"
  treff-4: "light-dark(#005266, #8EDADE)"
  treff-vask: "light-dark(#EAF8FB, #10272C)"
  primar: "light-dark(#17181A, #F2EEE8)"
  primar-blekk: "light-dark(#FFFFFF, #1E1A15)"
  primar-hover: "light-dark(#2E3238, #DED8CF)"
  varsel-bunn: "light-dark(#1B1D21, #2C2620)"
  varsel-blekk: "light-dark(#F4F3F0, #F2EEE8)"
typography:
  display:
    fontFamily: "Geist Mono, IBM Plex Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "80px"
    fontWeight: 600
    lineHeight: 0.84
    letterSpacing: "-0.04em"
    fontFeature: "tnum"
  numeral:
    fontFamily: "Geist Mono, IBM Plex Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.02em"
    fontFeature: "tnum"
  headline:
    fontFamily: "Familjen Grotesk, Helvetica Neue, Arial, sans-serif"
    fontSize: "27px"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Familjen Grotesk, Helvetica Neue, Arial, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.018em"
  row-title:
    fontFamily: "Familjen Grotesk, Helvetica Neue, Arial, sans-serif"
    fontSize: "14.5px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Familjen Grotesk, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.45
  body-sm:
    fontFamily: "Familjen Grotesk, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  data:
    fontFamily: "Geist Mono, IBM Plex Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.25
    fontFeature: "tnum"
  label:
    fontFamily: "Geist Mono, IBM Plex Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "10.5px"
    fontWeight: 500
    letterSpacing: "0.11em"
rounded:
  r: "14px"
  r-s: "9px"
  r-xs: "7px"
  pille: "100px"
spacing:
  side: "236px"
  les: "1120px"
  dato: "54px"
  om: "92px"
  hovedknapp: "96px"
components:
  button-primary:
    backgroundColor: "{colors.primar}"
    textColor: "{colors.primar-blekk}"
    typography: "{typography.body}"
    rounded: "{rounded.r-s}"
    padding: "10px 15px"
  button-primary-hover:
    backgroundColor: "{colors.primar-hover}"
  button:
    backgroundColor: "{colors.kort}"
    textColor: "{colors.blekk}"
    rounded: "{rounded.r-s}"
    padding: "10px 15px"
  button-quiet:
    textColor: "{colors.blekk-2}"
    rounded: "{rounded.r-s}"
    padding: "10px 15px"
  button-quiet-hover:
    backgroundColor: "{colors.innfelt}"
  row-action:
    backgroundColor: "{colors.innfelt}"
    textColor: "{colors.blekk-2}"
    rounded: "{rounded.r-xs}"
    padding: "6px 11px"
  row-action-hover:
    backgroundColor: "{colors.linje-2}"
    textColor: "{colors.blekk}"
  segmented-tab:
    textColor: "{colors.blekk-2}"
    rounded: "{rounded.r-xs}"
    padding: "6px 13px"
    height: "34px"
  segmented-tab-selected:
    backgroundColor: "{colors.kort}"
    textColor: "{colors.blekk}"
  nav-item-selected:
    backgroundColor: "{colors.hav-vask}"
    textColor: "{colors.hav-t}"
    rounded: "{rounded.r-s}"
    padding: "9px 10px"
  status-chip:
    backgroundColor: "{colors.innfelt-2}"
    textColor: "{colors.blekk-2}"
    rounded: "{rounded.pille}"
    padding: "4px 10px 4px 8px"
  status-chip-sent:
    backgroundColor: "{colors.mose-vask}"
    textColor: "{colors.mose-t}"
  input:
    backgroundColor: "{colors.innfelt}"
    rounded: "{rounded.r-s}"
    padding: "10px 12px"
  band-card:
    backgroundColor: "{colors.kort}"
    rounded: "{rounded.r}"
  top-find:
    backgroundColor: "{colors.treff-vask}"
    textColor: "{colors.treff-4}"
    typography: "{typography.display}"
    rounded: "{rounded.r}"
    padding: "26px 26px 24px 28px"
  fit-meter:
    backgroundColor: "{colors.innfelt-2}"
    width: "72px"
    height: "6px"
---

<!-- Opphav: skrevet etter at Radar ble bygd om, fra koden som ble sendt (src/stiler.css, src/skrifter.css, src/radarflate.js). -->
<!-- Seed-trekning: hoppet over, fordi brukeren valgte retningen i designforslaget (specs/radar/designforslag.html) før denne økten. -->
<!-- Bilder: bygget lagde ingen rasterbilder som sendes med appen; skjermbildene i .impeccable/review/ er bare gjennomgangsbevis. -->

# Design System: Hired

## Overview

**Creative North Star: "Arbeidsbordet med frister"**

Hired er et rolig arbeidsverktøy på varmt papir, der det som haster eller passer best skal sees før det leses.
Flatene er nøytrale og lagdelte, og nesten all tekst står i blekk; kulør er sjelden og betyr alltid noe bestemt.
Tettheten er høy uten å bli trang: en rad er rundt 56 px, ett kort holder et helt bånd, og hårstreker skiller radene inni det.

Skriften bærer mye av karakteren.
Familjen Grotesk gir overskrifter og navn en litt kantete, menneskelig tyngde, og Geist Mono står for alle tall, datoer og tellinger, så de står i kolonner og kan skummes.
Radar la til én ny farge, en petrolskala i fire trinn som bare sier hvor godt en stilling passer, og som aldri står uten tallet ved siden av.

Systemet har fem temaer (Lin, Sot, Ink og elfenben, Blush, Midnatt), og alle må virke.
Lin og Sot står én gang i `light-dark()`, og de tre navngitte temaene setter hvert token selv.

**Key Characteristics:**
- Tre flatenivåer (bunn, kort, innfelt) som skiller seg ved nivå, aldri ved ramme.
- Kulør med faste betydninger: frist, sendt, interaksjon og treff.
- Alle tall i Geist Mono med tabulære siffer.
- Ett kort per bånd, hårstreker mellom radene.
- Korte, stille overganger (0,12 s) og høyst ett bevegelsesmoment per flate.

## Colors

Paletten er varmt papir og nesten svart blekk, med fire kulørfamilier som hver har én jobb.
Hver familie har tre trinn: selve fargen (strek, prikk, fyll), en `-t`-variant som holder 4,5:1 som tekst, og en `-vask` som flate.
Ink og elfenben bytter til blått blekk på elfenben og lar aksenten være blekket selv.
Blush har babyrosa flater og rosebær som aksent og fyll i primærknappen, med ild dratt mot oransje så et hastevarsel aldri forveksles med aksenten.
Midnatt er blåsvart med sand som aksent og primærfyll.
Treff-skalaen følger `color-scheme`, så Ink og Blush bruker de lyse trinnene og Midnatt de mørke.

### Primary
- **Blekket** (blekk / primar): primærknappen i Lin, Sot og Ink er blekket selv, fylt og uten kulør, så kulør fortsatt er forbeholdt det som betyr noe.
- **Havblå interaksjon** (hav, hav-t, hav-vask): valgt navigasjon, fokusring, valgt rad, glidere og avkrysning, pulsen mens Radar søker, og diagramfyll; aldri et varsel.

### Secondary
- **Ild** (ild, ild-t, ild-vask, ild-trykk): frist i dag eller passert, feil som må rettes, og farlige handlinger når pekeren er på dem.
- **Rav** (rav, rav-t, rav-vask): frist som nærmer seg.
- **Mose** (mose, mose-t, mose-vask): søknaden er sendt eller tilbudet er tatt imot.

### Tertiary
- **Petrol treff** (treff-1 til treff-4): hvor godt en stilling passer, fra «verdt å lese» (1, fra 50 %) til «midt i blinken» (4, fra 95 %), som prikk, målerfyll og grunnprikker; treff-4 er også tallet i toppfunnet og siste trinn i trakten.
- **Petrolvask** (treff-vask): flaten under toppfunnet og under Radar-introen når Radar er av.
- **Diagramskala** (graf-1 til graf-4): én kulør i fire trinn fra minst til mest forpliktet, med hav som midttrinn, for diagrammene under Tall.

### Neutral
- **Bunnen** (bunn): papiret under alt, også under båndoverskriftene som klistrer seg.
- **Kortet** (kort): løftede flater, rader, faner som er valgt og knapper i ro.
- **Innfelt** (innfelt, innfelt-2): spor inni kort, felt, radhandlinger, monogram og målerspor.
- **Blekk i tre trinn** (blekk, blekk-2, blekk-3): innhold, dempet tekst og etiketter; alle tre holder 4,5:1 mot sin flate i alle temaer.
- **Hårstreker** (linje, linje-2): skiller rader inni én flate og tegner båndstreken.
- **Varselet** (varsel-bunn, varsel-blekk): kvitteringen nederst er sin egen mørke flate i alle temaer.

### Named Rules
**The Kulør Means One Thing Rule.** Ild og rav betyr bare frist, mose betyr bare Sendt eller Tilbud, hav betyr bare interaksjon, og treff betyr bare hvor godt noe passer.
**The Number Beside The Color Rule.** Treff-fargen står aldri alene: prosenten eller trinnets navn står alltid ved siden av, og en frist sies alltid også med dato og tekst.
**The Radar Only Rule.** Treff-skalaen brukes bare i Radar; resten av Hired viser match som et dempet mono-merke på innfelt flate, aldri i kulør.
**The Calm Ending Rule.** Det som har gått ut eller er trukket, haster ikke lenger og mister kulør; det sies i blekk og tekst.

## Typography

**Display Font:** Familjen Grotesk (med Helvetica Neue, Arial)
**Body Font:** Familjen Grotesk (med Helvetica Neue, Arial)
**Label/Mono Font:** Geist Mono (med IBM Plex Mono, ui-monospace, SF Mono, Menlo)

**Character:** En grotesk med litt kant og varme for alt som leses, og en presis mono for alt som telles, slik at tall og ord aldri blandes.
Begge ligger lokalt som variable woff2-filer, latin og latin-ext, og hentes aldri fra nett.

### Hierarchy
- **Display** (Geist Mono 600, 80 px, 56 px under 620 px panelbredde): prosenten i Radars toppfunn, det eneste stedet tallet får være størst på siden.
- **Numeral** (Geist Mono 600, 30 px, 26 px på smalt): tallene i Radar-trakten; nøkkeltallene under Tall bruker samme rolle i grotesken (29 px).
- **Headline** (Familjen Grotesk 700, 27 px): sidetittelen øverst i hver visning.
- **Title** (Familjen Grotesk 600 til 700, 18 til 21 px): toppfunnets stilling, skuff- og tomtilstandstitler.
- **Row title** (Familjen Grotesk 600, 14,5 px): selskap eller stilling i en rad, og båndnavnene i Radar (14 px).
- **Body** (Familjen Grotesk 400, 15 px, linjehøyde 1,45): løpende tekst, med 44 til 68 tegn i bredden der teksten er lang.
- **Body small** (13 til 13,5 px): undertekster, metalinjer og grunner.
- **Data** (Geist Mono 400 til 500, 10,5 til 12,5 px, tabulære siffer): datoer, nedtelling, tellinger, kostnad og klokkeslett.
- **Label** (Geist Mono 500, 10,5 px, 0,11em sperring, versaler): den ene etikettstemmen, som navngir et bånd, en flis eller en innstillingsgruppe i resten av appen.

### Named Rules
**The Mono Counts Rule.** Alt som er et tall, en dato eller en telling står i Geist Mono med `tabular-nums`, så tallene står i kolonne.
**The Tracking Floor Rule.** Negativ sperring går aldri strammere enn -0,04em, selv i display-størrelse.
**The Label Names The Block Rule.** Etikettstemmen er selve overskriften for et bånd eller en gruppe, aldri en liten linje over en annen overskrift; Radars innstillinger bruker vanlige overskrifter i setningsform.

## Layout

Skallet er et rutenett med sidepanel (236 px, 272 px fra 1600 px) og en innholdskolonne med tak på 1120 px som sentreres i plassen ved siden av.
Taket er en skannebredde, ikke et mål å fylle: en rad har to klynger, hvem og hva til venstre, når og hva nå til høyre, og avstanden mellom dem skal være kort.
Radene har faste kolonner (dato 54 px, nedtelling 92 px, hovedknapp 96 px), så knapper og frister står i samme linje i alle bånd.
Radar-radene har fire kolonner: måler og prosent (108 px), stilling og hvem, frist (96 px) og handlinger.
Radoppsettet svarer på listens bredde med `@container`, ikke på vinduet, fordi sidepanelet forsvinner ved 900 px.
Under 900 px blir sidepanelet en toppstripe på 68 px som ruller sidelengs med fade i kantene, og båndoverskriftene klistrer seg under den.
Ved 640 px listebredde faller handlingene ned på egen linje, og ved 430 px får teksten bryte.
Fanerekker som er for brede, ruller inni seg selv med en fade på 36 px der det er mer, og med plass til fadene når en fane rulles fram.
Appen må virke ned til 390 px.
Berøringsmål er 44 px når pekeren er grov, uavhengig av bredde; den fylte «Legg til» i Radar holder 34 px synlig høyde og når 44 px med en usynlig kant.
Luften følger et tett, uregelmessig mønster rundt 4, 9, 14, 18 og 26 px, ikke en streng skala.

## Elevation & Depth

Systemet er tonalt lagdelt, med en svak, myk skygge som bare sier at noe ligger over bunnen.
Flater skilles av nivå: kortet ligger over bunnen, innfelte spor ligger i kortet.
I mørke temaer overlever ikke skygge inverteringen, så bæreren byttes til en hårfin ring på 1 px med skyggen bare som dybde bak.

### Shadow Vocabulary
- **Loft** (`0 1px 2px rgba(24,26,30,.05), 0 4px 14px rgba(24,26,30,.07)`): kort, bånd, felt, knapper i ro og valgt fane.
- **Loft 2** (`0 2px 4px rgba(24,26,30,.06), 0 10px 28px rgba(24,26,30,.10)`): knapp og nedtrekk når pekeren er på dem, og menyer.
- **Loft 3** (`0 8px 16px rgba(24,26,30,.08), 0 24px 60px rgba(24,26,30,.16)`): skuffen og varselet.

### Named Rules
**The Level Not Line Rule.** Flater skilles av nivå, aldri av ramme; hårstreker brukes bare til å dele rader inni én flate.
**The Ring In The Dark Rule.** I Sot og Midnatt bærer en ring på 1 px avgrensningen, og skyggen er bare dybde bak den.

## Shapes

Hjørnene er myke og i tre trinn: 14 px for kort, bånd og toppfunn, 9 px for knapper, felt og fanerekker, og 7 px for radhandlinger, faner inni en rekke og menyvalg.
Statusmerker er piller med en prikk i `currentColor` foran teksten.
Prikker er runde (5 til 10 px) og bærer trinn og tilstand; målere og trakt-stolper er 6 px høye spor med 3 px avrunding.
Monogrammet er en avrundet brikke på 32 px.
Ikoner er tynne SVG-streker på 1,4 til 1,5 px med runde ender, i `currentColor`.

## Components

### Buttons
- **Shape:** mykt avrundet (9 px).
- **Primary:** fylt med primærfargen (blekket i Lin, Sot og Ink, aksenten i Blush og Midnatt), 600 i vekt, 10 px 15 px; høyst én per flate, og i Radar bare «Legg til» i toppfunnet.
- **Hover / Focus:** primærknappen går til primar-hover; den hvite knappen løftes fra loft til loft 2; fokus er en havblå ring på 2 px med 2 px avstand.
- **Secondary:** hvit knapp på kortflaten med loft.
- **Quiet:** uten fyll i blekk-2, får innfelt flate når pekeren er på den.
- **Row action:** en knapt merkbar brikke i innfelt (7 px hjørner, 6 px 11 px, 12,5 px) som blir innfelt-2 når raden har pekeren; farlige handlinger får ild-vask først når pekeren er på dem.

### Chips
- **Style:** pille i innfelt-2 og blekk-2, 11,5 px 600, med prikk i tekstfargen.
- **State:** Sendt og Tilbud i mose, Intervju i hav, Avslag og Utløpt i ild; Trukket står nøytral med vilje.
- **Ordbrikker:** i Radars ordlister står brikkene i innfelt-2 inni ett innfelt felt; et foreslått ord har stiplet kant til det lagres.

### Cards / Containers
- **Corner Style:** 14 px.
- **Background:** kort, eller treff-vask for toppfunnet og Radar-introen.
- **Shadow Strategy:** loft, se Elevation & Depth.
- **Border:** ingen; rader inni kortet skilles av en hårstrek på 1 px i linje.
- **Internal Padding:** 20 til 22 px i kort, 26 px i toppfunnet.

### Inputs / Fields
- **Style:** innfelt flate, hårstrek i linje, 9 px hjørner, 10 px 12 px.
- **Focus:** kanten blir hav og flaten blir kort.
- **Error / Disabled:** ugyldig felt får kant i ild og en feiltekst i ild-t under; deaktivert har halv opasitet.

### Navigation
- **Sidepanel:** poster i blekk-2 med ikon og telling i mono; valgt post står på hav-vask i hav-t, 600.
- **Segmenterte faner:** en rekke i innfelt-2 med 3 px innvendig luft; valgt fane er et hvitt kort med loft, og tellingen står i mono ved navnet.
- **Understrekede faner:** i detaljpanelet er valgt fane en strek på 2 px i hav under navnet.
- **Mobil:** sidepanelet blir en toppstripe som ruller sidelengs, med fade i stripas egen farge.

### Band and Row List (signature)
Listen er appens bærende mønster.
Hvert bånd har en overskrift som klistrer seg til toppen: navn, en hårstrek ut til kanten og antallet i mono helt til høyre.
Under står ett kort for hele båndet, med rader skilt av hårstreker, og raden får innfelt flate når pekeren eller fokus er i den.
Et sammenfoldet bånd (Fristen har gått ut, Under terskelen) har en pil foran navnet som snur 90 grader når det åpnes, og navnet står ett trinn dempet.

### Radar Top Find and Fit Meter (signature)
Toppfunnet er det eneste i Radar som får egen flate: treff-vask, prosenten i display-størrelse i treff-4 med prosenttegnet mindre, trinnets prikk og navn under, alle grunnene synlige, og primærknappen til høyre.
I båndene er treff en fylt måler på 72 px (44 px på smalt) i trinnets farge, alltid ved prosenten i mono.
Båndene i Radar heter etter trinnet, med prikk foran navnet og terskelen («fra 80 %») i mono.
«Hvorfor» er en bryter i tekst med en pil som snur når den er åpen, aldri fylt.
Trakten øverst er fire like brede kolonner med store mono-tall og lineære, nøytrale stolper; bare siste trinn, det som nådde terskelen, står i treff-4.
Stolpene vokser fram én gang når en kjøring er ferdig, og det er Radars eneste bevegelsesmoment.

## Do's and Don'ts

### Do:
- **Do** skill flater med nivå (bunn, kort, innfelt) og del rader inni ett kort med hårstrek i linje.
- **Do** sett alle tall, datoer og tellinger i Geist Mono med tabulære siffer.
- **Do** bruk treff-1 til treff-4 bare i Radar, og alltid med prosenten eller trinnets navn ved siden av.
- **Do** si en frist med dato og tekst i tillegg til ild eller rav.
- **Do** hold overganger på 0,12 s, og slå av bevegelse når brukeren ber om redusert bevegelse.
- **Do** prøv nye tokens i alle fem temaer, og hold tekst på minst 4,5:1 mot flaten i hvert av dem.
- **Do** gi berøringsmål 44 px når pekeren er grov.

### Don't:
- **Don't** bruk ild, rav eller mose til pynt, til merkevare eller for å vise valg.
- **Don't** la hav stå for et varsel eller en feil.
- **Don't** legg kulør på det som har gått ut eller er trukket.
- **Don't** sett ramme rundt en flate for å skille den fra en annen.
- **Don't** sett mer enn én fylt primærknapp på samme flate.
- **Don't** stram sperringen mer enn -0,04em.
- **Don't** legg en etikett i versaler over en overskrift som en kicker.
- **Don't** før fargestripa på forkanten av fristradene videre til nye flater; Radar sier frist med mono-tekst i ild-t og rav-t.
- **Don't** bruk tegn som ikoner; ikoner er SVG-streker i `currentColor`.
- **Don't** hent skrift, skript eller bilder fra nett.
