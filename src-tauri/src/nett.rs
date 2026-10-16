/* ============================================================
   De utgående operasjonene, i appmodus: siden importen henter,
   modellen, og JSON-en Radar henter fra kjente kilder.

   Motstykket til server/nett.mjs: samme operasjoner, samme vern,
   men utført av Rust. Reglene over dette laget ligger i
   src/importlogikk.mjs og src/radarnett.mjs og deles med
   nettleserversjonen. Reglene for hent_json står i begge språk, og
   testdata/hentjson.json holder dem like.

   Nøkkelen og NAV-tokenet leses her og forlater aldri Rust. Adressene
   til modellen og til NAVs token står i koden, ikke i et argument.
   Ellers ville en fiendtlig utlysning kunnet be oss sende nøkkelen
   et annet sted.
   ============================================================ */

use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;

const MAKS_SIDE: usize = 2 * 1024 * 1024;
const MAKS_HOPP: usize = 3;
const TIDSGRENSE: Duration = Duration::from_secs(10);
const TIDSGRENSE_MODELL: Duration = Duration::from_secs(30);
const MODELL_URL: &str = "https://api.anthropic.com/v1/messages";
const AGENT: &str = "Jobbsoknader/1.0 (personlig soknadsoversikt)";

#[derive(Serialize, Debug)]
pub struct Side {
    pub status: u16,
    #[serde(rename = "sluttUrl")]
    pub slutt_url: String,
    pub html: String,
}

/// Adresser vi aldri skal hente fra. Brukeren limer inn lenken, og
/// appen kjører på samme maskin som datafilen: uten denne sjekken er
/// «importer denne utlysningen» en måte å be appen lese det som ligger
/// på loopback eller på skymetadata-adressen.
pub fn er_intern(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_multicast()
                || v4.is_unspecified()
                || v4.octets()[0] == 0
                // operatør-NAT, 100.64.0.0/10
                || (v4.octets()[0] == 100 && (64..=127).contains(&v4.octets()[1]))
        }
        IpAddr::V6(v6) => {
            if let Some(kart) = v6.to_ipv4_mapped() {
                return er_intern(&IpAddr::V4(kart));
            }
            v6.is_loopback()
                || v6.is_multicast()
                || v6.is_unspecified()
                // unike lokale adresser, fc00::/7
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                // link-local, fe80::/10
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

/// Slår opp verten og godtar den bare hvis hver eneste adresse er
/// utvendig. Den kontrollerte adressen sendes tilbake, slik at
/// klienten kan pinnes til den — ellers kunne oppslaget gitt ett svar
/// til sjekken og et annet til koblingen.
fn sjekk_vert(vert: &str, port: u16) -> Result<SocketAddr, String> {
    let treff: Vec<SocketAddr> = (vert, port)
        .to_socket_addrs()
        .map_err(|_| "Fant ikke serveren for den adressen.".to_string())?
        .collect();

    if treff.is_empty() {
        return Err("Fant ikke serveren for den adressen.".into());
    }
    if treff.iter().any(|a| er_intern(&a.ip())) {
        return Err("Adressen peker til et internt nett.".into());
    }
    Ok(treff[0])
}

/// Redirects følges for hånd. Lot vi reqwest gjøre det, ville hoppene
/// vært usynlige for sjekken over — og det er hoppene som er hullet.
pub async fn hent_side(url: String) -> Result<Side, String> {
    let mut na = url;

    for _ in 0..=MAKS_HOPP {
        let u = reqwest::Url::parse(&na).map_err(|_| {
            "Lenken må være en full nettadresse, f.eks. https://…".to_string()
        })?;
        if u.scheme() != "http" && u.scheme() != "https" {
            return Err("Bare http- og https-lenker er tillatt.".into());
        }
        let vert = u.host_str().ok_or("Lenken mangler et vertsnavn.")?.to_string();
        let port = u.port_or_known_default().unwrap_or(443);
        let adresse = sjekk_vert(&vert, port)?;

        let klient = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(TIDSGRENSE)
            .user_agent(AGENT)
            .resolve(&vert, adresse)
            .build()
            .map_err(|e| format!("Fikk ikke satt opp hentingen: {e}"))?;

        let svar = klient
            .get(u.clone())
            .header("Accept", "text/html,application/xhtml+xml")
            .header("Accept-Language", "nb,no,en;q=0.8")
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    "Siden svarte ikke innen ti sekunder.".to_string()
                } else {
                    "Fikk ikke kontakt med siden.".to_string()
                }
            })?;

        let kode = svar.status();
        if kode.is_redirection() {
            if let Some(sted) = svar.headers().get(reqwest::header::LOCATION) {
                let sted = sted.to_str().map_err(|_| "Ugyldig videresending.".to_string())?;
                na = u.join(sted).map_err(|_| "Ugyldig videresending.".to_string())?.into();
                continue;
            }
        }
        if !kode.is_success() {
            return Err(format!("Siden svarte {}.", kode.as_u16()));
        }

        let type_ = svar
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !type_.is_empty()
            && !type_.contains("html")
            && !type_.contains("xml")
            && !type_.contains("text/plain")
        {
            return Err("Adressen peker ikke til en nettside.".into());
        }

        return Ok(Side {
            status: kode.as_u16(),
            slutt_url: u.to_string(),
            html: les_med_tak(svar).await?,
        });
    }

    Err("Siden sendte oss videre for mange ganger.".into())
}

