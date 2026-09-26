//! Settings: one TOML file, overridable from the environment. Everything has a
//! default, so the agent works without any file at all.

use std::collections::BTreeMap;
use std::collections::hash_map::RandomState;
use std::env;
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::model::{Machine, Provider, TEXT_LIMIT, clean_text, now_ms};
use crate::schedule::{DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS};

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Seconds between two measurements of one provider (at least 60, default 120).
    pub interval: Option<u64>,
    /// Measure providers less often while nobody uses them (default on).
    pub eco: Option<bool>,
    /// Tell the hub which coding agents run on this machine (default on).
    pub sessions: Option<bool>,
    /// With the names of their projects and folders (default on).
    pub projects: Option<bool>,
    pub hub: Option<Hub>,
    pub machine: MachineSettings,
    pub providers: BTreeMap<Provider, ProviderSettings>,
    /// Whom the machine measured for, before 0.2. A machine now belongs to the person
    /// whose token it uses; the key is still read so an older file keeps working.
    #[serde(skip_serializing)]
    pub owner: Option<String>,
    /// Whether the global interval came from `QUOTUM_INTERVAL` rather than the file.
    #[serde(skip)]
    interval_from_env: bool,
}

/// Where the interval of a provider is set: for it alone, for all in the file, or by `QUOTUM_INTERVAL`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntervalSource {
    Provider,
    File,
    Env,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Hub {
    /// Base URL of the hub; measurements go to `<url>/v1/ingest`.
    pub url: String,
    pub token: String,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct MachineSettings {
    /// How this machine is shown on the hub (default: the host name).
    pub name: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct ProviderSettings {
    pub enabled: Option<bool>,
    /// Seconds; overrides the global interval for this provider.
    pub interval: Option<u64>,
    /// Path to the client, when it is not on PATH.
    pub path: Option<PathBuf>,
    /// A name for this subscription when the client does not identify the account
    /// (Antigravity), to tell two subscriptions of one owner apart.
    pub account: Option<String>,
}

impl Config {
    /// Reads `path` (a missing file means defaults) and applies environment overrides.
    /// An error names where the bad value came from: the file or a variable.
    pub fn load(path: &Path) -> Result<Config, String> {
        let mut config = match fs::read_to_string(path) {
            Ok(text) => Config::parse(&text).map_err(|e| format!("{}: {e}", path.display()))?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => Config::default(),
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        config.apply_env(|key| env::var(key).ok().filter(|v| !v.is_empty()))?;
        Ok(config)
    }

    /// The settings a file holds, checked as the agent checks them when it reads the file,
    /// without the environment: for whatever writes the file (the desktop app).
    pub fn parse(text: &str) -> Result<Config, String> {
        let config = toml::from_str::<Config>(text).map_err(|e| e.to_string())?;
        config.check()?;
        Ok(config)
    }

    /// Refuses settings a hub would not take, rather than sending them and losing data.
    fn check(&self) -> Result<(), String> {
        let name = |what: &str, value: Option<&str>| match value {
            Some(v) if v.trim().is_empty() || v.chars().count() > TEXT_LIMIT => {
                Err(format!("{what}: a name is 1 to {TEXT_LIMIT} characters"))
            }
            _ => Ok(()),
        };
        check_interval("interval", self.interval)?;
        name("machine.name", self.machine.name.as_deref())?;
        for (provider, settings) in &self.providers {
            check_interval(&format!("providers.{}.interval", provider.id()), settings.interval)?;
            name(&format!("providers.{}.account", provider.id()), settings.account.as_deref())?;
        }
        Ok(())
    }

    fn apply_env(&mut self, var: impl Fn(&str) -> Option<String>) -> Result<(), String> {
        if let Some(value) = var("QUOTUM_INTERVAL") {
            let seconds =
                value.trim().parse().map_err(|_| format!("QUOTUM_INTERVAL: \"{value}\" is not a number of seconds"))?;
            check_interval("QUOTUM_INTERVAL", Some(seconds))?;
            self.interval = Some(seconds);
            self.interval_from_env = true;
        }
        match (var("QUOTUM_HUB_URL"), var("QUOTUM_HUB_TOKEN")) {
            (Some(url), Some(token)) => self.hub = Some(Hub { url, token }),
            (Some(url), None) => {
                if let Some(hub) = &mut self.hub {
                    hub.url = url;
                }
            }
            (None, Some(token)) => {
                if let Some(hub) = &mut self.hub {
                    hub.token = token;
                }
            }
            (None, None) => {}
        }
        Ok(())
    }

    pub fn enabled(&self, provider: Provider) -> bool {
        self.providers.get(&provider).and_then(|p| p.enabled).unwrap_or(true)
    }

    pub fn interval_ms(&self, provider: Provider) -> u64 {
        let seconds = self.providers.get(&provider).and_then(|p| p.interval).or(self.interval);
        seconds.map(|s| s.saturating_mul(1000)).unwrap_or(DEFAULT_INTERVAL_MS).max(MIN_INTERVAL_MS)
    }

    /// The interval set for a provider, if any: with a hub, the most often it is measured.
    pub fn min_interval_ms(&self, provider: Provider) -> Option<u64> {
        self.interval_source(provider).map(|_| self.interval_ms(provider))
    }

    /// The interval set for all providers, if any, in ms, and where it is set.
    pub fn global_interval(&self) -> Option<(u64, IntervalSource)> {
        let source = if self.interval_from_env { IntervalSource::Env } else { IntervalSource::File };
        self.interval.map(|s| (s.saturating_mul(1000).max(MIN_INTERVAL_MS), source))
    }

    pub fn interval_source(&self, provider: Provider) -> Option<IntervalSource> {
        if self.providers.get(&provider).and_then(|p| p.interval).is_some() {
            Some(IntervalSource::Provider)
        } else if self.interval.is_some() {
            Some(if self.interval_from_env { IntervalSource::Env } else { IntervalSource::File })
        } else {
            None
        }
    }

    pub fn eco(&self) -> bool {
        self.eco.unwrap_or(true)
    }

    pub fn sessions(&self) -> bool {
        self.sessions.unwrap_or(true)
    }

    pub fn projects(&self) -> bool {
        self.projects.unwrap_or(true)
    }

    pub fn program(&self, provider: Provider) -> Option<&Path> {
        self.providers.get(&provider).and_then(|p| p.path.as_deref())
    }

    pub fn account_name(&self, provider: Provider) -> Option<&str> {
        self.providers.get(&provider).and_then(|p| p.account.as_deref())
    }
}

/// Keeps an interval within what a hub takes; `what` names where the value came from.
fn check_interval(what: &str, seconds: Option<u64>) -> Result<(), String> {
    match seconds {
        Some(s) if !(60..=86_400).contains(&s) => Err(format!("{what}: {s} is not between 60 and 86400 seconds")),
        _ => Ok(()),
    }
}

/// What `quotum connect` receives from a hub: its address and this device's token.
/// Files of older versions also name a board and an owner; those are ignored.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct Credentials {
    pub url: String,
    pub token: String,
    /// Display name of the person the device belongs to (empty in older files).
    #[serde(default)]
    pub account: String,
}

impl Credentials {
    fn file(paths: &Paths) -> PathBuf {
        paths.state.join("credentials.json")
    }

    pub fn load(paths: &Paths) -> Option<Credentials> {
        serde_json::from_slice(&fs::read(Self::file(paths)).ok()?).ok()
    }

    /// Written readable by the user only, to a new file that then replaces the old one.
    pub fn save(&self, paths: &Paths) -> io::Result<()> {
        let file = Self::file(paths);
        let next = file.with_extension("json.new");
        let text = serde_json::to_vec_pretty(self).map_err(io::Error::other)?;
        let _ = fs::remove_file(&next);
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut out = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&next)?;
            out.write_all(&text)?;
        }
        #[cfg(not(unix))]
        fs::write(&next, text)?;
        fs::rename(next, file)
    }

    pub fn remove(paths: &Paths) -> bool {
        fs::remove_file(Self::file(paths)).is_ok()
    }
}

