/* ============================================================
   Radar i bakgrunnen: appen startet av launchd med `--radar`.

   Kjernen (src/radarlogikk.mjs) er JavaScript og kjører i et webview.
   Derfor starter bakgrunnskjøringen samme binær som vanlig, men med et
   skjult vindu som laster src/radar-bakgrunn.html, og ingen hovedvindu.
   Målingene bak valgene under ligger i spike/RAPPORT.md på branchen
   spike/radar-bakgrunn.

   Rekkefølgen, og hvorfor:
   1. main(): les radar.json for profilene og avslutt med en gang hvis
      ingen har Radar på, eller hvis appen alt er åpen (den kjører Radar
      selv hver time). Det koster ingen vinduer og ingen WebKit.
   2. main(): sett aktiveringspolicyen til Prohibited før NSApplication
      er startet. Ellers står prosessen et øyeblikk som en vanlig app
      med Dock-ikon, og tao tar tastaturfokus med activateIgnoringOtherApps.
   3. Det skjulte vinduet har background_throttling Disabled. Standarden
      fra macOS 14 fryser en skjult side etter noen sekunder, også svar
      på invoke.
   4. Vakthunden avslutter prosessen etter ti minutter, uansett.
   ============================================================ */

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::varsel;

pub const ARGUMENT: &str = "--radar";
pub const RADARVINDU: &str = "radar";
pub const HOVEDVINDU: &str = "main";
const SIDE: &str = "src/radar-bakgrunn.html";
const RADARFIL: &str = "radar.json";
pub const VAKTHUNDTID: Duration = Duration::from_secs(10 * 60);
const MAKS_LOGG: u64 = 200_000;

pub fn agentetikett() -> String {
    format!("{}.radar", varsel::IDENTIFIKATOR)
}

/// Ingen RunAtLoad: Radar skal ikke kjøre hver gang appen installerer
/// agenten på nytt, og den åpne appen kjører Radar selv. Første kjøring
/// kommer en time etter at agenten ble lastet.
pub fn agentplist(exe: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
    <string>{ARGUMENT}</string>
  </array>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
"#,
        varsel::xml(&agentetikett()),
        varsel::xml(&exe.to_string_lossy())
    )
}

/* ---------- valg av modus ---------- */

#[derive(Debug, PartialEq)]
pub enum Modus {
    /// Ingen `--radar`: en vanlig oppstart med hovedvindu.
    Vanlig,
    /// Ingenting å gjøre; avslutt uten å ha startet noe. Grunnen er til loggen.
    Avslutt(&'static str),
    /// Kjør Radar for disse profilene.
    Radar(Vec<String>),
}

pub fn er_radar(args: &[String]) -> bool {
    args.iter().any(|a| a == ARGUMENT)
}

/// Rent valg ut fra det main() har funnet. Den åpne appen går foran: den
/// kjører Radar selv hver time, og to kjøringer samtidig skal ikke være
/// mulig (leien i radar.json er vernet bak dette, ikke det eneste).
pub fn velg_modus(args: &[String], profiler_med_radar: Vec<String>, annen_instans: bool) -> Modus {
    if !er_radar(args) {
        Modus::Vanlig
    } else if annen_instans {
        Modus::Avslutt("appen er alt åpen")
    } else if profiler_med_radar.is_empty() {
        Modus::Avslutt("ingen profil har Radar på")
    } else {
        Modus::Radar(profiler_med_radar)
    }
}

/// Bare `innstillinger.pa === true` teller. En fil som mangler, ikke kan
/// leses eller har en annen form, betyr at Radar er av.
fn radar_på(rot: &Path, id: &str) -> bool {
    let Ok(dir) = crate::bruker_katalog_i(rot, Some(id)) else { return false };
    let Ok(Some(tekst)) = crate::les_i(&dir, RADARFIL) else { return false };
    serde_json::from_str::<Value>(&tekst)
        .ok()
        .and_then(|v| v.pointer("/innstillinger/pa")?.as_bool())
        .unwrap_or(false)
}

pub fn profiler_med_radar(rot: &Path) -> Vec<String> {
    varsel::profiler(rot).unwrap_or_default().into_iter().filter(|id| radar_på(rot, id)).collect()
}

/* ---------- main() ---------- */

static PROFILER: OnceLock<Vec<String>> = OnceLock::new();

/// Profilene bakgrunnskjøringen gjelder, eller None i en vanlig oppstart.
pub fn profiler_i_kjøring() -> Option<&'static Vec<String>> {
    PROFILER.get()
}

