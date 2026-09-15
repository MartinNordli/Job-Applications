# Jobbsøknader

Personlig oversikt over jobbsøknader: frister som nærmer seg, søknader som er sendt, og hvor de står.
Appen skriver også søknadsbrev med utgangspunkt i CV-en din og stillingsannonsen.

Alt lagres som lesbar JSON på din egen maskin.
Bare to ting går ut på nett: søknadsbrev skrives av leverandøren du velger (Claude eller OpenAI), og import fra lenke henter annonsen og kan be Claude om felt den ikke fant selv.

Appen finnes i to utgaver med samme kode og samme data:

- **Mac-app** (Tauri), som startes fra Dock eller Spotlight.
- **Nettleserversjon**, der en lokal Node-server kjører på `http://127.0.0.1:4173`.

## Innhold

- [Kom i gang](#kom-i-gang)
- [Oversikten](#oversikten)
- [Legg til søknader](#legg-til-søknader)
- [Import fra lenke](#import-fra-lenke)
- [Søknadsbrev](#søknadsbrev)
- [API-nøkler](#api-nøkler)
- [Kontoer](#kontoer)
- [Dataene dine](#dataene-dine)
- [Hvor dataene ligger](#hvor-dataene-ligger)
- [Utvikling](#utvikling)

## Kom i gang

### Som Mac-app

```sh
npm install
npm run app:bygg
```

Kommandoen legger `Jobbsøknader.app` i `src-tauri/target/release/bundle/macos/`.
Kopier den til `/Applications`, så finner du den i Spotlight.
Bygget samler frontenden i `dist/` først, så appen får med alt som er endret i nettleserversjonen.
Bygg og kopier på nytt etter hver oppdatering, ellers kjører du en eldre utgave.

Bygging krever Rust (`rustup default stable`).
Er rustup installert med Homebrew, må shimsene ligge på PATH: legg `export PATH="/opt/homebrew/opt/rustup/bin:$PATH"` i `~/.zshrc`.

`npm run app:dev` kjører appen uten å pakke den.
Utviklingsserveren tåler ikke filnavn utenfor ASCII: den svarer med `index.html` på adresser den ikke kjenner og prosentkoder ikke stien.
En modul som het `økt.js` ble derfor hentet som HTML, og hele modulgrafen falt sammen uten feilmelding.
Filene heter `okt.js` og `okt-app.mjs` av den grunn.
Identifikatorer inne i koden kan gjerne ha ø, men det som går over en URL kan ikke.

### I nettleseren

```sh
npm install
npm start
```

Åpne <http://127.0.0.1:4173>.
Bruk Node 20 eller nyere.
`npm start` pakker først dokumentbibliotekene (PDF og Word) lokalt til `src/vendor/`.
De lastes først når du leser eller eksporterer en fil, og ingen CDN er nødvendig.

Åpner du `index.html` rett fra disk, sier siden fra om at den trenger serveren.

### Første start

Første gang møter du innloggingen: opprett en konto.
Den første kontoen overtar det som allerede ligger i datakatalogen, se [Kontoer](#kontoer).
Finnes det søknader i nettleserens gamle lager, spør appen om de skal flyttes inn, og kopien i nettleseren blir liggende urørt.
Finnes det ingen data noe sted, starter den første kontoen med startlisten.

### Har du brukt den aller første utgaven?

Den første `index.html` ble åpnet som en fil, og nettleseren holder det lageret adskilt fra `http://127.0.0.1:4173`.
Appen finner altså ikke de gamle søknadene av seg selv.
Slik henter du dem:

1. Åpne `hent-gamle-data.html` på samme måte som du åpnet den gamle appen, altså ved å dobbeltklikke filen i samme nettleser.
2. Kopier JSON-en den viser.
3. Start appen, velg **Dataene dine**, lim inn under **Lim inn JSON** og trykk **Erstatt listen med dette**. Du kan angre.

## Oversikten

### Visninger

Sidepanelet har fire visninger, med antall søknader ved siden av navnet.

- **Frister**: søknader du ikke har sendt. De er gruppert i «Denne uka» (inkludert frister som har gått ut), «Løpende opptak» og én gruppe per måned. En farget stripe og teksten «i dag», «i morgen», «om N dager» eller «N dager siden» viser hastegraden.
- **Sendt**: søknader som venter på svar, gruppert etter sektor, med antall dager du har ventet.
- **Arkiv**: avslag, tilbud, trukne og utløpte søknader.
- **Tall**: statistikk, se under.

**Neste frist** nederst i sidepanelet viser din faktiske neste frist, uavhengig av filtre.
Et klikk hopper til søknaden og markerer den.

### Handlinger på hver søknad

- **Søknadsbrev** åpner brevskriveren.
- Hovedknappen følger statusen: **Merk sendt** (setter sendtdato), **Fikk intervju**, **Fikk tilbud** eller **Gjenåpne**.
- Sendte søknader og intervjuer kan markeres som **Avslag** eller **Trukket**.
- En søknad med utgått frist kan markeres som **Utløpt**. En frist som går ut endrer aldri status av seg selv.
- **Rediger** og **Slett**.
- Stillingstittelen lenker til annonsen. I Mac-appen åpnes lenken i systemets nettleser.

Sletting, statusbytte, å erstatte listen og tilbakestilling kan angres fra varselet som dukker opp.

### Statuser, sektorer og jobbtyper

| Felt | Verdier |
| --- | --- |
| Status | `todo` Å søke på · `sent` Sendt · `interview` Intervju · `accepted` Videre · `rejected` Avslag · `trukket` Trukket · `expired` Utløpt |
| Sektor | Energi · Industri og produksjon · Konsulent · Finans · Teknologi · Offentlig sektor · Verv og studentorg · Annet |
| Jobbtype | Graduate · Internship · Fast stilling · Deltid (valgfri) |

### Søk og filtre

Søkefeltet leter i selskap, stilling, sted og notat.
Sektor og sted kan filtreres, og **Nullstill filtre** fjerner alt.
Filtrene gjelder også i **Tall**.

### Tall

- Nøkkeltall: neste frist, antall å søke på, antall sendt med andelen som har fått svar, og frister denne uka.
- **Fra liste til tilbud**: sporet, sendt, fått svar og gått videre.
- **Fristtrykk de neste ti ukene**: antall frister per uke.
- **Sektorene du satser på**: sendt og ikke sendt per sektor.
- **Hvor stillingene ligger**: de sju vanligste stedene.
- **Selskapene du følger tettest**: topp ti.
- **Sendt per uke**: tempoet ditt, regnet fra sendtdatoene.

### Tema og tastatur

Fargetemaet kan være System, Lys eller Mørk.
Valget huskes i nettleseren eller appen og havner aldri i datafilen.

| Tast | Handling |
| --- | --- |
| `n` | Ny søknad |
| `/` | Søk |
| `Esc` | Lukk |
| `Enter` | Lagre skjemaet, hent lenken eller legg til fra notat |

Snarveiene er inaktive mens innloggingen står, ellers ville `n` åpnet skjemaet bak den.

## Legg til søknader

**Legg til søknad** åpner et skjema med tre faner.

- **For hånd**: selskap, stilling, lenke, frist eller løpende opptak, sted, sektor, jobbtype, status og notat. Selskap og stilling må fylles ut, fristen må være en ekte dato, og lenker må være `http` eller `https`.
- **Fra notat**: lim inn linjer fra et Markdown-notat, for eksempel Obsidian. Frist leses fra `**DD.MM**`, stilling og lenke fra `[tekst](url)`, sted fra `_kursiv_` og selskap fra fet skrift. Appen viser hva den har tolket før noe legges til.
- **Fra lenke**: se neste avsnitt.

Når du redigerer en søknad, kan du også sette sendtdato for eldre søknader og gå rett til søknadsbrevet.

## Import fra lenke

Lim inn adressen til en utlysning under **Fra lenke**.
Appen henter siden, leser ut det den finner og fyller skjemaet.
Ingenting lagres av seg selv: du trykker **Legg til søknad** når du er fornøyd.

Det meste leses rett ut av siden, uten modell:

- `schema.org/JobPosting` når den finnes.
- Etiketterte verdier i vanlig markup, som `<dt>Stillingstittel</dt>` og `<th>Søknadsfrist</th>`.
- Fristen i brødteksten, som «Søk senest søndag 13. september».
- Jobbtypen ut fra ansettelsesform og stillingsnavn.

Bare det som fortsatt mangler, går videre til Claude Haiku (`claude-haiku-4-5`).
Et selskap som allerede står i listen, får sektoren sin derfra i stedet for å klassifiseres på nytt.
Hvor mye annonsetekst som sendes, avhenger av hva som gjenstår.
En typisk norsk annonse gir tre felt og rundt 500 tokens, som koster under ett øre.
Er API-et opptatt, prøver appen én gang til.

Limer du inn en lenke som allerede står i listen, sier appen fra før den henter noe.

Uten nøkkel virker importen fortsatt for sider med strukturerte data.
Sider som bygges av JavaScript etter at de er lastet, gir lite eller ingenting.
Da blir lenken stående i skjemaet, og resten fyller du ut for hånd.

Adresser på egen maskin eller eget nett hentes aldri: `localhost`, private nett og `169.254.169.254` avvises, også via videresending.

Under **Dataene dine** står tre tall om importen: hva den har kostet til sammen, hvor ofte modellen slapp å kjøre, og hvilke felt modellen oftest måtte fylle.
Det siste er det nyttigste: står ett felt øverst lenge, er et uttrekk for nettopp det feltet det neste som bør skrives.
Tallene kommer fra `importlogg.jsonl` i kontoens katalog, med én linje per import (høyst 500), vertsnavn og ekte tokentall fra API-et.
Prisen står i `src/importlogg.mjs`.

## Søknadsbrev

Velg **Søknadsbrev** på en søknad.
Grunnlaget står i en kolonne til venstre, og brevet står på et papir til høyre.

### Grunnlaget

- **Din CV**: PDF, Word (`.docx`) eller tekst. Velg filen eller slipp den i feltet. Teksten leses lokalt og gjenbrukes på profilen din. **Se eller lim inn CV-tekst** viser nøyaktig hva som ble lest, så du kan rette kolonnerekkefølge eller manglende tekst. PDF-er må ha et tekstlag. Skannede eller passordbeskyttede dokumenter må erstattes med en lesbar fil eller innlimt tekst. Originalfilen lagres ikke.
- **Stillingsannonse**: trykk **Hent** for å hente teksten fra lenken, eller lim den inn.
- **Litt om deg og denne jobben**: valgfritt. Beskriv motivasjon, relevante eksempler og ønsker for brevet.
- **Språk**: Automatisk, norsk bokmål, nynorsk, engelsk, svensk, dansk, tysk eller fransk. Et konkret valg går foran et språkønske i konteksten, som går foran annonsens krav til søknadsspråk og deretter annonsens hovedspråk. CV-ens språk bestemmer ikke brevspråket.

### Slik blir brevet til

Trykk **Skriv utkast**.
Fremdriftsraden øverst viser tre steg: **Leser grunnlaget**, **Avklaring** og **Skriver brevet**.
Raden står der før du trykker, så du vet at avklaringen kan komme.

1. Modellen analyserer CV, annonse og kontekst.
2. Den kan stille inntil tre valgfrie spørsmål på papiret. Svar på det du vil og velg **Skriv med svarene**, eller velg **Hopp over og skriv**. Har modellen ingen spørsmål, sier steget det og flyten går videre.
3. Modellen skriver brevet, og en egen redaktørkontroll går gjennom det.

Teksten strømmer inn mens den skrives, først utkastet og så kontrollens gjennomgang.
Det du ser underveis er et forslag: det lagres ikke, erstatter aldri det du selv har skrevet, og kontrollen kan forkaste det.
Teksten lander i brevet først når et trinn er godkjent.
**Avbryt** stopper når som helst, og grunnlaget og tidligere brev beholdes.

Brevet følger Oxfords veiledning for søknadsbrev: en innledning med et konkret poeng, hvorfor stillingen og virksomheten, hvorfor deg, og en avslutning.
Sentrale krav i annonsen kobles til eksempler fra grunnlaget.
Manglende informasjon skal gi spørsmål, ikke oppdiktede erfaringer eller motivasjon.
Modellkontroll og kildehenvisninger reduserer feil, men brevet må fortsatt leses av den som skal sende det.

### Etter at brevet er skrevet

- Brevet kan redigeres direkte og lagres etter en kort skrivepause.
- **Lag ny versjon** bruker teksten du ser og instruksjonen din under **Hva vil du forbedre?**.
- Tidligere versjoner og manuelle endringer beholdes, og du kan bytte mellom dem. Appen sier fra når grunnlaget er endret siden en versjon ble skrevet. Oppdatert CV eller annonse endrer ikke grunnlaget til gamle versjoner.
- **Kopier brev** og **Last ned** som Word (`.docx`) eller PDF bruker den synlige teksten. Filene lages lokalt, uten modellkall.

### Kostnad og nettverk

Første utkast bruker tre modellkall.
En ny versjon med samme grunnlag gjenbruker analysen og trenger to.
Appen prøver ikke på nytt i skjul og bytter aldri leverandør av seg selv.
En brutt forbindelse kan bety at leverandøren behandlet kallet uten at svaret kom frem, så appen starter ikke kjeden på nytt.

CV-tekst, annonse, kontekst og eventuelle svar sendes til leverandøren du har valgt.
Å laste inn en CV eller eksportere et brev gjør ingen modellkall.

### Innstillinger i brevskriveren

**Innstillinger** øverst i brevskriveren bytter ut grunnlagskolonnen, mens brevet blir stående.

- **Skriv med**: Claude (`claude-opus-5`) eller OpenAI (`gpt-6-astra`). Valget huskes på profilen.
- **API-nøkkel for valgt leverandør**: legg til eller fjern. Mangler nøkkelen, sier grunnlagskolonnen fra og tar deg dit.
- **Last ned sikkerhetskopi** og **Gjenopprett fra sikkerhetskopi**, se [Dataene dine](#dataene-dine).
- **Slett CV fra profilen** og **Slett brevet og versjonene**.

## API-nøkler

Hver konto har sine egne nøkler, lagret i kontoens katalog med modus `0600`.

| Fil | Brukes til |
| --- | --- |
| `nokkel.txt` | Anthropic: import fra lenke og brev med Claude |
| `nokkel-openai.txt` | OpenAI: brev med OpenAI |

Anthropic-nøkkelen kan legges inn under **Dataene dine** eller i brevskriverens innstillinger.
OpenAI-nøkkelen legges inn i brevskriverens innstillinger.

Nøklene går inn og aldri ut igjen.
Appen viser bare hvor en nøkkel kommer fra og de fire siste tegnene, og ikke engang dem når nøkkelen er kort eller kommer fra miljøet.
En nøkkel sendes aldri til nettleseren, havner aldri i en feilmelding og aldri i `importlogg.jsonl`.
Filen leses ved hvert kall, så en ny nøkkel virker uten omstart.

Vil du skrive filen selv, holder `read -rs` nøkkelen utenfor shell-historikken:

```sh
KAT=~/Library/Application\ Support/no.nordli.jobbsoknader/brukere/<id>
read -rs "?Nøkkel: " K && printf '%s\n' "$K" > "$KAT/nokkel.txt" \
  && chmod 600 "$KAT/nokkel.txt" && unset K
```

I nettleserversjonen slår serveren opp nøkkelen i denne rekkefølgen:

1. Kontoens egen nøkkelfil. Den vinner alltid.
2. Miljøvariabelen `ANTHROPIC_API_KEY` eller `OPENAI_API_KEY`, men bare for den første kontoen. Variabelen tilhører den som startet serveren, og registreringen er åpen.
3. Er `DELT_NOKKEL=1` satt, gjelder miljøvariabelen for alle kontoene.

Mac-appen bruker bare nøkkelfilene.
En `nokkel.txt` som lå i rota av datakatalogen fra før, kopieres (ikke flyttes) til den første kontoen.

## Kontoer

Du oppretter en konto med e-post, valgfritt navn og et passord på minst ti tegn.
Hver konto har sin egen søknadsliste, importlogg, CV, brev og API-nøkler i sin egen katalog under `brukere/`.
Navnet og et monogram vises nederst i sidepanelet, sammen med knappen for å logge ut.

**Den første kontoen overtar det som lå der fra før.**
Søknadene i `<datakatalog>/jobber.json` kopieres inn i den første kontoens katalog, og originalen blir liggende urørt.
**Senere kontoer starter tomme**, slik at ingen får en annens søknader som sine.
Startlisten ligger fortsatt under **Dataene dine** for den som vil ha den.

**Registreringen er åpen, men serveren lytter bare på `127.0.0.1`.**
Det er sperren.
Åpner du porten utover via en tunnel, en proxy eller en annen adresse, kan hvem som helst som når den opprette en konto, og under `DELT_NOKKEL=1` bruke API-nøkkelen din.
Ikke gjør det.
Taket er 20 kontoer, og både registrering og innlogging har grense for antall forsøk.
Serveren avviser forespørsler med feil `Host` eller `Origin`.

**Passord** lagres bare som PBKDF2-HMAC-SHA256-hash.
Du holdes innlogget med en signert cookie i 30 dager.
Går økten ut mens du jobber, kommer innloggingen opp igjen, og ulagrede endringer beholdes og lagres når du logger inn som samme bruker.

**Innlogging er ikke kryptering.**
Filene ligger som lesbar JSON på disk, og det er med vilje.
Kryptering ville kostet all gjenoppretting ved glemt passord, og lesbar JSON er halve grunnen til at appen finnes.
Innloggingen holder to kontoer på samme maskin fra hverandre i nettleserversjonen, men den holder ingen unna disken din.

**I Mac-appen er passordet et profilvalg, ikke en lås.**
Appen har ingen server.
Passordet sjekkes i webviewet mot et register webviewet også kan lese direkte, og én linje i utviklerverktøyene hopper over det.
Vil du ha en ekte grense, er det diskkryptering og brukerkontoene i macOS som gir den.

**Appen og nettleserversjonen deler register.**
En konto opprettet i nettleseren er den samme kontoen i appen, med de samme søknadene, fordi begge leser fra samme katalog.

**Glemt passord kan ikke gjenopprettes**, fordi det ikke finnes noen e-post å sende eller nøkkel å utlede det fra.
Dataene er ikke tapt: åpne `brukere.json`, fjern raden med kontoen, opprett den på nytt, og flytt katalogen under `brukere/` over til den nye id-en.
Det finnes foreløpig ingen knapp for å bytte passord i appen.

## Dataene dine

**Dataene dine** nederst i sidepanelet samler det som gjelder søknadslisten:

- **Kopier som Markdown**: samme oppsett som notatet, med grupper, lenker og datoer.
- **Kopier som JSON**: alle feltene, klare til å limes inn igjen.
- **Lim inn JSON**: erstatter hele listen. Godtar både en ren liste og hele datafilen. Kan angres.
- **Tilbakestill til startlisten**: erstatter alt med de 55 søknadene appen startet med. Kan angres.
- Tallene om importen og Anthropic-nøkkelen.

**Sikkerhetskopien** under brevskriverens innstillinger omfatter profilens CV, brev, kildegrunnlag og versjoner, også brev til søknader som senere er fjernet.
Nøkler følger ikke med.
Gjenoppretting legger inn dokumenter som mangler, men erstatter ikke en eksisterende samling.
JSON-eksporten under **Dataene dine** inneholder bare søknadslisten, så ta begge kopiene hvis du vil flytte alt.

## Hvor dataene ligger

Begge utgavene bruker samme katalog:

```
~/Library/Application Support/no.nordli.jobbsoknader/
```

Det er katalogen Tauri gir appen, og `npm start` leser og skriver i den samme.
En app i `/Applications` har ingen måte å finne prosjektmappa på, mens appkatalogen finnes uansett hvor appen startes fra.
Logger du inn i appen, er du logget inn på det samme i nettleseren.

Vil du ha dataene et annet sted, setter du `DATA_KATALOG` når du starter serveren:

```sh
DATA_KATALOG=~/et/annet/sted npm start
```

**Hadde du data i `data/` i prosjektmappa?**
Det var stedet før, og dataene blir liggende der.
Serveren sier fra ved oppstart hvis den finner noe der, men flytter ingenting selv.
Flytt innholdet inn i katalogen over mens appen og serveren er avslått.

### Innhold

```
<datakatalog>/
  jobber.json               den gamle enbrukerfilen, urørt og kilde til migreringen
  jobber.forrige.json       urørt
  nokkel.txt                urørt, kopieres til første konto
  brukere.json              registeret over kontoer, modus 0600
  brukere.forrige.json
  okthemmelighet.txt        nøkkelen øktcookiene signeres med, modus 0600
  brukere/<id>/
    jobber.json             søknadene dine
    jobber.forrige.json
    importlogg.jsonl
    nokkel.txt              Anthropic-nøkkelen, modus 0600
    nokkel-openai.txt       OpenAI-nøkkelen, modus 0600
    cv.json                 CV-teksten
    brev-<jobb-id>.json     brev, grunnlag og versjoner for én søknad
```

`jobber.json` er vanlig JSON som kan leses og redigeres for hånd:

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

### Slik går ingenting tapt

**Søknadslisten** skrives aldri halvveis: den lages som en midlertidig fil, tvinges til disk og byttes inn med `rename`.
Forrige versjon tas vare på i `jobber.forrige.json`.
Er filen uleselig, flyttes den til `jobber.ødelagt-<tid>.json` i stedet for å bli overskrevet, og appen tilbyr å gjenopprette fra sikkerhetskopien.
Ingenting skrives før du har valgt.

**Er appen og nettleseren åpne samtidig, kan de skrive i samme fil.**
Hver lagring sier hvilken versjon den bygger på, og filen leses på nytt rett før den skrives.
Er den endret i mellomtiden, avvises lagringen, du får «Hent på nytt», og ingenting går tapt.
Søknadslisten har ingen fillås, så to lagringer i nøyaktig samme øyeblikk kan la den siste vinne, og derfor ligger forrige versjon alltid i `jobber.forrige.json`.

Sidepanelet viser om endringene er lagret, lagres nå eller ikke ble lagret.
Er serveren nede, beholdes endringen og lagres når den er tilbake.

**CV og brev** ligger utenfor søknadslisten.
Filene har revisjonskontroll, en kopi av forrige lagring og en kort fillås som deles av nettleserversjonen og Mac-appen.
Ved en lagringskonflikt beholdes teksten på skjermen, så ikke lukk før den er kopiert eller lagret.
**Gjenopprett forrige lagring** henter den lokale kopien når et dokument er skadet, og originalen legges til side.
Sletting av brevdata fjerner også de tilhørende lokale kopiene.
Sletting av profilens CV fjerner ikke CV-grunnlaget som allerede er lagret sammen med tidligere brevversjoner.

Dataene ligger utenfor repoet, og `data/` står dessuten i `.gitignore`.
Repoet er offentlig, og filene inneholder ekte søknader.

## Utvikling

### Tester

```sh
npm test          # lagerlogikk, server, kontoer, import, brev og dokumenter
npm run test:ui   # nettlesertest av brevflyten med syntetiske modellsvar
npm run test:rust # fil-, nett- og brevoperasjonene i Mac-appen
```

`npm test` kjører alle `server/*.test.mjs` med `node:test`.
Testene bruker simulerte modellsvar og krever ingen API-nøkkel.

Nettlesertesten bruker installert Chrome på macOS, ellers Playwright Chromium (`npx playwright install chromium`).
`BROWSER_EXECUTABLE` kan peke på en annen Chromium-binær.
Testen oppretter en midlertidig profil og lagrer skjermbilder og eksportfiler der, så egne kontoer berøres ikke.

### Evaluering av søknadsbrev

Skriveinstruksjonene og evalueringsdataene ligger i kildekoden.
`node evals/kjor.mjs` viser 24 syntetiske testtilfeller uten nettverkskall.
Kjøring mot betalte modeller og vurdering av skrivekvalitet er beskrevet i [`evals/README.md`](evals/README.md).

### Miljøvariabler

| Variabel | Virkning |
| --- | --- |
| `PORT` | Porten for `npm start` når 4173 er opptatt |
| `DATA_KATALOG` | Flytter datakatalogen for `npm start` |
| `ANTHROPIC_API_KEY` | Anthropic-nøkkel for den første kontoen i nettleserversjonen |
| `OPENAI_API_KEY` | OpenAI-nøkkel for den første kontoen i nettleserversjonen |
| `DELT_NOKKEL=1` | Lar alle kontoer bruke nøkkelen fra miljøet |
| `BROWSER_EXECUTABLE` | Chromium-binær for `npm run test:ui` |

### Oppbygging

```
index.html               markup
hent-gamle-data.html     henter søknader ut av den første utgavens nettleserlager
src/stiler.css           «Lin», designsystemet
src/skrifter.css         Familjen Grotesk og Geist Mono, lagt inn lokalt
src/tema-tidlig.js       setter fargetemaet før første maling
src/app.js               appen: visninger, skjema, eksport og hendelser
src/felles.mjs           statuser, sektorer og validering, delt av alle lag
src/startliste.js        søknadene appen starter med

src/lagerlogikk.mjs      reglene for datafilen, uten filsystem
src/lagring.js           henting og lagring, velger transport etter modus
src/tauri-filer.mjs      filsystemet i appmodus, over Rust

src/importlogikk.mjs     reglene for å lese en utlysning, uten I/O
src/importlogg.mjs       kostnadsloggen for importen
src/import.js            importflyten, velger transport
src/tauri-nett.mjs       henting og modellkall i appmodus, over Rust

src/brukerlogikk.mjs     reglene for kontoer og økter, uten I/O
src/okt.js               hvem som er logget inn, i begge modi
src/okt-app.mjs          kontoene i appmodus, over Rust og crypto.subtle
src/innlogging.js        innloggingen

src/brevlogikk.mjs       grunnlag, skrivetrinn og svarformat for brevet
src/brevtjeneste.mjs     kjeden analyse, avklaring, skriving og kontroll
src/brev-provider.mjs    meldingsformatet for Anthropic og OpenAI
src/brev-strom.mjs       strømmende modellsvar
src/brevdata.mjs         formatet for CV- og brevdokumentene
src/brev.js              brevets transport, velger modus
src/brevflate.js         brevskriveren
src/annonsetekst.mjs     annonseteksten ut av en hentet side
src/brev-dokumenter.mjs  lesing av CV og eksport av brev
src/brev-dokumentmotor.mjs  PDF og Word, pakkes til src/vendor/

server/server.mjs        statiske filer og API-et
server/brukere.mjs       registeret, PBKDF2, cookier og ett lager per konto
server/katalog.mjs       hvor datakatalogen ligger
server/lager.mjs         søknadslisten i nettlesermodus
server/nett.mjs          henting og modellkall for importen
server/nokkel.mjs        API-nøkkelen, inn og aldri ut
server/brev-api.mjs      endepunktene for CV, brev, nøkler og kjøringer
server/brev-modell.mjs   modellkall og profilnøkler for brevet
server/brevlager.mjs     CV- og brevfilene, med lås

src-tauri/src/lib.rs     filoperasjonene appen bruker
src-tauri/src/nett.rs    henting og modellkall for importen i appen
src-tauri/src/brev.rs    brevfiler, nøkler, modellkall og nedlasting i appen

scripts/bygg-front.mjs       samler frontenden i dist/ for Tauri
scripts/bygg-dokumenter.mjs  pakker dokumentmotoren med esbuild
scripts/test-brev-browser.mjs  nettlesertesten av brevflyten
evals/                   evaluering av søknadsbrev
temaer/                  fargestudier, ikke i bruk av appen
specs/job-tracker/       filbasert lagring: hva som ble bygget og hvorfor
specs/flerbruker/        kontoene, og hva innloggingen ikke er
```

Reglene for datafilen står ett sted, i `src/lagerlogikk.mjs`.
Under den ligger to filsystemer, Node i nettlesermodus og Rust i appen, og de gjør nøyaktig det samme: kopi av forrige versjon, midlertidig fil, fsync og `rename`.
