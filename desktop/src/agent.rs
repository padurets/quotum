//! The agent of this machine, inside the app: the same settings, state and identity as
//! `quotum`, delivering to the app's own hub. It measures only while it holds the machine
//! (see quotum_core::holder). If `quotum run` holds it, the app asks once, in its window,
//! whether to take over; agreed, it takes over by itself on every start after. The app
//! never holds the machine without measuring or being able to: stopped for good (a panic,
//! the hub down for good, quitting), it lets it go, and a waiting `quotum` goes on.
//!
//! Two mutexes: `ops` puts the operations one after another (they join threads and wait
//! for `quotum` to make way), `data` is held only to read or write fields, so the board's
//! `app_state` never waits for an operation.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime};

use quotum_core::config::{Config, Hub, IntervalSource, Paths, home, machine};
use quotum_core::holder::{Holder, LockError, RunLock, Running};
use quotum_core::model::{Millis, Outcome, Provider, now_ms};
use quotum_core::providers::{adapter, find_client};
use quotum_core::runner::{Event, Runner};
use quotum_core::sink::HubSink;
use quotum_core::stop::{How, Stop};
use serde::Serialize;

use crate::files::Log;
use crate::hub::{HubState, Ready};
use crate::settings::{self, Patch};
use crate::shell::{self, Shell};
use crate::{autostart, window};

