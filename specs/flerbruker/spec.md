# Jobbsøknader — flere kontoer

## Problem

`specs/job-tracker/spec.md` holdt «brukere og innlogging» utenfor omfang, og det
var riktig da: én person, én maskin, én fil. Prisen var at alt som kjørte på
maskinen kunne lese og skrive hele `/api/jobber` uten legitimasjon, og at to
personer på samme maskin måtte dele én liste eller bytte på datakatalogen for
hånd.

Nettleserversjonen er den som merker det. Serveren binder `127.0.0.1`, men på
loopback finnes ingen grense mellom to personer med hver sin konto på samme Mac —
og ingen mellom appen og hva som helst annet som kan sende en HTTP-forespørsel
dit.

## Ønsket oppførsel

Flere kontoer, hver med sin egen søknadsliste, sin egen importlogg og sin egen
API-nøkkel. Adskillelsen håndheves på serveren, per forespørsel, på
filsystemnivå — ikke i flaten. Registrering er åpen, men serveren lytter bare på
loopback.

Søknadene som allerede lå i `data/jobber.json` tilfaller den første kontoen som
opprettes. Originalen blir liggende urørt. Kontoer etter den første starter tomme
— en ny bruker skal ikke arve en annens jobbsøknader som «sine».

Alt en person gjorde før, gjør de fortsatt: legge til, endre, bytte status,
arkivere, slette, angre, søke, filtrere, bytte visning, tastatursnarveiene.

## Krav

**Kontoer**
- Registrering med e-post, valgfritt navn og passord på minst 10 tegn.
- E-post er unik uansett skrivemåte; duplikat gir «finnes», ikke en ny konto.
- Hardt kontotak (20) og ratebegrensning på registrering og innlogging.
- Passordet lagres bare som PBKDF2-HMAC-SHA256-hash med selvbeskrivende format,
  aldri i klartekst. Iterasjonstallet kan heves uten å låse gamle kontoer ute.
- Ukjent e-post og feil passord gir samme svar, og koster like mye tid.

**Adskillelse**
- Hver konto har `<datakatalog>/brukere/<id>/` med `jobber.json`,
  `jobber.forrige.json`, `importlogg.jsonl` og `nokkel.txt`.
- `GET|PUT /api/jobber`, `POST /api/importer` og `GET /api/importlogg` krever
  økt og svarer `401 {feil:"utlogget"}` uten.
- En bruker kan hverken lese eller skrive en annens liste, og kan ikke
  overskrive den ved å sende den andres versjonsnummer.
- Én lagerinstans per konto: skrivekøen ligger i closuren i `lagerlogikk.mjs`,
  og to instanser for samme konto ville gitt to køer og dermed en tapt skriving.
- Statiske filer forblir åpne — uten det får ingen se innloggingsskjemaet.

**Økt**
- Signert cookie, ingen øktfil på disk. Signatur, utløp, generasjon og at
  brukeren finnes må alle stemme.
- `HttpOnly; SameSite=Strict`, ingen `Secure` — http på loopback.
- Passordbytte og «logg ut overalt» hever generasjonen og feller alle økter.
- `Host` må være loopback, og `Origin` må stemme når den er satt. Ellers 403.

**Nøkkelen**
- Kontoens egen `nokkel.txt` vinner. `ANTHROPIC_API_KEY` gjelder bare den første
  kontoen, med mindre `DELT_NOKKEL=1` er satt.
- Nøkkelen går inn og aldri ut: ikke i et svar, ikke i en feilmelding, ikke i
  importloggen. Statusen bærer `kilde`, og fire tegns hale bare fra tolv tegn og
  opp — aldri når kilden er miljøvariabelen.

**Klienten når økten ryker**
- En 401 er hverken «ingen kontakt» eller «avvist»: porten kommer opp, endringen
  ligger i behold, og ingen nye forsøk planlegges.
- Gjeninnlogging som samme bruker beholder det ulagrede og skriver det.
- Gjeninnlogging som en annen bruker laster siden på nytt; ingenting av den
  forriges tas med videre.
- Tastatursnarveiene er inaktive mens porten står.

**Appmodus**
- Samme hashformat og samme katalogoppsett, verifisert i webviewet med
  `crypto.subtle`. Rust får bare en valgfri `bruker`-parameter, og setter fortsatt
  sammen alle stier selv.
- Appen og nettleserversjonen har hvert sitt register.

## Akseptansekriterier

- [ ] `GET /api/jobber` uten cookie gir `401 {feil:"utlogget"}`.
- [ ] Første registrering arver de eksisterende radene, og originalen er bit for
      bit uendret etterpå.
- [ ] Konto nummer to starter tom og ser ingen spor av den første.
- [ ] To samtidige registreringer på samme adresse: nøyaktig én lykkes.
- [ ] Ett endret tegn i signaturen eller nyttelasten gir 401.
- [ ] Et token for en slettet bruker, en utløpt økt og en gammel generasjon
      gir alle 401.
- [ ] `Host: ond.example` gir 403, sendt rått over `net.connect`.
- [ ] Hele svarkroppen fra `GET /api/nokkel` inneholder ikke nøkkelen, og
      `importlogg.jsonl` gjør det ikke etter en import.
- [ ] Legge til, endre, statusbytte, arkivere, slette og angre virker som før,
      og havner i kontoens egen fil.
- [ ] Ødelagt datafil settes i karantene, og sikkerhetskopien kan hentes inn.
- [ ] Konflikt mellom to faner gir 409 og en sperre, ikke tap.
- [ ] Serveren nede gir «ikke lagret» med endringen i behold, og den skrives når
      serveren er tilbake.
- [ ] Kapselen slettes midt i en endring: porten kommer opp, endringen er i
      behold, nettverksfanen viser ingen gjentatte kall, og endringen lagres når
      du logger inn igjen.

## Utenfor omfang

Kryptering av datafilen · e-postverifisering · gjenoppretting av glemt passord ·
tilbakekalling av enkeltøkter · TLS og drift utenfor loopback · felles liste
mellom kontoer · roller og rettigheter.
