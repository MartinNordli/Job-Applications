# Jobbsøknader

Personlig oversikt over jobbsøknader: frister som nærmer seg, søknader som er
sendt, og hvor de står. Én bruker, én maskin, ingen sky.

## Kom i gang

```sh
npm start
```

Åpne <http://127.0.0.1:4173>. Ingen avhengigheter å installere — alt bruker det
som følger med Node (versjon 18 eller nyere).

Første gang: har du data liggende i nettleseren fra før, spør appen om de skal
flyttes til datafilen. Kopien i nettleseren blir liggende urørt. Har du ingen
data noe sted, starter appen med startlisten.

## Hvor dataene ligger

`data/jobber.json` — vanlig JSON, lesbar og redigerbar for hånd:

```json
{
  "versjon": 8,
  "oppdatert": "2026-08-29T21:26:29.949Z",
  "jobber": [
    {
      "id": "sy1y2t2w4nuz",
      "selskap": "Aker BP",
      "stilling": "Graduate: Life Cycle Data Services",
      "lenke": "https://akerbp.com/…",
      "sted": "Oslo / Trondheim",
      "frist": "2026-08-28",
      "status": "todo",
      "sektor": "energi",
      "notat": "",
      "sendtDato": null,
      "opprettet": "…",
      "oppdatert": "…"
    }
  ]
}
```

Filen skrives aldri halvveis: den lages først som en midlertidig fil, tvinges
til disk, og byttes inn med `rename`. Forrige versjon tas vare på i
`jobber.forrige.json`. Er filen uleselig, flyttes den til
`jobber.ødelagt-<tid>.json` i stedet for å bli overskrevet — og appen tilbyr å
gjenopprette fra sikkerhetskopien.

`data/jobber.json` kan gjerne sjekkes inn i git; kopiene og karantenefilene er
i `.gitignore`.

## Statuser

`todo` Å søke på · `sent` Sendt · `interview` Intervju · `accepted` Videre ·
`rejected` Avslag · `trukket` Trukket · `expired` Utløpt

En frist som går ut endrer ikke status av seg selv — søknaden dukker opp i
«Gikk ut»-båndet med en knapp for å arkivere den når du vil.

## Tastatur

`n` ny søknad · `/` søk · `Esc` lukk · `Enter` lagre i skjemaet

## Tester

```sh
npm test
```

## Oppbygging

```
index.html          markup
src/stiler.css      «Lin» — designsystemet
src/app.js          appen
src/felles.mjs      validering, delt av nettleser og server
src/lagring.js      henting og lagring mot serveren
src/startliste.js   søknadene appen starter med
server/server.mjs   statiske filer + /api/jobber
server/lager.mjs    lesing og skriving av datafilen
temaer/             fargestudier, ikke i bruk av appen
specs/job-tracker/  hva som ble bygget og hvorfor
```

`PORT` kan settes hvis 4173 er opptatt. `DATA_KATALOG` flytter datafilen.