/// Content-Length kan lyve; taket må gjelde det som faktisk kommer inn.
async fn les_med_tak(mut svar: reqwest::Response) -> Result<String, String> {
    let mut biter: Vec<u8> = Vec::new();
    while let Some(bit) = svar
        .chunk()
        .await
        .map_err(|_| "Mistet forbindelsen mens siden ble lest.".to_string())?
    {
        if biter.len() + bit.len() > MAKS_SIDE {
            biter.extend_from_slice(&bit[..MAKS_SIDE - biter.len()]);
            break;
        }
        biter.extend_from_slice(&bit);
    }
    Ok(String::from_utf8_lossy(&biter).into_owned())
}

fn prøv_igjen(kode: u16) -> bool {
    matches!(kode, 408 | 409 | 429 | 500 | 502 | 503 | 504 | 529)
}

/// Kroppen kommer som tekst fra JavaScript; adressen og nøkkelen gjør
/// ikke det. Nøkkelen returneres aldri, heller ikke i en feilmelding.
pub async fn spor_modell(nokkel: String, kropp: String) -> Result<String, String> {
    let klient = reqwest::Client::builder()
        .timeout(TIDSGRENSE_MODELL)
        .user_agent(AGENT)
        .build()
        .map_err(|e| format!("Fikk ikke satt opp forespørselen: {e}"))?;

    let send = || {
        klient
            .post(MODELL_URL)
            .header("x-api-key", &nokkel)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .body(kropp.clone())
            .send()
    };

    let feilmelding = |e: reqwest::Error| {
        if e.is_timeout() {
            "Modellen svarte ikke i tide.".to_string()
        } else {
            "Fikk ikke kontakt med modellen.".to_string()
        }
    };

    let mut svar = send().await.map_err(feilmelding)?;

    /* Ett nytt forsøk når køen er full eller noe er nede et øyeblikk.
       Uten det må brukeren trykke selv, og betaler hentingen på nytt. */
    if prøv_igjen(svar.status().as_u16()) {
        let pause = svar
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .map(|s| Duration::from_secs(s.min(10)))
            .unwrap_or(Duration::from_millis(1500));
        tokio::time::sleep(pause).await;
        svar = send().await.map_err(feilmelding)?;
    }

    let kode = svar.status();
    let tekst = svar
        .text()
        .await
        .map_err(|_| "Klarte ikke lese svaret fra modellen.".to_string())?;

    if !kode.is_success() {
        let melding = serde_json::from_str::<serde_json::Value>(&tekst)
            .ok()
            .and_then(|j| j["error"]["message"].as_str().map(str::to_owned))
            .map(|m| format!("Modellen svarte {}: {m}", kode.as_u16()))
            .unwrap_or_else(|| format!("Modellen svarte {}.", kode.as_u16()));
        return Err(melding.replace(&nokkel, "«…»"));
    }
    Ok(tekst)
}

