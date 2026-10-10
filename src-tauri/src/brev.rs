//! Avgrensede fil-, nøkkel- og nettoperasjoner for skriveverkstedet.
//! Samme mkdir-lås som Node; en gammel lås stjeles aldri på tid alene.
//! Operasjonene gjelder alle profildokumentene (cv.json, stil.json,
//! brev-<id>.json, jobb-<id>.json og radar.json), ikke bare brevene. Navneregelen og
//! utdraget er speilet fra src/dokumentnavn.mjs og src/dokumentutdrag.mjs,
//! og testdata/dokumenter.json holder de to sidene like.
use serde::Serialize;
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::Duration,
};
use tauri::{
    ipc::{Channel, JavaScriptChannelId},
    AppHandle, Manager, Webview,
};

const MAKS_DOKUMENT: usize = 32 * 1024 * 1024;
const MAKS_SVAR: usize = 2 * 1024 * 1024;
static TELLER: AtomicU64 = AtomicU64::new(0);

fn profil_i(rot: &Path, bruker: &str) -> Result<PathBuf, String> {
    if bruker.len() != 16 || !bruker.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("ugyldig-profil".into());
    }
    Ok(rot.join("brukere").join(bruker))
}

fn profil(app: &AppHandle, bruker: &str) -> Result<PathBuf, String> {
    profil_i(
        &app.path()
            .app_data_dir()
            .map_err(|_| "Finner ikke datakatalogen.")?,
        bruker,
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Dokumenttype {
    Cv,
    Stil,
    Brev,
    Jobb,
    Radar,
}

/// Prefiksene med id. Faste navn står i `dokumenttype`.
const MED_ID: [(&str, Dokumenttype); 2] =
    [("brev-", Dokumenttype::Brev), ("jobb-", Dokumenttype::Jobb)];

/// Bare ASCII-bokstaver, sifre, bindestrek og understrek. Ingen punktum,
/// så kopiene (`.forrige.json`, `.odelagt-*.json`) og «..» faller utenfor.
fn gyldig_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn dokumenttype(navn: &str) -> Option<Dokumenttype> {
    match navn {
        "cv.json" => return Some(Dokumenttype::Cv),
        "stil.json" => return Some(Dokumenttype::Stil),
        "radar.json" => return Some(Dokumenttype::Radar),
        _ => {}
    }
    MED_ID.iter().find_map(|(prefiks, type_)| {
        navn.strip_prefix(prefiks)
            .and_then(|s| s.strip_suffix(".json"))
            .filter(|id| gyldig_id(id))
            .map(|_| *type_)
    })
}

fn dokumentnavn(navn: &str) -> Result<&str, String> {
    dokumenttype(navn)
        .map(|_| navn)
        .ok_or_else(|| "ugyldig-filnavn".into())
}

fn backup(navn: &str) -> String {
    format!("{}.forrige.json", navn.trim_end_matches(".json"))
}

fn les(sti: &Path) -> Result<Option<String>, String> {
    if let Ok(m) = fs::metadata(sti) {
        if m.len() > MAKS_DOKUMENT as u64 {
            return Err("Dokumentet er for stort.".into());
        }
    }
    match fs::read_to_string(sti) {
        Ok(t) if t.len() <= MAKS_DOKUMENT => Ok(Some(t)),
        Ok(_) => Err("Dokumentet er for stort.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Fikk ikke lest dokumentet.".into()),
    }
}

fn markor(dir: &Path, navn: &str) -> Result<u64, String> {
    match les(&dir.join(format!(".{navn}.revisjon")))? {
        None => Ok(0),
        Some(t) => t
            .trim()
            .parse::<u64>()
            .map_err(|_| "ugyldig-revisjon".into()),
    }
}

/// Det tomme dokumentet etter en sletting, med revisjonen fra markøren.
/// CV, stilreferanse og brev får hele formen. Jobbdokumentet og radar.json får
/// bare skjema, revisjon og tidsstempel: valideringen i JavaScript fyller
/// inn resten, så formen deres står ett sted.
fn tomt_dokument(navn: &str, rev: u64) -> Result<String, String> {
    let mut v = serde_json::json!({"skjemaVersjon":1,"revisjon":rev,"oppdatert":null});
    match dokumenttype(navn).ok_or("ugyldig-filnavn")? {
        Dokumenttype::Cv => {
            v["tekst"] = "".into();
            v["navn"] = "".into();
            v["format"] = "tekst".into();
        }
        Dokumenttype::Stil => {
            v["tekst"] = "".into();
        }
        Dokumenttype::Brev => {
            let id = navn
                .strip_prefix("brev-")
                .and_then(|s| s.strip_suffix(".json"))
                .ok_or("ugyldig-filnavn")?;
            v["tekst"] = "".into();
            v["jobbId"] = id.into();
            v["leverandor"] = "anthropic".into();
            v["versjoner"] = serde_json::json!([]);
            v["aktivVersjon"] = Value::Null;
            v["annonse"] = serde_json::json!({"tekst":"","url":"","hentet":null});
            v["kontekst"] = "".into();
            v["sprak"] = "auto".into();
            v["kjoring"] = Value::Null;
        }
        Dokumenttype::Jobb | Dokumenttype::Radar => {}
    }
    Ok(v.to_string())
}

fn revisjon(tekst: &str) -> Result<u64, String> {
    let dok: Value = serde_json::from_str(tekst).map_err(|_| "odelagt")?;
    if !dok.is_object() {
        return Err("odelagt".into());
    }
    match dok.get("revisjon") {
        None => Ok(0),
        Some(v) => v.as_u64().ok_or_else(|| "odelagt".into()),
    }
}

struct Las(PathBuf);
impl Drop for Las {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}

fn laas(dir: &Path, navn: &str) -> Result<Las, String> {
    fs::create_dir_all(dir).map_err(|_| "Fikk ikke opprettet profilkatalogen.")?;
    let sti = dir.join(format!(".{navn}.las"));
    for forsok in 0..=10 {
        match fs::create_dir(&sti) {
            Ok(()) => return Ok(Las(sti)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if forsok == 10 {
                    return Err("opptatt".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return Err("Fikk ikke låst dokumentet.".into()),
        }
    }
    Err("opptatt".into())
}

fn atomisk(dir: &Path, navn: &str, tekst: &str) -> Result<(), String> {
    let n = TELLER.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".{navn}.{}.{n}.tmp", std::process::id()));
    let r = (|| -> std::io::Result<()> {
        let mut valg = OpenOptions::new();
        valg.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            valg.mode(0o600);
        }
        let mut f = valg.open(&tmp)?;
        f.write_all(tekst.as_bytes())?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, dir.join(navn))?;
        let _ = File::open(dir).and_then(|f| f.sync_all());
        Ok(())
    })();
    if r.is_err() {
        let _ = fs::remove_file(tmp);
    }
    r.map_err(|_| "Fikk ikke skrevet dokumentet.".into())
}

fn les_dokument(dir: &Path, navn: &str, forrige: bool) -> Result<Option<String>, String> {
    dokumentnavn(navn)?;
    let sti = dir.join(if forrige {
        backup(navn)
    } else {
        navn.to_owned()
    });
    let tekst = les(&sti)?;
    if let Some(t) = &tekst {
        revisjon(t)?;
    }
    if tekst.is_none() && !forrige && dir.join(backup(navn)).exists() {
        return Err("gjenoppretting".into());
    }
    if tekst.is_none() && !forrige {
        let n = markor(dir, navn)?;
        if n > 0 {
            return Ok(Some(tomt_dokument(navn, n)?));
        }
    }
    Ok(tekst)
}

fn skriv_dokument(dir: &Path, navn: &str, tekst: &str, forventet: u64) -> Result<String, String> {
    dokumentnavn(navn)?;
    if tekst.len() > MAKS_DOKUMENT {
        return Err("Dokumentet er for stort.".into());
    }
    if revisjon(tekst)? != forventet.checked_add(1).ok_or("ugyldig-revisjon")? {
        return Err("ugyldig-revisjon".into());
    }
    let _las = laas(dir, navn)?;
    let gammel = les_dokument(dir, navn, false)?;
    // Ikke overskriv en korrupt backup heller; brukeren må først ta stilling til den.
    if let Some(kopi) = les(&dir.join(backup(navn)))? {
        revisjon(&kopi)?;
    }
    let gjeldende = match &gammel {
        Some(t) => revisjon(t)?,
        None => 0,
    };
    if forventet != gjeldende {
        return Err("konflikt".into());
    }
    if dir.join(navn).exists() {
        if let Some(t) = gammel {
            atomisk(dir, &backup(navn), &t)?;
        }
    }
    atomisk(dir, navn, tekst)?;
    Ok(tekst.to_owned())
}

fn slett_dokument(dir: &Path, navn: &str, forventet: u64) -> Result<(), String> {
    dokumentnavn(navn)?;
    let _las = laas(dir, navn)?;
    let gjeldende = match les_dokument(dir, navn, false)? {
        Some(t) => revisjon(&t)?,
        None => 0,
    };
    if gjeldende != forventet {
        return Err("konflikt".into());
    }
    atomisk(
        dir,
        &format!(".{navn}.revisjon"),
        &gjeldende
            .checked_add(1)
            .ok_or("ugyldig-revisjon")?
            .to_string(),
    )?;
    for fil in [backup(navn), navn.to_owned()] {
        match fs::remove_file(dir.join(fil)) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err("Fikk ikke slettet dokumentet.".into()),
        }
    }
    let prefiks = format!("{}.odelagt-", navn.trim_end_matches(".json"));
    for inn in fs::read_dir(dir).map_err(|_| "Fikk ikke lest profilkatalogen.")? {
        let inn = inn.map_err(|_| "Fikk ikke lest profilkatalogen.")?;
        let n = inn.file_name().to_string_lossy().into_owned();
        if n.starts_with(&prefiks) && n.ends_with(".json") {
            fs::remove_file(inn.path()).map_err(|_| "Fikk ikke slettet gammel dokumentkopi.")?;
        }
    }
    Ok(())
}

