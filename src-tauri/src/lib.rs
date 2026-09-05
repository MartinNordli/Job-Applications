/* ============================================================
   Filoperasjonene under lagerlogikken.

   Reglene for datafilen ligger i src/lagerlogikk.mjs, delt med
   Node-serveren. Her er bare de fire operasjonene JavaScript ikke
   kan gjøre selv — og de gjøres nøye: uten fsync kan et strømbrudd
   gi en tom fil, og uten rename kan en leser treffe en halvskrevet.

   Alt skjer inne i appens datakatalog. Navnene kommer fra vår egen
   kode, men de sjekkes likevel: en sti som slipper ut av katalogen
   er ikke en feil vi vil oppdage den dagen den skjer.

   Med flere profiler har hver operasjon en valgfri `bruker`. Uten
   den gjelder datakatalogen selv — der registeret og den gamle
   enbrukerfilen ligger. Med den gjelder <datakatalog>/brukere/<id>.
   Id-en er JavaScript sin, men den går gjennom trygt_navn() før den
   settes sammen med noe: sammensetting av stier skjer bare her, og
   den som setter sammen er den som må sjekke.
   ============================================================ */

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

mod nett;

/// Filen API-nøkkelen ligger i, ved siden av datafilen — i profilens
/// katalog, ikke i rota. Rust leser den selv når modellen skal spørres,
/// så adressen til modellen og nøkkelen møtes utenfor webviewet.
///
/// Merk at dette er disiplin, ikke en grense: webviewet har `les_tekst`
/// og kan lese den samme filen selv. I nettlesermodus er «nøkkelen går
/// aldri tilbake til klienten» en ekte grense, håndhevet av serveren.
/// I appmodus ER webviewet klienten. Se kommentaren i src/tauri-filer.mjs.
const NOKKELFIL: &str = "nokkel.txt";

/// Katalogen profilene ligger under. Samme form som i nettlesermodus,
/// så en datakatalog ser lik ut uansett hvilken skinn som lagde den.
const BRUKERKATALOG: &str = "brukere";

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

/// `None` → rota selv. `Some(id)` → <rot>/brukere/<id>.
///
/// Id-en er 16 heksadesimale tegn og dermed allerede lovlig i
/// trygt_navn(); den sjekkes likevel her, fordi det er her stien
/// settes sammen. Formatet i seg selv er JavaScript sin regel og
/// står i src/brukerlogikk.mjs — det som må stå her, er at ingenting
/// slipper ut av datakatalogen. Feiler sjekken, blir det ingen sti.
fn bruker_katalog_i(rot: &Path, bruker: Option<&str>) -> Result<PathBuf, String> {
    match bruker {
        None => Ok(rot.to_path_buf()),
        Some(id) => Ok(rot.join(BRUKERKATALOG).join(trygt_navn(id)?)),
    }
}

fn bruker_katalog(app: &AppHandle, bruker: Option<&str>) -> Result<PathBuf, String> {
    bruker_katalog_i(&katalog(app)?, bruker)
}

#[tauri::command]
fn data_katalog(app: AppHandle, bruker: Option<String>) -> Result<String, String> {
    Ok(bruker_katalog(&app, bruker.as_deref())?
        .to_string_lossy()
        .into_owned())
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
fn les_tekst(app: AppHandle, navn: String, bruker: Option<String>) -> Result<Option<String>, String> {
    les_i(&bruker_katalog(&app, bruker.as_deref())?, &navn)
}

#[tauri::command]
fn flytt_fil(
    app: AppHandle,
    fra: String,
    til: String,
    bruker: Option<String>,
) -> Result<(), String> {
    flytt_i(&bruker_katalog(&app, bruker.as_deref())?, &fra, &til)
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
    bruker: Option<String>,
) -> Result<(), String> {
    /* skriv_i gjør create_dir_all, så profilkatalogen blir til av seg
       selv ved første skriving. Derfor ingen egen kommando for å lage
       kataloger — én operasjon mindre å ta feil av. */
    skriv_i(
        &bruker_katalog(&app, bruker.as_deref())?,
        &navn,
        &tekst,
        kopi_til.as_deref(),
    )
}

#[tauri::command]
async fn hent_side(url: String) -> Result<nett::Side, String> {
    nett::hent_side(url).await
}

/// Nøkkelen til profilen som spør. Ingen fallback til rota og ingen
/// miljøvariabel: appen startes fra Dock uten miljø, og en nøkkel som
/// stilltiende kunne komme fra en annen profil ville vært den ene
/// profilen som betaler for den andre.
fn les_nokkel(dir: &Path) -> Result<String, String> {
    les_i(dir, NOKKELFIL)?
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            format!("Ingen API-nøkkel. Legg den inn under «Dataene dine», eller i {NOKKELFIL} i profilkatalogen — se README.")
        })
}