/// Kalles først i main(). Avslutter prosessen når det ikke er noe å gjøre.
pub fn forbered() -> Modus {
    let args: Vec<String> = std::env::args().collect();
    if !er_radar(&args) {
        return Modus::Vanlig;
    }
    let profiler = match varsel::datarot() {
        Ok(rot) => profiler_med_radar(&rot),
        Err(e) => {
            logg(&format!("fant ikke datakatalogen: {e}"));
            Vec::new()
        }
    };
    let modus = velg_modus(&args, profiler, annen_instans_kjører());
    match &modus {
        Modus::Avslutt(grunn) => {
            logg(&format!("avslutter straks: {grunn}"));
            std::process::exit(0);
        }
        Modus::Radar(p) => {
            logg(&format!("starter for {} profil(er), pid {}", p.len(), std::process::id()));
            let _ = PROFILER.set(p.clone());
            tidlig_bakgrunn();
        }
        Modus::Vanlig => {}
    }
    modus
}

/// Før NSApplication er ferdig startet. tao setter policyen først i
/// applicationDidFinishLaunching, og da har macOS alt registrert appen som
/// en vanlig app ut fra Info.plist (målt: 40 til 300 ms i Dock).
#[cfg(target_os = "macos")]
fn tidlig_bakgrunn() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
    if let Some(mtm) = MainThreadMarker::new() {
        NSApplication::sharedApplication(mtm).setActivationPolicy(NSApplicationActivationPolicy::Prohibited);
    }
}

#[cfg(not(target_os = "macos"))]
fn tidlig_bakgrunn() {}

/// launchd starter binæren direkte og ikke via LaunchServices, så en åpen
/// app og en bakgrunnskjøring blir to prosesser med samme identitet.
#[cfg(target_os = "macos")]
fn annen_instans_kjører() -> bool {
    use objc2_app_kit::NSRunningApplication;
    use objc2_foundation::NSString;
    let egen = std::process::id() as i32;
    NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(varsel::IDENTIFIKATOR))
        .iter()
        .any(|a| a.processIdentifier() != egen && !a.isTerminated())
}

#[cfg(not(target_os = "macos"))]
fn annen_instans_kjører() -> bool {
    false
}

/// Aktiveringspolicyen til Tauri-appen før hendelsesløkka starter. Uten
/// den setter tao standarden Regular tilbake.
#[cfg(target_os = "macos")]
pub fn policy_for_bakgrunn() -> tauri::ActivationPolicy {
    tauri::ActivationPolicy::Prohibited
}

/* ---------- vakthunden ---------- */

/// Henger kjøringen, avsluttes prosessen. Men har brukeren åpnet appen
/// underveis (Dock-klikk), er prosessen blitt brukerens, og da skal
/// vakthunden la den være.
pub fn start_vakthund(
    etter: Duration,
    brukeren_har_overtatt: impl Fn() -> bool + Send + 'static,
    avslutt: impl FnOnce() + Send + 'static,
) {
    std::thread::spawn(move || {
        std::thread::sleep(etter);
        if brukeren_har_overtatt() {
            logg("vakthunden: appen er åpnet av brukeren, lar den stå");
            return;
        }
        logg(&format!("vakthunden: ikke ferdig etter {} s, avslutter", etter.as_secs()));
        avslutt();
    });
}

static OVERTATT: AtomicBool = AtomicBool::new(false);

pub fn brukeren_har_overtatt() -> bool {
    OVERTATT.load(Ordering::SeqCst)
}

/* ---------- loggen ---------- */

fn loggfil() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("HOME")?).join("Library/Logs/Hired/radar.log"))
}

fn logg_til(sti: &Path, melding: &str) {
    if let Some(dir) = sti.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    /* Én generasjon er nok: loggen er til å se hva siste kjøringer gjorde. */
    if std::fs::metadata(sti).map(|m| m.len() > MAKS_LOGG).unwrap_or(false) {
        let _ = std::fs::rename(sti, sti.with_extension("log.1"));
    }
    let tid = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(sti) {
        let _ = writeln!(f, "{tid} pid={} {melding}", std::process::id());
    }
}

