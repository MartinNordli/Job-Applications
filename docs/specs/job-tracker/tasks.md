# Oppgaver

- [x] Git-baseline før noe røres
- [x] Del `index.html` i `index.html` + `src/stiler.css` + `src/app.js` (verifisert byte-likt)
- [x] `src/felles.mjs` — statuser, sektorer, validering
- [x] `server/lager.mjs` — atomisk lesing/skriving, karantene, sikkerhetskopi
- [x] `server/server.mjs` — statiske filer + `/api/jobber`
- [x] `server/*.test.mjs` — 32 tester
- [x] `package.json`
- [x] `src/startliste.js` — startlisten ut av app.js
- [x] `src/lagring.js` — hent, lagre med debounce, versjonssporing, tilstandsvarsler
- [x] Koble `lagre()` og oppstart til serveren
- [x] Migrering fra `localStorage` med bekreftelse
- [x] Gjenoppretting fra `jobber.forrige.json` når datafilen mangler
- [x] Lagringsindikator i sidepanelet (også på smale skjermer)
- [x] Frakoblet-stripe med «Prøv igjen» og automatisk nytt forsøk
- [x] Fiks: `I_DAG` fryser ved sidelasting
- [x] Fiks: `expired` mangler farge
- [x] Fiks: skuffen er ikke en ekte dialog (fokusfelle, fokus tilbake)
- [x] Fiks: fokus hoppet ut til angreknappen i varselet
- [x] Fiks: utsatt fokus kunne lande i en lukket skuff
- [x] Fiks: utgåtte frister ble talt som «løpende»
- [x] Fiks: usikre lenker fjernes i stedet for å forkaste hele raden
- [x] Fiks: skjemavalidering mot `validerSoknad`
- [x] `sendtDato` redigerbar i skjemaet
- [x] Status `trukket`
- [x] «Marker som utløpt» i Gikk ut-båndet
- [x] JSON-import i eksportskuffen
- [x] `confirm()` byttet ut med appens egen bekreftelse
- [x] Tester (32/32), manuell gjennomgang i nettleseren
- [x] Uavhengig gjennomgang av diffen

## Etter gjennomgangen

- [x] Ødelagt fil flyttes ikke lenger under lesing — den lå igjen som en tom
      katalog, og neste skriving ble godtatt og overskrev sikkerhetskopien
- [x] Sperre: ingenting skrives før brukeren har valgt, ved ødelagt fil,
      ubesvart migrering eller konflikt
- [x] Konflikt overtar ikke lenger serverens versjon — neste tastetrykk
      ville ellers skrevet over den andre fanen
- [x] keepalive bare ved utflukt; ellers hadde lagringen stoppet ved ~140 rader
- [x] Rader validatoren ikke forstår skrives tilbake urørt i stedet for å bli slettet
- [x] XSS: dobbeltdekoding i `data-tips`, uescapet `p.id` og selskapsnavn i tallflisen
- [x] Lukket skuff er ikke lenger tabbar
- [x] «Vil du forlate siden?» fjernet — stripa sier det samme uten å blokkere
- [x] `trukket` med i tall og markdown-eksport
- [x] Nullbyte i sti gir 404, fsync av katalogen etter rename
- [x] Snarveier virker ikke inni dialogen, fokus flyttes ikke til en rad som straks tegnes om
- [x] `hent-gamle-data.html` — den gamle file://-lagringen er et annet origin
