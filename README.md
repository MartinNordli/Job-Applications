# Jobbsøknader

Personlig oversikt over jobbsøknader: frister som nærmer seg, søknader som er
sendt, og hvor de står. Én bruker, én maskin, ingen sky.

## Kom i gang

Appen finnes i to skikkelser, med de samme dataene og den samme koden:
en Mac-app du starter fra Dock, og en nettleserversjon for rask redigering.

### Som app

```sh
npm run app:bygg
```

Legger `Jobbsøknader.app` i `src-tauri/target/release/bundle/macos/`. Kopier
den til `/Applications`, så ligger den i Spotlight som alt annet. Første gang
må dataene flyttes inn:

```sh
mkdir -p ~/Library/Application\ Support/no.nordli.jobbsoknader
cp data/jobber.json ~/Library/Application\ Support/no.nordli.jobbsoknader/
```

Bygging krever Rust (`rustup default stable`). Er rustup installert med
Homebrew, må shimsene på PATH — legg
`export PATH="/opt/homebrew/opt/rustup/bin:$PATH"` i `~/.zshrc`.
`npm run app:dev` kjører appen uten å pakke den.

### I nettleseren

```sh
npm start
```

Åpne <http://127.0.0.1:4173>. Ingen avhengigheter å installere — alt bruker det
som følger med Node (versjon 18 eller nyere).

Første gang: har du data liggende i nettleseren fra før, spør appen om de skal
flyttes til datafilen. Kopien i nettleseren blir liggende urørt. Har du ingen
data noe sted, starter appen med startlisten.

### Har du brukt den gamle appen?

Den gamle `index.html` ble åpnet som en fil, og nettleseren holder det lageret
adskilt fra `http://127.0.0.1:4173`. Appen finner altså ikke de gamle søknadene
av seg selv. Slik henter du dem:

1. Åpne `hent-gamle-data.html` **på samme måte som du pleide å åpne den gamle
   appen** — dobbeltklikk filen, i samme nettleser.
2. Kopier JSON-en den viser.
3. Start appen, velg **Dataene dine**, lim inn under **Lim inn JSON** og trykk
   **Erstatt listen med dette**. Du kan angre.

## Import fra lenke

Lim inn adressen til en utlysning under **Fra lenke** i skjemaet, så henter
appen siden, leser ut det den finner, og fyller feltene. Ingenting lagres av
seg selv — utkastet havner i det vanlige skjemaet, og du trykker **Legg til
søknad** selv.

Det meste leses rett ut av siden: de fleste utlysninger bærer
`schema.org/JobPosting` som strukturerte data, og da er stilling, selskap,
frist og sted eksakte. Bare det som mangler går videre til en språkmodell
(Claude Haiku), og et selskap som allerede står i listen får sektoren sin
derfra i stedet for å bli klassifisert på nytt.

Det krever en API-nøkkel fra <https://console.anthropic.com>. Den legges i
`nokkel.txt` i den datakatalogen versjonen bruker — samme sted som
`jobber.json`, så filen kan settes `chmod 600` og allerede er i
`.gitignore`. `read -rs` holder den utenfor shell-historikken:

```sh
# nettleserversjonen
read -rs "?Nøkkel: " K && printf '%s\n' "$K" > data/nokkel.txt && chmod 600 data/nokkel.txt && unset K

# appen
read -rs "?Nøkkel: " K && printf '%s\n' "$K" > ~/Library/Application\ Support/no.nordli.jobbsoknader/nokkel.txt && unset K
```

Filen leses ved hvert kall, så en ny nøkkel virker uten omstart. Serveren
tar `ANTHROPIC_API_KEY` i stedet hvis den er satt.

Nøkkelen leses av serveren i nettlesermodus og av Rust i appen. Den sendes
aldri til nettleseren, og havner aldri i en feilmelding.

Uten nøkkel virker resten fortsatt: sider med strukturerte data fylles ut i
sin helhet uten at modellen blir spurt. Sider som bygges av JavaScript etter
at de er lastet, gir lite eller ingenting — da blir lenken stående i
skjemaet, og resten fylles ut for hånd.

Adresser inne på egen maskin eller eget nett hentes ikke: `localhost`,
private nett og `169.254.169.254` avvises, også via videresending.

## Hvor dataene ligger

Appen og nettleserversjonen har hver sin fil, så en halvferdig redigering i
den ene ikke velter den andre:

| | |
|---|---|
| Appen | `~/Library/Application Support/no.nordli.jobbsoknader/jobber.json` |
| `npm start` | `data/jobber.json` i prosjektmappa |

Begge er vanlig JSON, lesbar og redigerbar for hånd:

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
      "jobbtype": "graduate",
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

Hele `data/` er i `.gitignore` — dette repoet er offentlig, og filen inneholder
ekte søknader. Vil du versjonere den likevel, fjern linjen og legg den til selv.

## Statuser

`todo` Å søke på · `sent` Sendt · `interview` Intervju · `accepted` Videre ·
`rejected` Avslag · `trukket` Trukket · `expired` Utløpt

En frist som går ut endrer ikke status av seg selv — søknaden dukker opp i
«Gikk ut»-båndet med en knapp for å arkivere den når du vil.

## Tastatur

`n` ny søknad · `/` søk · `Esc` lukk · `Enter` lagre i skjemaet

## Tester

```sh
npm test        # lagerlogikken og serveren
npm run test:rust   # filoperasjonene appen bruker
```

## Oppbygging

```
index.html            markup
hent-gamle-data.html  henter søknader ut av den gamle nettleserlagringen
src/stiler.css        «Lin» — designsystemet
src/skrifter.css      Familjen Grotesk og Geist Mono, hentet inn lokalt
src/app.js            appen
src/felles.mjs        validering, delt av alle tre
src/importlogikk.mjs  reglene for å lese en utlysning, uten I/O
src/import.js         importflyten i nettleseren — velger transport
src/tauri-nett.mjs    henting i appmodus, over Rust
src/lagerlogikk.mjs   reglene for datafilen, uten et filsystem
src/lagring.js        henting og lagring — velger transport etter modus
src/tauri-filer.mjs   filsystemet i appmodus, over Rust
src/startliste.js     søknadene appen starter med
server/server.mjs     statiske filer + /api/jobber
server/lager.mjs      filsystemet i nettlesermodus, over Node
server/nett.mjs       henting og modellkall i nettlesermodus
src-tauri/src/nett.rs de samme to operasjonene i appen
src-tauri/src/lib.rs  de fire filoperasjonene appen bruker
scripts/bygg-front.mjs  samler frontenden i dist/ for Tauri
temaer/               fargestudier, ikke i bruk av appen
specs/job-tracker/    hva som ble bygget og hvorfor
```

Reglene for datafilen står ett sted: `src/lagerlogikk.mjs`. Under den ligger
to filsystemer — Node i nettlesermodus, Rust i appen — og de gjør nøyaktig det
samme: kopi av forrige versjon, midlertidig fil, fsync, `rename`.

`PORT` kan settes hvis 4173 er opptatt. `DATA_KATALOG` flytter datafilen for
`npm start`.
