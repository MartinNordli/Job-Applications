/* ============================================================
   Fristvarsel — systemvarselet øverst til høyre, også når appen
   er lukket.

   Regelen og ordene er en kopi av src/fristvarsel.mjs. Kopien finnes
   fordi bakgrunnsjobben kjører uten et webview og dermed uten
   JavaScript. Endres noe der, endres det her; testene nederst bruker
   de samme tilfellene som server/fristvarsel.test.mjs.

   To veier inn, én vei ut:
     • appen kaller `sjekk_frister` ved oppstart, etter lagring og ved
       døgnskiftet, for profilen som er innlogget;
     • launchd starter binæren med `--sjekk-frister` kl. 09 og ved
       innlogging, og da sjekkes alle profilene på maskinen.
   Begge går gjennom `sjekk_katalog`, og begge fører varslet.json, så
   en frist varsles én gang uansett hvem som så den først.
   ============================================================ */

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{Datelike, Local, NaiveDate};
use serde_json::Value;

use crate::{bruker_katalog_i, les_i, skriv_i};

/// Appens identifikator, som i tauri.conf.json. Datakatalogen,
/// varselets avsender og LaunchAgent-etiketten henger alle på den.
pub const IDENTIFIKATOR: &str = "no.nordli.jobbsoknader";
pub const ARGUMENT: &str = "--sjekk-frister";

const INNSTILLINGSFIL: &str = "varsel.json";
const LOGGFIL: &str = "varslet.json";
const REGISTERFIL: &str = "brukere.json";
const JOBBFIL: &str = "jobber.json";
const MIN_DAGER: i64 = 1;
const MAKS_DAGER: i64 = 14;

#[derive(Debug, Clone, PartialEq)]
pub struct Innstilling {
    pub på: bool,
    pub dager_før: i64,
}

impl Default for Innstilling {
    fn default() -> Self {
        Innstilling { på: true, dager_før: 1 }
    }
}

/// Raus, som lesInnstilling i JavaScript: en rar fil gir standarden,
/// aldri et stille avslått varsel.
pub fn les_innstilling(rå: Option<&str>) -> Innstilling {
    let Some(v) = rå.and_then(|t| serde_json::from_str::<Value>(t).ok()) else {
        return Innstilling::default();
    };
    match (v.get("på").and_then(Value::as_bool), v.get("dagerFør").and_then(Value::as_i64)) {
        (Some(på), Some(d)) if (MIN_DAGER..=MAKS_DAGER).contains(&d) => Innstilling { på, dager_før: d },
        _ => Innstilling::default(),
    }
}

pub type Logg = BTreeMap<String, String>;

pub fn les_logg(rå: Option<&str>) -> Logg {
    let Some(Value::Object(o)) = rå.and_then(|t| serde_json::from_str::<Value>(t).ok()) else {
        return Logg::new();
    };
    o.into_iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string())))
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct Varsel {
    pub id: String,
    pub dager: i64,
    pub tittel: String,
    pub tekst: String,
}

fn iso(t: &str) -> Option<NaiveDate> {
    /* Strengere enn parse_from_str alene: «2026-1-5» er ikke en
       gyldig frist i datafilen, og skal ikke bli det her heller. */
    if t.len() != 10 {
        return None;
    }
    NaiveDate::parse_from_str(t, "%Y-%m-%d").ok()
}

const UKEDAGER: [&str; 7] = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
const MÅNEDER: [&str; 12] = [
    "januar", "februar", "mars", "april", "mai", "juni", "juli",
    "august", "september", "oktober", "november", "desember",
];

pub fn varseltekst(selskap: &str, stilling: &str, frist: NaiveDate, dager: i64) -> (String, String) {
    let når = match dager {
        0 => "Frist i dag".to_string(),
        1 => "Frist i morgen".to_string(),
        n => format!("Frist om {n} dager"),
    };
    let lang = format!(
        "{} {}. {}",
        UKEDAGER[frist.weekday().num_days_from_sunday() as usize],
        frist.day(),
        MÅNEDER[frist.month0() as usize]
    );
    let stilling = stilling.trim();
    let tekst = if stilling.is_empty() {
        format!("Søknadsfristen er {lang}.")
    } else {
        format!("{stilling} · søknadsfristen er {lang}.")
    };
    (format!("{når}: {}", selskap.trim()), tekst)
}