impl Config {
    /// The hub to deliver to: from the settings or environment, else the one connected with a code.
    pub fn hub_or_connected(&self, paths: &Paths) -> Option<Hub> {
        self.hub.clone().or_else(|| Credentials::load(paths).map(|c| Hub { url: c.url, token: c.token }))
    }
}

/// Where the agent keeps its files.
#[derive(Clone, Debug)]
pub struct Paths {
    pub config: PathBuf,
    /// Machine id, delivery spool, client logs.
    pub state: PathBuf,
    /// Empty working directory for client processes.
    pub work: PathBuf,
}

impl Paths {
    pub fn resolve() -> Paths {
        let config = env::var_os("QUOTUM_CONFIG").map(PathBuf::from).unwrap_or_else(|| {
            dirs::config_dir().unwrap_or_else(|| home().join(".config")).join("quotum").join("config.toml")
        });
        let state = env::var_os("QUOTUM_STATE_DIR").map(PathBuf::from).unwrap_or_else(|| {
            dirs::state_dir()
                .or_else(dirs::data_local_dir)
                .unwrap_or_else(|| home().join(".local/state"))
                .join("quotum")
        });
        let work = state.join("work");
        Paths { config, state, work }
    }

    pub fn ensure(&self) -> io::Result<()> {
        fs::create_dir_all(&self.work)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.state, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    /// Where `quotum start` has the agent write its log.
    pub fn log_file(&self) -> PathBuf {
        self.state.join("agent.log")
    }
}

/// `path` opened and locked exclusively, or `WouldBlock` when someone else holds it; the
/// lock lasts while the file stays open and ends with the process.
#[cfg(unix)]
pub fn lock_file(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::io::AsRawFd;
    let file = fs::OpenOptions::new().write(true).create(true).truncate(false).open(path)?;
    // SAFETY: flock(2) on a descriptor owned by `file`, which outlives the call.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(file)
}

/// Opened without sharing: every other open of the file fails while this one lasts.
#[cfg(windows)]
pub fn lock_file(path: &Path) -> io::Result<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    fs::OpenOptions::new().write(true).create(true).truncate(false).share_mode(0).open(path).map_err(|e| {
        if e.raw_os_error() == Some(ERROR_SHARING_VIOLATION) { io::ErrorKind::WouldBlock.into() } else { e }
    })
}