fn gjenopprett_dokument(dir: &Path, navn: &str) -> Result<String, String> {
    dokumentnavn(navn)?;
    let _las = laas(dir, navn)?;
    let tekst = les(&dir.join(backup(navn)))?.ok_or("ingen-kopi")?;
    let kopi_rev = revisjon(&tekst)?;
    let mut dok: Value = serde_json::from_str(&tekst).map_err(|_| "odelagt")?;
    let main_rev = les(&dir.join(navn))?
        .and_then(|t| revisjon(&t).ok())
        .unwrap_or(0);
    let n = markor(dir, navn)?
        .max(main_rev)
        .max(kopi_rev.checked_add(1).ok_or("ugyldig-revisjon")?)
        .checked_add(1)
        .ok_or("ugyldig-revisjon")?;
    dok["revisjon"] = n.into();
    // Tidsstempel kommer fra klientens neste lagring. Selve gjenopprettingen
    // får alltid et nytt revisjonsnummer, også om den samme kopien velges igjen.
    let ny = dok.to_string();
    atomisk(dir, &format!(".{navn}.revisjon"), &n.to_string())?;
    if dir.join(navn).exists() {
        let tid = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "Ugyldig klokke.")?
            .as_millis();
        let kopi = format!(
            "{}.odelagt-{tid}-{}.json",
            navn.trim_end_matches(".json"),
            TELLER.fetch_add(1, Ordering::Relaxed)
        );
        fs::rename(dir.join(navn), dir.join(kopi))
            .map_err(|_| "Fikk ikke bevart det gamle dokumentet.")?;
    }
    atomisk(dir, navn, &ny)?;
    Ok(ny)
}

#[tauri::command]
pub fn brev_gjenopprett(app: AppHandle, bruker: String, navn: String) -> Result<String, String> {
    gjenopprett_dokument(&profil(&app, &bruker)?, &navn)
}

#[tauri::command]
pub fn brev_les(
    app: AppHandle,
    bruker: String,
    navn: String,
    forrige: Option<bool>,
) -> Result<Option<String>, String> {
    les_dokument(&profil(&app, &bruker)?, &navn, forrige.unwrap_or(false))
}

#[tauri::command]
pub fn brev_skriv(
    app: AppHandle,
    bruker: String,
    navn: String,
    tekst: String,
    forventet: u64,
) -> Result<String, String> {
    skriv_dokument(&profil(&app, &bruker)?, &navn, &tekst, forventet)
}

