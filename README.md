# Jobbsøknader

Personlig oversikt over jobbsøknader: frister som nærmer seg, søknader som er
sendt, og hvor de står. Kontoer på egen maskin, ingen sky.

## Kom i gang

Appen finnes i to skikkelser, med de samme dataene og den samme koden:
en Mac-app du starter fra Dock, og en nettleserversjon for rask redigering.

### Som app

```sh
npm run app:bygg
```

Legger `Jobbsøknader.app` i `src-tauri/target/release/bundle/macos/`. Kopier
den til `/Applications`, så ligger den i Spotlight som alt annet. Appen og
`npm start` leser fra samme katalog — har du data liggende i `data/` i
prosjektmappa fra før, flytt dem dit én gang, se **Hvor dataene ligger**.

Bygging krever Rust (`rustup default stable`). Er rustup installert med
Homebrew, må shimsene på PATH — legg
`export PATH="/opt/homebrew/opt/rustup/bin:$PATH"` i `~/.zshrc`.
`npm run app:dev` kjører appen uten å pakke den — men den tåler ikke filnavn
utenfor ASCII. Utviklingsserveren svarer med `index.html` på enhver adresse den
ikke kjenner, og prosentkoder ikke stien: en modul som het `økt.js` ble hentet
som HTML, og hele modulgrafen falt sammen uten en eneste feilmelding. Derfor
heter filene `okt.js` og `okt-app.mjs`. Identifikatorer inne i koden kan gjerne
ha ø; det som går over en URL, kan ikke.

### I nettleseren

```sh
npm start
```

Åpne <http://127.0.0.1:4173>. Ingen avhengigheter å installere — alt bruker det
som følger med Node (versjon 18 eller nyere).

Første gang møter du porten: opprett en konto. Den første kontoen arver det som
allerede ligger i datakatalogen — se **Kontoer** under. Har du i tillegg data
liggende i nettleseren fra gammelt av, spør appen om de skal flyttes inn. Kopien
i nettleseren blir liggende urørt. Har du ingen data noe sted, starter den første
kontoen med startlisten.

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

Det meste leses rett ut av siden, uten modell: `schema.org/JobPosting` når
den finnes, ellers etiketterte verdier i vanlig markup — `<dt>Stillingstittel</dt>`,
`<th>Søknadsfrist</th> — og fristen i brødteksten, «Søk senest søndag 13.
september». Jobbtypen følger av ansettelsesform og stillingsnavn.

Bare det som fortsatt mangler går videre til en språkmodell (Claude Haiku),
og et selskap som allerede står i listen får sektoren sin derfra i stedet
for å bli klassifisert på nytt. Hvor mye annonsetekst som sendes følger av
hva som gjenstår: selskap og sted står i toppen, mens en frist kan stå hvor
som helst. På en typisk norsk annonse er det tre felt og ~500 tokens — under
ett øre.

Limer du inn en lenke du allerede har i listen, sier appen fra før den
henter noe som helst.

Under **Dataene dine** står tre tall om importen: hva den har kostet til
sammen, hvor ofte modellen slapp å kjøre, og hvilke felt modellen måtte
fylle. Det siste er det nyttigste — står ett felt øverst lenge, er et
uttrekk for nettopp det neste ting å skrive. Tallene kommer fra
`importlogg.jsonl` ved siden av datafilen, én linje per import med
vertsnavn og de ekte tokentallene fra API-et. Prisen står i
`src/importlogg.mjs`; endrer den seg, er det den linjen som skal rettes.

Det krever en API-nøkkel fra <https://console.anthropic.com>. **Hver konto har
sin egen.** Den enkleste veien er å lime den inn under **Dataene dine** i appen;
da havner den i `nokkel.txt` i kontoens egen katalog, med modus `0600`.

Nøkkelen går inn og aldri ut igjen. Appen viser bare hvor den kommer fra og de
fire siste tegnene — og ikke engang dem når den er kort, eller når den er
serverens egen. Den sendes aldri til nettleseren, havner aldri i en feilmelding
og aldri i `importlogg.jsonl`.

Vil du heller skrive filen selv, ligger den i kontoens katalog. `read -rs`
holder nøkkelen utenfor shell-historikken:

```sh
KAT=~/Library/Application\ Support/no.nordli.jobbsoknader/brukere/<id>
read -rs "?Nøkkel: " K && printf '%s\n' "$K" > "$KAT/nokkel.txt" \
  && chmod 600 "$KAT/nokkel.txt" && unset K
