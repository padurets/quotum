//! Drives the adapters: once for a status check, or continuously on the schedule.

use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use crate::activity::Activity;
use crate::config::{Config, Paths, home, jitter};
use crate::model::{ErrorKind, Millis, Outcome, Provider, RunningSession, STALE_LIMIT_MS, now_ms};
use crate::providers::{Adapter, Context, adapter, find_client, last_activity};
use crate::schedule::Schedule;
use crate::sink::{Ask, Directive, Sink};
use crate::stop::Stop;

/// A single measurement may take this long before the client is killed.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(60);
/// The loop wakes at least this often, to notice a stop request or a jump of the clock.
const TICK: Duration = Duration::from_secs(1);
/// A wall clock set back by less than this is not worth correcting for.
const CLOCK_SLACK_MS: Millis = 2_000;

/// How often the agent looks at which coding agents run here, and how often it tells the
/// hub at least while any run (the hub keeps a list for five minutes).
const LOOK_EVERY: Duration = Duration::from_secs(15);
const REPORT_EVERY: Duration = Duration::from_secs(120);

/// Which coding agents run on this machine, told to the hub when that changes.
struct Watch {
    activity: Activity,
    looked: Option<Instant>,
    reported: Option<(Instant, Vec<RunningSession>)>,
}

impl Watch {
    /// Whether `now` is a new list to send: the first one, a change, or one repeated in time.
    fn worth_sending(&self, sessions: &[RunningSession]) -> bool {
        match &self.reported {
            None => true,
            Some((at, before)) => before != sessions || (!sessions.is_empty() && at.elapsed() >= REPORT_EVERY),
        }
    }
}

/// The wall clock as last seen, with the monotonic clock at that moment.
struct Clock {
    at: Instant,
    wall: Millis,
}

impl Clock {
    fn new(wall: Millis) -> Clock {
        Clock { at: Instant::now(), wall }
    }

    /// How far the wall clock went back since the last look, measured against the
    /// monotonic clock; 0 when it did not. A jump forward is left alone: after a
    /// sleep everything is overdue anyway.
    fn went_back(&mut self, wall: Millis) -> Millis {
        let back = self.at.elapsed().as_millis() as Millis - (wall - self.wall);
        *self = Clock::new(wall);
        if back > CLOCK_SLACK_MS { back } else { 0 }
    }
}

pub struct Runner {
    config: Config,
    paths: Paths,
    home: PathBuf,
    adapters: Vec<Box<dyn Adapter>>,
    /// Ends this run, a measurement under way included.
    stop: Stop,
}

impl Runner {
    /// Adapters for the enabled providers, cheapest first: Codex, Claude, Antigravity.
    pub fn new(config: Config, paths: Paths, only: &[Provider], stop: Stop) -> Runner {
        let order = [Provider::Codex, Provider::Claude, Provider::Antigravity];
        let adapters = order
            .into_iter()
            .filter(|p| config.enabled(*p) && (only.is_empty() || only.contains(p)))
            .map(adapter)
            .collect();
        Runner::with_adapters(config, paths, adapters, home(), stop)
    }

    /// A runner of the given adapters, in the order they are measured, with `home` as the user's.
    pub fn with_adapters(
        config: Config,
        paths: Paths,
        adapters: Vec<Box<dyn Adapter>>,
        home: PathBuf,
        stop: Stop,
    ) -> Runner {
        Runner { config, paths, home, adapters, stop }
    }

    pub fn providers(&self) -> Vec<Provider> {
        self.adapters.iter().map(|a| a.provider()).collect()
    }

    fn measure(&mut self, index: usize) -> Outcome {
        let adapter = &mut self.adapters[index];
        let provider = adapter.provider();
        let ctx = Context {
            home: &self.home,
            work_dir: &self.paths.work,
            state_dir: &self.paths.state,
            program: self.config.program(provider),
            timeout: CLIENT_TIMEOUT,
            stop: &self.stop,
        };
        let mut outcome = adapter.measure(&ctx);
        if let Ok(snapshot) = &mut outcome {
            if snapshot.account.is_none() {
                snapshot.account_name = self.config.account_name(provider).map(str::to_string);
            }
            snapshot.tidy();
        }
        outcome
    }

    /// Whether the provider's client is on this machine: a device checks in only for
    /// what it can measure, or it would keep duty from one that can.
    fn installed(&self, index: usize) -> bool {
        let adapter = &self.adapters[index];
        match self.config.program(adapter.provider()) {
            Some(path) => path.exists(),
            None => find_client(adapter.as_ref(), &self.home).is_some(),
        }
    }