#[tauri::command]
pub fn brev_slett(
    app: AppHandle,
    bruker: String,
    navn: String,
    forventet: u64,
) -> Result<(), String> {
    slett_dokument(&profil(&app, &bruker)?, &navn, forventet)
}

fn liste_i(dir: &Path) -> Result<Vec<String>, String> {
    let leser = match fs::read_dir(dir) {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("Fikk ikke lest profilkatalogen.".into()),
    };
    let mut navn = Vec::new();
    for inn in leser {
        let inn = inn.map_err(|_| "Fikk ikke lest profilkatalogen.")?;
        let n = inn.file_name().to_string_lossy().into_owned();
        if dokumentnavn(&n).is_ok()
            && inn
                .file_type()
                .map_err(|_| "Fikk ikke lest filtypen.")?
                .is_file()
        {
            navn.push(n);
        }
    }
    navn.sort();
    Ok(navn)
}

#[tauri::command]
pub fn brev_liste(app: AppHandle, bruker: String) -> Result<Vec<String>, String> {
    liste_i(&profil(&app, &bruker)?)
}

/* ---------- utdrag ----------
Små verdier fra mange dokumenter, uten å sende dokumentene over IPC.
Reglene er de samme som i src/dokumentutdrag.mjs: 1 til 4 ledd per
sti, høyst 20 stier, bare egne nøkler, bare enkle verdier, tekst kortet
til 300 kodepunkter, og et dokument som ikke kan leses hoppes over. */

const MAKS_STIER: usize = 20;
/// Taket på listen før duplikatene er fjernet, så en enorm liste aldri
/// blir en kvadratisk løkke.
const MAKS_RÅ_STIER: usize = 100;
const MAKS_UTDRAGSTEKST: usize = 300;
/// Alle samlingene utdraget går over har skjemaversjon 1, som i
/// src/brevdata.mjs. Et dokument med et annet skjema forstår vi ikke.
const SAMLINGSSKJEMA: u64 = 1;

fn gyldig_sti(sti: &str) -> bool {
    let ledd: Vec<&str> = sti.split('.').collect();
    (1..=4).contains(&ledd.len())
        && ledd.iter().all(|l| {
            !l.is_empty()
                && l.len() <= 40
                && l.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
                && !matches!(*l, "__proto__" | "constructor" | "prototype")
        })
}

fn tolk_stier(stier: &[String]) -> Result<Vec<String>, String> {
    let feil = || {
        format!("ugyldig: Utdraget kan ha 1 til {MAKS_STIER} felt, skrevet som for eksempel match.prosent.")
    };
    if stier.len() > MAKS_RÅ_STIER {
        return Err(feil());
    }
    let mut ut: Vec<String> = Vec::new();
    for s in stier.iter().map(|s| s.trim()) {
        if !ut.iter().any(|x| x == s) {
            ut.push(s.to_owned());
        }
    }
    if ut.is_empty() || ut.len() > MAKS_STIER || !ut.iter().all(|s| gyldig_sti(s)) {
        return Err(feil());
    }
    Ok(ut)
}

fn enkel(v: &Value) -> Option<Value> {
    match v {
        Value::Null | Value::Bool(_) | Value::Number(_) => Some(v.clone()),
        Value::String(s) if s.chars().count() > MAKS_UTDRAGSTEKST => {
            Some(Value::String(s.chars().take(MAKS_UTDRAGSTEKST).collect()))
        }
        Value::String(_) => Some(v.clone()),
        _ => None,
    }
}

fn utdrag_av(dok: &Value, stier: &[String]) -> Map<String, Value> {
    let mut ut = Map::new();
    for sti in stier {
        let mut v = Some(dok);
        for ledd in sti.split('.') {
            v = v.and_then(Value::as_object).and_then(|o| o.get(ledd));
        }
        if let Some(e) = v.and_then(enkel) {
            ut.insert(sti.clone(), e);
        }
    }
    ut
}

type Utdrag = BTreeMap<String, Map<String, Value>>;

fn utdrag_i(dir: &Path, prefiks: &str, stier: &[String]) -> Result<Utdrag, String> {
    if !MED_ID.iter().any(|(p, _)| *p == prefiks) {
        return Err("ugyldig: Ukjent dokumentsamling.".into());
    }
    let felt = tolk_stier(stier)?;
    let mut ut = BTreeMap::new();
    for navn in liste_i(dir)?.into_iter().filter(|n| n.starts_with(prefiks)) {
        // For stort, uleselig, ikke JSON eller ukjent skjema: hoppes over.
        let Ok(Some(tekst)) = les(&dir.join(&navn)) else {
            continue;
        };
        let Ok(dok) = serde_json::from_str::<Value>(&tekst) else {
            continue;
        };
        if !dok.is_object()
            || dok.get("skjemaVersjon").and_then(Value::as_u64) != Some(SAMLINGSSKJEMA)
        {
            continue;
        }
        let utdrag = utdrag_av(&dok, &felt);
        ut.insert(navn, utdrag);
    }
    Ok(ut)
}

/// Kjøres utenfor hovedtråden: å lese og tolke et par hundre filer skal
/// ikke fryse vinduet mens listen tegnes.
#[tauri::command]
pub async fn dokument_utdrag(
    app: AppHandle,
    bruker: String,
    prefiks: String,
    stier: Vec<String>,
) -> Result<Utdrag, String> {
    let dir = profil(&app, &bruker)?;
    tauri::async_runtime::spawn_blocking(move || utdrag_i(&dir, &prefiks, &stier))
        .await
        .map_err(|_| "Fikk ikke lest dokumentene.".to_string())?
}

/// Modellene er knyttet til formålet (brev, vurdering, radar), og må være
/// de samme som i src/brev-provider.mjs. Frontenden velger modell i
/// kroppen; her godtas bare de som er oppført for leverandøren.
fn leverandor(navn: &str) -> Result<(&'static str, &'static str, &'static [&'static str]), String> {
    match navn {
        "anthropic" => Ok((
            "nokkel.txt",
            "https://api.anthropic.com/v1/messages",
            &["claude-opus-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
        )),
        "openai" => Ok((
            "nokkel-openai.txt",
            "https://api.openai.com/v1/responses",
            &["gpt-6-astra"],
        )),
        _ => Err("Ukjent modellleverandør.".into()),
    }
}

fn gyldig_nokkel(nokkel: &str) -> bool {
    (20..=500).contains(&nokkel.len()) && nokkel.bytes().all(|c| (0x21..=0x7e).contains(&c))
}

fn les_nokkel(dir: &Path, leverandor_navn: &str) -> Result<Option<String>, String> {
    let (navn, _, _) = leverandor(leverandor_navn)?;
    Ok(les(&dir.join(navn))?
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty()))
}