```

Oppslagsrekkefølgen er:

1. Kontoens egen `nokkel.txt`. Den vinner alltid.
2. Mangler den: `ANTHROPIC_API_KEY`, men **bare for den første kontoen**.
   Miljøvariabelen tilhører den som startet serveren, og registreringen er åpen
   — å la enhver som oppretter en konto bruke den, ville vært å gi bort
   kredittkortet.
3. Med mindre `DELT_NOKKEL=1` er satt. Da gjelder den for alle kontoene.

En `nokkel.txt` som lå i rota fra før, kopieres — ikke flyttes — inn til den
første kontoen. Filen leses ved hvert kall, så en ny nøkkel virker uten omstart.

Uten nøkkel virker resten fortsatt: sider med strukturerte data fylles ut i
sin helhet uten at modellen blir spurt. Sider som bygges av JavaScript etter
at de er lastet, gir lite eller ingenting — da blir lenken stående i
skjemaet, og resten fylles ut for hånd.

Adresser inne på egen maskin eller eget nett hentes ikke: `localhost`,
private nett og `169.254.169.254` avvises, også via videresending.

## Hvor dataene ligger

Ett sted, for begge skikkelsene:

```
~/Library/Application Support/no.nordli.jobbsoknader/
```

Det er appens egen katalog, den Tauri gir den, og `npm start` leser og skriver
i den samme. Retningen er valgt med vilje: en app i `/Applications` har ingen
måte å finne prosjektmappa på, mens appkatalogen finnes uansett hvor appen
startes fra. Én katalog betyr én konto og én liste — logger du inn i appen,
er du logget inn på det samme i nettleseren.

Vil du ha dem et annet sted, setter du `DATA_KATALOG` når du starter serveren:

```sh
DATA_KATALOG=~/et/annet/sted npm start
```

**Er begge åpne samtidig, kan de skrive i samme fil.** Det går bra: hver
lagring sier hvilken versjon den bygger på, og filen leses på nytt rett før
den skrives. Er den endret i mellomtiden, avvises lagringen, du får «Hent på
nytt», og ingenting går tapt. Det er ingen fillås — to lagringer i nøyaktig
samme sekund kan la den siste vinne — og det er derfor forrige versjon alltid
ligger i `jobber.forrige.json`.

**Hadde du data i `data/` i prosjektmappa?** Det var stedet før, og de blir
liggende der. Serveren sier fra ved oppstart hvis den finner noe der, men
flytter ingenting selv — flytt innholdet inn i katalogen over mens appen og
serveren er avslått, så er du der du var.

Inni katalogen:

```
<datakatalog>/
  jobber.json               den gamle enbrukerfilen — urørt, kilde til migreringen
  jobber.forrige.json       urørt
  nokkel.txt                urørt — kopieres til første konto
  brukere.json              registeret over kontoer, modus 0600
  brukere.forrige.json
  okthemmelighet.txt        nøkkelen øktcookiene signeres med, modus 0600
  brukere/<id>/
    jobber.json             søknadene dine
    jobber.forrige.json
    importlogg.jsonl
    nokkel.txt              din API-nøkkel, modus 0600
