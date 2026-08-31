/* ============================================================
   Filoperasjonene under lagerlogikken.

   Reglene for datafilen ligger i src/lagerlogikk.mjs, delt med
   Node-serveren. Her er bare de fire operasjonene JavaScript ikke
   kan gjøre selv — og de gjøres nøye: uten fsync kan et strømbrudd
   gi en tom fil, og uten rename kan en leser treffe en halvskrevet.

   Alt skjer inne i appens datakatalog. Navnene kommer fra vår egen
   kode, men de sjekkes likevel: en sti som slipper ut av katalogen
   er ikke en feil vi vil oppdage den dagen den skjer.
   ============================================================ */

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

mod nett;

/// Filen API-nøkkelen ligger i, ved siden av datafilen. Den leses av
/// Rust og sendes aldri til webviewet — der ville den ligget i minnet
/// til en side vi ikke kontrollerer innholdet på.
const NOKKELFIL: &str = "nokkel.txt";

/// Bare enkle filnavn. Ingen skilletegn, ingen «..», ingen tomme navn.
fn trygt_navn(navn: &str) -> Result<&str, String> {
    let gyldig = !navn.is_empty()
        && navn != "."
        && navn != ".."
        && navn.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | 'æ' | 'ø' | 'å' | 'Æ' | 'Ø' | 'Å')
        });
    if gyldig {
        Ok(navn)
    } else {
        Err(format!("ulovlig filnavn: {navn}"))
    }
}

fn katalog(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("fant ikke datakatalogen: {e}"))
}

#[tauri::command]
fn data_katalog(app: AppHandle) -> Result<String, String> {
    Ok(katalog(&app)?.to_string_lossy().into_owned())
}

/// Innholdet i filen, eller `None` hvis den ikke finnes. Andre feil
/// er ekte feil og skal fram — en uleselig fil er ikke en tom fil.
fn les_i(dir: &Path, navn: &str) -> Result<Option<String>, String> {
    let sti = dir.join(trygt_navn(navn)?);
    match fs::read_to_string(&sti) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("kunne ikke lese {}: {e}", sti.display())),
    }
}

fn flytt_i(dir: &Path, fra: &str, til: &str) -> Result<(), String> {
    let fra = dir.join(trygt_navn(fra)?);
    let til = dir.join(trygt_navn(til)?);
    fs::rename(&fra, &til).map_err(|e| format!("kunne ikke flytte {}: {e}", fra.display()))
}

#[tauri::command]
fn les_tekst(app: AppHandle, navn: String) -> Result<Option<String>, String> {
    les_i(&katalog(&app)?, &navn)
}

#[tauri::command]
fn flytt_fil(app: AppHandle, fra: String, til: String) -> Result<(), String> {
    flytt_i(&katalog(&app)?, &fra, &til)
}

/// Skriver hele filen på nytt uten at den noen gang står halvferdig:
/// kopi av forrige gode versjon, så en midlertidig fil som synkes til
/// disk, og til slutt et navnebytte. Katalogen synkes etterpå — ellers
/// kan selve navnebyttet mangle etter et strømbrudd.
fn skriv_i(dir: &Path, navn: &str, tekst: &str, kopi_til: Option<&str>) -> Result<(), String> {
    let tmp_navn = format!(".{navn}.tmp");
    let mål = dir.join(trygt_navn(navn)?);
    let tmp = dir.join(trygt_navn(&tmp_navn)?);

    fs::create_dir_all(dir).map_err(|e| format!("kunne ikke lage {}: {e}", dir.display()))?;

    if let Some(kopi) = kopi_til {
        let kopi = dir.join(trygt_navn(kopi)?);
        match fs::copy(&mål, &kopi) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {} /* ingen fil å ta vare på ennå */
            Err(e) => return Err(format!("kunne ikke ta sikkerhetskopi: {e}")),
        }
    }

    let skriv = || -> std::io::Result<()> {
        let mut f = File::create(&tmp)?;
        f.write_all(tekst.as_bytes())?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, &mål)?;
        /* Katalogen kan nekte fsync på enkelte filsystemer. Det er verdt
           å be om, men ikke verdt å feile på. */
        let _ = File::open(dir).and_then(|d| d.sync_all());
        Ok(())
    };

    skriv().map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("kunne ikke skrive {}: {e}", mål.display())
    })
}