#[tauri::command]
async fn spor_modell(
    app: AppHandle,
    kropp: String,
    bruker: Option<String>,
) -> Result<String, String> {
    let nokkel = les_nokkel(&bruker_katalog(&app, bruker.as_deref())?)?;
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

    /* ---------- profilkatalogene ---------- */

    #[test]
    fn bruker_som_slipper_ut_av_katalogen_avvises() {
        let rot = Path::new("/tmp/rot");
        for ond in ["../", "a/b", "..", "", ".", "/etc", "..%2f", "a\\b"] {
            assert!(
                bruker_katalog_i(rot, Some(ond)).is_err(),
                "id-en {ond:?} skulle vært avvist"
            );
        }
        assert!(bruker_katalog_i(rot, Some("0123456789abcdef")).is_ok());
    }

    #[test]
    fn ingen_bruker_gir_rotkatalogen() {
        /* Bakoverkompatibilitet: registeret og den gamle enbrukerfilen
           ligger i rota, og de leses uten `bruker`. */
        let rot = Path::new("/tmp/rot");
        assert_eq!(bruker_katalog_i(rot, None).unwrap(), rot.to_path_buf());
        assert_eq!(
            bruker_katalog_i(rot, Some("0123456789abcdef")).unwrap(),
            rot.join("brukere").join("0123456789abcdef")
        );
    }

    #[test]
    fn skriving_for_en_bruker_havner_i_profilkatalogen_og_ikke_i_rota() {
        let rot = ny_katalog("profil");
        let dir = bruker_katalog_i(&rot, Some("00112233445566aa")).unwrap();

        skriv_i(&dir, "jobber.json", "mine", None).unwrap();

        assert_eq!(les_i(&dir, "jobber.json").unwrap().as_deref(), Some("mine"));
        assert_eq!(les_i(&rot, "jobber.json").unwrap(), None, "rota ble rørt");
        assert!(rot.join("brukere").join("00112233445566aa").is_dir());
    }

    #[test]
    fn to_brukere_kolliderer_ikke() {
        let rot = ny_katalog("to-brukere");
        let a = bruker_katalog_i(&rot, Some("aaaaaaaaaaaaaaaa")).unwrap();
        let b = bruker_katalog_i(&rot, Some("bbbbbbbbbbbbbbbb")).unwrap();

        skriv_i(&a, "jobber.json", "til a", Some("jobber.forrige.json")).unwrap();
        skriv_i(&b, "jobber.json", "til b", Some("jobber.forrige.json")).unwrap();

        assert_eq!(les_i(&a, "jobber.json").unwrap().as_deref(), Some("til a"));
        assert_eq!(les_i(&b, "jobber.json").unwrap().as_deref(), Some("til b"));
        /* Sikkerhetskopien hører også til én profil. */
        skriv_i(&a, "jobber.json", "til a igjen", Some("jobber.forrige.json")).unwrap();
        assert_eq!(les_i(&a, "jobber.forrige.json").unwrap().as_deref(), Some("til a"));
        assert_eq!(les_i(&b, "jobber.forrige.json").unwrap(), None);
    }

    #[test]
    fn karantene_treffer_profilens_katalog() {
        let rot = ny_katalog("profil-karantene");
        let dir = bruker_katalog_i(&rot, Some("ccccccccccccccc1")).unwrap();
        skriv_i(&rot, "jobber.json", "rotas fil", None).unwrap();
        skriv_i(&dir, "jobber.json", "ødelagt", None).unwrap();

        flytt_i(&dir, "jobber.json", "jobber.ødelagt-2026-09-05.json").unwrap();

        assert_eq!(les_i(&dir, "jobber.json").unwrap(), None);
        assert_eq!(
            les_i(&dir, "jobber.ødelagt-2026-09-05.json").unwrap().as_deref(),
            Some("ødelagt")
        );
        /* Rotas fil er migreringskilden. Den skal ikke ha flyttet seg. */
        assert_eq!(les_i(&rot, "jobber.json").unwrap().as_deref(), Some("rotas fil"));
        assert_eq!(les_i(&rot, "jobber.ødelagt-2026-09-05.json").unwrap(), None);
    }

    #[test]
    fn nøkkelen_leses_fra_profilen_og_ikke_fra_rota() {
        let rot = ny_katalog("profil-nøkkel");
        let dir = bruker_katalog_i(&rot, Some("dddddddddddddddd")).unwrap();
        skriv_i(&rot, NOKKELFIL, "rotas-nøkkel-som-ikke-skal-brukes", None).unwrap();

        /* Uten egen nøkkel er svaret en feil — ikke rotas nøkkel. */
        let feil = les_nokkel(&dir).unwrap_err();
        assert!(feil.contains("API-nøkkel"), "uventet melding: {feil}");
        assert!(!feil.contains("rotas-nøkkel"), "feilmeldingen røper en nøkkel");

        skriv_i(&dir, NOKKELFIL, "  profilens-nøkkel\n", None).unwrap();
        assert_eq!(les_nokkel(&dir).unwrap(), "profilens-nøkkel");
        /* Rotas nøkkel er urørt — den er fortsatt migreringskilden. */
        assert_eq!(
            les_i(&rot, NOKKELFIL).unwrap().as_deref(),
            Some("rotas-nøkkel-som-ikke-skal-brukes")
        );
    }

    #[test]
    fn tom_nøkkelfil_er_ingen_nøkkel() {
        /* Slik «fjern nøkkelen» ser ut i appmodus: webviewet skriver en
           tom fil, fordi Rust ikke har en slette-operasjon. Da skal
           spørringen mot modellen nekte, ikke sende et tomt hode. */
        let rot = ny_katalog("tom-nøkkel");
        let dir = bruker_katalog_i(&rot, Some("eeeeeeeeeeeeeeee")).unwrap();
        skriv_i(&dir, NOKKELFIL, "", None).unwrap();
        assert!(les_nokkel(&dir).is_err());
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