#[cfg(not(any(unix, windows)))]
pub fn lock_file(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new().write(true).create(true).truncate(false).open(path)
}

pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// This machine as the hub sees it. The id is random and created on first use.
pub fn machine(paths: &Paths, config: &Config) -> Machine {
    let file = paths.state.join("machine-id");
    let id =
        fs::read_to_string(&file).ok().map(|s| s.trim().to_string()).filter(|s| s.len() >= 16).unwrap_or_else(|| {
            let id = random_hex();
            let _ = fs::write(&file, &id);
            id
        });
    Machine {
        id,
        name: clean_text(config.machine.name.clone())
            .or_else(|| clean_text(Some(hostname())))
            .unwrap_or_else(|| "machine".into()),
        os: env::consts::OS.into(),
        arch: env::consts::ARCH.into(),
    }
}

/// 128 random bits as hex, from the standard library's per-process random keys.
fn random_hex() -> String {
    (0..2u8)
        .map(|i| {
            let mut hasher = RandomState::new().build_hasher();
            hasher.write_i64(now_ms());
            hasher.write_u32(std::process::id());
            hasher.write_u8(i);
            format!("{:016x}", hasher.finish())
        })
        .collect()
}

/// A number in [-1, 1] for scheduling jitter.
pub fn jitter() -> f64 {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_i64(now_ms());
    (hasher.finish() as f64 / u64::MAX as f64) * 2.0 - 1.0
}