/// Where the agent is, as the board shows it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum State {
    Starting,
    TakingOver,
    Measuring,
    /// Every provider is off: holding the machine, measuring nothing.
    Idle,
    /// `quotum` holds the machine; `error` says why taking over failed, if it did.
    Held {
        holder: HolderInfo,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Failed {
        cause: Cause,
        error: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HolderInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// Where it delivers, as far as known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hub: Option<String>,
    /// It said it makes way (run.info): it waits while the app runs and goes on after.
    pub yields: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Cause {
    /// config.toml cannot be read: fixing it starts the agent again.
    Config,
    /// The machine cannot be held.
    Lock,
    /// The agent stopped by itself.
    Panic,
}

/// The last measurement of a provider here.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Last {
    pub at: Millis,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<quotum_core::model::ErrorKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

type Lasts = Arc<Mutex<BTreeMap<Provider, Last>>>;

/// A run of the agent on a thread of its own, for one start of the hub.
struct Run {
    stop: Stop,
    thread: JoinHandle<Option<String>>,
    /// The hub's generation it delivers to.
    generation: u64,
}

pub struct Agent {
    pub state: State,
    lock: Option<RunLock>,
    run: Option<Run>,
    /// The settings in effect: the ones read last without an error.
    pub config: Config,
    /// config.toml as it was when read (modified, length): a change starts the agent again.
    seen: Option<(Option<SystemTime>, u64)>,
    pub clients: BTreeMap<Provider, Option<PathBuf>>,
    pub last: Lasts,
    /// Numbers the saves: only the last of several quick ones restarts the agent.
    saves: u64,
    /// A stopped worker still owns its spool until delivery has finished.
    restart_pending: bool,
    started: bool,
}

impl Agent {
    pub fn new() -> Agent {
        Agent {
            state: State::Starting,
            lock: None,
            run: None,
            config: Config::default(),
            seen: None,
            clients: BTreeMap::new(),
            last: Arc::default(),
            saves: 0,
            restart_pending: false,
            started: false,
        }
    }

    /// Whether the app holds the machine and so reads its settings (and may measure).
    fn holds(&self) -> bool {
        self.lock.is_some()
    }
}

/// What the app does when `quotum` holds the machine at its start.
#[derive(Debug, PartialEq)]
pub enum OnHeld {
    /// Agreed before: take over without asking.
    TakeOver,
    /// Ask in the window.
    Ask,
    /// Started at login with no window: nobody would see the question, and the app does
    /// not hold the machine without an answer. It quits until it is opened.
    Quit,
}

pub fn on_held(confirmed: bool, window_open: bool) -> OnHeld {
    match (confirmed, window_open) {
        (true, _) => OnHeld::TakeOver,
        (false, true) => OnHeld::Ask,
        (false, false) => OnHeld::Quit,
    }
}

/// Whether closing the window quits the app: while it asks, closing it is the answer no.
pub fn closing_quits(state: &State, confirmed: bool) -> bool {
    matches!(state, State::Held { .. }) && !confirmed
}

/// Native close events must not decide from Starting while startup is about to publish
/// Held. Run after that operation, off the native event loop, and recheck any later open.
pub fn window_closed(shell: &Arc<Shell>) {
    let shell = shell.clone();
    thread::spawn(move || {
        if close_requires_exit(
            &shell.agent,
            &shell.agent_ops,
            || window::is_open_or_opening(&shell),
            || shell.take_over_confirmed(),
        ) {
            shell::quit(&shell);
        }
    });
}

fn close_requires_exit(
    agent: &Mutex<Agent>,
    operations: &Mutex<()>,
    visible: impl FnOnce() -> bool,
    confirmed: impl FnOnce() -> bool,
) -> bool {
    let _ops = operations.lock().unwrap_or_else(|e| e.into_inner());
    !visible() && closing_quits(&agent.lock().unwrap_or_else(|e| e.into_inner()).state, confirmed())
}

/// config.toml as it is now: changed or not since it was read.
fn stat(paths: &Paths) -> Option<(Option<SystemTime>, u64)> {
    fs::metadata(&paths.config).ok().map(|m| (m.modified().ok(), m.len()))
}

fn clients(config: &Config) -> BTreeMap<Provider, Option<PathBuf>> {
    let home = home();
    Provider::ALL
        .into_iter()
        .map(|p| (p, config.program(p).map(PathBuf::from).or_else(|| find_client(adapter(p).as_ref(), &home))))
        .collect()
}

/// Who holds the machine, as the question about taking over names them.
fn holder_info(paths: &Paths, running: Running) -> HolderInfo {
    match paths.run_info() {
        Some(info) if Some(info.pid) == running.pid => HolderInfo { pid: running.pid, hub: info.hub, yields: true },
        // `quotum` 0.3.0 or older: where it delivers is known only from its settings (it may have got --hub).
        _ => {
            let hub = Config::load(&paths.config).ok().and_then(|c| c.hub_or_connected(paths)).map(|h| h.url);
            HolderInfo { pid: running.pid, hub, yields: false }
        }
    }
}

fn describe(error: LockError) -> String {
    match error {
        LockError::Held(Running { app: true, .. }) => "another copy of the Quotum app measures this machine".into(),
        LockError::Held(Running { pid, .. }) => {
            format!("`quotum`{} still measures this machine", pid.map(|p| format!(" (pid {p})")).unwrap_or_default())
        }
        LockError::Io(e) => e,
    }
}

impl Shell {
    fn agent(&self) -> MutexGuard<'_, Agent> {
        self.agent.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set_agent(&self, state: State) {
        self.agent().state = state;
    }
}

/// The hub's first start is ready: the agent takes the machine, or finds who has it.
pub fn start(shell: &Arc<Shell>) {
    let _ops = shell.agent_ops.lock().unwrap_or_else(|e| e.into_inner());
    if shell.exiting() || std::mem::replace(&mut shell.agent().started, true) {
        return;
    }
    // Readable by this user only, even where `quotum` never ran: the spool and client logs are there.
    if let Err(e) = shell.paths.ensure() {
        shell.set_agent(State::Failed { cause: Cause::Lock, error: format!("{}: {e}", shell.paths.state.display()) });
        return;
    }
    match shell.paths.lock_run(Holder::App) {
        Ok(lock) => {
            shell.agent().lock = Some(lock);
            begin(shell);
        }
        Err(LockError::Held(running)) if !running.app => {
            let window_open = window::is_open_or_opening(shell);
            match on_held(shell.take_over_confirmed(), window_open) {
                OnHeld::TakeOver => {
                    drop(_ops);
                    let _ = take_over(shell);
                }
                OnHeld::Ask => shell.set_agent(State::Held { holder: holder_info(&shell.paths, running), error: None }),
                OnHeld::Quit => {
                    shell.agent_log.line("app: `quotum` measures this machine; the app quits until it is opened");
                    shell::quit(shell);
                }
            }
        }
        Err(e) => shell.set_agent(State::Failed { cause: Cause::Lock, error: describe(e) }),
    }
}

/// With the machine held: reads the settings and measures, or is idle, or says the settings are broken.
fn begin(shell: &Arc<Shell>) {
    let _settings = shell.settings_ops.lock().unwrap_or_else(|e| e.into_inner());
    let seen = stat(&shell.paths);
    let loaded = Config::load(&shell.paths.config);
    let mut agent = shell.agent();
    agent.restart_pending = false;
    agent.seen = seen;
    match loaded {
        Ok(config) => {
            agent.clients = clients(&config);
            let idle = Provider::ALL.iter().all(|p| !config.enabled(*p));
            agent.config = config;
            agent.state = if idle { State::Idle } else { State::Measuring };
            drop(agent);
            if !idle {
                run(shell);
            }
            autostart::by_default(shell);
        }
        Err(error) => agent.state = State::Failed { cause: Cause::Config, error },
    }
}

/// Starts measuring for the hub's current start, if it is ready (else its `Ready` will).
fn run(shell: &Arc<Shell>) {
    let (hub, generation) = shell.hub();
    let HubState::Ready(ready) = hub else { return };
    let mut agent = shell.agent();
    // Only under the machine's lock, never twice, and for the start of the hub decided on.
    if !agent.holds() || agent.run.is_some() || shell.generation() != generation || shell.exiting() {
        return;
    }
    let stop = Stop::new();
    let (config, paths, log, last) =
        (agent.config.clone(), shell.paths.clone(), shell.agent_log.clone(), agent.last.clone());
    let (measuring, asked) = (shell.clone(), stop.clone());
    let thread = thread::spawn(move || measure(config, paths, asked, ready, log, last, measuring));
    agent.run = Some(Run { stop, thread, generation });
}

/// One run of the agent: measures on the schedule and delivers to the app's hub.
fn measure(
    config: Config,
    paths: Paths,
    stop: Stop,
    ready: Ready,
    log: Arc<Log>,
    last: Lasts,
    shell: Arc<Shell>,
) -> Option<String> {
    let hub = Hub { url: ready.origin(), token: ready.token };
    let identity = machine(&paths, &config);
    let delivered = log.clone();
    let mut sink = HubSink::new(
        &hub,
        identity,
        paths.state.join("app-spool.jsonl"),
        Box::new(move |line: &str| delivered.line(line)),
    );
    let mut runner = Runner::new(config, paths, &[], stop);
    let mut failing: BTreeMap<Provider, String> = BTreeMap::new();
    runner.run(&mut sink, |event| match event {
        Event::Measured(outcome, _) => {
            record(&last, outcome);
            if let (Ok(_), Some(smoke)) = (outcome, &shell.smoke) {
                smoke.measured(&shell);
            }
            let (provider, summary) = summary(outcome);
            // A failure that repeats itself is logged once.
            let repeated = match outcome {
                Ok(_) => {
                    failing.remove(&provider);
                    false
                }
                Err(_) => failing.insert(provider, summary.clone()).as_ref() == Some(&summary),
            };
            if !repeated {
                log.line(&format!("{}: {summary}", provider.id()));
            }
        }
        Event::Waiting(provider, _) => {
            log.line(&format!("{}: another device measures this subscription", provider.id()));
        }
    })
}

fn summary(outcome: &Outcome) -> (Provider, String) {
    match outcome {
        Ok(s) => {
            let windows: Vec<String> =
                s.windows.iter().map(|w| format!("{} {:.0}% left", w.id, w.remaining())).collect();
            (s.provider, windows.join(", "))
        }
        Err(f) => {
            let detail = f.detail.as_ref().map(|d| format!(": {d}")).unwrap_or_default();
            (f.provider, format!("{}{detail}", f.error.describe()))
        }
    }
}

fn record(last: &Lasts, outcome: &Outcome) {
    let (provider, entry) = match outcome {
        Ok(s) => (s.provider, Last { at: now_ms(), ok: true, error: None, detail: None }),
        Err(f) => (f.provider, Last { at: now_ms(), ok: false, error: Some(f.error), detail: f.detail.clone() }),
    };
    last.lock().unwrap_or_else(|e| e.into_inner()).insert(provider, entry);
}

/// A delivery may outlast the wait. Keep its worker registered until it has finished:
/// starting another would give two independent queues ownership of the same spool.
fn finish_run(agent: &Mutex<Agent>, limit: Duration) -> bool {
    {
        let agent = agent.lock().unwrap_or_else(|e| e.into_inner());
        let Some(run) = &agent.run else { return true };
        run.stop.request(How::Exit);
    }
    let until = Instant::now() + limit;
    loop {
        let finished = {
            let mut agent = agent.lock().unwrap_or_else(|e| e.into_inner());
            if agent.run.as_ref().is_none_or(|run| run.thread.is_finished()) { Some(agent.run.take()) } else { None }
        };
        if let Some(run) = finished {
            if let Some(run) = run {
                let _ = run.thread.join();
            }
            return true;
        }
        if Instant::now() >= until {
            return false;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn halt(shell: &Arc<Shell>, limit: Duration) -> bool {
    finish_run(&shell.agent, limit)
}

/// Measures anew: the settings read again, or the hub started again.
fn restart(shell: &Arc<Shell>) {
    shell.agent().restart_pending = true;
    if !halt(shell, Duration::from_secs(5)) {
        return;
    }
    if shell.agent().holds() && !shell.exiting() {
        begin(shell);
    }
}

/// The hub is ready (started again, maybe): the agent delivers to this start of it, with
/// its token. The events of the hub may come here out of order: what counts is the
/// generation of the run against the hub's current one.
pub fn hub_ready(shell: &Arc<Shell>) {
    let _ops = shell.agent_ops.lock().unwrap_or_else(|e| e.into_inner());
    let current = shell.generation();
    let resume = {
        let agent = shell.agent();
        agent.holds()
            && matches!(agent.state, State::Measuring)
            && agent.run.as_ref().is_none_or(|run| run.generation != current)
    };
    if resume {
        restart(shell);
    }
}

/// The hub stopped (its start of `generation`): nothing goes to its port any more. The
/// machine stays held.
pub fn hub_starting(shell: &Arc<Shell>, generation: u64) {
    let _ops = shell.agent_ops.lock().unwrap_or_else(|e| e.into_inner());
    if shell.agent().run.as_ref().is_some_and(|run| run.generation < generation) {
        halt(shell, Duration::from_secs(5));
    }
}

/// The hub is down for good: the app measures no more and lets the machine go.
pub fn hub_down(shell: &Arc<Shell>) {
    let _ops = shell.agent_ops.lock().unwrap_or_else(|e| e.into_inner());
    halt(shell, Duration::from_secs(5));
    shell.agent().lock.take();
}

/// Quitting: the agent stops within `limit` and the machine is let go.
pub fn quit(shell: &Arc<Shell>, limit: Duration) {
    halt(shell, limit);
    shell.agent().lock.take();
}

/// Takes the machine over from `quotum`: asks it to make way (one that knows how lets go at
/// once and waits; an older one stops), then holds it and measures. Only then the answer
/// is remembered: from now on the app takes over without asking.
pub fn take_over(shell: &Arc<Shell>) -> Result<(), String> {
    let _ops = shell.agent_ops.lock().unwrap_or_else(|e| e.into_inner());
    {
        let mut agent = shell.agent();
        if agent.holds() {
            return Ok(());
        }
        agent.state = State::TakingOver;
    }
    let taken = shell.paths.stop_running(How::Yield).and_then(|_| shell.paths.lock_run(Holder::App).map_err(describe));
    if shell.exiting() {
        return Ok(());
    }
    match taken {
        Ok(lock) => {
            shell.agent().lock = Some(lock);
            shell.confirm_take_over();
            shell.agent_log.line("app: took the machine over from `quotum`");
            begin(shell);
            Ok(())
        }
        Err(error) => {
            let holder = shell.paths.running().map(|r| holder_info(&shell.paths, r));
            let holder = holder.unwrap_or(HolderInfo { pid: None, hub: None, yields: false });
            shell.agent_log.line(&format!("app: could not take the machine over: {error}"));
            shell.set_agent(State::Held { holder, error: Some(error.clone()) });
            Err(error)
        }
    }
}

/// Every five seconds, window or not: takes a machine let go, follows config.toml, and
/// notices an agent that stopped by itself.
pub fn tick(shell: &Arc<Shell>) {
    let Ok(_ops) = shell.agent_ops.try_lock() else { return };
    if shell.exiting() || matches!(shell.hub().0, HubState::Down) {
        return;
    }
    let state = shell.agent().state.clone();
    match state {
        State::Held { error, .. } => match shell.paths.lock_run(Holder::App) {
            Ok(lock) => {
                shell.agent().lock = Some(lock);
                shell.agent_log.line("app: `quotum` let the machine go; measuring");
                begin(shell);
            }
            Err(LockError::Held(running)) if !running.app => {
                shell.set_agent(State::Held { holder: holder_info(&shell.paths, running), error })
            }
            Err(_) => {}
        },
        State::Measuring | State::Idle | State::Failed { cause: Cause::Config, .. } if shell.agent().holds() => {
            let panicked = {
                let mut agent = shell.agent();
                match &agent.run {
                    Some(run) if run.thread.is_finished() && !run.stop.requested() => agent.run.take(),
                    _ => None,
                }
            };
            if let Some(run) = panicked {
                let why = match run.thread.join() {
                    Ok(Some(reason)) => reason,
                    Ok(None) => "it ended".into(),
                    Err(_) => "it panicked".into(),
                };
                shell.agent_log.line(&format!("app: the agent stopped unexpectedly: {why}"));
                let mut agent = shell.agent();
                agent.state = State::Failed {
                    cause: Cause::Panic,
                    error: "the agent stopped unexpectedly; see agent.log".into(),
                };
                // It measures no more: the machine is let go, and a waiting `quotum` goes on.
                agent.lock.take();
                return;
            }
            let now = stat(&shell.paths);
            let changed = {
                let mut agent = shell.agent();
                agent.clients = clients(&agent.config);
                let changed = agent.seen != now;
                agent.seen = now;
                changed
            };
            if changed {
                shell.agent_log.line("app: config.toml changed; reading it again");
                restart(shell);
            } else if shell.agent().restart_pending {
                restart(shell);
            }
        }
        _ => {}
    }
}

/// Changes the settings in config.toml; the agent measures with them in a moment.
pub fn save_settings(shell: &Arc<Shell>, patch: &Patch) -> Result<(), String> {
    let number = accept_settings(&shell.paths, &shell.agent, &shell.settings_ops, patch)?;
    let shell = shell.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(1500));
        let _ops = shell.agent_ops.lock().unwrap_or_else(|e| e.into_inner());
        let current = {
            let agent = shell.agent();
            agent.saves == number
                && agent.holds()
                && matches!(agent.state, State::Measuring | State::Idle | State::Failed { cause: Cause::Config, .. })
        };
        if current {
            restart(&shell);
        }
    });
    Ok(())
}

/// File replacement and its published snapshot form one transaction, also when the
/// native command transport runs several saves concurrently.
fn accept_settings(paths: &Paths, state: &Mutex<Agent>, writes: &Mutex<()>, patch: &Patch) -> Result<u64, String> {
    let _settings = writes.lock().unwrap_or_else(|e| e.into_inner());
    settings::save(&paths.config, patch)?;
    let config = Config::load(&paths.config)?;
    let mut agent = state.lock().unwrap_or_else(|e| e.into_inner());
    // Publish accepted settings now; replacing the running worker is debounced.
    agent.config = config;
    // Its own write is no change to follow: the ticker would restart once more.
    agent.seen = stat(paths);
    agent.saves += 1;
    Ok(agent.saves)
}

/// The board's view of the agent (`app_state`). The intervals are always there, `null`
/// when not set: with a hub, no interval of a provider means the hub measures it as often
/// as needed, and the board offers that choice.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provided {
    pub id: &'static str,
    pub enabled: bool,
    /// The most often it is measured, and where that is set.
    pub interval_s: Option<u64>,
    pub interval_from: Option<&'static str>,
    /// The interval set for all providers, and where.
    pub inherited_s: Option<u64>,
    pub inherited_from: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last: Option<Last>,
}

pub fn snapshot(shell: &Arc<Shell>) -> (State, Vec<Provided>, bool) {
    let agent = shell.agent();
    let last = agent.last.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let providers = Provider::ALL
        .into_iter()
        .map(|p| Provided {
            id: p.id(),
            enabled: agent.config.enabled(p),
            interval_s: agent.config.min_interval_ms(p).map(|ms| ms / 1000),
            interval_from: agent.config.interval_source(p).map(source_id),
            inherited_s: agent.config.global_interval().map(|(ms, _)| ms / 1000),
            inherited_from: agent.config.global_interval().map(|(_, source)| source_id(source)),
            account: agent.config.account_name(p).map(str::to_string),
            client: agent.clients.get(&p).cloned().flatten().map(|c| c.display().to_string()),
            last: last.get(&p).cloned(),
        })
        .collect();
    (agent.state.clone(), providers, agent.config.sessions())
}

/// Where an interval is set, as the board names it.
fn source_id(source: IntervalSource) -> &'static str {
    match source {
        IntervalSource::Provider => "provider",
        IntervalSource::File => "file",
        IntervalSource::Env => "env",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intervals_not_set_go_to_the_board_as_null() {
        let provided = Provided {
            id: "codex",
            enabled: true,
            interval_s: None,
            interval_from: None,
            inherited_s: None,
            inherited_from: None,
            account: None,
            client: None,
            last: None,
        };
        let json = serde_json::to_value(&provided).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"id": "codex", "enabled": true, "intervalS": null, "intervalFrom": null, "inheritedS": null, "inheritedFrom": null})
        );
        let set =
            Provided { interval_s: Some(300), interval_from: Some(source_id(IntervalSource::Provider)), ..provided };
        assert_eq!(serde_json::to_value(&set).unwrap()["intervalFrom"], "provider");
    }

    #[test]
    fn a_slow_stopped_worker_keeps_ownership_until_it_finishes() {
        use quotum_core::model::{ErrorKind, Failure, Machine};
        use quotum_core::sink::Sink;
        use std::io::{BufRead, BufReader, Read, Write};
        use std::net::TcpListener;

        let dir = std::env::temp_dir().join(format!("quotum-spool-handover-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let spool = dir.join("app-spool.jsonl");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let hub = Hub { url: format!("http://{}", listener.local_addr().unwrap()), token: "qt_m_test".into() };
        let identity =
            Machine { id: "0123456789abcdef".into(), name: "test".into(), os: "linux".into(), arch: "x86_64".into() };
        let (release, held) = std::sync::mpsc::channel();
        let (entered, request) = std::sync::mpsc::channel();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut reader = BufReader::new(stream);
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") {
                        length = value.trim().parse().unwrap();
                    }
                }
            }
            reader.read_exact(&mut vec![0; length]).unwrap();
            entered.send(()).unwrap();
            held.recv_timeout(Duration::from_secs(5)).unwrap();
            reader
                .get_mut()
                .write_all(b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .unwrap();
        });
        let mut sink = HubSink::new(&hub, identity.clone(), spool.clone(), Box::new(|_| {}));
        let mut agent = Agent::new();
        let stop = Stop::new();
        let observed = stop.clone();
        agent.run = Some(Run {
            stop,
            thread: thread::spawn(move || {
                sink.deliver(&Err(Failure::new(Provider::Codex, ErrorKind::Failed, "before restart")));
                None
            }),
            generation: 1,
        });
        let agent = Mutex::new(agent);
        request.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(!finish_run(&agent, Duration::ZERO));
        assert!(observed.requested());
        assert!(agent.lock().unwrap().run.is_some(), "the spool is still owned by the old worker");
        release.send(()).unwrap();
        assert!(finish_run(&agent, Duration::from_secs(2)));
        assert!(agent.lock().unwrap().run.is_none());
        server.join().unwrap();
        // The successor opens the queue only after the old delivery persisted it.
        let mut next = HubSink::new(&hub, identity, spool.clone(), Box::new(|_| {}));
        next.deliver(&Err(Failure::new(Provider::Codex, ErrorKind::Failed, "after restart")));
        let persisted = fs::read_to_string(&spool).unwrap();
        assert!(persisted.contains("before restart") && persisted.contains("after restart"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_patches_are_both_saved_and_published_before_restart() {
        let dir = std::env::temp_dir().join(format!("quotum-accepted-settings-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let paths = Paths { config: dir.join("config.toml"), work: dir.join("work"), state: dir.clone() };
        let state = Mutex::new(Agent::new());
        let writes = Mutex::new(());
        let first: Patch = serde_json::from_str(r#"{"sessions":false}"#).unwrap();
        let second: Patch = serde_json::from_str(r#"{"providers":{"antigravity":{"account":"changed"}}}"#).unwrap();
        let ready = std::sync::Barrier::new(2);
        thread::scope(|scope| {
            for patch in [&first, &second] {
                let (paths, state, writes, ready) = (&paths, &state, &writes, &ready);
                scope.spawn(move || {
                    ready.wait();
                    accept_settings(paths, state, writes, patch).unwrap();
                });
            }
        });
        let agent = state.lock().unwrap();
        assert_eq!(agent.saves, 2);
        assert!(!agent.config.sessions());
        assert_eq!(agent.config.account_name(Provider::Antigravity), Some("changed"));
        let saved = Config::load(&paths.config).unwrap();
        assert!(!saved.sessions());
        assert_eq!(saved.account_name(Provider::Antigravity), Some("changed"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn quotum_holding_the_machine_is_asked_about_only_in_the_window() {
        assert_eq!(on_held(true, false), OnHeld::TakeOver, "agreed before: without a question");
        assert_eq!(on_held(false, true), OnHeld::Ask);
        assert_eq!(on_held(false, false), OnHeld::Quit, "no window, no question: the app goes");
    }

    #[test]
    fn closing_the_window_while_asked_is_the_answer_no() {
        let held = State::Held { holder: HolderInfo { pid: Some(1), hub: None, yields: true }, error: None };
        assert!(closing_quits(&held, false));
        assert!(!closing_quits(&held, true), "held after agreeing: a failed take-over, retried in the background");
        assert!(!closing_quits(&State::Measuring, false));
    }

    #[test]
    fn closing_during_startup_waits_for_the_takeover_decision() {
        let agent = Arc::new(Mutex::new(Agent::new()));
        let operations = Arc::new(Mutex::new(()));
        let (seen, open_seen) = std::sync::mpsc::channel();
        let (publish, held) = std::sync::mpsc::channel();
        let (result, closed) = std::sync::mpsc::channel();
        let (starting, serial) = (agent.clone(), operations.clone());
        let startup = thread::spawn(move || {
            let _ops = serial.lock().unwrap();
            // Startup has seen a foreground window, but is still reading holder info.
            seen.send(()).unwrap();
            held.recv_timeout(Duration::from_secs(3)).unwrap();
            starting.lock().unwrap().state =
                State::Held { holder: HolderInfo { pid: Some(42), hub: None, yields: true }, error: None };
        });
        open_seen.recv_timeout(Duration::from_secs(3)).unwrap();
        let (closing, serial) = (agent.clone(), operations.clone());
        let closer = thread::spawn(move || {
            result.send(close_requires_exit(&closing, &serial, || false, || false)).unwrap();
        });
        assert!(closed.recv_timeout(Duration::from_millis(50)).is_err(), "no decision from Starting");
        publish.send(()).unwrap();
        assert!(closed.recv_timeout(Duration::from_secs(3)).unwrap(), "the invisible question is declined");
        startup.join().unwrap();
        closer.join().unwrap();
        assert!(!close_requires_exit(&agent, &operations, || true, || false), "a later open stays");
        assert!(!close_requires_exit(&agent, &operations, || false, || true), "consent was already given");
    }

    #[test]
    fn the_board_reads_the_state_in_its_own_words() {
        let held = State::Held {
            holder: HolderInfo { pid: Some(42), hub: Some("https://q.example".into()), yields: true },
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&held).unwrap(),
            serde_json::json!({"state": "held", "holder": {"pid": 42, "hub": "https://q.example", "yields": true}})
        );
        let failed = State::Failed { cause: Cause::Config, error: "x".into() };
        assert_eq!(
            serde_json::to_value(&failed).unwrap(),
            serde_json::json!({"state": "failed", "cause": "config", "error": "x"})
        );
        assert_eq!(serde_json::to_value(State::TakingOver).unwrap(), serde_json::json!({"state": "taking_over"}));
        let last = Last { at: 1, ok: false, error: Some(quotum_core::model::ErrorKind::NotLoggedIn), detail: None };
        assert_eq!(
            serde_json::to_value(&last).unwrap(),
            serde_json::json!({"at": 1, "ok": false, "error": "not_logged_in"})
        );
    }
}