```

`jobber.json` er vanlig JSON, lesbar og redigerbar for hånd:

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

Dataene ligger utenfor repoet, og `data/` er dessuten i `.gitignore` — dette
repoet er offentlig, og filen inneholder ekte søknader.

## Kontoer

Første gang du åpner appen møter du en port: opprett en konto med e-post og et
passord på minst ti tegn. Etterpå har hver konto sin egen søknadsliste, sin egen
importlogg og sin egen API-nøkkel, i sin egen katalog under `brukere/`.

**Den første kontoen arver det som lå der fra før.** Søknadene i
`<datakatalog>/jobber.json` flyttes inn i den første kontoens katalog, og
originalen blir liggende urørt som den den var. **Kontoer etter den første
starter tomme** — en ny bruker skal ikke få en annens jobbsøknader som «sine».
Startlisten ligger fortsatt under **Dataene dine** for den som vil ha den.

**Registreringen er åpen**, men serveren binder `127.0.0.1`. Det er sperren.
Åpner du porten utover — via en tunnel, en proxy eller `--host` på noe annet —
kan hvem som helst som når den opprette en konto, og under `DELT_NOKKEL=1` bruke
API-nøkkelen din. Ikke gjør det. Taket er 20 kontoer, og både registrering og
innlogging er ratebegrenset.

**Innlogging er ikke kryptering.** Filene ligger i lesbar JSON på disk, akkurat
som før, og det er et poeng — ikke en forglemmelse. Kryptering ville kostet all
gjenoppretting ved glemt passord, og lesbar JSON er halve grunnen til at appen
finnes. Innloggingen holder to kontoer på samme maskin fra hverandre i
nettleserversjonen; den holder ikke noen unna disken din.

**I Mac-appen er passordet et profilvalg, ikke en lås.** Appen har ingen server.
Passordet sjekkes i webviewet, mot et register webviewet også kan lese direkte,
og én linje i utviklerverktøyene hopper over det. Det er en profilbytter med
hengelås på. Vil du ha en ekte grense, er det diskkryptering og
brukerkontoene i macOS som gir den.

**Appen og nettleserversjonen deler register.** En konto opprettet i
nettleseren er den samme kontoen i appen, med de samme søknadene, fordi begge
leser fra samme katalog — se **Hvor dataene ligger**.

**Glemt passord kan ikke gjenopprettes.** Det finnes ingen e-post å sende og
ingen nøkkel å utlede det fra. Dataene er ikke tapt: åpne `brukere.json`, fjern
raden med kontoen, opprett den på nytt, og flytt katalogen under `brukere/` over
til den nye id-en. Vil du bare bytte passord og husker det gamle, står det under
**Dataene dine**. Et passordbytte feller alle andre økter.

## Statuser

`todo` Å søke på · `sent` Sendt · `interview` Intervju · `accepted` Videre ·
`rejected` Avslag · `trukket` Trukket · `expired` Utløpt

En frist som går ut endrer ikke status av seg selv — søknaden dukker opp i
«Gikk ut»-båndet med en knapp for å arkivere den når du vil.

## Tastatur

`n` ny søknad · `/` søk · `Esc` lukk · `Enter` lagre i skjemaet

Snarveiene er inaktive mens porten står — ellers ville `n` åpnet skuffen bak
overlegget.

## Tester

```sh
npm test        # lagerlogikken, serveren, kontoene og flytene
npm run test:rust   # filoperasjonene appen bruker
```

Nye testfiler må legges til i `test`-skriptet i `package.json` for hånd — det
bruker ingen glob.

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
src/brukerlogikk.mjs  reglene for kontoer og økter, uten I/O
src/okt.js            «hvem er logget inn», begge modi
src/okt-app.mjs       kontoene i appmodus, over Rust og crypto.subtle
src/innlogging.js     porten
server/server.mjs     statiske filer + API-et
server/brukere.mjs    registeret, PBKDF2, cookier og ett lager per konto
server/nokkel.mjs     API-nøkkelen — inn, aldri ut
server/lager.mjs      filsystemet i nettlesermodus, over Node
server/nett.mjs       henting og modellkall i nettlesermodus
src-tauri/src/nett.rs de samme to operasjonene i appen
src-tauri/src/lib.rs  de fire filoperasjonene appen bruker
scripts/bygg-front.mjs  samler frontenden i dist/ for Tauri
temaer/               fargestudier, ikke i bruk av appen
specs/job-tracker/    hva som ble bygget og hvorfor
specs/flerbruker/     kontoene, og hva innloggingen ikke er
```

Reglene for datafilen står ett sted: `src/lagerlogikk.mjs`. Under den ligger
to filsystemer — Node i nettlesermodus, Rust i appen — og de gjør nøyaktig det
samme: kopi av forrige versjon, midlertidig fil, fsync, `rename`.

`PORT` kan settes hvis 4173 er opptatt. `DATA_KATALOG` flytter datafilen for
`npm start`.