fn nøkkel(id: &str, frist: &str) -> String {
    format!("{id}|{frist}")
}

/// Søknadene som skal varsles nå, nærmeste frist først.
pub fn forfalne(jobber: &[Value], i_dag: NaiveDate, inn: &Innstilling, logg: &Logg) -> Vec<(String, Varsel)> {
    if !inn.på {
        return Vec::new();
    }
    let tekst = |j: &Value, f: &str| j.get(f).and_then(Value::as_str).unwrap_or("").to_string();
    let mut ut: Vec<(String, String, Varsel)> = jobber
        .iter()
        .filter(|j| j.get("status").and_then(Value::as_str) == Some("todo"))
        .filter_map(|j| {
            let id = j.get("id")?.as_str()?.to_string();
            let frist_t = j.get("frist")?.as_str()?;
            let frist = iso(frist_t)?;
            let dager = (frist - i_dag).num_days();
            let n = nøkkel(&id, frist_t);
            if dager < 0 || dager > inn.dager_før || logg.contains_key(&n) {
                return None;
            }
            let selskap = tekst(j, "selskap");
            let (tittel, t) = varseltekst(&selskap, &tekst(j, "stilling"), frist, dager);
            Some((n, selskap, Varsel { id, dager, tittel, tekst: t }))
        })
        .collect();
    ut.sort_by(|a, b| a.2.dager.cmp(&b.2.dager).then_with(|| a.1.cmp(&b.1)));
    ut.into_iter().map(|(n, _, v)| (n, v)).collect()
}