fn hostname() -> String {
    #[cfg(unix)]
    {
        let mut buffer = [0u8; 256];
        // SAFETY: the buffer outlives the call and its length is passed along.
        let ok = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0;
        if ok {
            let end = buffer.iter().position(|&b| b == 0).unwrap_or(buffer.len());
            if let Ok(name) = std::str::from_utf8(&buffer[..end]) {
                if !name.is_empty() {
                    return name.to_string();
                }
            }
        }
    }
    env::var("COMPUTERNAME").or_else(|_| env::var("HOSTNAME")).unwrap_or_else(|_| "machine".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_means_defaults() {
        let config = Config::load(Path::new("/nonexistent/quotum.toml")).unwrap();
        assert!(config.enabled(Provider::Claude) && config.eco());
        assert_eq!(config.interval_ms(Provider::Codex), DEFAULT_INTERVAL_MS);
    }

    #[test]
    fn per_provider_settings_override_the_global_ones_and_a_minute_is_the_floor() {
        let config: Config = toml::from_str(
            r#"
            interval = 300
            eco = false
            [hub]
            url = "https://quotum.example.com"
            token = "t"
            [providers.claude]
            interval = 10
            [providers.antigravity]
            enabled = false
            "#,
        )
        .unwrap();
        assert_eq!(config.interval_ms(Provider::Codex), 300_000);
        assert_eq!(config.interval_ms(Provider::Claude), MIN_INTERVAL_MS);
        assert!(!config.enabled(Provider::Antigravity) && !config.eco());
        assert!(
            toml::from_str::<Config>("[providers.cursor]\nenabled = true").is_err(),
            "unknown providers are errors"
        );
    }

    #[test]
    fn settings_a_hub_would_not_take_are_refused_at_load() {
        let check = |text: &str| toml::from_str::<Config>(text).unwrap().check();
        assert!(check("interval = 120\n[providers.antigravity]\naccount = \"work\"").is_ok());
        assert!(check("interval = 30").unwrap_err().contains("interval"));
        assert!(check("[providers.codex]\ninterval = 200000").is_err());
        assert!(check(&format!("[machine]\nname = \"{}\"", "m".repeat(121))).is_err());
        assert!(check("[providers.antigravity]\naccount = \"\"").is_err());
        assert!(check("owner = \"alice\"").is_ok(), "the key of older versions is ignored, not refused");
        assert!(Config::parse("interval = 30").unwrap_err().contains("interval"), "parse checks as load does");
        assert!(Config::parse("[providers.cursor]").is_err());
        assert!(!Config::parse("sessions = false").unwrap().sessions());
    }

    #[test]
    fn the_environment_can_point_the_agent_at_a_hub() {
        let mut config = Config::default();
        config
            .apply_env(|key| match key {
                "QUOTUM_HUB_URL" => Some("https://hub.example".into()),
                "QUOTUM_HUB_TOKEN" => Some("secret".into()),
                "QUOTUM_INTERVAL" => Some("90".into()),
                _ => None,
            })
            .unwrap();
        assert_eq!(config.hub, Some(Hub { url: "https://hub.example".into(), token: "secret".into() }));
        assert_eq!(config.interval_ms(Provider::Claude), 90_000);
    }

    #[test]
    fn an_interval_is_a_least_one_only_where_it_is_set() {
        let mut config: Config = toml::from_str("[providers.claude]\ninterval = 300").unwrap();
        assert_eq!((config.min_interval_ms(Provider::Codex), config.interval_source(Provider::Codex)), (None, None));
        assert_eq!(config.min_interval_ms(Provider::Claude), Some(300_000));
        assert_eq!(config.interval_source(Provider::Claude), Some(IntervalSource::Provider));
        config.interval = Some(90);
        assert_eq!(config.min_interval_ms(Provider::Codex), Some(90_000));
        assert_eq!(config.interval_source(Provider::Codex), Some(IntervalSource::File));
        assert_eq!(config.interval_source(Provider::Claude), Some(IntervalSource::Provider), "its own wins");
        assert_eq!(config.global_interval(), Some((90_000, IntervalSource::File)));
        config.apply_env(|key| (key == "QUOTUM_INTERVAL").then(|| "120".to_string())).unwrap();
        assert_eq!(config.interval_source(Provider::Codex), Some(IntervalSource::Env));
        assert_eq!(config.min_interval_ms(Provider::Codex), Some(120_000));
        assert_eq!(config.global_interval(), Some((120_000, IntervalSource::Env)));
    }

    #[test]
    fn a_bad_interval_in_the_environment_is_blamed_on_the_variable() {
        let interval = |value: &'static str| {
            Config::default().apply_env(move |key| (key == "QUOTUM_INTERVAL").then(|| value.to_string()))
        };
        assert_eq!(interval("5m").unwrap_err(), "QUOTUM_INTERVAL: \"5m\" is not a number of seconds");
        assert_eq!(interval("30").unwrap_err(), "QUOTUM_INTERVAL: 30 is not between 60 and 86400 seconds");
    }

    #[test]
    fn credentials_of_older_versions_still_connect() {
        let old = r#"{"url": "https://quotum.example.com", "token": "qt_d_x", "board": "", "owner": "alice"}"#;
        let credentials: Credentials = serde_json::from_str(old).unwrap();
        assert_eq!((credentials.url.as_str(), credentials.account.as_str()), ("https://quotum.example.com", ""));
    }

    #[test]
    fn jitter_stays_in_range() {
        assert!((0..100).map(|_| jitter()).all(|j| (-1.0..=1.0).contains(&j)));
    }
}
