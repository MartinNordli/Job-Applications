# Evaluering av søknadsbrev

`node evals/kjor.mjs` viser 24 syntetiske tilfeller uten nettverk. Ordinære tester bruker modellstubber, og kjører aldri denne betalte evalueringen.

Sett valgt leverandørs `ANTHROPIC_API_KEY` eller `OPENAI_API_KEY` i miljøet uten å legge nøkler i repoet. Kjør deretter eksplisitt:

```sh
node evals/kjor.mjs --live --leverandor anthropic --repetisjoner 3 --baseline --rapport /tmp/breveval-anthropic.json
node evals/kjor.mjs --live --leverandor openai --repetisjoner 3 --baseline --rapport /tmp/breveval-openai.json
```

Dette koster API-bruk: 216 kall per leverandør uten baseline, inntil 288 med baseline. `--tilfelle 09 --repetisjoner 1` kjører bare ett tilfelle. Det er ingen automatisk retry. Rapporten overskriver aldri en eksisterende fil. Ubesvarte oppfølgingsspørsmål hoppes over med hensikt; spørsmål og bruk ligger i rapporten.

De automatiske kontrollene dekker format, kildehenvisninger, valgt språk, kjente stilbrudd og enkelte eksplisitte tilfellekrav. De beviser ikke at brevet er naturlig eller at en påstand er semantisk støttet. For hver modell/promptendring må en person vurdere brev og baseline i tilfeldig rekkefølge uten å se hvilken variant som skrev dem. Modell-ID og promptversjon i rapporten skal følge vurderingen; et modellbytte er ikke i seg selv dokumentasjon på bedre brev.

Vurder hvert brev 1–5 etter disse kriteriene. Godkjenning krever ingen oppdiktede konkrete påstander og minst 4 i hver dimensjon:

| Kriterium | Hva en god tekst viser |
| --- | --- |
| Naturlig åpning | Første setning tilfører et konkret poeng om personen, motivasjonen eller arbeidet. En løs «Jeg søker stillingen …» eller «I am writing to apply …» teller som svak åpning. Vurder funksjonen, ikke bare bestemte ord. |
| Relevans uten overforklaring | Utvalget av erfaringer gjør forbindelsen til jobben forståelig. Brevet trenger ikke forklare etter hvert eksempel at erfaringen er relevant eller verdifull. Direkte annonsespørsmål om relevans skal likevel besvares. |
| Utdypning fremfor CV-gjengivelse | Teksten gir innblikk i en konkret situasjon, egne valg, arbeidsmåte eller oppgitt motivasjon. Den omskriver ikke bare CV-punkter til avsnitt. Utdypningen må ha dekning i kildene; manglende detaljer kan gi spørsmål, ikke nye fakta. |
| Troverdig motivasjon og personlighet | Oppgitt interesse, glede, ambisjon eller engasjement får plass og høres ut som et menneske. Konkrete, kildebaserte uttrykk for lidenskap er velkomne; generelle superlativer og oppdiktet entusiasme er det ikke. En nøktern tekst kan få høy score når brukeren ikke har oppgitt følelser eller motivasjon. |
| Faktastøtte | Erfaring, egne bidrag, resultater og personlige begrunnelser kan spores til grunnlaget. Et rimelig utvalg og en ny formulering er tillatt; nye årsaksforklaringer, resultater eller personlighetstrekk krever støtte. |
| Recruiter-vennlig språk | Brevet beholder relevant faglighet og beskriver arbeid og bidrag klart. Verken teknologistakker, implementasjonsdetaljer eller pedagogiske forklaringer av åpenbare sammenhenger dominerer. |
| Naturlig stemme og flyt | Avsnittene henger sammen og prioriterer det som betyr noe. Teksten er fri for em dash og retoriske kontrastklisjeer, samtidig som den beholder varme og personlighet. |

Hvert tilfelle i `tilfeller.mjs` har `vurderingspunkter` for menneskelig gjennomgang. Disse er vurderingsfasit, sendes ikke til modellen og sjekkes ikke automatisk av CLI-en. Registrer vurderingene sammen med rapporten, inkludert kildepassasjene som begrunner ros eller feil. Sammenlign særlig 02, 03, 04, 05, 10, 23 og 24, som har konkret personlig kontekst, med 01, 06 og 08, som har tynt grunnlag. Et godt skriveopplegg bruker rik kontekst aktivt og holder igjen når den mangler. Ikke belønn samme følelsesnivå eller samme brevstruktur i alle tilfeller.

Promptens korte eksempler er separate fra evalueringstilfellene. Korriger produktprompten når et mønster feiler, og vurder på nytt hele settet. Ikke legg virkelige CV-er, brev eller API-nøkler i disse filene.