/* ---------- hent JSON for Radar ---------- */
/*
   Samme regler som src/radarnett.mjs og lagHentJson i server/nett.mjs:
   bare https og bare vertene under, ingen videresendinger, typen må
   være application/json, 304 er «ingenting nytt», og over 5 MiB er en
   feil, ikke et stille kutt. 30 s for NAV, 15 s ellers.

   DNS låses som i hent_side: oppslaget sjekkes, og klienten får den
   sjekkede adressen med .resolve(). Uten videresendinger er det ett
   oppslag per kall.

   Det offentlige NAV-tokenet holdes i minnet i prosessen. Det roterer
   etter rundt 86 minutter uten at exp sier fra, så et 401 gir ett nytt
   token og ett nytt forsøk. Et privat token fra nav-token.txt brukes
   hvis filen finnes, og avvises det, sier vi fra i stedet for å bytte
   stille til det offentlige.
*/

const MAKS_JSON: usize = 5 * 1024 * 1024;
const MAKS_TOKEN: usize = 8 * 1024;
const NAV_TOKENURL: &str = "https://pam-stilling-feed.nav.no/api/publicToken";
pub const NAV_TOKENFIL: &str = "nav-token.txt";

static OFFENTLIG_TOKEN: Mutex<Option<String>> = Mutex::new(None);

#[derive(Serialize, Debug)]
pub struct JsonSvar {
    pub status: u16,
    pub json: serde_json::Value,
    pub etag: Option<String>,
    #[serde(rename = "sistEndret")]
    pub sist_endret: Option<String>,
}

/// Verten hver kilde får hente fra. Ukjent kilde har ingen vert.
pub fn vert_for(kilde: &str) -> Option<&'static str> {
    match kilde {
        "nav" => Some("pam-stilling-feed.nav.no"),
        "jobbnorge" => Some("publicapi.jobbnorge.no"),
        "greenhouse" => Some("boards-api.greenhouse.io"),
        "lever" => Some("api.lever.co"),
        _ => None,
    }
}

fn tidsgrense_for(kilde: &str) -> Duration {
    Duration::from_secs(if kilde == "nav" { 30 } else { 15 })
}

/// Adressen, eller en melding brukeren kan lese. Brukernavn, passord
/// og annen port enn 443 avvises: ingen av API-ene trenger dem, og
/// alle tre er måter å få samme vertsnavn til å bety noe annet.
pub fn sjekk_json_adresse(url: &str, kilde: &str) -> Result<reqwest::Url, String> {
    let vert = vert_for(kilde).ok_or("Ukjent kilde.")?;
    let u = reqwest::Url::parse(url).map_err(|_| "Ugyldig adresse til kilden.".to_string())?;
    if u.scheme() != "https" {
        return Err("Kilden må hentes over https.".into());
    }
    if !u.username().is_empty() || u.password().is_some() || u.port().is_some() {
        return Err("Ugyldig adresse til kilden.".into());
    }
    if u.host_str().map(str::to_ascii_lowercase).as_deref() != Some(vert) {
        return Err("Adressen hører ikke til kilden.".into());
    }
    Ok(u)
}

/// «application/json», med eller uten parametre. Tom type avvises.
pub fn er_json_type(type_: &str) -> bool {
    let t = type_.trim().to_ascii_lowercase();
    match t.strip_prefix("application/json") {
        Some(rest) => {
            let rest = rest.trim_start();
            rest.is_empty() || rest.starts_with(';')
        }
        None => false,
    }
}

/// ETag og Last-Modified kommer tilbake fra radar.json. Bare synlige
/// ASCII-tegn og mellomrom, så ingenting kan bære et linjeskift inn i
/// et hode.
pub fn hodeverdi(v: Option<&str>, maks: usize) -> Option<String> {
    let v = v?;
    let ok = !v.is_empty() && v.len() <= maks && v.bytes().all(|b| (0x20..=0x7e).contains(&b));
    ok.then(|| v.to_owned())
}

/// Siste ikke-tomme linje, og bare hvis den har formen til en JWT.
/// Formen er også vernet mot hodeinjeksjon i Authorization.
pub fn tolk_nav_token(tekst: &str) -> Option<String> {
    let siste = tekst.lines().map(str::trim).filter(|l| !l.is_empty()).last()?;
    let deler: Vec<&str> = siste.split('.').collect();
    let gyldig = siste.len() <= 4096
        && deler.len() == 3
        && deler.iter().all(|d| {
            !d.is_empty() && d.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        });
    gyldig.then(|| siste.to_owned())
}