    /// Measures every provider once, one after another, reporting each as it finishes.
    pub fn measure_all(&mut self, mut each: impl FnMut(&Outcome)) {
        for index in 0..self.adapters.len() {
            let mut outcome = self.measure(index);
            if let Ok(snapshot) = &mut outcome {
                snapshot.stale_after_ms = self.config.interval_ms(snapshot.provider).min(STALE_LIMIT_MS);
            }
            each(&outcome);
        }
    }

    /// Measures on the schedule until its stop is requested or the hub refuses this device
    /// for good (then its reason is returned). When it is time, the device checks in with
    /// the hub (when there is one) about every provider due, in one request: the hub says
    /// which to measure now and when to ask again. While the hub sets the pace of a
    /// provider, it is asked often and the provider measured only when told; if another
    /// device measures the same subscription, this one only waits.
    pub fn run(&mut self, sink: &mut dyn Sink, mut each: impl FnMut(Event)) -> Option<String> {
        let intervals: Vec<u64> = self.adapters.iter().map(|a| self.config.interval_ms(a.provider())).collect();
        let least: Vec<Option<u64>> = self.adapters.iter().map(|a| self.config.min_interval_ms(a.provider())).collect();
        let mut schedule = Schedule::new(&intervals, now_ms(), self.config.eco());
        let activity_paths: Vec<Vec<PathBuf>> = self.adapters.iter().map(|a| a.activity_paths(&self.home)).collect();
        let identity_paths: Vec<Vec<PathBuf>> = self.adapters.iter().map(|a| a.identity_paths(&self.home)).collect();
        let mut seen: Vec<Option<SystemTime>> = vec![None; self.adapters.len()];
        // Whether each provider was used here since it was last looked at, for its own rhythm.
        let mut used = vec![false; self.adapters.len()];
        // The account each provider last reported, and the state of its sign-in files then.
        let mut accounts: Vec<Option<(Option<String>, Option<SystemTime>)>> = vec![None; self.adapters.len()];
        let mut clock = Clock::new(now_ms());
        let mut watch = self.config.sessions().then(|| Watch {
            activity: Activity::new(self.home.clone(), self.config.projects()),
            looked: None,
            reported: None,
        });

        while !self.stop.requested() {
            if let Some(reason) = sink.refused() {
                return Some(reason.to_string());
            }
            // Only while the list can go somewhere: no looking for a hub that does not take it
            // (now: an older one is asked again later, and looking starts over then).
            if let Some(watch) = watch.as_mut().filter(|_| !sink.takes_sessions()) {
                watch.looked = None;
            }
            if let Some(watch) =
                watch.as_mut().filter(|w| sink.takes_sessions() && w.looked.is_none_or(|at| at.elapsed() >= LOOK_EVERY))
            {
                let first = watch.looked.is_none();
                watch.looked = Some(Instant::now());
                let seen = watch.activity.look();
                // The first look cannot tell working from idle: the list goes out from the second.
                if !first {
                    let sessions = self.running(seen, &accounts, &identity_paths);
                    // A list the hub did not take goes out again at the next look.
                    if watch.worth_sending(&sessions) && sink.sessions(&sessions) {
                        watch.reported = Some((Instant::now(), sessions));
                    }
                }
            }
            // A clock set back (by hand, or synced after a wrong start) would leave every
            // due time far ahead: move them back with it.
            let back = clock.went_back(now_ms());
            if back > 0 {
                schedule.shift(-back);
            }

            // What the last answer cleared is measured first, one after another.
            if let Some((index, next_in_ms)) = schedule.take_cleared() {
                // A run asked to stop starts no client, whatever it waited for until now.
                if self.stop.requested() {
                    break;
                }
                // As the sign-in files were before it: a sign-in during the measurement (or a token
                // it refreshed) leaves the account unknown until the next one, never another's.
                let signed_in = last_activity(&identity_paths[index]);
                let mut outcome = self.measure(index);
                if self.stop.requested() {
                    break;
                }
                // Taken after the measurement, so the client's own writes do not count as use.
                seen[index] = last_activity(&activity_paths[index]).or(Some(SystemTime::UNIX_EPOCH));
                if let Ok(snapshot) = &outcome {
                    accounts[index] = Some((snapshot.account.clone(), signed_in));
                }
                let now = now_ms();
                let gone = matches!(&outcome, Err(failure) if failure.error == ErrorKind::NotInstalled);
                let next = match next_in_ms {
                    // The hub waits out failures and promised the next measurement; the client
                    // gone since it was asked for goes on its own rhythm, as one never there.
                    Some(next_in_ms) if !gone => {
                        let stale_after_ms = schedule.measured_paced(index, now, next_in_ms);
                        if let Ok(snapshot) = &mut outcome {
                            snapshot.stale_after_ms = stale_after_ms;
                        }
                        now + next_in_ms as Millis
                    }
                    _ => {
                        schedule.unpace(index);
                        let next = schedule.complete(index, now, &outcome, used[index], jitter());
                        if let Ok(snapshot) = &mut outcome {
                            snapshot.stale_after_ms = schedule.stale_after_ms(index, now);
                        }
                        next
                    }
                };
                sink.deliver(&outcome);
                each(Event::Measured(&outcome, next));
                continue;
            }

            let now = now_ms();
            let due = schedule.asks(now);
            if due.is_empty() {
                let (_, due) = schedule.next()?;
                let wait = due - now_ms();
                if wait > 0 {
                    thread::sleep(Duration::from_millis(wait as u64).min(TICK));
                }
                continue;
            }
            let mut asked: Vec<(usize, Option<String>)> = Vec::new();
            for index in due {
                let adapter = &self.adapters[index];
                let before = seen[index];
                let latest = last_activity(&activity_paths[index]);
                used[index] = before.is_some() && latest > before;
                seen[index] = latest.or(Some(SystemTime::UNIX_EPOCH));
                // Which subscription this is, if known without starting the client.
                let account = if !self.installed(index) {
                    // Measured right away: it fails without starting anything and is asked less often.
                    None
                } else if !adapter.identifies_account() {
                    Some(None)
                } else {
                    let signed_in = last_activity(&identity_paths[index]);
                    ask_account(&schedule, index, adapter.local_account(&self.home), &accounts[index], signed_in)
                };
                match account {
                    Some(account) => asked.push((index, account)),
                    None => schedule.leave_out(index),
                }
            }
            if asked.is_empty() {
                continue;
            }
            let asks: Vec<Ask> = asked
                .iter()
                .map(|(index, account)| {
                    let provider = self.adapters[*index].provider();
                    Ask {
                        provider,
                        account: account.as_deref(),
                        account_name: self.config.account_name(provider).filter(|_| account.is_none()),
                        active: used[*index],
                        min_interval_ms: least[*index],
                    }
                })
                .collect();
            let directives = sink.checkin(&asks);
            // Refused just now: measuring would only start a client for nothing.
            if let Some(reason) = sink.refused() {
                return Some(reason.to_string());
            }
            // The hub answers again: what it did not take before goes now, or it would take the provider for silent.
            if directives.iter().any(|d| *d != Directive::Unanswered) {
                sink.flush();
            }
            let answers: Vec<(usize, Directive)> = asked.iter().map(|(index, _)| *index).zip(directives).collect();
            for index in schedule.answer(&answers, now_ms()) {
                each(Event::Waiting(self.adapters[index].provider(), schedule.due(index)));
            }
        }
        None
    }
}