#[derive(Serialize)]
pub struct Nokkelstatus {
    finnes: bool,
    kilde: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    hale: Option<String>,
}

#[tauri::command]
pub fn brev_nokkel_status(
    app: AppHandle,
    bruker: String,
    leverandor: String,
) -> Result<Nokkelstatus, String> {
    let n = les_nokkel(&profil(&app, &bruker)?, &leverandor)?;
    let hale = n.as_ref().filter(|n| n.chars().count() >= 12).map(|n| {
        n.chars()
            .rev()
            .take(4)
            .collect::<String>()
            .chars()
            .rev()
            .collect()
    });
    Ok(Nokkelstatus {
        finnes: n.is_some(),
        kilde: if n.is_some() { "egen" } else { "ingen" },
        hale,
    })
}

#[tauri::command]
pub fn brev_nokkel_sett(
    app: AppHandle,
    bruker: String,
    leverandor: String,
    nokkel: String,
) -> Result<(), String> {
    let (navn, _, _) = self::leverandor(&leverandor)?;
    let n = nokkel.trim();
    if !gyldig_nokkel(n) {
        return Err("Nøkkelen må ha 20–500 tegn uten mellomrom eller kontrolltegn.".into());
    }
    let dir = profil(&app, &bruker)?;
    fs::create_dir_all(&dir).map_err(|_| "Fikk ikke opprettet profilkatalogen.")?;
    atomisk(&dir, navn, &format!("{n}\n"))
}

#[tauri::command]
pub fn brev_nokkel_slett(app: AppHandle, bruker: String, leverandor: String) -> Result<(), String> {
    let (navn, _, _) = self::leverandor(&leverandor)?;
    match fs::remove_file(profil(&app, &bruker)?.join(navn)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Fikk ikke fjernet API-nøkkelen.".into()),
    }
}

type Kall = HashMap<String, tokio::task::AbortHandle>;
static KALL: OnceLock<Mutex<Kall>> = OnceLock::new();
fn kall() -> &'static Mutex<Kall> {
    KALL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Én melding på kanalen: hele SSE-linjer, uten linjeskift. Frontenden legger
/// linjeskiftet tilbake når rammene settes sammen. Rust kjenner ikke Anthropics
/// eller OpenAIs hendelsesformat og skal ikke gjøre det: da måtte protokollen
/// vedlikeholdes to steder for alltid.
#[derive(Clone, Serialize)]
pub struct Linjer {
    linjer: Vec<String>,
}

/// Deler en byte-strøm i hele linjer. `\n` og `\r\n` behandles likt, og
/// linjeskiftet strippes. En komplett SSE-linje er per definisjon gyldig UTF-8,
/// så byte-grensen mellom to biter kan aldri dele et tegn i to.
struct Linjedeler {
    rest: Vec<u8>,
    lest: usize,
}

impl Linjedeler {
    fn ny() -> Self {
        Self {
            rest: Vec::new(),
            lest: 0,
        }
    }
    fn ta(&mut self, bit: &[u8]) -> Result<Vec<String>, String> {
        self.lest += bit.len();
        if self.lest > MAKS_SVAR {
            return Err("Modellen sendte et for stort svar.".into());
        }
        self.rest.extend_from_slice(bit);
        let mut ut = Vec::new();
        let mut start = 0;
        for i in 0..self.rest.len() {
            if self.rest[i] != b'\n' {
                continue;
            }
            let mut slutt = i;
            if slutt > start && self.rest[slutt - 1] == b'\r' {
                slutt -= 1;
            }
            ut.push(
                std::str::from_utf8(&self.rest[start..slutt])
                    .map_err(|_| "Modellen svarte i feil format.".to_string())?
                    .to_string(),
            );
            start = i + 1;
        }
        self.rest.drain(..start);
        Ok(ut)
    }
    /// En avsluttende linje uten linjeskift. SSE dispatcher den ikke, men den
    /// hører med i kroppen vi gir tilbake.
    fn slutt(&mut self) -> Option<String> {
        if self.rest.is_empty() {
            return None;
        }
        let mut linje = std::mem::take(&mut self.rest);
        if linje.last() == Some(&b'\r') {
            linje.pop();
        }
        String::from_utf8(linje).ok()
    }
}

/// Kroppen frontenden sender inn. Strømming er eneste transportvei: et kall
/// uten den ville gitt en annen feilsemantikk enn Node-siden har.
fn sjekk_modellkropp(leverandor: &str, modeller: &[&str], kropp: &str) -> Result<(), String> {
    if kropp.len() > 1024 * 1024 {
        return Err("Grunnlaget er for stort.".into());
    }
    let json: Value = serde_json::from_str(kropp).map_err(|_| "Ugyldig modellforespørsel.")?;
    if !json
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|m| modeller.contains(&m))
    {
        return Err("Ukjent modell.".into());
    }
    if json.get("stream").and_then(Value::as_bool) != Some(true) {
        return Err("Strømming må være påslått.".into());
    }
    if leverandor == "openai" && json.get("store").and_then(Value::as_bool) != Some(false) {
        return Err("Modellagring må være avslått.".into());
    }
    Ok(())
}

