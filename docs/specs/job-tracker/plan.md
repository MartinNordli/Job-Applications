# Plan

## Arkitektur

    Nettleser (index.html + src/*.js, ES-moduler)
       ↓  fetch — debounced PUT av hele dokumentet
    server/server.mjs   (Node 26, ingen avhengigheter)
       ↓  valider → midlertidig fil → fs.rename (atomisk)
    data/jobber.json

## Hvorfor hele dokumentet, ikke granulære endepunkter

Alle endringer i appen går allerede gjennom én funksjon, `lagre()`. `settStatus`,
`slett`, `lagreSkjema`, `lagreLim` og hver eneste angre-callback kaller den og
ingenting annet. Da holder det å bytte ut kroppen i den ene funksjonen. Granulære
endepunkter ville betydd omskriving av seks kallsteder uten gevinst i en app med
én bruker og én maskin.

En `versjon`-teller fanger opp to faner som skriver over hverandre: foreldet PUT
gir 409 med gjeldende dokument, og klienten laster om og sier fra.

## Filformat

    { "versjon": 8, "oppdatert": "…", "jobber": [ … ] }

## Delt validering

`src/felles.mjs` importeres av både nettleseren og serveren. Klienten validerer for
rask tilbakemelding, serveren fordi den ikke kan stole på klienten. Én definisjon,
ingen glidning.

`sted` og `lenke` får være tomme: ekte rader i listen mangler begge — åpne steder,
verv uten utlysning — og å avvise dem ville gjort brukerens egne data ugyldige.

## Ikke ødelegge datafilen

Én skrivekø · midlertidig fil + `fsync` + `rename` · forrige versjon tas vare på i
`jobber.forrige.json` · ugyldig JSON flyttes til `jobber.ødelagt-<tid>.json` og
overskrives aldri · gyldige rader beholdes selv om enkeltrader forkastes.

## Frontend

Designet er ferdig og blir stående. Nye flater bygges av komponenter som allerede
finnes — skuffen, `.knapp`, `.felt__omr`, `.merkelapp`-vasken.

Systemets egen regel er «kulør betyr hastegrad, ingenting annet». Derfor er
lagringsstatus mono mikrotekst i `--blekk-3`, ikke et grønt merke; bare *ikke
lagret* får farge, fordi det faktisk haster.

## Testing

`node:test`, ingen avhengigheter. Validator, atomisk skriving, karantene,
versjonskonflikt, samtidige skrivinger, HTTP-runde. Manuell gjennomgang i
nettleseren for flyt, fokus og brekkpunkter.