/// Rader for frister som er passert, trengs ikke lenger.
pub fn rydd_logg(logg: &Logg, i_dag: NaiveDate) -> Logg {
    logg.iter()
        .filter(|(n, _)| {
            n.rsplit('|').next().and_then(iso).is_some_and(|f| f >= i_dag)
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// Det som faktisk viser varselet. Et trekk, så testene kan sjekke
/// hva som ville blitt sendt uten å fylle skjermen med varsler.
pub trait Avsender {
    fn send(&self, v: &Varsel) -> Result<(), String>;
}

/// Én runde for én profilkatalog. Bare varsler som faktisk ble sendt
/// føres i loggen; feiler avsenderen, prøves de igjen neste gang.
fn sjekk_profil(dir: &Path, i_dag: NaiveDate, nå: &str, avsender: &dyn Avsender) -> Result<usize, String> {
    let jobber = match les_i(dir, JOBBFIL)?.and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        Some(Value::Object(o)) => match o.get("jobber") {
            Some(Value::Array(a)) => a.clone(),
            _ => return Ok(0),
        },
        _ => return Ok(0),
    };
    let inn = les_innstilling(les_i(dir, INNSTILLINGSFIL)?.as_deref());
    let logg = les_logg(les_i(dir, LOGGFIL)?.as_deref());

    let mut ny = rydd_logg(&logg, i_dag);
    let mut sendt = 0;
    for (n, v) in forfalne(&jobber, i_dag, &inn, &logg) {
        match avsender.send(&v) {
            Ok(()) => {
                ny.insert(n, nå.to_string());
                sendt += 1;
            }
            Err(e) => eprintln!("varselet for {} ble ikke sendt: {e}", v.id),
        }
    }
    if sendt > 0 || ny.len() != logg.len() {
        let tekst = serde_json::to_string_pretty(&ny).map_err(|e| e.to_string())? + "\n";
        skriv_i(dir, LOGGFIL, &tekst, None)?;
    }
    Ok(sendt)
}

/// Profilene i registeret. Id-ene går gjennom bruker_katalog_i, som
/// er stedet en sti blir til og stedet den sjekkes.
fn profiler(rot: &Path) -> Result<Vec<String>, String> {
    let Some(Value::Object(reg)) = les_i(rot, REGISTERFIL)?.and_then(|t| serde_json::from_str(&t).ok()) else {
        return Ok(Vec::new());
    };
    Ok(reg
        .get("brukere")
        .and_then(Value::as_array)
        .map(|b| b.iter().filter_map(|u| u.get("id")?.as_str().map(str::to_string)).collect())
        .unwrap_or_default())
}

/* To sjekker skal aldri lese den samme loggen samtidig: begge ville
   sett en logg uten varselet og begge sendt det. Det skjer i praksis,
   ikke bare i teorien. Når appen installerer agenten, kjører launchd
   den med en gang (RunAtLoad), i samme sekund som appen selv sjekker
   ved oppstart. Derfor en lås i prosessen og en fillås mellom
   prosessene. Låsen slippes når filen lukkes, også om prosessen dør. */
static KØ: Mutex<()> = Mutex::new(());
const LÅSEFIL: &str = ".varsel.lock";

struct Fillås(#[allow(dead_code)] std::fs::File);

fn lås_katalog(rot: &Path) -> Result<Fillås, String> {
    std::fs::create_dir_all(rot).map_err(|e| format!("kunne ikke lage {}: {e}", rot.display()))?;
    let f = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(rot.join(LÅSEFIL))
        .map_err(|e| format!("kunne ikke åpne låsen: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(format!("kunne ikke låse: {}", std::io::Error::last_os_error()));
        }
    }
    Ok(Fillås(f))
}

/// `bare` = én profil (appen), `None` = alle (bakgrunnsjobben).
pub fn sjekk_katalog(
    rot: &Path,
    bare: Option<&str>,
    i_dag: NaiveDate,
    nå: &str,
    avsender: &dyn Avsender,
) -> Result<usize, String> {
    let _lås = KØ.lock().unwrap_or_else(|e| e.into_inner());
    let _fillås = lås_katalog(rot)?;
    let ider = match bare {
        Some(id) => vec![id.to_string()],
        None => profiler(rot)?,
    };
    let mut sum = 0;
    for id in ider {
        match bruker_katalog_i(rot, Some(&id)).and_then(|dir| sjekk_profil(&dir, i_dag, nå, avsender)) {
            Ok(n) => sum += n,
            /* Én ødelagt profil skal ikke stoppe varslene til de andre. */
            Err(e) => eprintln!("hoppet over profilen {id}: {e}"),
        }
    }
    Ok(sum)
}

/* ------------------------------------------------------------
   Selve varselet, i macOS sitt varselsenter.
   ------------------------------------------------------------ */

pub struct Varselsenter;

impl Varselsenter {
    pub fn ny() -> Self {
        /* Uten dette sender biblioteket på vegne av Finder. Med appens
           egen identifikator står varselet som «Hired», med ikonet.
           Feilen når den alt er satt, er ingen feil. */
        #[cfg(target_os = "macos")]
        let _ = mac_notification_sys::set_application(IDENTIFIKATOR);
        Varselsenter
    }
}

impl Avsender for Varselsenter {
    #[cfg(target_os = "macos")]
    fn send(&self, v: &Varsel) -> Result<(), String> {
        mac_notification_sys::send_notification(&v.tittel, None, &v.tekst, None)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    #[cfg(not(target_os = "macos"))]
    fn send(&self, _v: &Varsel) -> Result<(), String> {
        Err("systemvarsler finnes bare på macOS".into())
    }
}

fn nå_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Bakgrunnsjobben: alle profilene, uten vindu.
pub fn kjør_i_bakgrunnen() -> Result<usize, String> {
    let hjem = std::env::var_os("HOME").ok_or("HOME er ikke satt")?;
    let rot = PathBuf::from(hjem).join("Library/Application Support").join(IDENTIFIKATOR);
    sjekk_katalog(&rot, None, Local::now().date_naive(), &nå_iso(), &Varselsenter::ny())
}

/// Appen: bare profilen som er innlogget.
pub fn kjør_for(rot: &Path, bruker: &str) -> Result<usize, String> {
    sjekk_katalog(rot, Some(bruker), Local::now().date_naive(), &nå_iso(), &Varselsenter::ny())
}

/* ------------------------------------------------------------
   LaunchAgent: det som får varselet til å komme når appen er lukket.

   Appen skriver den selv ved oppstart, med stien til sin egen binær.
   Flyttes appen, skrives den på nytt neste gang appen åpnes. launchd
   tar igjen en kjøring den gikk glipp av mens Macen sov, og RunAtLoad
   dekker innlogging etter at den var slått av.
   ------------------------------------------------------------ */

pub fn agentetikett() -> String {
    format!("{IDENTIFIKATOR}.fristvarsel")
}

fn xml(t: &str) -> String {
    t.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

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
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
"#,
        xml(&agentetikett()),
        xml(&exe.to_string_lossy())
    )
}

/// Bare en ferdig pakket app i en fast mappe skal installere agenten.
/// `tauri dev` og en binær rett fra target/ ville pekt agenten på noe
/// som forsvinner, og en app macOS har flyttet til en tilfeldig mappe
/// (App Translocation, når den åpnes rett fra Nedlastinger) likeså.
pub fn bør_installere(exe: &Path) -> bool {
    let s = exe.to_string_lossy();
    !cfg!(debug_assertions) && s.contains(".app/Contents/MacOS/") && !s.contains("/AppTranslocation/")
}

#[cfg(target_os = "macos")]
pub fn installer_agent() -> Result<(), String> {
    use std::process::Command;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if !bør_installere(&exe) {
        return Ok(());
    }
    let hjem = std::env::var_os("HOME").ok_or("HOME er ikke satt")?;
    let katalog = PathBuf::from(hjem).join("Library/LaunchAgents");
    let sti = katalog.join(format!("{}.plist", agentetikett()));
    let innhold = agentplist(&exe);
    if std::fs::read_to_string(&sti).ok().as_deref() == Some(innhold.as_str()) {
        return Ok(());
    }
    std::fs::create_dir_all(&katalog).map_err(|e| e.to_string())?;
    std::fs::write(&sti, &innhold).map_err(|e| e.to_string())?;

    /* Ut med den gamle (finnes den ikke, er feilen uten betydning),
       inn med den nye. */
    let domene = format!("gui/{}", unsafe { libc::getuid() });
    let _ = Command::new("/bin/launchctl")
        .args(["bootout", &format!("{domene}/{}", agentetikett())])
        .output();
    let ut = Command::new("/bin/launchctl")
        .args(["bootstrap", &domene, &sti.to_string_lossy()])
        .output()
        .map_err(|e| e.to_string())?;
    if !ut.status.success() {
        return Err(format!("launchctl bootstrap: {}", String::from_utf8_lossy(&ut.stderr).trim()));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn installer_agent() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tester {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;

    /* Samme tilfeller som server/fristvarsel.test.mjs. */
    fn dag(t: &str) -> NaiveDate {
        iso(t).unwrap()
    }
    const PÅ: Innstilling = Innstilling { på: true, dager_før: 1 };

    fn jobb(id: &str, frist: &str, status: &str) -> Value {
        json!({ "id": id, "selskap": "Aker BP", "stilling": "ML Engineer", "frist": frist, "status": status })
    }
    fn ider(l: &[(String, Varsel)]) -> Vec<String> {
        l.iter().map(|(_, v)| v.id.clone()).collect()
    }

    #[test]
    fn grensene() {
        let i_dag = dag("2026-10-04");
        let jobber = [
            jobb("i-dag", "2026-10-04", "todo"),
            jobb("om-3", "2026-10-07", "todo"),
            jobb("om-4", "2026-10-08", "todo"),
            jobb("i-går", "2026-10-03", "todo"),
            jobb("sendt", "2026-10-05", "sent"),
            json!({ "id": "løpende", "frist": null, "status": "todo" }),
        ];
        let tre = Innstilling { på: true, dager_før: 3 };
        assert_eq!(ider(&forfalne(&jobber, i_dag, &tre, &Logg::new())), ["i-dag", "om-3"]);
        assert_eq!(ider(&forfalne(&jobber, i_dag, &PÅ, &Logg::new())), ["i-dag"]);
        let av = Innstilling { på: false, dager_før: 14 };
        assert!(forfalne(&jobber, i_dag, &av, &Logg::new()).is_empty());
    }

    #[test]
    fn loggen_og_en_flyttet_frist() {
        let i_dag = dag("2026-10-04");
        let logg: Logg = [("a1|2026-10-05".to_string(), "t".to_string())].into();
        assert!(forfalne(&[jobb("a1", "2026-10-05", "todo")], i_dag, &PÅ, &logg).is_empty());
        assert_eq!(ider(&forfalne(&[jobb("a1", "2026-10-04", "todo")], i_dag, &PÅ, &logg)), ["a1"]);

        let gammel: Logg = [("x|2026-09-01".into(), "t".into()), ("y|2026-10-04".into(), "t".into())].into();
        assert_eq!(rydd_logg(&gammel, i_dag).keys().collect::<Vec<_>>(), ["y|2026-10-04"]);
    }

    #[test]
    fn ordene() {
        assert_eq!(
            varseltekst("Aker BP", "ML Engineer", dag("2026-10-05"), 1),
            ("Frist i morgen: Aker BP".into(), "ML Engineer · søknadsfristen er mandag 5. oktober.".into())
        );
        assert_eq!(varseltekst("Aker BP", "", dag("2026-10-04"), 0).0, "Frist i dag: Aker BP");
        assert_eq!(varseltekst("Aker BP", "", dag("2026-10-07"), 3).0, "Frist om 3 dager: Aker BP");
        assert_eq!(varseltekst("Aker BP", " ", dag("2026-10-05"), 1).1, "Søknadsfristen er mandag 5. oktober.");
    }

    #[test]
    fn innstillingen_leses_raust() {
        assert_eq!(les_innstilling(None), Innstilling::default());
        assert_eq!(les_innstilling(Some("{ikke json")), Innstilling::default());
        assert_eq!(les_innstilling(Some(r#"{"på":true,"dagerFør":99}"#)), Innstilling::default());
        assert_eq!(
            les_innstilling(Some(r#"{"versjon":1,"på":false,"dagerFør":3}"#)),
            Innstilling { på: false, dager_før: 3 }
        );
        assert!(les_logg(Some("[1,2]")).is_empty());
    }

    struct Opptak(RefCell<Vec<String>>, bool);
    impl Avsender for Opptak {
        fn send(&self, v: &Varsel) -> Result<(), String> {
            if self.1 {
                return Err("nektet".into());
            }
            self.0.borrow_mut().push(v.tittel.clone());
            Ok(())
        }
    }

    fn katalog(merke: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("varsel-rust-test-{merke}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn profil(rot: &Path, id: &str, jobber: Value, innstilling: Option<&str>) {
        let dir = rot.join("brukere").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(JOBBFIL), json!({ "versjon": 1, "jobber": jobber }).to_string()).unwrap();
        if let Some(i) = innstilling {
            std::fs::write(dir.join(INNSTILLINGSFIL), i).unwrap();
        }
    }

    #[test]
    fn bakgrunnen_går_gjennom_alle_profilene_og_varsler_én_gang() {
        let rot = katalog("alle");
        std::fs::write(
            rot.join(REGISTERFIL),
            json!({ "versjon": 1, "brukere": [{ "id": "aaaaaaaaaaaaaaaa" }, { "id": "bbbbbbbbbbbbbbbb" }, { "id": "../ut" }] }).to_string(),
        )
        .unwrap();
        profil(&rot, "aaaaaaaaaaaaaaaa", json!([jobb("a1", "2026-10-05", "todo")]), None);
        profil(&rot, "bbbbbbbbbbbbbbbb", json!([jobb("b1", "2026-10-07", "todo")]),
               Some(r#"{"versjon":1,"på":true,"dagerFør":3}"#));

        let opptak = Opptak(RefCell::new(Vec::new()), false);
        let i_dag = dag("2026-10-04");
        assert_eq!(sjekk_katalog(&rot, None, i_dag, "T", &opptak).unwrap(), 2);
        assert_eq!(*opptak.0.borrow(), ["Frist i morgen: Aker BP", "Frist om 3 dager: Aker BP"]);

        /* Andre runde: alt står i loggen. */
        assert_eq!(sjekk_katalog(&rot, None, i_dag, "T", &opptak).unwrap(), 0);
        let logg = std::fs::read_to_string(rot.join("brukere/aaaaaaaaaaaaaaaa").join(LOGGFIL)).unwrap();
        assert_eq!(les_logg(Some(&logg)).keys().collect::<Vec<_>>(), ["a1|2026-10-05"]);

        /* Appen sjekker bare sin egen profil. */
        profil(&rot, "bbbbbbbbbbbbbbbb", json!([jobb("b2", "2026-10-05", "todo")]), None);
        profil(&rot, "aaaaaaaaaaaaaaaa", json!([jobb("a2", "2026-10-05", "todo")]), None);
        assert_eq!(sjekk_katalog(&rot, Some("aaaaaaaaaaaaaaaa"), i_dag, "T", &opptak).unwrap(), 1);
        let _ = std::fs::remove_dir_all(&rot);
    }

    #[test]
    fn et_varsel_som_ikke_ble_sendt_prøves_igjen() {
        let rot = katalog("nektet");
        profil(&rot, "aaaaaaaaaaaaaaaa", json!([jobb("a1", "2026-10-05", "todo")]), None);
        let nekter = Opptak(RefCell::new(Vec::new()), true);
        let i_dag = dag("2026-10-04");
        assert_eq!(sjekk_katalog(&rot, Some("aaaaaaaaaaaaaaaa"), i_dag, "T", &nekter).unwrap(), 0);
        assert!(!rot.join("brukere/aaaaaaaaaaaaaaaa").join(LOGGFIL).exists());
        let opptak = Opptak(RefCell::new(Vec::new()), false);
        assert_eq!(sjekk_katalog(&rot, Some("aaaaaaaaaaaaaaaa"), i_dag, "T", &opptak).unwrap(), 1);
        let _ = std::fs::remove_dir_all(&rot);
    }

    #[test]
    fn fillåsen_holder_en_annen_ute_til_den_slippes() {
        use std::os::fd::AsRawFd;
        let rot = katalog("lås");
        let første = lås_katalog(&rot).unwrap();
        /* En annen åpning av filen, som i en annen prosess. */
        let annen = std::fs::OpenOptions::new().write(true).open(rot.join(LÅSEFIL)).unwrap();
        let prøv = || unsafe { libc::flock(annen.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        assert_ne!(prøv(), 0, "låsen skulle vært tatt");
        drop(første);
        assert_eq!(prøv(), 0, "låsen skulle vært sluppet");
        let _ = std::fs::remove_dir_all(&rot);
    }

    #[test]
    fn agenten_peker_på_appen_selv() {
        let p = agentplist(Path::new("/Applications/Hired & co.app/Contents/MacOS/jobbsoknader"));
        assert!(p.contains("<string>no.nordli.jobbsoknader.fristvarsel</string>"));
        assert!(p.contains("<string>/Applications/Hired &amp; co.app/Contents/MacOS/jobbsoknader</string>"));
        assert!(p.contains("<string>--sjekk-frister</string>"));
        assert!(p.contains("<key>RunAtLoad</key>\n  <true/>"));

        let pakket = Path::new("/Applications/Hired.app/Contents/MacOS/jobbsoknader");
        assert_eq!(bør_installere(pakket), !cfg!(debug_assertions));
        assert!(!bør_installere(Path::new("/x/target/release/jobbsoknader")));
        assert!(!bør_installere(Path::new("/private/var/folders/x/AppTranslocation/y/Hired.app/Contents/MacOS/jobbsoknader")));
    }

    #[test]
    fn identifikatoren_er_den_samme_som_i_konfigurasjonen() {
        let konf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(konf["identifier"], IDENTIFIKATOR);
    }
}