async fn send_json(
    u: &reqwest::Url,
    kilde: &str,
    hoder: &[(&str, String)],
) -> Result<reqwest::Response, String> {
    let vert = u.host_str().ok_or("Lenken mangler et vertsnavn.")?.to_string();
    let adresse = sjekk_vert(&vert, 443)?;
    let grense = tidsgrense_for(kilde);
    let klient = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(grense)
        .user_agent(AGENT)
        .resolve(&vert, adresse)
        .build()
        .map_err(|e| format!("Fikk ikke satt opp hentingen: {e}"))?;
    let mut be = klient.get(u.clone()).header("Accept", "application/json");
    for (navn, verdi) in hoder {
        be = be.header(*navn, verdi);
    }
    be.send().await.map_err(|e| {
        if e.is_timeout() {
            format!("Kilden svarte ikke innen {} sekunder.", grense.as_secs())
        } else {
            "Fikk ikke kontakt med kilden.".to_string()
        }
    })
}

/// Taket er en feil, ikke et kutt. Content-Length kan lyve, så det
/// telles det som faktisk kommer inn.
async fn les_med_hardt_tak(
    mut svar: reqwest::Response,
    tak: usize,
    melding: &str,
    kilde: &str,
) -> Result<Vec<u8>, String> {
    let mut biter: Vec<u8> = Vec::new();
    loop {
        let bit = svar.chunk().await.map_err(|e| {
            if e.is_timeout() {
                format!("Kilden svarte ikke innen {} sekunder.", tidsgrense_for(kilde).as_secs())
            } else {
                "Mistet forbindelsen mens svaret ble lest.".to_string()
            }
        })?;
        let Some(bit) = bit else { break };
        if over_tak(biter.len(), bit.len(), tak) {
            return Err(melding.to_owned());
        }
        biter.extend_from_slice(&bit);
    }
    Ok(biter)
}

fn over_tak(har: usize, ny: usize, tak: usize) -> bool {
    har.saturating_add(ny) > tak
}

async fn nytt_offentlig_token() -> Result<String, String> {
    *OFFENTLIG_TOKEN.lock().map_err(|_| "Tokenlageret er ødelagt.".to_string())? = None;
    let u = sjekk_json_adresse(NAV_TOKENURL, "nav")?;
    let svar = send_json(&u, "nav", &[("Accept", "text/plain".to_string())]).await?;
    match svar.status().as_u16() {
        200 => {}
        404 => return Err("NAV har ikke et offentlig token akkurat nå. Radar prøver igjen senere.".into()),
        k => return Err(format!("NAV svarte {k} på tokenet.")),
    }
    let tekst = les_med_hardt_tak(svar, MAKS_TOKEN, "Tokenet fra NAV var for langt.", "nav").await?;
    let token = tolk_nav_token(&String::from_utf8_lossy(&tekst))
        .ok_or("NAV svarte ikke med et gyldig token.")?;
    *OFFENTLIG_TOKEN.lock().map_err(|_| "Tokenlageret er ødelagt.".to_string())? = Some(token.clone());
    Ok(token)
}

/// Innholdet i nav-token.txt. Ingen fil, eller en tom fil, er intet
/// privat token, som for nokkel.txt. En fil med noe annet enn et token
/// er en feil: da stopper vi heller enn å bruke et annet token enn det
/// brukeren la der.
pub fn privat_token(innhold: Option<String>) -> Result<Option<String>, String> {
    let Some(t) = innhold else { return Ok(None) };
    if t.trim().is_empty() {
        return Ok(None);
    }
    if t.len() > MAKS_TOKEN {
        return Err(format!("{NAV_TOKENFIL} har ikke et gyldig token."));
    }
    tolk_nav_token(&t)
        .map(Some)
        .ok_or_else(|| format!("{NAV_TOKENFIL} har ikke et gyldig token."))
}

fn lagret_token() -> Option<String> {
    OFFENTLIG_TOKEN.lock().ok().and_then(|t| t.clone())
}

