//! Avgrensede fil-, nøkkel- og nettoperasjoner for skriveverkstedet.
//! Samme mkdir-lås som Node; en gammel lås stjeles aldri på tid alene.
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
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

fn dokumentnavn(navn: &str) -> Result<&str, String> {
    if navn == "cv.json" {
        return Ok(navn);
    }
    if let Some(id) = navn
        .strip_prefix("brev-")
        .and_then(|s| s.strip_suffix(".json"))
    {
        if !id.is_empty()
            && id.len() <= 64
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Ok(navn);
        }
    }
    Err("ugyldig-filnavn".into())
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

fn tomt_dokument(navn: &str, rev: u64) -> String {
    let mut v = serde_json::json!({"skjemaVersjon":1,"revisjon":rev,"tekst":"","oppdatert":null});
    if navn == "cv.json" {
        v["navn"] = "".into();
        v["format"] = "tekst".into();
    } else {
        v["jobbId"] = navn[5..navn.len() - 5].into();
        v["leverandor"] = "anthropic".into();
        v["versjoner"] = serde_json::json!([]);
        v["aktivVersjon"] = Value::Null;
        v["annonse"] = serde_json::json!({"tekst":"","url":"","hentet":null});
        v["kontekst"] = "".into();
        v["sprak"] = "auto".into();
        v["kjoring"] = Value::Null;
    }
    v.to_string()
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
            return Ok(Some(tomt_dokument(navn, n)));
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

#[tauri::command]
pub fn brev_liste(app: AppHandle, bruker: String) -> Result<Vec<String>, String> {
    let dir = profil(&app, &bruker)?;
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

fn leverandor(navn: &str) -> Result<(&'static str, &'static str, &'static str), String> {
    match navn {
        "anthropic" => Ok((
            "nokkel.txt",
            "https://api.anthropic.com/v1/messages",
            "claude-opus-5",
        )),
        "openai" => Ok((
            "nokkel-openai.txt",
            "https://api.openai.com/v1/responses",
            "gpt-6-astra",
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
fn sjekk_modellkropp(leverandor: &str, modell: &str, kropp: &str) -> Result<(), String> {
    if kropp.len() > 1024 * 1024 {
        return Err("Grunnlaget er for stort.".into());
    }
    let json: Value = serde_json::from_str(kropp).map_err(|_| "Ugyldig modellforespørsel.")?;
    if json.get("model").and_then(Value::as_str) != Some(modell) {
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
    let (_, url, modell) = self::leverandor(&leverandor)?;
    sjekk_modellkropp(&leverandor, modell, &kropp)?;
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
    if !["pdf", "docx", "json"].contains(&ext.as_str()) {
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
    fn bare_profil_og_dokumentnavn() {
        for id in ["..", "../0123456789abcd", "x", "0123456789abcdeg"] {
            assert!(profil_i(Path::new("/tmp"), id).is_err());
        }
        assert!(profil_i(Path::new("/tmp"), "0123456789abcdef").is_ok());
        for n in [
            "nokkel.txt",
            "brukere.json",
            "../cv.json",
            "brev-.json",
            "brev-x.forrige.json",
        ] {
            assert!(dokumentnavn(n).is_err());
        }
        assert!(dokumentnavn("cv.json").is_ok());
        assert!(dokumentnavn("brev-abc-123.json").is_ok());
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
        assert_eq!(d.ta(b"event: fase\ndata: {\"a\"").unwrap(), vec!["event: fase"]);
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
        let ok = r#"{"model":"gpt-6-astra","store":false,"stream":true}"#;
        assert!(sjekk_modellkropp("openai", "gpt-6-astra", ok).is_ok());
        assert_eq!(
            sjekk_modellkropp("openai", "gpt-6-astra", r#"{"model":"gpt-6-astra","store":false}"#)
                .unwrap_err(),
            "Strømming må være påslått."
        );
        assert_eq!(
            sjekk_modellkropp(
                "openai",
                "gpt-6-astra",
                r#"{"model":"gpt-6-astra","store":false,"stream":"ja"}"#
            )
            .unwrap_err(),
            "Strømming må være påslått."
        );
        assert_eq!(
            sjekk_modellkropp(
                "openai",
                "gpt-6-astra",
                r#"{"model":"gpt-6-astra","store":true,"stream":true}"#
            )
            .unwrap_err(),
            "Modellagring må være avslått."
        );
        assert_eq!(
            sjekk_modellkropp("anthropic", "claude-opus-5", r#"{"model":"feil","stream":true}"#)
                .unwrap_err(),
            "Ukjent modell."
        );
        assert!(sjekk_modellkropp(
            "anthropic",
            "claude-opus-5",
            r#"{"model":"claude-opus-5","stream":true}"#
        )
        .is_ok());
        assert_eq!(
            sjekk_modellkropp("anthropic", "claude-opus-5", "ikke json").unwrap_err(),
            "Ugyldig modellforespørsel."
        );
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
