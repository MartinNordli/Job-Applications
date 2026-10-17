# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Hired brukes av eieren og noen få andre, hver med sin egen konto og sine egne data.
Brukeren er en jobbsøker midt i en søkeperiode, som holder styr på mange søknader samtidig og vil bruke tiden på de stillingene som passer.
Siden brukerne er få og kjenner appen, kan grensesnittet ta egne valg, men det må forklare seg selv uten opplæring.

## Product Purpose

Hired er en personlig oversikt over jobbsøknader: frister som nærmer seg, søknader som er sendt, og hvor de står.
Appen skriver søknadsbrev med utgangspunkt i CV-en og annonsen, vurderer hvor godt en stilling passer, og forbereder intervjuer.
Radar leter etter nye ledige stillinger hos NAV, Jobbnorge og karrieresider, vurderer dem mot CV-en og legger de beste i en innboks.
Suksess er at brukeren ser med en gang hva som er verdt å søke på, og bruker minst mulig tid på resten.

## Positioning

Alt ligger som lesbar JSON på brukerens egen maskin.
Bare det som må, går ut på nett: brev og vurderinger til modelleverandøren brukeren selv har valgt, og henting av annonser.
Radar sorterer først uten modell (søkeord, steder, ekskluderte ord), og vurderer bare det som slipper gjennom, så det koster få øre.

## Operating Context

Appen finnes som Mac-app (Tauri) og som nettleserversjon mot en lokal Node-server, med samme kode og samme data.
Radar søker hver time mens appen er åpen, og som bakgrunnsjobb på Mac.
Brukeren åpner Radar når et varsel sier at noe nytt passer, eller som en del av en daglig runde gjennom søknadene.

## Capabilities and Constraints

- Fem fargetemaer (Lin, Sot, Ink og elfenben, Blush, Midnatt) som alle må virke.
- Må fungere ned til 390 px bredde.
- Matchskalaen er felles for panelet og Radar: 95 og over er «midt i blinken», 80 «passer godt», 65 «passer på det meste», 50 «verdt å lese».
- Ingen ekstern skrift eller skript fra nett; alt er lokalt.
- Bokmål i all tekst, aldri tankestrek.

## Brand Commitments

Navnet er Hired.
Stemmen er nøktern og presis bokmål, som sier hva som skjedde og hva man kan gjøre, uten utropstegn eller salgsspråk.

## Evidence on Hand

Ingen kunder, sitater eller tall om bruk; appen er personlig og skal ikke påstå noe slikt.
Syntetiske testdata ligger i `testdata/`.

## Product Principles

- Det som haster eller passer best, skal sees før det leses.
- Brukerens data blir på brukerens maskin.
- Ingenting forsvinner uten spor: det som gjemmes, kan finnes og angres.
- Kostnaden ved modellkall er synlig og liten.

## Accessibility & Inclusion

Tastatur og skjermleser skal virke i alle visninger, og farge står aldri alene om å si noe.
Tekst holder minst 4,5:1 mot flaten i alle fem temaene.