/// `privat` er innholdet i nav-token.txt hvis filen finnes.
pub async fn hent_json_med(
    url: String,
    kilde: String,
    etag: Option<String>,
    sist_endret: Option<String>,
    privat: Option<String>,
) -> Result<JsonSvar, String> {
    let u = sjekk_json_adresse(&url, &kilde)?;
    let etag = hodeverdi(etag.as_deref(), 200);
    let sist_endret = hodeverdi(sist_endret.as_deref(), 64);
    let mut hoder: Vec<(&str, String)> = Vec::new();
    if let Some(e) = &etag {
        hoder.push(("If-None-Match", e.clone()));
    }
    if let Some(s) = &sist_endret {
        hoder.push(("If-Modified-Since", s.clone()));
    }

    let svar = if kilde == "nav" {
        let privat = privat_token(privat)?;
        let token = match (&privat, lagret_token()) {
            (Some(p), _) => p.clone(),
            (None, Some(t)) => t,
            (None, None) => nytt_offentlig_token().await?,
        };
        let med = |t: &str| {
            let mut h = hoder.clone();
            h.push(("Authorization", format!("Bearer {t}")));
            h
        };
        let mut svar = send_json(&u, &kilde, &med(&token)).await?;
        if svar.status().as_u16() == 401 {
            if privat.is_some() {
                return Err(format!("NAV avviste tokenet i {NAV_TOKENFIL}."));
            }
            let nytt = nytt_offentlig_token().await?;
            svar = send_json(&u, &kilde, &med(&nytt)).await?;
            if svar.status().as_u16() == 401 {
                if let Ok(mut t) = OFFENTLIG_TOKEN.lock() {
                    *t = None;
                }
                return Err("NAV avviste tokenet. Radar prøver igjen senere.".into());
            }
        }
        svar
    } else {
        send_json(&u, &kilde, &hoder).await?
    };

    let hode = |navn: reqwest::header::HeaderName, maks: usize| {
        hodeverdi(svar.headers().get(navn).and_then(|v| v.to_str().ok()), maks)
    };
    let ny_etag = hode(reqwest::header::ETAG, 200);
    let ny_sist = hode(reqwest::header::LAST_MODIFIED, 64);
    let type_ = svar
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let kode = svar.status().as_u16();

    if kode == 304 {
        return Ok(JsonSvar {
            status: 304,
            json: serde_json::Value::Null,
            etag: ny_etag.or(etag),
            sist_endret: ny_sist.or(sist_endret),
        });
    }
    if (300..400).contains(&kode) {
        return Err("Kilden sendte oss videre. Det følger ikke Radar.".into());
    }
    if kode != 200 {
        return Err(format!("Kilden svarte {kode}."));
    }
    if !er_json_type(&type_) {
        return Err("Kilden svarte ikke med JSON.".into());
    }
    let kropp = les_med_hardt_tak(svar, MAKS_JSON, "Svaret fra kilden er større enn 5 MiB.", &kilde).await?;
    let json = serde_json::from_slice(&kropp).map_err(|_| "Kilden svarte med ugyldig JSON.".to_string())?;
    Ok(JsonSvar { status: 200, json, etag: ny_etag, sist_endret: ny_sist })
}

/// Kommandoen webviewet kaller. `bruker` sier hvilken profilkatalog et
/// privat NAV-token leses fra; tokenet selv går aldri tilbake.
#[tauri::command]
pub async fn hent_json(
    app: AppHandle,
    url: String,
    kilde: String,
    etag: Option<String>,
    sist_endret: Option<String>,
    bruker: Option<String>,
) -> Result<JsonSvar, String> {
    let privat = if kilde == "nav" {
        let dir = super::bruker_katalog(&app, bruker.as_deref())?;
        super::les_i(&dir, NAV_TOKENFIL).map_err(|_| format!("Kunne ikke lese {NAV_TOKENFIL}."))?
    } else {
        None
    };
    hent_json_med(url, kilde, etag, sist_endret, privat).await
}