impl Runner {
    /// The coding agents seen running, as the hub is told: of the providers measured here,
    /// each with its subscription as far as it is known, the project's name only if allowed.
    fn running(
        &self,
        seen: Vec<crate::activity::Session>,
        accounts: &[Option<(Option<String>, Option<SystemTime>)>],
        identity_paths: &[Vec<PathBuf>],
    ) -> Vec<RunningSession> {
        let sessions = seen
            .into_iter()
            .filter_map(|session| {
                let index = self.adapters.iter().position(|a| a.provider() == session.provider)?;
                let adapter = &self.adapters[index];
                let (account, account_name) = if adapter.identifies_account() {
                    let signed_in = last_activity(&identity_paths[index]);
                    // Not known (signed in anew since measured): left out rather than filed
                    // under whatever the hub last saw from this machine.
                    (current_account(adapter.local_account(&self.home), &accounts[index], signed_in)?, None)
                } else {
                    (None, self.config.account_name(session.provider).map(str::to_string))
                };
                let (project, folder) = names(session.project, session.folder, self.config.projects());
                Some(RunningSession {
                    provider: session.provider,
                    account,
                    account_name,
                    origin: session.origin.id(),
                    project,
                    folder,
                    started_at: session.started_at,
                    last_worked_at: session.last_worked,
                    working: session.working == Some(true),
                })
            })
            .collect();
        capped(sessions)
    }
}

