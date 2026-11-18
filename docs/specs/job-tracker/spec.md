# Jobbsøknader — filbasert lagring

## Problem

`index.html` er allerede en ferdig, gjennomarbeidet søknadsoversikt: fire visninger
(Frister / Sendt / Arkiv / Tall), fristlinje, markdown-import fra Obsidian, eksport,
angre på alt som er destruktivt, tastatursnarveier. Designsystemet «Lin» er bevisst
og konsekvent.

Men dataene ligger i `localStorage`. De er bundet til én nettleser på én maskin,
usynlige utenfor appen, og kan forsvinne om nettleserdata tømmes. Listen inneholder
55 ekte søknader.

## Ønsket oppførsel

Dataene skal ligge i en lesbar fil på disk, `data/jobber.json`, og overleve både
omlasting av siden og omstart av appen. Alt annet i appen skal fungere som før.

## Krav

**Lagring**
- Legge til, endre, endre status og slette skriver til `data/jobber.json`.
- Dataene overlever omlasting og omstart.
- Ødelagt eller manglende datafil håndteres uten tap.
- Filen kan ikke bli halvskrevet — skriving er atomisk.
- Ingen `localStorage` som primærlager.

**Migrering**
- Eksisterende data i `localStorage` flyttes til filen etter bekreftelse.
- `localStorage` tømmes ikke — den blir liggende som sikkerhetskopi.
- Uten data noe sted: startlisten på 55 søknader seedes.

**Validering**
- Samme regler i nettleseren og på serveren, fra én modul.
- Selskap og stilling kan ikke være tomme.
- Frist er tom eller en ekte kalenderdato.
- Status er en av de tillatte.
- Lenke er tom eller `http`/`https` — aldri `javascript:`.
- Serveren stoler ikke på klienten.

**Brukeropplevelse**
- Brukeren ser når noe er lagret, holder på å lagres, eller ikke ble lagret.
- Mistet forbindelse til serveren skjules ikke.
- Ingen endring forsvinner stille.

## Akseptansekriterier

- [ ] Ny søknad havner i `data/jobber.json` og er der etter omstart.
- [ ] Endring, statusbytte og sletting oppdaterer filen.
- [ ] Angre virker fortsatt, og angringen lagres.
- [ ] Ødelagt datafil settes i karantene i stedet for å overskrives.
- [ ] Foreldet versjon fra en annen fane gir konflikt, ikke tap.
- [ ] `javascript:`-lenke avvises av både klient og server.
- [ ] Frister viser «i dag», «i morgen», «om N dager», «gikk ut» riktig.
- [ ] Datoen holder seg riktig i en fane som står åpen over midnatt.
- [ ] Skuffen er en ekte dialog: fokusfelle, fokus tilbake, bakgrunn ikke tabbar.
- [ ] Eksisterende utseende og oppførsel er uendret der det ikke står noe annet.

## Utenfor omfang

Mørkt tema · brukere og innlogging · database · rammeverk · inkrementell
opptegning · endringer i `temaer/`.

«Brukere og innlogging» ble senere tatt inn med vitende og vilje. Linjen over
står som den står — den er et riktig referat av avgrensningen som gjaldt da
filbasert lagring ble bygget. Det som kom etterpå, står i
[`specs/flerbruker/spec.md`](../flerbruker/spec.md).