#[tauri::command]
fn skriv_atomisk(
    app: AppHandle,
    navn: String,
    tekst: String,
    kopi_til: Option<String>,
) -> Result<(), String> {
    skriv_i(&katalog(&app)?, &navn, &tekst, kopi_til.as_deref())
}

#[tauri::command]
async fn hent_side(url: String) -> Result<nett::Side, String> {
    nett::hent_side(url).await
}

#[tauri::command]
async fn spor_modell(app: AppHandle, kropp: String) -> Result<String, String> {
    let nokkel = les_i(&katalog(&app)?, NOKKELFIL)?
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            format!("Ingen API-nøkkel. Legg den i {NOKKELFIL} i datakatalogen — se README.")
        })?;
    nett::spor_modell(nokkel, kropp).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            data_katalog,
            les_tekst,
            flytt_fil,
            skriv_atomisk,
            hent_side,
            spor_modell
        ])
        .run(tauri::generate_context!())
        .expect("appen klarte ikke å starte");
}

#[cfg(test)]
mod tester {
    use super::*;

    /* Egen katalog per test, så ingen ekte datafil kan komme i veien. */
    fn ny_katalog(merke: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("jobber-rust-test-{merke}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn navn_som_slipper_ut_av_katalogen_avvises() {
        assert!(trygt_navn("jobber.json").is_ok());
        assert!(trygt_navn("jobber.ødelagt-2026-08-30.json").is_ok());
        assert!(trygt_navn(".jobber.json.tmp").is_ok());

        assert!(trygt_navn("../jobber.json").is_err());
        assert!(trygt_navn("data/jobber.json").is_err());
        assert!(trygt_navn("..").is_err());
        assert!(trygt_navn("").is_err());
    }

    #[test]
    fn skriving_kan_leses_tilbake_og_etterlater_ingen_rest() {
        let dir = ny_katalog("rundtur");
        skriv_i(&dir, "jobber.json", "{\"a\":1}", None).unwrap();

        assert_eq!(les_i(&dir, "jobber.json").unwrap().as_deref(), Some("{\"a\":1}"));
        assert!(!dir.join(".jobber.json.tmp").exists(), "den midlertidige filen ble liggende");
    }

    #[test]
    fn fil_som_ikke_finnes_er_ikke_en_feil() {
        let dir = ny_katalog("mangler");
        assert_eq!(les_i(&dir, "jobber.json").unwrap(), None);
    }

    #[test]
    fn forrige_versjon_tas_vare_på_før_bytte() {
        let dir = ny_katalog("kopi");
        skriv_i(&dir, "jobber.json", "først", Some("jobber.forrige.json")).unwrap();
        /* Ingenting å ta kopi av ennå — det skal ikke være en feil. */
        assert_eq!(les_i(&dir, "jobber.forrige.json").unwrap(), None);

        skriv_i(&dir, "jobber.json", "så", Some("jobber.forrige.json")).unwrap();
        assert_eq!(les_i(&dir, "jobber.json").unwrap().as_deref(), Some("så"));
        assert_eq!(les_i(&dir, "jobber.forrige.json").unwrap().as_deref(), Some("først"));
    }

    #[test]
    fn karantene_flytter_filen_i_stedet_for_å_skrive_over() {
        let dir = ny_katalog("karantene");
        skriv_i(&dir, "jobber.json", "ødelagt", None).unwrap();
        flytt_i(&dir, "jobber.json", "jobber.ødelagt-2026-08-30.json").unwrap();

        assert_eq!(les_i(&dir, "jobber.json").unwrap(), None);
        assert_eq!(
            les_i(&dir, "jobber.ødelagt-2026-08-30.json").unwrap().as_deref(),
            Some("ødelagt")
        );
    }
}
