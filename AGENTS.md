# AGENTS.md

Hired er en søknadsliste for én person.
Den kjører som `npm start` i nettleseren og som Tauri-app på Mac, over samme data og samme regler.
Oppbyggingen og filkartet står i README under Utvikling, og gjentas ikke her.

## Kommandoer

```sh
npm test                                       # alle enhetstester, rundt 10 s
node --test server/lager.test.mjs              # én fil
node --test --test-name-pattern="karantene" server/lager.test.mjs

npm run test:ui                                # alle nettlesertester, rundt 1 min
node scripts/test-radar-browser.mjs            # én flyt, rundt 10 s

PATH="/opt/homebrew/opt/rustup/bin:$PATH" npm run test:rust   # rundt 1 min, flere minutter første gang i en worktree
cd src-tauri && cargo test <navn>              # et utvalg, når dist/ finnes

DATA_KATALOG=$(mktemp -d) PORT=<ledig port> npm start
```

Under arbeidet kjører du den filen eller flyten du rører.
Alle tre suitene kjøres før fletting.
Det finnes ingen linter eller formatter, så følg stilen i filen du endrer.

## Oppsett i en worktree

- Worktreene ligger i `/Users/nordli/Projects/Jobbsoknader-wt/<navn>`, med `node_modules` som symlenke til hovedrepoet.
- `src/vendor/` og `dist/` er ikke sjekket inn.
  Kjør `npm run bygg:dokumenter` før en enkelt nettlesertest, og `npm run bygg:front` før `cargo test` direkte.
  `npm run test:ui` og `npm run test:rust` bygger selv.
- `src-tauri/target/` er per worktree, så den første Rust-kjøringen kompilerer alt.
- Nettlesertestene bruker installert Chrome, ellers `npx playwright install chromium`.
- Rust-verktøyet ligger ikke på PATH i agentskallet, derav `PATH=` over.

## Det som koster

- Ekte nett og ekte modellkall koster brukeren penger.
  Ingen test, eval eller kjøring når dem uten at orkestratoren har sagt at brukeren har godkjent kostnaden.
  Testene bruker falskt nett og falsk modell via `lagServer({ katalog, nett, brevModellFor })`.
- `node evals/kjor.mjs` og `node evals/radar-kjor.mjs` er gratis.
  Betalte evals kjøres ikke.
- `npm run app:bygg` og `npm run app:installer` bygger en release av Mac-appen og tar lang tid.

## Grenser

- Rør aldri `data/` eller `~/Library/Application Support/no.nordli.jobbsoknader/`, og les aldri API-nøkkelen.
- Repoet er offentlig.
  Ingenting fra `data/`, `examples/` (ekte brev med navn), nøkler eller ekte søknader havner i kode, tester, evals eller commits.
- Ingen nye avhengigheter, ingen rammeverk og ikke noe byggesteg for frontenden.
- En regel som endres i Node og ikke i Rust, er en feil.
  Regler som finnes begge steder, låses av en felles fil i `testdata/`.
- En agent jobber bare i worktreen den har fått, og bytter ikke branch, fletter ikke og pusher ikke.

## Konvensjoner

- Bokmål i navn, kommentarer, tekst i appen og commit-meldinger.
- Aldri tankestrek (U+2014), heller ikke i tekst i appen.
- En setning per linje i lange Markdown-filer.
- Små commits når en del er ferdig og prøvd.
  Meldingen sier hva endringen oppnår, og har ingen medforfatterlinje.
- README oppdateres i samme branch når oppførselen endres.
- En feil, en ustabil test eller noe som ser galt ut utenfor oppgaven nevnes i rapporten.

## Testnivå

- Enhetstester for regler som beskytter data, for sikkerhet og for regler som finnes i både JS og Rust.
- Én Playwright-flyt per ny brukerflyt, med den viktigste feilveien.
- Visuelt: ett lyst og ett mørkt tema og 390 px bredde, alle fem temaene bare når nye CSS-tokens er lagt til.
- Ikke tester for hvert kanttilfelle, hver CSS-detalj eller hver tekst.

## Orkestrering

Hovedsesjonen skriver briefer og fletter, og lar agentene i `.claude/agents/` skrive koden.

- Høyst to agenter samtidig, i hver sin worktree, på oppgaver som ikke rører de samme filene.
- Briefen har målet, filene å starte i, ferdigkriterier og testnivå, ikke hele planen.
- Før fletting: `tester` går gjennom branchen, rebase på `main`, alle tre suitene, `git merge --ff-only`, og så fjernes worktree og branch.
  En konflikt som ikke kan løses mekanisk, går til brukeren.
- Etter en fletting brukeren merker, og før arbeidet stopper: `npm run app:installer` fra `main`.
  Kjører `npm start` fra hovedrepoet, startes den på nytt når serverkoden er endret.
