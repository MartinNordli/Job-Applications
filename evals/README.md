# Evaluering av søknadsbrev

`node evals/kjor.mjs` viser de 23 syntetiske tilfellene og validerer grunnlagene, uten nettverk.
Vanlige tester bruker modellstubber og kjører aldri den betalte evalueringen.
`server/evals.test.mjs` sjekker at tilfellene er gyldige, at de automatiske sjekkene gjør det de sier, og at modellsammenligningen bare bytter modell og innsats.

## Betalt kjøring

En betalt kjøring gjøres bare når brukeren har godkjent kostnaden.
Sett `ANTHROPIC_API_KEY` eller `OPENAI_API_KEY` i miljøet, uten å legge nøkler i repoet, og kjør eksplisitt:

```sh
node evals/kjor.mjs --live --leverandor anthropic --repetisjoner 3 --rapport /tmp/breveval-anthropic.json
node evals/kjor.mjs --live --leverandor openai --repetisjoner 3 --rapport /tmp/breveval-openai.json
```

Hvert tilfelle bruker tre modellkall: analyse, skriving og kontroll.
Det blir 69 kall per leverandør og repetisjon.
`--tilfelle 01` kjører bare ett tilfelle, og `--tilfelle 01,08,15` flere.
Det er ingen automatiske nye forsøk, og rapporten overskriver aldri en eksisterende fil.
Rapporten har med bruken per trinn og en oppsummering av hurtigbufferen (`lest`, `skrevet` og `ubufret`), så effekten av bufringen kan måles over analyse, skriving og kontroll.
Den har også kostnaden i dollar og kroner, regnet av de faktiske tokentallene med prisene i `evals/sammenligning.mjs`.
`--tak-dollar` (standard 20) stopper kjøringen før neste tilfelle når taket er nådd, så det overskrides med høyst ett tilfelle.

### Modellbytte

`--sammenlign <modell>` kjører hele kjeden en gang til per tilfelle med en annen Anthropic-modell, typisk den appen brukte før byttet.
Forespørselen er den samme byte for byte, bortsett fra modellen og innsatsen (`--sammenlign-innsats`, standard `high`).
Slik ble brevet bedt om før byttet til Opus 5.5: `claude-opus-5` uten innsats, som for den modellen betyr `high`.

```sh
node evals/kjor.mjs --live --leverandor anthropic --repetisjoner 1 --sammenlign claude-opus-5 --rapport /tmp/breveval-opus-5-5.json
```

Ved siden av rapporten skrives en blind vurderingsfil (`/tmp/breveval-opus-5-5.blind.md`) med de to brevene per tilfelle som A og B.
Hvilken side som er den nye modellen, trekkes per tilfelle, og filen har verken modellnavn, tokentall eller tider.
Rapporten sier hvilken variant som er A og B (`variant` er `ny` eller `forrige`), og den åpnes først når alle brevene er vurdert.
`kostnad.perVariant` i rapporten viser kostnad, utdatatokens, bufring og beståtte automatiske sjekker for hver modell.

`--baseline` er ikke en modellsammenligning.
Det gir ett ekstra kall per tilfelle med en naiv prompt på samme modell, og viser hva kjeden med analyse og kontroll tilfører.

Tilfelle 22 og 23 ligger nær modellenes sikkerhetsfiltre (biologi og IT-sikkerhet), men er helt vanlige søknader.
En avvisning der er en feil, og vises i rapporten som en feil med meldingen «Modellen kunne ikke skrive et brev fra dette grunnlaget.»

## Automatiske sjekker

`evals/sjekker.mjs` sjekker hvert ferdige brev:

- språket er det tilfellet forventer
- ordtallet er 220 til 300, med mindre tilfellet har en annen grense (tynt grunnlag, eller en ordgrense i annonsen)
- hilsen og avslutning følger språket: «Til rekrutteringsteamet i …,» eller «Hei …,» og «Med vennlig hilsen» på bokmål, «Med venleg helsing» på nynorsk, «Dear …,» og «Sincerely,» på engelsk
- hilsenen bruker kontaktpersonen når annonsen oppgir en
- brevet har fire eller fem innholdsavsnitt mellom hilsen og avslutning, eller det tilfellet sier
- `finnStilbrudd` finner ingen em dash, tankestrek som pause, kontrastmal, tom frase eller plassholder
- `finnLånteFakta` finner ingen særord fra stileksemplene eller stilreferansen som ikke står i grunnlaget
- brevet har ikke noe av det tilfellet forbyr, som spor etter et injeksjonsforsøk