/// The names a session is reported with: none when project names are turned off; its
/// folder only where it is not its project. Each as long as a hub takes it (spec: text
/// fields); the hub would cut it too.
fn names(project: Option<String>, folder: Option<String>, allowed: bool) -> (Option<String>, Option<String>) {
    if !allowed {
        return (None, None);
    }
    let cut = |name: String| name.chars().take(120).collect::<String>();
    let (project, folder) = (project.map(cut), folder.map(cut));
    let folder = folder.filter(|folder| project.as_ref() != Some(folder));
    (project, folder)
}

/// A hub takes at most this many sessions of a machine at once (spec: Reporting running agents).
const MAX_SESSIONS: usize = 200;

/// A list the hub can take: working first, then those that worked most recently, then the newest.
fn capped(mut sessions: Vec<RunningSession>) -> Vec<RunningSession> {
    if sessions.len() > MAX_SESSIONS {
        sessions.sort_by_key(|s| {
            std::cmp::Reverse((s.working, if s.working { None } else { s.last_worked_at }, s.started_at))
        });
        sessions.truncate(MAX_SESSIONS);
    }
    sessions
}

/// The account the client is signed in to now: the one it names on this machine, else
/// the one it last reported while its sign-in files are as they were then; no account
/// (`Some(None)`) when it named none or has not been measured yet, and the hub takes the
/// one this machine last delivered. A sign-in since the measurement makes it unknown
/// (`None`) until measured again.
fn current_account(
    local: Option<String>,
    measured: &Option<(Option<String>, Option<SystemTime>)>,
    signed_in: Option<SystemTime>,
) -> Option<Option<String>> {
    match (local, measured) {
        (Some(local), _) => Some(Some(local)),
        (None, None) => Some(None),
        (None, Some((account, at))) => (*at == signed_in).then(|| account.clone()),
    }
}

/// The account to check in with, when known without starting the client: the one it
/// names on this machine, else the one it last reported while its sign-in files are as
/// they were then. While the hub sets the pace, the last one reported stands even after a
/// sign-in: the measurement the hub asks for shows which account it is now.
fn ask_account(
    schedule: &Schedule,
    index: usize,
    local: Option<String>,
    measured: &Option<(Option<String>, Option<SystemTime>)>,
    signed_in: Option<SystemTime>,
) -> Option<Option<String>> {
    if local.is_some() {
        return Some(local);
    }
    let (account, at) = measured.as_ref()?;
    (schedule.paced(index) || *at == signed_in).then(|| account.clone())
}

