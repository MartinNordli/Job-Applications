# Agentene i Hired

Denne filen beskriver hvordan arbeidet i appen deles mellom en orkestrator og fem underagenter.
Definisjonene ligger i `.claude/agents/`, og hver av dem gjentar de felles reglene kort.

## Orkestratoren

Orkestratoren er hovedsesjonen.
Den skriver ikke selv funksjoner av betydning, men gjør dette:

1. Lager branch og worktree i `/Users/nordli/Projects/Jobbsoknader-wt/<navn>`, med `node_modules` som symlenke til hovedrepoet.
2. Skriver en brief til agenten: målet, den delen av planen som gjelder, filene å starte i, funksjoner som kan gjenbrukes, ferdigkriterier og testnivå.
   Agenten får bare den konteksten oppgaven trenger, ikke hele planen.
3. Ser gjennom diffen når agenten er ferdig.
4. Sender branchen til `tester`, og funnene tilbake til den som skrev koden, samlet i én liste.
   Små rettelser gjør orkestratoren selv.
5. Fletter: rebase på oppdatert `main`, `npm test && npm run test:ui && npm run test:rust`, `git merge --ff-only`, og så fjernes worktree og branch.
   En konflikt som ikke kan løses mekanisk, går til brukeren.

Høyst to agenter jobber samtidig, og bare på oppgaver som ikke rører de samme filene.
To agenter deler aldri worktree samtidig.
Flere agenter kan jobbe etter hverandre i samme worktree når en funksjon trenger både backend og grensesnitt.

## Rollene

| Agent | Modell | Eier | Typiske oppgaver |
| --- | --- | --- | --- |
| `frontend-designer` | opus | `index.html`, `src/stiler.css`, visningsfilene i `src/` (`app.js`, `detaljpanel.js`, `brevflate.js`, `annonseflate.js`, `tidslinje.js`, `radmeny.js` og lignende), `temaer/` | Nye visninger, faner og skjema, utseende, tilgjengelighet, mobilbredde |
| `backend-developer` | sonnet | `server/`, de rene `.mjs`-modulene i `src/` (logikk, tjenester, validering, lagring), Rust-speilingen i `src-tauri/src/` av fil-, nett- og varseloperasjoner, `testdata/` | Ruter, dokumenter og datamodell, kilder og nett, regler som må være like i Node og Rust |
| `app-plattform` | sonnet | Tauri-appens livsløp: oppstart og vinduer i `main.rs` og `lib.rs`, `tauri.conf.json`, capabilities, launchd-agenter og plist, pakking og installasjon i `/Applications` | Kjøring i bakgrunnen, skjulte webview, Dock og aktiveringsregler, alt som bare kan prøves i en pakket app |
| `modell-og-prompt` | opus | prompter og utdataskjema, modelltabellen i `src/brev-provider.mjs`, `evals/`, hurtigbuffer, tak og kostnad | Nye modellkall, kalibrering, modellbytte, evals |
| `tester` | sonnet | testfilene i `server/`, `scripts/test-*-browser.mjs`, testmodulene i Rust, testskriptene i `package.json` | Porten før fletting |

Grensene er der for at hver agent skal kunne holde sitt område i hodet.
Trenger en oppgave endringer på andre siden av en grense, gjør agenten sin del, og skriver i rapporten nøyaktig hva den andre siden må gjøre.

## Felles regler

- Jobb bare i worktree-stien du har fått.
  Ikke bytt branch, ikke flett, ikke push.
- Rør aldri `data/` eller appkatalogen i `~/Library/Application Support/no.nordli.jobbsoknader/`, og les aldri API-nøkkelen.
  Kjør serveren med `DATA_KATALOG=$(mktemp -d)`.
- Rust-verktøyet ligger ikke på PATH i agentskallet. Kjør `PATH="/opt/homebrew/opt/rustup/bin:$PATH" npm run test:rust`.
- Ingen test eller kjøring når et ekte nett eller en ekte modell, med mindre orkestratoren har sagt det, etter at brukeren har godkjent kostnaden.
- Bokmål i kode, kommentarer, tekst i appen og commit-meldinger.
- Aldri tankestrek (U+2014).
- En setning per linje i lange Markdown-filer.
- Små commits underveis, når en del er ferdig og prøvd.
  Meldingen sier hva endringen oppnår, ikke hvilke filer den rører.
  Ingen medforfatterlinje.
- README oppdateres i samme branch når oppførselen endres.
- Ser du en feil, en lint-advarsel eller en ustabil test som ikke er din, nevn den i rapporten.

## Testnivået

Det testes det som beskytter brukeren, ikke hver detalj.

- Enhetstester for regler som beskytter data (validering, lagring, konflikter), for sikkerhet (vertsliste, interne adresser, tak) og for regler som finnes i både JS og Rust, via en felles testfil i `testdata/`.
- Én Playwright-flyt per ny brukerflyt, med den viktigste feilveien.
  Falsk nett og falsk modell via `lagServer({ nett, brevModellFor })`.
- Ikke tester for hvert kanttilfelle, hver CSS-detalj eller hver tekst.
- Visuelt: ett lyst og ett mørkt tema, og 390 px bredde.
  Alle fem temaene bare når nye CSS-tokens er lagt til.

## Rapporten tilbake

Høyst rundt 25 linjer:

- hva som er gjort, og begrunnelsen for valg som ikke er opplagte
- commitene
- testresultatet, med faktisk utdata hvis noe feilet
- hva som er åpent, blokkert eller må gjøres på andre siden av en grense