pub fn logg(melding: &str) {
    if let Some(sti) = loggfil() {
        logg_til(&sti, melding);
    }
}

/* ---------- vinduene ---------- */

/// Det skjulte vinduet som kjører kjernen.
pub fn start(app: &AppHandle) -> tauri::Result<()> {
    start_vakthund(VAKTHUNDTID, brukeren_har_overtatt, || std::process::exit(3));
    WebviewWindowBuilder::new(app, RADARVINDU, WebviewUrl::App(SIDE.into()))
        .title("Radar")
        .visible(false)
        .focused(false)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .build()?;
    Ok(())
}

/// Hovedvinduet fra konfigurasjonen, der det står med `create: false`.
pub fn lag_hovedvindu(app: &AppHandle) -> tauri::Result<()> {
    if let Some(v) = app.get_webview_window(HOVEDVINDU) {
        v.show()?;
        v.set_focus()?;
        return Ok(());
    }
    let konfig = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == HOVEDVINDU)
        .cloned()
        .expect("hovedvinduet mangler i tauri.conf.json");
    WebviewWindowBuilder::from_config(app, &konfig)?.build()?;
    Ok(())
}

/// Brukeren klikket på appen i Dock mens Radar kjørte. Da blir prosessen en
/// vanlig app med et vanlig vindu; Radar-siden får fullføre.
#[cfg(target_os = "macos")]
pub fn ved_gjenåpning(app: &AppHandle) {
    if app.get_webview_window(HOVEDVINDU).is_some() {
        return;
    }
    OVERTATT.store(true, Ordering::SeqCst);
    logg("Dock-klikk under kjøringen: åpner hovedvinduet");
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Err(e) = lag_hovedvindu(app) {
        logg(&format!("hovedvinduet kunne ikke åpnes: {e}"));
    }
}

/* ---------- kommandoene ---------- */

#[tauri::command]
pub fn radar_profiler() -> Vec<String> {
    profiler_i_kjøring().cloned().unwrap_or_default()
}

#[tauri::command]
pub fn radar_logg(melding: String) {
    let kort: String = melding.chars().take(2000).collect();
    logg(&format!("side: {kort}"));
}

/// Ferdig. Er hovedvinduet åpnet underveis, lukkes bare det skjulte
/// vinduet; ellers hadde vi tatt vinduet fra brukeren.
#[tauri::command]
pub fn radar_ferdig(app: AppHandle, kode: i32) {
    if app.get_webview_window(HOVEDVINDU).is_some() {
        logg("ferdig, men hovedvinduet er åpent: lukker bare radarvinduet");
        if let Some(v) = app.get_webview_window(RADARVINDU) {
            let _ = v.close();
        }
        return;
    }
    logg(&format!("ferdig, kode {kode}"));
    app.exit(kode);
}