/// What happened to one scheduled slot.
pub enum Event<'a> {
    /// Measured (or failed); the next run is due at the given time.
    Measured(&'a Outcome, Millis),
    /// Another device measures this subscription; ask again at the given time.
    Waiting(Provider, Millis),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_list_keeps_the_working_sessions_and_then_the_newest() {
        let session = |working, started_at| RunningSession {
            provider: Provider::Claude,
            account: None,
            account_name: None,
            origin: "terminal",
            project: None,
            folder: None,
            started_at,
            last_worked_at: None,
            working,
        };
        let list: Vec<_> = (0..250).map(|i| session(i % 50 == 0, i)).collect();
        let mut recent = session(false, 1);
        recent.last_worked_at = Some(300);
        let mut older = session(false, 2);
        older.last_worked_at = Some(290);
        let kept = capped([list, vec![older, recent]].concat());
        assert_eq!(kept.len(), MAX_SESSIONS);
        assert_eq!(kept.iter().filter(|s| s.working).count(), 5, "every working one");
        assert_eq!(kept[0].started_at, 200, "newest working first");
        assert_eq!(kept[5].last_worked_at, Some(300), "recent work precedes newer sessions never seen working");
        assert_eq!(kept[6].last_worked_at, Some(290));
        assert_eq!(kept.last().map(|s| s.started_at), Some(54), "then the newest idle ones");
        assert_eq!(capped(vec![session(false, 1)]).len(), 1, "a short list as it is");
    }

    #[test]
    fn a_session_is_reported_with_its_folder_only_where_that_is_not_its_project() {
        let some = |name: &str| Some(name.to_string());
        assert_eq!(names(some("quotum"), some("hub"), false), (None, None), "turned off");
        assert_eq!(names(some("quotum"), some("quotum"), true), (some("quotum"), None));
        assert_eq!(names(some("quotum"), some("hub"), true), (some("quotum"), some("hub")));
        assert_eq!(names(None, some("scratch"), true), (None, some("scratch")), "a folder of no project");
        let long = "й".repeat(130);
        let cut = "й".repeat(120);
        assert_eq!(names(some(&long), some(&format!("{long}-feat")), true), (Some(cut), None), "alike once cut");
    }

    #[test]
    fn a_session_is_filed_under_the_account_signed_in_now() {
        let then = Some(SystemTime::UNIX_EPOCH);
        let later = Some(SystemTime::UNIX_EPOCH + Duration::from_secs(60));
        let measured = Some((Some("a".to_string()), then));
        assert_eq!(
            current_account(Some("b".into()), &measured, later),
            Some(Some("b".into())),
            "what the client names now"
        );
        assert_eq!(current_account(None, &measured, then), Some(Some("a".into())), "measured, and not signed in since");
        assert_eq!(current_account(None, &measured, later), None, "signed in again since: not known");
        assert_eq!(current_account(None, &None, later), Some(None), "not measured yet: the hub's guess");
        assert_eq!(current_account(None, &Some((None, then)), then), Some(None), "measured, and named no account");
    }

    #[test]
    fn a_list_of_running_agents_goes_out_first_on_change_and_then_in_time() {
        let session = |working| RunningSession {
            provider: Provider::Claude,
            account: None,
            account_name: None,
            origin: "terminal",
            project: None,
            folder: None,
            started_at: 0,
            last_worked_at: None,
            working,
        };
        let mut watch =
            Watch { activity: Activity::new(PathBuf::from("/nowhere"), true), looked: None, reported: None };
        assert!(watch.worth_sending(&[]), "the first, even empty: the hub may still hold an older one");
        watch.reported = Some((Instant::now(), vec![session(true)]));
        assert!(!watch.worth_sending(&[session(true)]));
        assert!(watch.worth_sending(&[session(false)]));
        assert!(watch.worth_sending(&[]), "none runs any more");
        let mut idle = session(false);
        idle.last_worked_at = Some(15_000);
        watch.reported = Some((Instant::now(), vec![idle.clone()]));
        assert!(!watch.worth_sending(&[idle.clone()]), "a remembered date stays equal on later idle looks");
        idle.last_worked_at = None;
        assert!(watch.worth_sending(&[idle.clone()]), "a clock correction can send one changed list");
        watch.reported = Some((Instant::now(), vec![idle.clone()]));
        assert!(!watch.worth_sending(&[idle]), "then idle dates stay unknown until new work");
        watch.reported = Some((Instant::now() - REPORT_EVERY, vec![session(true)]));
        assert!(watch.worth_sending(&[session(true)]), "in time, so the hub keeps it");
        watch.reported = Some((Instant::now() - REPORT_EVERY, vec![]));
        assert!(!watch.worth_sending(&[]), "an empty list said once is enough");
    }

    #[test]
    fn a_clock_set_back_is_noticed_and_a_jump_forward_is_not() {
        let start = 10 * 3_600_000;
        let mut clock = Clock::new(start);
        assert_eq!(clock.went_back(start + 5), 0);
        let back = clock.went_back(start - 3_600_000);
        assert!((3_600_000..3_601_000).contains(&back), "{back}");
        assert_eq!(clock.went_back(start + 3_600_000), 0);
    }

    /// A hub that refuses the device at its first check-in.
    #[derive(Default)]
    struct Refusing {
        delivered: usize,
        refused: Option<String>,
    }

    impl Sink for Refusing {
        fn deliver(&mut self, _: &Outcome) {
            self.delivered += 1;
        }

        fn checkin(&mut self, asks: &[Ask]) -> Vec<Directive> {
            self.refused = Some("removed".into());
            vec![Directive::Unanswered; asks.len()]
        }

        fn refused(&self) -> Option<&str> {
            self.refused.as_deref()
        }
    }

    #[test]
    fn a_device_refused_at_check_in_starts_no_client() {
        // Any file that exists stands for the client: it is never started.
        let client = std::env::current_exe().unwrap();
        let config: Config = toml::from_str(&format!("[providers.antigravity]\npath = {:?}", client)).unwrap();
        let state = std::env::temp_dir().join("quotum-runner-refused");
        let paths = Paths { config: state.join("config.toml"), work: state.join("work"), state };
        let mut runner = Runner::new(config, paths, &[Provider::Antigravity], Stop::new());
        let mut sink = Refusing::default();
        let mut events = 0;
        assert_eq!(runner.run(&mut sink, |_| events += 1).as_deref(), Some("removed"));
        assert_eq!((events, sink.delivered), (0, 0));
    }

    /// Counts check-ins; the first delivery ends the run.
    #[derive(Default)]
    struct Counting {
        checkins: usize,
        refused: Option<String>,
    }

    impl Sink for Counting {
        fn deliver(&mut self, _: &Outcome) {
            self.refused = Some("done".into());
        }

        fn checkin(&mut self, asks: &[Ask]) -> Vec<Directive> {
            self.checkins += 1;
            vec![Directive::Measure { paced: None }; asks.len()]
        }

        fn refused(&self) -> Option<&str> {
            self.refused.as_deref()
        }
    }

    #[test]
    fn a_client_that_is_not_there_is_not_checked_in_for() {
        let config: Config = toml::from_str("[providers.antigravity]\npath = \"/nonexistent/agy\"").unwrap();
        let state = std::env::temp_dir().join("quotum-runner-missing");
        let paths = Paths { config: state.join("config.toml"), work: state.join("work"), state };
        let mut runner = Runner::new(config, paths, &[Provider::Antigravity], Stop::new());
        let mut sink = Counting::default();
        assert_eq!(runner.run(&mut sink, |_| {}).as_deref(), Some("done"));
        assert_eq!(sink.checkins, 0, "no duty is claimed for a client this machine lacks");
    }

    /// Takes whatever it is given, and counts what it delivers.
    #[derive(Default)]
    struct Taking {
        delivered: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    impl Sink for Taking {
        fn deliver(&mut self, _: &Outcome) {
            self.delivered.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// A runner of one provider whose client is not there: it measures (and fails) at
    /// once, without starting anything, and then waits for the next time.
    fn missing_client(name: &str, stop: Stop) -> Runner {
        let config: Config = toml::from_str("[providers.antigravity]\npath = \"/nonexistent/agy\"").unwrap();
        let state = std::env::temp_dir().join(name);
        let paths = Paths { config: state.join("config.toml"), work: state.join("work"), state };
        Runner::new(config, paths, &[Provider::Antigravity], stop)
    }

    #[test]
    fn a_stopped_run_ends_and_a_new_run_with_a_new_stop_measures_again() {
        for round in 0..2 {
            let stop = Stop::new();
            let mut runner = missing_client("quotum-runner-stop", stop.clone());
            let sink = Taking::default();
            let delivered = sink.delivered.clone();
            let (done, ended) = std::sync::mpsc::channel();
            thread::spawn(move || {
                let mut sink = sink;
                let _ = done.send(runner.run(&mut sink, |_| {}));
            });
            let until = Instant::now() + Duration::from_secs(3);
            while delivered.load(std::sync::atomic::Ordering::SeqCst) == 0 && Instant::now() < until {
                thread::sleep(Duration::from_millis(20));
            }
            assert_eq!(delivered.load(std::sync::atomic::Ordering::SeqCst), 1, "round {round}: measured");
            stop.request(crate::stop::How::Exit);
            let result = ended.recv_timeout(Duration::from_secs(3));
            assert!(matches!(result, Ok(None)), "round {round}: the run ended on its stop");
        }
    }

    /// A client that answers what it is told to, and counts how often it was started.
    struct Scripted {
        outcome: fn() -> Outcome,
        runs: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        /// What changes when someone uses it.
        activity: Vec<PathBuf>,
    }

    impl Adapter for Scripted {
        fn provider(&self) -> Provider {
            Provider::Antigravity
        }
        fn program(&self) -> &'static str {
            "scripted"
        }
        fn install_dirs(&self, _: &std::path::Path) -> Vec<PathBuf> {
            Vec::new()
        }
        fn measure(&mut self, _: &Context) -> Outcome {
            self.runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            (self.outcome)()
        }
        fn activity_paths(&self, _: &std::path::Path) -> Vec<PathBuf> {
            self.activity.clone()
        }
        fn identifies_account(&self) -> bool {
            false
        }
    }

    fn snapshot() -> Outcome {
        Ok(crate::model::Snapshot {
            provider: Provider::Antigravity,
            account: None,
            account_name: None,
            plan: None,
            observed_at: now_ms(),
            via: "scripted".into(),
            client: None,
            stale_after_ms: 0,
            windows: vec![crate::model::Window::new("weekly", Some(10_080), None, 5.0, None)],
            resets: None,
        })
    }

    /// A hub that answers every check-in with `directive`, and keeps what it gets.
    struct Pacing {
        directive: fn(Millis) -> Directive,
        checkins: usize,
        flushed: usize,
        delivered: Vec<Outcome>,
        /// What each check-in said of the first subscription: whether in use, the least interval, its name.
        asked: Vec<(bool, Option<u64>, Option<String>)>,
    }

    impl Sink for Pacing {
        fn deliver(&mut self, outcome: &Outcome) {
            self.delivered.push(outcome.clone());
        }
        fn checkin(&mut self, asks: &[Ask]) -> Vec<Directive> {
            self.checkins += 1;
            self.asked.push((asks[0].active, asks[0].min_interval_ms, asks[0].account_name.map(str::to_string)));
            asks.iter().map(|_| (self.directive)(now_ms())).collect()
        }
        fn flush(&mut self) {
            self.flushed += 1;
        }
    }

    /// Runs a scripted client against `directive` until the first measurement, or for at
    /// most `for_ms`; returns the hub, how often the client ran and the events' next times.
    fn paced_run(
        directive: fn(Millis) -> Directive,
        outcome: fn() -> Outcome,
        for_ms: u64,
    ) -> (Pacing, usize, Vec<(bool, Millis)>) {
        let client = std::env::current_exe().unwrap();
        let config: Config = toml::from_str(&format!("[providers.antigravity]\npath = {:?}", client)).unwrap();
        let state = std::env::temp_dir().join("quotum-runner-paced");
        let paths = Paths { config: state.join("config.toml"), work: state.join("work"), state };
        let runs = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let adapter: Box<dyn Adapter> = Box::new(Scripted { outcome, runs: runs.clone(), activity: Vec::new() });
        let stop = Stop::new();
        let mut runner = Runner::with_adapters(config, paths, vec![adapter], std::env::temp_dir(), stop.clone());
        let timer = stop.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(for_ms));
            timer.request(crate::stop::How::Exit);
        });
        let mut sink = Pacing { directive, checkins: 0, flushed: 0, delivered: Vec::new(), asked: Vec::new() };
        let mut events = Vec::new();
        runner.run(&mut sink, |event| {
            match event {
                Event::Measured(_, next) => events.push((true, next)),
                Event::Waiting(_, next) => events.push((false, next)),
            }
            stop.request(crate::stop::How::Exit);
        });
        (sink, runs.load(std::sync::atomic::Ordering::SeqCst), events)
    }

    fn paced(now: Millis) -> Directive {
        Directive::Measure { paced: Some(crate::sink::Paced { ask_at: now + 15_000, next_in_ms: 240_000 }) }
    }

    #[test]
    fn on_duty_but_not_yet_it_starts_no_client_and_says_nothing() {
        let (sink, runs, events) =
            paced_run(|now| Directive::Wait { ask_at: now + 15_000, on_duty: true }, snapshot, 1_500);
        assert_eq!((runs, sink.checkins), (0, 1));
        assert!(events.is_empty(), "waiting at the hub's pace is not news");
        assert_eq!(sink.flushed, 1, "the hub answered: what it did not take goes now");
    }

    #[test]
    fn told_to_measure_it_measures_once_and_promises_the_next_as_the_hub_did() {
        let started = now_ms();
        let (sink, runs, events) = paced_run(paced, snapshot, 5_000);
        assert_eq!(runs, 1);
        let Ok(snapshot) = &sink.delivered[0] else { panic!("{:?}", sink.delivered) };
        assert_eq!(snapshot.stale_after_ms, 240_000 + 48_000 + 60_000);
        let (measured, next) = events[0];
        assert!(measured && next >= started + 240_000 && next <= now_ms() + 240_000);
    }

    #[test]
    fn a_failed_paced_measurement_is_delivered_and_waited_out_by_the_hub() {
        let started = now_ms();
        let timeout = || Err(crate::model::Failure::new(Provider::Antigravity, ErrorKind::Timeout, ""));
        let (sink, _, events) = paced_run(paced, timeout, 5_000);
        assert!(matches!(&sink.delivered[0], Err(f) if f.error == ErrorKind::Timeout));
        let promise = started + 240_000;
        assert!(events[0].1 >= promise && events[0].1 < promise + 5_000, "the hub's promise, not a local back-off");

        // A client gone since it was asked for is not the hub's business: its own rhythm, half an hour.
        let gone = || Err(crate::model::Failure::new(Provider::Antigravity, ErrorKind::NotInstalled, ""));
        let (_, _, events) = paced_run(paced, gone, 5_000);
        assert!(events[0].1 >= started + 30 * 60_000);
    }

    #[test]
    fn a_check_in_says_whether_the_client_was_used_since_the_last_one_and_how_often_at_most_to_measure() {
        let dir = std::env::temp_dir().join(format!("quotum-runner-asks-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let history = dir.join("history");
        std::fs::write(&history, "").unwrap();
        let client = std::env::current_exe().unwrap();
        let settings = format!("[providers.antigravity]\npath = {client:?}\ninterval = 300\naccount = \"live\"");
        let config: Config = toml::from_str(&settings).unwrap();
        let paths = Paths { config: dir.join("config.toml"), work: dir.join("work"), state: dir.clone() };
        let runs = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let adapter: Box<dyn Adapter> = Box::new(Scripted { outcome: snapshot, runs, activity: vec![history.clone()] });
        let stop = Stop::new();
        let mut runner = Runner::with_adapters(config, paths, vec![adapter], dir.clone(), stop.clone());
        let timer = stop.clone();
        thread::spawn(move || {
            // Used between the first question and the next, which comes 10 s later.
            thread::sleep(Duration::from_secs(3));
            std::fs::write(&history, "used").unwrap();
            thread::sleep(Duration::from_secs(9));
            timer.request(crate::stop::How::Exit);
        });
        let wait = |now| Directive::Wait { ask_at: now, on_duty: true };
        let mut sink = Pacing { directive: wait, checkins: 0, flushed: 0, delivered: Vec::new(), asked: Vec::new() };
        runner.run(&mut sink, |_| {});
        let _ = std::fs::remove_dir_all(&dir);
        let live = Some("live".to_string());
        assert_eq!(sink.asked, [(false, Some(300_000), live.clone()), (true, Some(300_000), live)]);
    }

    #[test]
    fn another_device_on_duty_is_said_once_with_when_to_ask_again() {
        let started = now_ms();
        let other = |now| Directive::Wait { ask_at: now + 10 * 60_000, on_duty: false };
        let (_, runs, events) = paced_run(other, snapshot, 3_000);
        assert_eq!(runs, 0);
        assert_eq!(events.len(), 1, "{events:?}");
        let (measured, next) = events[0];
        assert!(!measured && next >= started + 10 * 60_000 && next <= now_ms() + 10 * 60_000);
    }

    #[test]
    fn an_unanswered_check_in_is_not_followed_by_sending_the_spool() {
        let (sink, runs, _) = paced_run(|_| Directive::Unanswered, snapshot, 5_000);
        assert_eq!((sink.flushed, runs), (0, 1), "measured as without a hub, nothing flushed");
    }

    #[test]
    fn a_paced_provider_checks_in_with_the_account_it_last_measured_even_after_a_sign_in() {
        let then = Some(SystemTime::UNIX_EPOCH);
        let later = Some(SystemTime::UNIX_EPOCH + Duration::from_secs(60));
        let measured = Some((Some("a".to_string()), then));
        // Slot 0 follows the hub's pace, slot 1 does not.
        let mut schedule = Schedule::new(&[120_000, 120_000], 0, true);
        schedule.answer(&[(0, Directive::Wait { ask_at: 15_000, on_duty: true })], 0);
        let (paced, own) = (0, 1);
        let ask = |index, local: Option<&str>, measured, signed_in| {
            ask_account(&schedule, index, local.map(str::to_string), measured, signed_in)
        };
        assert_eq!(ask(paced, None, &measured, later), Some(Some("a".into())), "the measurement will tell");
        assert_eq!(ask(own, None, &measured, later), None, "not known: measured without asking");
        assert_eq!(ask(own, None, &measured, then), Some(Some("a".into())));
        assert_eq!(ask(paced, Some("b"), &measured, later), Some(Some("b".into())), "what the client names");
        assert_eq!(ask(paced, None, &None, later), None, "never measured");
    }

    #[test]
    fn a_run_asked_to_stop_measures_nothing_more() {
        let stop = Stop::new();
        stop.request(crate::stop::How::Yield);
        let mut runner = missing_client("quotum-runner-stopped", stop);
        let mut sink = Taking::default();
        assert_eq!(runner.run(&mut sink, |_| {}), None);
        assert_eq!(sink.delivered.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
}