async fn modellkall(
    nokkel: String,
    url: &'static str,
    anthropic: bool,
    kropp: String,
    kanal: Option<Channel<Linjer>>,
) -> Result<String, String> {
    let klient = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Fikk ikke startet modelltjenesten.")?;
    let mut req = klient.post(url).header("content-type", "application/json");
    req = if anthropic {
        req.header("x-api-key", nokkel)
            .header("anthropic-version", "2023-06-01")
    } else {
        req.bearer_auth(nokkel)
    };
    let mut svar = req.body(kropp).send().await.map_err(|e| {
        if e.is_timeout() {
            "tidsavbrudd"
        } else {
            "Fikk ikke kontakt med modelltjenesten."
        }
    })?;
    if !svar.status().is_success() {
        return Err(match svar.status().as_u16() {
            401 | 403 => "nokkel: Leverandøren avviste API-nøkkelen.".into(),
            429 => "for-mange: Leverandøren har nådd en grense. Vent litt og prøv igjen.".into(),
            _ => format!(
                "Modelltjenesten svarte {}. Prøv igjen senere.",
                svar.status().as_u16()
            ),
        });
    }
    /* Linjene sendes videre med én gang, men samles også opp: svaret
    frontenden tolker er den returnerte kroppen, aldri kanalen. En tapt
    eller sen kanalmelding kan dermed ikke endre brevet. */
    let mut deler = Linjedeler::ny();
    let mut samlet = String::new();
    while let Some(bit) = svar
        .chunk()
        .await
        .map_err(|_| "Mistet kontakten med modelltjenesten.")?
    {
        let linjer = deler.ta(&bit)?;
        if linjer.is_empty() {
            continue;
        }
        for l in &linjer {
            samlet.push_str(l);
            samlet.push('\n');
        }
        if let Some(k) = &kanal {
            let _ = k.send(Linjer { linjer });
        }
    }
    if let Some(l) = deler.slutt() {
        samlet.push_str(&l);
        samlet.push('\n');
    }
    Ok(samlet)
}

#[tauri::command]
pub async fn brev_modell(
    app: AppHandle,
    webview: Webview,
    bruker: String,
    leverandor: String,
    kropp: String,
    kjoring_id: Option<String>,
    kanal: Option<JavaScriptChannelId>,
) -> Result<String, String> {
    // Channel selv kan ikke deserialiseres; ID-en kobles til webviewet her.
    // Uten kanal sendes ingen linjer, og et kall uten forhåndsvisning koster
    // dermed ingen IPC-trafikk.
    let kanal: Option<Channel<Linjer>> = kanal.map(|id| id.channel_on(webview));
    let dir = profil(&app, &bruker)?;
    let (_, url, modeller) = self::leverandor(&leverandor)?;
    sjekk_modellkropp(&leverandor, modeller, &kropp)?;
    let nokkel = les_nokkel(&dir, &leverandor)?
        .ok_or("mangler-nokkel: Legg til API-nøkkelen for valgt leverandør.")?;
    if !gyldig_nokkel(&nokkel) {
        return Err("nokkel: API-nøkkelen har ugyldig format.".into());
    }
    let id =
        kjoring_id.unwrap_or_else(|| format!("kall-{}", TELLER.fetch_add(1, Ordering::Relaxed)));
    if id.is_empty()
        || id.len() > 100
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("Ugyldig kjørings-ID.".into());
    }
    let navn = format!("{bruker}:{id}");
    let oppgave = {
        let mut aktive = kall()
            .lock()
            .map_err(|_| "Fikk ikke startet genereringen.")?;
        if aktive.contains_key(&navn) {
            return Err("En generering kjører allerede.".into());
        }
        let oppgave = tokio::spawn(modellkall(
            nokkel,
            url,
            leverandor == "anthropic",
            kropp,
            kanal,
        ));
        aktive.insert(navn.clone(), oppgave.abort_handle());
        oppgave
    };
    let r = oppgave.await;
    if let Ok(mut aktive) = kall().lock() {
        aktive.remove(&navn);
    }
    match r {
        Ok(r) => r,
        Err(e) if e.is_cancelled() => Err("avbrutt".into()),
        Err(_) => Err("Genereringen ble avbrutt av en feil.".into()),
    }
}

#[tauri::command]
pub fn brev_avbryt_modell(
    app: AppHandle,
    bruker: String,
    kjoring_id: String,
) -> Result<(), String> {
    profil(&app, &bruker)?;
    if let Some(k) = kall()
        .lock()
        .map_err(|_| "Fikk ikke avbrutt genereringen.")?
        .get(&format!("{bruker}:{kjoring_id}"))
    {
        k.abort();
    }
    Ok(())
}

/// Filtypene brukeren kan lagre: brev (pdf, docx), sikkerhetskopi (json)
/// og kalenderfiler for intervjuer (ics).
fn eksport_tillatt(ext: &str) -> bool {
    ["pdf", "docx", "json", "ics"].contains(&ext)
}

#[tauri::command]
pub async fn brev_lagre_fil(navn: String, bytes: Vec<u8>) -> Result<bool, String> {
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("Filen er for stor.".into());
    }
    let ext = Path::new(&navn)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !eksport_tillatt(&ext) {
        return Err("Ugyldig eksportformat.".into());
    }
    let rent = Path::new(&navn)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("soknadsbrev.pdf");
    let fil = rfd::AsyncFileDialog::new()
        .set_file_name(rent)
        .add_filter(ext.to_ascii_uppercase(), &[ext.as_str()])
        .save_file()
        .await;
    let Some(fil) = fil else {
        return Ok(false);
    };
    fil.write(&bytes)
        .await
        .map_err(|_| "Fikk ikke lagret eksporten.")?;
    Ok(true)
}