Sjekkene beviser ikke at brevet er godt, at en påstand er semantisk støttet eller at teksten er naturlig.
Det avgjør den menneskelige vurderingen.

## Vurderingsmal

Målestokken er et kort brev i fire avsnitt: stillingen og en konkret grunn fra annonsen, de to eller tre viktigste erfaringene knyttet til kravene, noe spesifikt om selskapet fra annonsen, og en kort avslutning.
Tilfelle 01 er gulltilfellet og viser hvor konkret et brev kan bli når grunnlaget er rikt.

For hver modell- eller promptendring vurderer en person brevene og baseline i tilfeldig rekkefølge, uten å vite hvilken variant som skrev dem.
Modell-ID og promptversjon i rapporten skal følge vurderingen.
Et modellbytte er ikke i seg selv dokumentasjon på bedre brev.

Vurder hvert brev fra 1 til 5 på hvert kriterium.
Godkjent krever ingen oppdiktede konkrete påstander og minst 4 på hvert kriterium.

| Kriterium | Hva et godt brev viser |
| --- | --- |
| Åpning | Første avsnitt nevner stillingen og selskapet, søkerens utdanning og spesialisering eller nåværende rolle, og én konkret grunn til å søke som står i annonsen. En løs «Jeg søker stillingen …» uten grunn trekker ned. |
| Erfaring mot krav | De to eller tre mest relevante erfaringene er hver knyttet til et krav i annonsen, med hva søkeren gjorde og hva det førte til. Resultater og tall brukes når grunnlaget har dem. En CV-gjennomgang i setninger trekker ned. |
| Selskapet | Det som sies om selskapet, står i annonsen, og er koblet til søkeren. Når annonsen ikke sier noe, er avsnittet kort og knyttet til oppgavene. Brevet kunne ikke vært sendt til et annet selskap ved å bytte navnet. |
| Avslutning og form | Kort ønske om å bidra med noe konkret, takk og invitasjon til en prat. Riktig hilsen og avslutningshilsen for språket, og navnet fra CV-en. |
| Konkret språk | Korte setninger med handlinger og resultater. Ingen tomme fraser som «brenner for», «spennende mulighet», «esteemed team», «ideal candidate», «resonates with» eller «I am excited to apply». Faguttrykk er forklart så en recruiter forstår bidraget. |
| Faktastøtte | Alt om erfaring, resultater og motivasjon kan spores til grunnlaget. Ingenting er lånt fra stileksemplene eller stilreferansen. Tynt grunnlag gir et kortere brev, ikke oppdiktede detaljer. |
| Lengde og flyt | Omtrent 220 til 300 ord, med mindre annonsen sier noe annet. Avsnittene henger sammen og prioriterer det som betyr mest for stillingen. |

Hvert tilfelle i `tilfeller.mjs` har `vurderingspunkter` for den menneskelige vurderingen.
De sendes ikke til modellen og sjekkes ikke automatisk.
Registrer vurderingene sammen med rapporten, med kildepassasjene som begrunner ros eller trekk.
Sammenlign særlig gulltilfellet 01 og tilfellene med tall (15) med de tynne tilfellene (02, 07, 08 og 16).
Et godt opplegg bruker et rikt grunnlag fullt ut og holder igjen når det mangler.

## Regler for tilfellene

Alle personer, selskaper og steder er oppdiktet.
Ikke legg virkelige CV-er, brev, annonser eller API-nøkler i disse filene, og ikke noe hentet fra brukerens egne eksempelbrev.
Promptens stileksempler (`STILEKSEMPLER` i `src/brevlogikk.mjs`) holdes atskilt fra tilfellene, og en test sørger for at ingen av særordene deres står her.
Feiler et mønster, rett produktprompten og vurder hele settet på nytt.
