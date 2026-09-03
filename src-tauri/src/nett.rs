/* ============================================================
   De to utgående operasjonene, i appmodus.

   Motstykket til server/nett.mjs: samme to operasjoner, samme
   vern, men utført av Rust. Reglene over dette laget ligger i
   src/importlogikk.mjs og deles med nettleserversjonen.

   Nøkkelen leses her og forlater aldri Rust. Adressen til modellen
   står i koden, ikke i et argument — ellers ville en fiendtlig
   utlysning kunnet be oss sende nøkkelen et annet sted.
   ============================================================ */

use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

use serde::Serialize;

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
        return Err(melding);
    }
    Ok(tekst)
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

    #[tokio::test]
    async fn bare_http_og_https() {
        for url in ["file:///etc/passwd", "javascript:alert(1)", "ftp://example.com/"] {
            assert!(hent_side(url.into()).await.is_err(), "{url} skulle vaert avvist");
        }
    }
}