#[cfg(test)]
mod tester {
    use super::*;
    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }
    #[test]
    fn eksport_tillater_kalenderfiler_men_ikke_kjørbare() {
        for ok in ["pdf", "docx", "json", "ics"] {
            assert!(eksport_tillatt(ok), "{ok}");
        }
        for nei in ["", "exe", "sh", "html", "ICS"] {
            assert!(!eksport_tillatt(nei), "{nei}");
        }
    }
    #[test]
    fn bare_profil_og_dokumentnavn() {
        for id in ["..", "../0123456789abcd", "x", "0123456789abcdeg"] {
            assert!(profil_i(Path::new("/tmp"), id).is_err());
        }
        assert!(profil_i(Path::new("/tmp"), "0123456789abcdef").is_ok());
        // Navnene selv dekkes av dokumentnavn_er_like_i_node_og_rust.
        assert!(dokumentnavn("cv.json").is_ok());
    }
    fn felles() -> Value {
        serde_json::from_str(include_str!("../../testdata/dokumenter.json")).unwrap()
    }
    #[test]
    fn dokumentnavn_er_like_i_node_og_rust() {
        let t = felles();
        for (navn, type_) in t["navn"]["gyldige"].as_object().unwrap() {
            let ventet = match type_.as_str().unwrap() {
                "cv" => Dokumenttype::Cv,
                "stil" => Dokumenttype::Stil,
                "brev" => Dokumenttype::Brev,
                "jobb" => Dokumenttype::Jobb,
                "radar" => Dokumenttype::Radar,
                annet => panic!("ukjent type {annet}"),
            };
            assert_eq!(dokumenttype(navn), Some(ventet), "{navn}");
            assert!(dokumentnavn(navn).is_ok(), "{navn}");
        }
        for navn in t["navn"]["ugyldige"].as_array().unwrap() {
            let navn = navn.as_str().unwrap();
            assert_eq!(dokumenttype(navn), None, "{navn:?} skulle vært avvist");
            assert!(dokumentnavn(navn).is_err(), "{navn:?}");
        }
    }
    #[test]
    fn tomme_dokumenter_for_alle_typer() {
        let cv: Value = serde_json::from_str(&tomt_dokument("cv.json", 2).unwrap()).unwrap();
        assert_eq!(cv["revisjon"], 2);
        assert_eq!(cv["format"], "tekst");
        let stil: Value = serde_json::from_str(&tomt_dokument("stil.json", 5).unwrap()).unwrap();
        assert_eq!(
            stil,
            serde_json::json!({"skjemaVersjon":1,"revisjon":5,"oppdatert":null,"tekst":""})
        );
        let brev: Value = serde_json::from_str(&tomt_dokument("brev-j1.json", 3).unwrap()).unwrap();
        assert_eq!(brev["jobbId"], "j1");
        assert_eq!(brev["revisjon"], 3);
        // Før kuttet denne navn[5..len-5] for alt som ikke var CV: «jobb-»
        // ga feil id, og radar.json fikk et snitt som ikke finnes.
        for navn in ["jobb-j1.json", "radar.json"] {
            let d: Value = serde_json::from_str(&tomt_dokument(navn, 4).unwrap()).unwrap();
            assert_eq!(
                d,
                serde_json::json!({"skjemaVersjon":1,"revisjon":4,"oppdatert":null}),
                "{navn}"
            );
        }
        for navn in ["nokkel.txt", "../radar.json", "jobb-.json", "x"] {
            assert_eq!(tomt_dokument(navn, 1).unwrap_err(), "ugyldig-filnavn");
        }
    }
    #[test]
    fn jobbdokument_og_radar_har_samme_mekanikk_som_brev() {
        let d = dir();
        for navn in ["jobb-j1.json", "radar.json"] {
            skriv_dokument(
                d.path(),
                navn,
                r#"{"skjemaVersjon":1,"revisjon":1,"a":"først"}"#,
                0,
            )
            .unwrap();
            skriv_dokument(
                d.path(),
                navn,
                r#"{"skjemaVersjon":1,"revisjon":2,"a":"så"}"#,
                1,
            )
            .unwrap();
            assert_eq!(
                skriv_dokument(d.path(), navn, r#"{"skjemaVersjon":1,"revisjon":2}"#, 1)
                    .unwrap_err(),
                "konflikt"
            );
            assert!(les_dokument(d.path(), navn, true)
                .unwrap()
                .unwrap()
                .contains("først"));
            slett_dokument(d.path(), navn, 2).unwrap();
            // Etter sletting lages det tomme dokumentet fra markøren. Det var
            // her radar.json fikk appen til å panikke.
            let tom = les_dokument(d.path(), navn, false).unwrap().unwrap();
            assert_eq!(revisjon(&tom).unwrap(), 3);
            fs::write(d.path().join(navn), "ødelagt").unwrap();
            fs::write(
                d.path().join(backup(navn)),
                r#"{"skjemaVersjon":1,"revisjon":5}"#,
            )
            .unwrap();
            assert_eq!(
                revisjon(&gjenopprett_dokument(d.path(), navn).unwrap()).unwrap(),
                7
            );
        }
    }
    #[test]
    fn ingen_operasjon_slipper_ut_av_profilen() {
        let rot = dir();
        let profil = rot.path().join("p");
        fs::create_dir(&profil).unwrap();
        fs::write(
            rot.path().join("jobb-x.json"),
            r#"{"skjemaVersjon":1,"revisjon":1}"#,
        )
        .unwrap();
        for navn in [
            "../jobb-x.json",
            "jobb-../x.json",
            "jobb-x/../../jobb-x.json",
            "../radar.json",
            "/etc/passwd",
        ] {
            assert_eq!(
                les_dokument(&profil, navn, false).unwrap_err(),
                "ugyldig-filnavn",
                "{navn}"
            );
            assert_eq!(
                skriv_dokument(&profil, navn, r#"{"revisjon":1}"#, 0).unwrap_err(),
                "ugyldig-filnavn",
                "{navn}"
            );
            assert_eq!(
                slett_dokument(&profil, navn, 1).unwrap_err(),
                "ugyldig-filnavn"
            );
            assert_eq!(
                gjenopprett_dokument(&profil, navn).unwrap_err(),
                "ugyldig-filnavn"
            );
        }
        assert!(rot.path().join("jobb-x.json").exists());
        assert_eq!(fs::read_dir(&profil).unwrap().count(), 0);
    }
    #[test]
    fn listen_har_alle_typer_og_ingen_kopier() {
        let d = dir();
        for n in [
            "cv.json",
            "stil.json",
            "stil.forrige.json",
            "radar.json",
            "brev-a.json",
            "jobb-a.json",
            "jobb-a.forrige.json",
            "radar.forrige.json",
            "jobb-a.odelagt-1.json",
            "jobber.json",
            "nokkel.txt",
        ] {
            fs::write(d.path().join(n), "{}").unwrap();
        }
        fs::create_dir(d.path().join("jobb-mappe.json")).unwrap();
        assert_eq!(
            liste_i(d.path()).unwrap(),
            [
                "brev-a.json",
                "cv.json",
                "jobb-a.json",
                "radar.json",
                "stil.json"
            ]
        );
    }
    #[test]
    fn utdrag_folger_de_felles_tilfellene() {
        let t = felles();
        for (i, tilfelle) in t["utdrag"].as_array().unwrap().iter().enumerate() {
            let d = dir();
            fs::write(d.path().join("jobb-a.json"), tilfelle["dok"].to_string()).unwrap();
            let stier: Vec<String> = serde_json::from_value(tilfelle["stier"].clone()).unwrap();
            let ut = utdrag_i(d.path(), "jobb-", &stier).unwrap();
            assert_eq!(
                Value::Object(ut["jobb-a.json"].clone()),
                tilfelle["ventet"],
                "tilfelle {i}: {}",
                tilfelle["om"]
            );
        }
        let d = dir();
        for stier in t["ugyldigeStier"].as_array().unwrap() {
            let stier: Vec<String> = serde_json::from_value(stier.clone()).unwrap();
            assert!(utdrag_i(d.path(), "jobb-", &stier).is_err(), "{stier:?}");
        }
        assert!(utdrag_i(d.path(), "jobb-", &vec!["a".to_string(); MAKS_RÅ_STIER + 1]).is_err());
    }
    #[test]
    fn utdrag_hopper_over_det_det_ikke_forstaar() {
        let d = dir();
        let p = d.path();
        fs::write(
            p.join("jobb-ok.json"),
            r#"{"skjemaVersjon":1,"match":{"prosent":70}}"#,
        )
        .unwrap();
        fs::write(p.join("jobb-odelagt.json"), "ikke json").unwrap();
        fs::write(
            p.join("jobb-nyere.json"),
            r#"{"skjemaVersjon":2,"match":{"prosent":1}}"#,
        )
        .unwrap();
        fs::write(p.join("jobb-liste.json"), "[1,2]").unwrap();
        fs::write(
            p.join("jobb-ok.forrige.json"),
            r#"{"skjemaVersjon":1,"match":{"prosent":9}}"#,
        )
        .unwrap();
        fs::write(
            p.join("brev-ok.json"),
            r#"{"skjemaVersjon":1,"match":{"prosent":9}}"#,
        )
        .unwrap();
        let ut = utdrag_i(p, "jobb-", &["match.prosent".to_string()]).unwrap();
        assert_eq!(
            serde_json::to_value(&ut).unwrap(),
            serde_json::json!({"jobb-ok.json":{"match.prosent":70}})
        );
        assert_eq!(
            utdrag_i(p, "brev-", &["match.prosent".to_string()])
                .unwrap()
                .len(),
            1
        );
        for prefiks in ["cv", "radar", "", "../", "jobb"] {
            assert!(
                utdrag_i(p, prefiks, &["a".to_string()]).is_err(),
                "{prefiks}"
            );
        }
        // En profil uten katalog ennå har ingen dokumenter, ikke en feil.
        assert!(
            utdrag_i(&p.join("finnes-ikke"), "jobb-", &["a".to_string()])
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn revisjoner_backup_og_konflikt() {
        let d = dir();
        skriv_dokument(d.path(), "cv.json", r#"{"revisjon":1,"tekst":"først"}"#, 0).unwrap();
        assert_eq!(
            skriv_dokument(d.path(), "cv.json", r#"{"revisjon":1}"#, 0).unwrap_err(),
            "konflikt"
        );
        skriv_dokument(d.path(), "cv.json", r#"{"revisjon":2,"tekst":"ny"}"#, 1).unwrap();
        assert!(les_dokument(d.path(), "cv.json", true)
            .unwrap()
            .unwrap()
            .contains("først"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(d.path().join("cv.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn korrupt_og_manglende_hoved_skrives_ikke_over() {
        let d = dir();
        fs::write(d.path().join("cv.json"), "ødelagt").unwrap();
        assert_eq!(
            skriv_dokument(d.path(), "cv.json", r#"{"revisjon":1}"#, 0).unwrap_err(),
            "odelagt"
        );
        assert_eq!(
            fs::read_to_string(d.path().join("cv.json")).unwrap(),
            "ødelagt"
        );
        fs::remove_file(d.path().join("cv.json")).unwrap();
        fs::write(d.path().join("cv.forrige.json"), r#"{"revisjon":2}"#).unwrap();
        assert_eq!(
            skriv_dokument(d.path(), "cv.json", r#"{"revisjon":1}"#, 0).unwrap_err(),
            "gjenoppretting"
        );
    }
    #[test]
    fn sletting_sjekker_revisjon_og_fjerner_backup() {
        let d = dir();
        skriv_dokument(d.path(), "cv.json", r#"{"revisjon":1}"#, 0).unwrap();
        skriv_dokument(d.path(), "cv.json", r#"{"revisjon":2}"#, 1).unwrap();
        assert_eq!(
            slett_dokument(d.path(), "cv.json", 1).unwrap_err(),
            "konflikt"
        );
        slett_dokument(d.path(), "cv.json", 2).unwrap();
        assert_eq!(
            revisjon(&les_dokument(d.path(), "cv.json", false).unwrap().unwrap()).unwrap(),
            3
        );
        assert!(!d.path().join("cv.forrige.json").exists());
        assert_eq!(
            skriv_dokument(d.path(), "cv.json", r#"{"revisjon":3}"#, 2).unwrap_err(),
            "konflikt"
        );
        skriv_dokument(d.path(), "cv.json", r#"{"revisjon":4}"#, 3).unwrap();
        assert!(!d.path().join("cv.forrige.json").exists());
    }
    #[test]
    fn node_kompatibel_las_stjeles_ikke() {
        let d = dir();
        fs::create_dir(d.path().join(".cv.json.las")).unwrap();
        assert_eq!(
            skriv_dokument(d.path(), "cv.json", r#"{"revisjon":1}"#, 0).unwrap_err(),
            "opptatt"
        );
        assert!(d.path().join(".cv.json.las").exists());
    }
    #[test]
    fn samtidige_skrivinger_gir_en_vinner() {
        let d = dir();
        let p = d.path().to_path_buf();
        let q = p.clone();
        let a = std::thread::spawn(move || {
            skriv_dokument(&p, "cv.json", r#"{"revisjon":1,"tekst":"a"}"#, 0)
        });
        let b = std::thread::spawn(move || {
            skriv_dokument(&q, "cv.json", r#"{"revisjon":1,"tekst":"b"}"#, 0)
        });
        let svar = [a.join().unwrap(), b.join().unwrap()];
        assert_eq!(svar.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            svar.iter()
                .filter(|r| r.as_ref().err().is_some_and(|e| e == "konflikt"))
                .count(),
            1
        );
    }
    #[test]
    fn linjedeler_over_chunkgrenser_crlf_og_tak() {
        let mut d = Linjedeler::ny();
        // En linje delt over to biter settes sammen.
        assert_eq!(
            d.ta(b"event: fase\ndata: {\"a\"").unwrap(),
            vec!["event: fase"]
        );
        assert_eq!(
            d.ta(b":1}\n\n").unwrap(),
            vec!["data: {\"a\":1}".to_string(), String::new()]
        );
        // CRLF gir nøyaktig samme linjer som LF: linjeskiftet strippes alltid,
        // og JS-siden legger på \n igjen. Uenighet her ville blitt en stille feil.
        assert_eq!(
            d.ta(b"event: x\r\ndata: y\r\n\r\n").unwrap(),
            vec!["event: x".to_string(), "data: y".to_string(), String::new()]
        );
        assert_eq!(d.slutt(), None);

        // Et flerbytetegn delt mellom to biter tolkes ikke før linjen er hel.
        let mut d = Linjedeler::ny();
        let kilde = "data: årene\n".as_bytes();
        assert!(d.ta(&kilde[..7]).unwrap().is_empty());
        assert_eq!(d.ta(&kilde[7..]).unwrap(), vec!["data: årene"]);

        // En avsluttende halv linje er ingen ramme, men går ikke tapt.
        let mut d = Linjedeler::ny();
        assert!(d.ta(b"data: halv").unwrap().is_empty());
        assert_eq!(d.slutt(), Some("data: halv".to_string()));

        // Ugyldig UTF-8 i en hel linje er et formatavvik, ikke noe å gjette på.
        let mut d = Linjedeler::ny();
        assert_eq!(
            d.ta(b"\xff\xfe\n").unwrap_err(),
            "Modellen svarte i feil format."
        );

        let mut d = Linjedeler::ny();
        assert!(d.ta(&vec![b'x'; MAKS_SVAR]).unwrap().is_empty());
        assert_eq!(
            d.ta(b"mer\n").unwrap_err(),
            "Modellen sendte et for stort svar."
        );
    }
    #[test]
    fn modellkroppen_ma_be_om_strom_og_riktig_modell() {
        const OPENAI: &[&str] = &["gpt-6-astra"];
        const ANTHROPIC: &[&str] = &["claude-opus-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
        let ok = r#"{"model":"gpt-6-astra","store":false,"stream":true}"#;
        assert!(sjekk_modellkropp("openai", OPENAI, ok).is_ok());
        assert_eq!(
            sjekk_modellkropp("openai", OPENAI, r#"{"model":"gpt-6-astra","store":false}"#)
                .unwrap_err(),
            "Strømming må være påslått."
        );
        assert_eq!(
            sjekk_modellkropp(
                "openai",
                OPENAI,
                r#"{"model":"gpt-6-astra","store":false,"stream":"ja"}"#
            )
            .unwrap_err(),
            "Strømming må være påslått."
        );
        assert_eq!(
            sjekk_modellkropp(
                "openai",
                OPENAI,
                r#"{"model":"gpt-6-astra","store":true,"stream":true}"#
            )
            .unwrap_err(),
            "Modellagring må være avslått."
        );
        assert_eq!(
            sjekk_modellkropp("anthropic", ANTHROPIC, r#"{"model":"feil","stream":true}"#)
                .unwrap_err(),
            "Ukjent modell."
        );
        assert!(sjekk_modellkropp(
            "anthropic",
            ANTHROPIC,
            r#"{"model":"claude-opus-5","stream":true}"#
        )
        .is_ok());
        // Kroppen med hurtigbuffer: systemet og kildene er blokker med cache_control.
        assert!(sjekk_modellkropp(
            "anthropic",
            ANTHROPIC,
            r#"{"model":"claude-opus-5","stream":true,"system":[{"type":"text","text":"Regler.","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":[{"type":"text","text":"{}","cache_control":{"type":"ephemeral"}},{"type":"text","text":"{}"}]}]}"#
        )
        .is_ok());
        assert_eq!(
            sjekk_modellkropp("anthropic", ANTHROPIC, "ikke json").unwrap_err(),
            "Ugyldig modellforespørsel."
        );
    }
    #[test]
    fn hvert_formal_har_sin_modell_hos_leverandoren() {
        let (_, _, modeller) = leverandor("anthropic").unwrap();
        for m in ["claude-opus-5", "claude-sonnet-5-5", "claude-haiku-5-5"] {
            let kropp = format!(r#"{{"model":"{m}","stream":true}}"#);
            assert!(
                sjekk_modellkropp("anthropic", modeller, &kropp).is_ok(),
                "{m}"
            );
        }
        // En modell fra den andre leverandøren godtas ikke.
        assert_eq!(
            sjekk_modellkropp(
                "anthropic",
                modeller,
                r#"{"model":"gpt-6-astra","stream":true}"#
            )
            .unwrap_err(),
            "Ukjent modell."
        );
        let (_, _, openai) = leverandor("openai").unwrap();
        assert_eq!(openai, &["gpt-6-astra"]);
    }
    #[test]
    fn nokler_og_leverandorer() {
        assert!(leverandor("openai").is_ok());
        assert!(leverandor("anthropic").is_ok());
        assert!(leverandor("https://evil.test").is_err());
        assert!(gyldig_nokkel("abcdefghijklmno123456789"));
        assert!(!gyldig_nokkel("abc\r\ndefghijklmno123456789"));
    }
    #[test]
    fn recovery_bevarer_original_og_bruker_nye_revisjoner() {
        let d = dir();
        skriv_dokument(
            d.path(),
            "cv.json",
            r#"{"skjemaVersjon":1,"revisjon":1,"tekst":"først"}"#,
            0,
        )
        .unwrap();
        skriv_dokument(
            d.path(),
            "cv.json",
            r#"{"skjemaVersjon":1,"revisjon":2,"tekst":"ny"}"#,
            1,
        )
        .unwrap();
        fs::write(d.path().join("cv.json"), "ødelagt").unwrap();
        let r = gjenopprett_dokument(d.path(), "cv.json").unwrap();
        assert_eq!(revisjon(&r).unwrap(), 3);
        assert!(r.contains("først"));
        let r = gjenopprett_dokument(d.path(), "cv.json").unwrap();
        assert_eq!(revisjon(&r).unwrap(), 4);
        assert_eq!(
            revisjon(&les_dokument(d.path(), "cv.json", true).unwrap().unwrap()).unwrap(),
            1
        );
        assert!(fs::read_dir(d.path()).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("cv.odelagt-")));
        slett_dokument(d.path(), "cv.json", 4).unwrap();
        assert!(!fs::read_dir(d.path()).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("cv.odelagt-")));
    }
}