#[cfg(test)]
mod tester {
    use super::*;
    use std::sync::atomic::AtomicU32;
    use std::sync::Arc;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }
    fn ider(a: &[&str]) -> Vec<String> {
        args(a)
    }

    #[test]
    fn agenten_starter_appen_med_radarflagget_hver_time() {
        let p = agentplist(Path::new("/Applications/Hired & co.app/Contents/MacOS/jobbsoknader"));
        assert!(p.contains("<string>no.nordli.jobbsoknader.radar</string>"));
        assert!(p.contains("<string>/Applications/Hired &amp; co.app/Contents/MacOS/jobbsoknader</string>"));
        assert!(p.contains("<string>--radar</string>"));
        assert!(p.contains("<key>StartInterval</key>\n  <integer>3600</integer>"));
        assert!(p.contains("<key>ProcessType</key>\n  <string>Background</string>"));
        assert!(!p.contains("RunAtLoad"), "Radar skal ikke kjøre hver gang agenten lastes");
        assert_ne!(agentetikett(), varsel::agentetikett(), "to agenter, to etiketter");
    }

    #[test]
    fn vanlig_start_er_vanlig_uansett_hva_radar_sier() {
        assert_eq!(velg_modus(&args(&["hired"]), ider(&["a"]), false), Modus::Vanlig);
        assert_eq!(velg_modus(&args(&["hired", "--sjekk-frister"]), vec![], true), Modus::Vanlig);
    }

    #[test]
    fn radar_avslutter_straks_uten_profiler_eller_når_appen_er_åpen() {
        let a = args(&["hired", "--radar"]);
        assert_eq!(velg_modus(&a, vec![], false), Modus::Avslutt("ingen profil har Radar på"));
        assert_eq!(velg_modus(&a, ider(&["a"]), true), Modus::Avslutt("appen er alt åpen"));
        assert_eq!(velg_modus(&a, vec![], true), Modus::Avslutt("appen er alt åpen"));
    }

    #[test]
    fn radar_kjører_for_profilene_som_har_det_på() {
        let a = args(&["hired", "--radar"]);
        assert_eq!(velg_modus(&a, ider(&["a", "b"]), false), Modus::Radar(ider(&["a", "b"])));
    }

    fn rot(merke: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("jobber-radar-bakgrunn-{merke}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn profil(rot: &Path, id: &str, radar: Option<&str>) {
        let dir = rot.join("brukere").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        if let Some(r) = radar {
            std::fs::write(dir.join("radar.json"), r).unwrap();
        }
    }

    #[test]
    fn bare_profiler_med_radar_på_blir_med() {
        let r = rot("profiler");
        std::fs::write(
            r.join("brukere.json"),
            r#"{"brukere":[{"id":"aaaaaaaaaaaaaaaa"},{"id":"bbbbbbbbbbbbbbbb"},{"id":"cccccccccccccccc"},{"id":"dddddddddddddddd"},{"id":"eeeeeeeeeeeeeeee"},{"id":"ffffffffffffffff"}]}"#,
        )
        .unwrap();
        profil(&r, "aaaaaaaaaaaaaaaa", Some(r#"{"innstillinger":{"pa":true}}"#));
        profil(&r, "bbbbbbbbbbbbbbbb", Some(r#"{"innstillinger":{"pa":false}}"#));
        profil(&r, "cccccccccccccccc", None); /* aldri brukt Radar */
        profil(&r, "dddddddddddddddd", Some("ikke json"));
        profil(&r, "eeeeeeeeeeeeeeee", Some(r#"{"innstillinger":{"pa":"true"}}"#)); /* feil type: av */
        profil(&r, "ffffffffffffffff", Some(r#"{"innstillinger":{"pa":true}}"#));

        assert_eq!(profiler_med_radar(&r), ider(&["aaaaaaaaaaaaaaaa", "ffffffffffffffff"]));
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn uten_register_er_det_ingen_profiler() {
        let r = rot("uten-register");
        assert!(profiler_med_radar(&r).is_empty());
        let _ = std::fs::remove_dir_all(&r);
    }

    #[test]
    fn vakthunden_avslutter_når_ingen_har_overtatt() {
        let avsluttet = Arc::new(AtomicU32::new(0));
        let a = avsluttet.clone();
        start_vakthund(Duration::from_millis(30), || false, move || {
            a.fetch_add(1, Ordering::SeqCst);
        });
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(avsluttet.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn vakthunden_lar_en_app_brukeren_har_åpnet_stå() {
        let avsluttet = Arc::new(AtomicU32::new(0));
        let a = avsluttet.clone();
        start_vakthund(Duration::from_millis(30), || true, move || {
            a.fetch_add(1, Ordering::SeqCst);
        });
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(avsluttet.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn vakthunden_er_ti_minutter() {
        assert_eq!(VAKTHUNDTID, Duration::from_secs(600));
    }

    #[test]
    fn loggen_vokser_ikke_uten_grense() {
        let r = rot("logg");
        let sti = r.join("Logs/Hired/radar.log");
        logg_til(&sti, "første");
        assert!(std::fs::read_to_string(&sti).unwrap().contains("første"));
        std::fs::write(&sti, "x".repeat(MAKS_LOGG as usize + 1)).unwrap();
        logg_til(&sti, "etter rotasjon");
        let ny = std::fs::read_to_string(&sti).unwrap();
        assert!(ny.contains("etter rotasjon") && ny.len() < 200, "ny logg: {ny}");
        assert!(sti.with_extension("log.1").exists());
        let _ = std::fs::remove_dir_all(&r);
    }
}