#[cfg(test)]
mod tester {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().expect("gyldig ip i testen")
    }

    #[test]
    fn interne_adresser_avvises() {
        for a in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.0.5",
            "169.254.169.254", // skymetadata
            "0.0.0.0",
            "100.64.0.1",      // operator-NAT
            "224.0.0.1",
            "::1",
            "::",
            "fe80::1",
            "fd00::1",
            "::ffff:127.0.0.1", // IPv4 i IPv6-drakt
            "::ffff:10.0.0.1",
        ] {
            assert!(er_intern(&ip(a)), "{a} skulle vaert avvist");
        }
    }

    #[test]
    fn utvendige_adresser_slipper_gjennom() {
        for a in [
            "93.184.216.34",
            "8.8.8.8",
            "172.32.0.1", // rett utenfor 172.16/12
            "99.64.0.1",  // rett utenfor 100.64/10
            "2606:2800:220:1:248:1893:25c8:1946",
        ] {
            assert!(!er_intern(&ip(a)), "{a} skulle sluppet gjennom");
        }
    }

    #[test]
    fn bare_forbigående_feil_gir_nytt_forsøk() {
        for k in [408, 429, 500, 502, 503, 529] {
            assert!(prøv_igjen(k), "{k} skulle gitt nytt forsøk");
        }
        for k in [200, 400, 401, 403, 404, 422] {
            assert!(!prøv_igjen(k), "{k} skal ikke prøves på nytt");
        }
    }

    #[tokio::test]
    async fn loopback_hentes_ikke() {
        let feil = hent_side("http://127.0.0.1:4173/api/jobber".into())
            .await
            .expect_err("loopback skal avvises");
        assert!(feil.contains("internt nett"), "uventet melding: {feil}");
    }

    /* De to under går ut på nettet og koster penger. De kjøres ikke av
       `npm run test:rust` — bare med `cargo test -- --ignored`, når man
       vil se at appmodus faktisk snakker med omverdenen. */
    #[tokio::test]
    #[ignore = "går ut på nettet"]
    async fn henter_en_ekte_side() {
        let side = hent_side("https://job-boards.greenhouse.io/anthropic".into())
            .await
            .expect("skulle hentet siden");
        assert_eq!(side.status, 200);
        assert!(side.html.len() > 1000, "fikk {} tegn", side.html.len());
    }

    #[tokio::test]
    #[ignore = "går ut på nettet og koster penger"]
    async fn spor_modellen_pa_ekte() {
        let sti = dirs_datakatalog().join("nokkel.txt");
        let nokkel = match std::fs::read_to_string(&sti) {
            Ok(t) if !t.trim().is_empty() => t.trim().to_owned(),
            _ => {
                eprintln!("hopper over: ingen nokkel.txt i {}", sti.display());
                return;
            }
        };
        let kropp = serde_json::json!({
            "model": "claude-haiku-5-5",
            "max_tokens": 1024,
            "output_config": { "effort": "low" },
            "messages": [{ "role": "user", "content": "Svar med ordet: hei" }]
        })
        .to_string();

        let svar = spor_modell(nokkel, kropp).await.expect("modellen skulle svart");
        assert!(svar.contains("\"content\""), "uventet svar: {}", &svar[..svar.len().min(200)]);
    }

    /* Samme katalog som appen bruker, uten en AppHandle å spørre. */
    fn dirs_datakatalog() -> std::path::PathBuf {
        std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
            .join("Library/Application Support/no.nordli.jobbsoknader")
    }

    #[tokio::test]
    async fn bare_http_og_https() {
        for url in ["file:///etc/passwd", "javascript:alert(1)", "ftp://example.com/"] {
            assert!(hent_side(url.into()).await.is_err(), "{url} skulle vaert avvist");
        }
    }

    /* ---------- hent_json ---------- */

    /* Den samme filen leses av server/hentjson.test.mjs. */
    fn felles() -> serde_json::Value {
        serde_json::from_str(include_str!("../../testdata/hentjson.json")).expect("hentjson.json er gyldig")
    }

    #[test]
    fn vertslisten_er_den_samme_som_i_node() {
        for t in felles()["adresser"].as_array().unwrap() {
            let (url, kilde, ok) = (t["url"].as_str().unwrap(), t["kilde"].as_str().unwrap(), t["ok"].as_bool().unwrap());
            assert_eq!(sjekk_json_adresse(url, kilde).is_ok(), ok, "{url} for {kilde}: {}", t["om"]);
        }
    }

    #[test]
    fn bare_application_json_godtas() {
        for t in felles()["typer"].as_array().unwrap() {
            let type_ = t["type"].as_str().unwrap();
            assert_eq!(er_json_type(type_), t["ok"].as_bool().unwrap(), "{type_:?}");
        }
    }

    #[test]
    fn nav_tokenet_leses_likt_som_i_node() {
        for t in felles()["tokens"].as_array().unwrap() {
            let tekst = t["tekst"].as_str().unwrap();
            assert_eq!(tolk_nav_token(tekst).as_deref(), t["token"].as_str(), "{tekst:?}");
        }
        let lagret = include_str!("../../testdata/radar/nav/publicToken.txt");
        assert!(tolk_nav_token(lagret).is_some_and(|t| t.starts_with("eyJ")));
    }

    #[test]
    fn privat_token_tom_fil_er_ingen_fil_og_tull_er_en_feil() {
        assert_eq!(privat_token(None), Ok(None));
        assert_eq!(privat_token(Some("  \n".into())), Ok(None));
        assert_eq!(privat_token(Some("eyJ.privat.token\n".into())), Ok(Some("eyJ.privat.token".into())));
        assert!(privat_token(Some("ikke et token\r\nX-Injisert: ja".into())).is_err());
        assert!(privat_token(Some(format!("a.b.{}", "ø".repeat(MAKS_TOKEN)))).is_err(), "langt token skal avvises uten å dele et tegn");
    }

    #[test]
    fn hodeverdier_kan_ikke_bære_linjeskift() {
        assert_eq!(hodeverdi(Some("W/\"abc\""), 200).as_deref(), Some("W/\"abc\""));
        for ond in ["a\r\nX-Injisert: ja", "a\nb", "", "ø"] {
            assert_eq!(hodeverdi(Some(ond), 200), None, "{ond:?}");
        }
        assert_eq!(hodeverdi(Some(&"x".repeat(201)), 200), None);
        assert_eq!(hodeverdi(None, 200), None);
    }

    #[test]
    fn taket_er_en_grense_og_ikke_et_kutt() {
        assert!(!over_tak(0, MAKS_JSON, MAKS_JSON), "akkurat på taket er greit");
        assert!(over_tak(MAKS_JSON, 1, MAKS_JSON));
        assert!(over_tak(usize::MAX, 1, MAKS_JSON), "ingen overflyt");
        assert_eq!(tidsgrense_for("nav"), Duration::from_secs(30));
        assert_eq!(tidsgrense_for("lever"), Duration::from_secs(15));
    }

    #[test]
    fn localhost_er_internt_også_for_json() {
        let feil = sjekk_vert("localhost", 443).expect_err("localhost skal avvises");
        assert!(feil.contains("internt nett"), "uventet melding: {feil}");
    }

    #[tokio::test]
    async fn json_utenfor_vertslisten_hentes_ikke() {
        for (url, kilde) in [
            ("https://127.0.0.1/api", "nav"),
            ("https://evil.example/v3/jobs", "jobbnorge"),
            ("http://api.lever.co/v0/postings/bekk", "lever"),
            ("https://api.lever.co/v0/postings/bekk", "webcruiter"),
        ] {
            assert!(hent_json_med(url.into(), kilde.into(), None, None, None).await.is_err(), "{url}");
        }
    }

    #[tokio::test]
    #[ignore = "går ut på nettet"]
    async fn henter_ekte_json_fra_jobbnorge() {
        let svar = hent_json_med(
            "https://publicapi.jobbnorge.no/v3/jobs?orderby=Published&period=Day&results=2&page=0".into(),
            "jobbnorge".into(),
            None,
            None,
            None,
        )
        .await
        .expect("skulle hentet søket");
        assert_eq!(svar.status, 200);
        assert!(svar.json["jobs"].is_array());
    }

    #[tokio::test]
    #[ignore = "går ut på nettet"]
    async fn henter_ekte_nav_feed_med_offentlig_token() {
        let svar = hent_json_med(
            "https://pam-stilling-feed.nav.no/api/v1/feed?last".into(),
            "nav".into(),
            None,
            None,
            None,
        )
        .await
        .expect("skulle hentet siste side");
        assert_eq!(svar.status, 200);
        assert!(svar.json["items"].is_array());
        assert!(!serde_json::to_string(&svar).unwrap().contains("Bearer"));
    }
}
