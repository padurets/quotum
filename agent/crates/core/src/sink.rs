//! Where measurements go. A hub gets them over HTTPS; while it is unreachable they
//! wait in a small on-disk spool and are sent oldest first once it answers again.

use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ureq::http::Response;
use ureq::{Body, ResponseExt};

use crate::config::Hub;
use crate::model::{
    Batch, ErrorKind, Failure, INGEST_VERSION, Machine, Millis, Outcome, Provider, RunningSession, STALE_LIMIT_MS,
    Snapshot, now_ms, parse_time, ts,
};

/// One subscription this device could measure now, as a check-in asks about it.
#[derive(Clone, Debug, PartialEq)]
pub struct Ask<'a> {
    pub provider: Provider,
    pub account: Option<&'a str>,
    pub account_name: Option<&'a str>,
    /// Whether the client was used on this machine since the last question.
    pub active: bool,
    /// The most often this device agrees to measure it, when set.
    pub min_interval_ms: Option<u64>,
}

/// What the hub answered about one subscription (spec: Asking whether to measure).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Directive {
    /// Measure now; `paced` when the hub sets the pace.
    Measure { paced: Option<Paced> },
    /// Do not measure before `ask_at`, then ask again; `on_duty` when this device is on duty.
    Wait { ask_at: Millis, on_duty: bool },
    /// The hub did not answer.
    Unanswered,
}

/// The hub's pace: ask again at `ask_at`; the next measurement comes within `next_in_ms` after this one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Paced {
    pub ask_at: Millis,
    pub next_in_ms: u64,
}

pub trait Sink {
    fn deliver(&mut self, outcome: &Outcome);

    /// Asks the hub, in one request, whether this device should measure each of the
    /// subscriptions now; one directive for each, in order. Without a hub, always measure.
    fn checkin(&mut self, asks: &[Ask]) -> Vec<Directive> {
        asks.iter().map(|_| Directive::Measure { paced: None }).collect()
    }

    /// Sends the measurements kept for later, when the hub answers again.
    fn flush(&mut self) {}

    /// Whether the hub is to be told which coding agents run here (there is one, it knows
    /// that request, and it has not refused this device).
    fn takes_sessions(&self) -> bool {
        false
    }

    /// Tells the hub which coding agents run on this machine now (all of them); whether it took the list.
    fn sessions(&mut self, _sessions: &[RunningSession]) -> bool {
        false
    }

    /// Why the hub will never take anything from this device again, once it said so.
    fn refused(&self) -> Option<&str> {
        None
    }
}

/// Discards everything; for running without a hub (the caller logs).
pub struct Discard;

impl Sink for Discard {
    fn deliver(&mut self, _: &Outcome) {}
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Item {
    Snapshot(Snapshot),
    Failure(Failure),
}

/// Keeps about two days of measurements of three providers every two minutes.
const SPOOL_LIMIT: usize = 5_000;
const CHUNK: usize = 200;
/// Requests in one delivery: enough for a full spool, few when the hub refuses piece after piece.
const ROUND_REQUESTS: usize = 64;
/// After a failed delivery the hub is left alone for a while, longer each time.
const RETRY_FIRST: Duration = Duration::from_secs(60);
const RETRY_LAST: Duration = Duration::from_secs(3600);
const AGENT: &str = concat!("quotum/", env!("CARGO_PKG_VERSION"));
/// Asking the hub and telling it which agents run are quick or not done: they must not hold up measuring.
const CHECKIN_TIMEOUT: Duration = Duration::from_secs(5);
const SESSIONS_TIMEOUT: Duration = Duration::from_secs(5);
const SESSIONS_RETRY: Duration = Duration::from_secs(60);
/// A hub that does not know the request yet (older than the agent) is asked again this much later: it may be upgraded.
const SESSIONS_ASK_AGAIN: Duration = Duration::from_secs(3600);

/// Why the hub did not take a request.
enum Trouble {
    /// The hub will never take this batch (malformed, too large): split it or drop it.
    Rejected(String),
    /// The hub will never take anything from this device again.
    Refused(String),
    /// Try again later (network, hub down, token not accepted yet).
    Later(String),
}

/// An HTTP client for the hub at `url`. It follows no redirects: a hub's API does not
/// redirect, a sign-in page in front of it does (see [`not_the_hub`]). A hub on this
/// machine is reached directly: a proxy from the environment (ureq honours ALL_PROXY,
/// HTTPS_PROXY and HTTP_PROXY, and its NO_PROXY knows no loopback by itself) is for others.
pub fn http_to(url: &str) -> ureq::Agent {
    agent(url, ureq::Proxy::try_from_env())
}

fn agent(url: &str, proxy: Option<ureq::Proxy>) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .max_redirects(0)
        .user_agent(AGENT)
        .proxy(proxy.filter(|_| !is_loopback(url)))
        .build()
        .into()
}

/// Whether `url` leads to this machine: `localhost` (not looked up), 127.0.0.0/8, `::1`
/// and IPv4 loopback written as IPv6. Told by the host of the URL, not by how it starts
/// (`http://localhost.example.com` is not local).
pub fn is_loopback(url: &str) -> bool {
    let Ok(uri) = url.parse::<ureq::http::Uri>() else { return false };
    let Some(host) = uri.host() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || match host.parse::<std::net::IpAddr>() {
            Ok(std::net::IpAddr::V4(ip)) => ip.is_loopback(),
            Ok(std::net::IpAddr::V6(ip)) => ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback()),
            Err(_) => false,
        }
}

/// Says so when something other than the hub's API answers: a sign-in page in front of
/// the hub (Cloudflare Access, oauth2-proxy, a private port of a dev environment) with a
/// redirect or a web page where the API answers with JSON, or a redirect to https.
pub fn not_the_hub(response: &Response<Body>) -> Option<String> {
    let status = response.status();
    let header = |name: &str| response.headers().get(name).and_then(|v| v.to_str().ok());
    let answer = if status.is_redirection() {
        let location = header("location").unwrap_or_default();
        let target = destination(location);
        let uri = response.get_uri();
        let same_host = uri.host().is_some_and(|host| target.split(':').next() == Some(host));
        if uri.scheme_str() == Some("http") && location.starts_with("https://") && same_host {
            return Some(format!("the hub answers on https: use https://{target} as its address"));
        }
        format!("it sends the agent to {}", if target.is_empty() { "another page" } else { &target })
    } else if header("content-type").is_some_and(|t| t.contains("text/html"))
        && (status.is_success() || [401, 403].contains(&status.as_u16()))
    {
        "it answers with a web page instead of JSON".into()
    } else {
        return None;
    };
    Some(format!(
        "a sign-in page stands in front of the hub ({answer}); the agent needs direct access to the hub: a public port or an address of its own"
    ))
}

/// The host a redirect leads to, or its path when it stays on the hub's address.
fn destination(location: &str) -> String {
    let rest = location.split_once("://").map(|(_, rest)| rest).or_else(|| location.strip_prefix("//"));
    match rest {
        Some(rest) => rest.split(['/', '?', '#']).next().unwrap_or(rest).to_string(),
        None => location.split(['?', '#']).next().unwrap_or(location).to_string(),
    }
}

/// What an answer of the hub other than plain success means; `None` for success.
fn trouble(response: &mut Response<Body>) -> Option<Trouble> {
    if let Some(why) = not_the_hub(response) {
        return Some(Trouble::Later(why));
    }
    let status = response.status().as_u16();
    if response.status().is_success() {
        return None;
    }
    let body: Value = response.body_mut().read_json().unwrap_or_default();
    let code = body["error"].as_str();
    let named = |what: &str| match (code, body["detail"].as_str()) {
        (Some(code), Some(detail)) => format!("{what} (HTTP {status}, {code}: {detail})"),
        (Some(code), None) => format!("{what} (HTTP {status}, {code})"),
        _ => format!("{what} (HTTP {status})"),
    };
    Some(match (status, code) {
        (403, Some("device_revoked")) => Trouble::Refused(
            "this device was removed from the hub or its token was revoked; connect it again to deliver".into(),
        ),
        (403, Some("device_conflict")) => Trouble::Refused(
            "this machine is connected with a code already, and a machine token cannot take it over; stop this agent or `quotum disconnect` the other".into(),
        ),
        (401, _) => Trouble::Later(named("the hub does not accept this token")),
        (400 | 413 | 422, _) => Trouble::Rejected(named("the hub refused the data")),
        _ => Trouble::Later(named("the hub did not take the request")),
    })
}

/// 1, 2, 4 … 32 minutes, then an hour, after `failures` failed attempts in a row.
fn retry_wait(failures: u32) -> Duration {
    RETRY_FIRST.saturating_mul(1 << (failures.clamp(1, 7) - 1)).min(RETRY_LAST)
}

pub struct HubSink {
    base: String,
    token: String,
    machine: Machine,
    http: ureq::Agent,
    spool_file: PathBuf,
    spool: VecDeque<Item>,
    /// No request before this moment, after failures in a row (monotonic: a clock set
    /// back must not silence the hub for as long).
    retry_at: Option<Instant>,
    failures: u32,
    refused: Option<String>,
    /// The last problem reported, so a long outage is logged once.
    problem: Option<String>,
    /// Until when the hub is taken not to know running agents (an older one), to ask it again then.
    sessions_unknown_until: Option<Instant>,
    sessions_retry_at: Option<Instant>,
    log: Box<dyn FnMut(&str) + Send>,
}

impl HubSink {
    pub fn new(hub: &Hub, machine: Machine, spool_file: PathBuf, log: Box<dyn FnMut(&str) + Send>) -> HubSink {
        HubSink::with_proxy(hub, machine, spool_file, log, ureq::Proxy::try_from_env())
    }

    /// As `new`, with the proxy the environment would give (a hub on this machine goes without it).
    fn with_proxy(
        hub: &Hub,
        machine: Machine,
        spool_file: PathBuf,
        log: Box<dyn FnMut(&str) + Send>,
        proxy: Option<ureq::Proxy>,
    ) -> HubSink {
        let spool = fs::read_to_string(&spool_file)
            .map(|text| text.lines().filter_map(|line| serde_json::from_str(line).ok()).collect())
            .unwrap_or_default();
        HubSink {
            base: hub.url.trim_end_matches('/').to_string(),
            token: hub.token.clone(),
            machine,
            http: agent(&hub.url, proxy),
            spool_file,
            spool,
            retry_at: None,
            failures: 0,
            refused: None,
            problem: None,
            sessions_unknown_until: None,
            sessions_retry_at: None,
            log,
        }
    }

    fn post(&self, items: &[Item]) -> Result<(), Trouble> {
        let mut batch = Batch {
            version: INGEST_VERSION,
            agent: AGENT.into(),
            machine: self.machine.clone(),
            sent_at: now_ms(),
            snapshots: Vec::new(),
            failures: Vec::new(),
        };
        for item in items {
            match item {
                Item::Snapshot(s) => batch.snapshots.push(s.clone()),
                Item::Failure(f) => batch.failures.push(f.clone()),
            }
        }
        let response = self
            .http
            .post(&format!("{}/v1/ingest", self.base))
            .header("Authorization", &format!("Bearer {}", self.token))
            .send_json(&batch);
        match response {
            Ok(mut response) => trouble(&mut response).map_or(Ok(()), Err),
            Err(e) => Err(Trouble::Later(format!("the hub is unreachable: {e}"))),
        }
    }

    /// Written to a new file that then replaces the old one, so a crash never leaves half a spool.
    fn save_spool(&mut self) {
        let result = if self.spool.is_empty() {
            fs::remove_file(&self.spool_file)
                .or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) })
        } else {
            let text: String =
                self.spool.iter().filter_map(|i| serde_json::to_string(i).ok()).map(|line| line + "\n").collect();
            let next = self.spool_file.with_extension("jsonl.new");
            fs::write(&next, text).and_then(|_| fs::rename(&next, &self.spool_file))
        };
        if let Err(e) = result {
            (self.log)(&format!("delivery: cannot keep measurements in {}: {e}", self.spool_file.display()));
        }
    }

    fn report(&mut self, problem: Option<String>) {
        if problem != self.problem {
            match &problem {
                Some(p) => (self.log)(&format!("delivery: {p}; keeping measurements ({} waiting)", self.spool.len())),
                None if self.problem.is_some() => (self.log)("delivery: the hub answers again"),
                None => {}
            }
            self.problem = problem;
        }
    }

    /// Whether the hub is being left alone after failures.
    fn resting(&self) -> bool {
        self.retry_at.is_some_and(|at| Instant::now() < at)
    }

    /// The hub did not answer as hoped: leave it alone for longer each time.
    fn back_off(&mut self) {
        self.failures += 1;
        self.retry_at = Some(Instant::now() + retry_wait(self.failures));
    }

    /// Sends the spool, oldest first; `had_backlog` when it was kept on disk before.
    fn send(&mut self, had_backlog: bool) {
        let mut problem = None;
        // A refused piece is halved until the measurement the hub will not take is
        // found and dropped alone; accepted pieces grow back to the full size.
        let mut size = CHUNK;
        let mut dropped: Option<(usize, String)> = None;
        for _ in 0..ROUND_REQUESTS {
            if self.spool.is_empty() {
                break;
            }
            let count = self.spool.len().min(size);
            let chunk: Vec<Item> = self.spool.iter().take(count).cloned().collect();
            match self.post(&chunk) {
                Ok(()) => {
                    self.spool.drain(..count);
                    self.failures = 0;
                    size = (size * 2).min(CHUNK);
                }
                Err(Trouble::Rejected(_)) if count > 1 => size = count / 2,
                Err(Trouble::Rejected(reason)) => {
                    self.spool.pop_front();
                    dropped = Some((dropped.map_or(0, |(n, _)| n) + 1, reason));
                }
                Err(Trouble::Refused(reason)) => {
                    self.refused = Some(reason);
                    break;
                }
                Err(Trouble::Later(reason)) => {
                    problem = Some(reason);
                    self.back_off();
                    break;
                }
            }
        }
        if let Some((count, reason)) = dropped {
            let plural = if count == 1 { "" } else { "s" };
            (self.log)(&format!("delivery: {reason}; dropped {count} measurement{plural} it will never take"));
        }
        if had_backlog || !self.spool.is_empty() {
            self.save_spool();
        }
        self.report(problem);
    }
}

impl Sink for HubSink {
    fn deliver(&mut self, outcome: &Outcome) {
        match outcome {
            Ok(snapshot) => self.spool.push_back(Item::Snapshot(snapshot.clone())),
            // What is not installed here is none of the hub's business.
            Err(failure) if failure.error == ErrorKind::NotInstalled => {}
            Err(failure) => self.spool.push_back(Item::Failure(failure.clone())),
        }
        while self.spool.len() > SPOOL_LIMIT {
            self.spool.pop_front();
        }
        if self.refused.is_some() || self.resting() {
            self.save_spool();
            return;
        }
        let had_backlog = self.spool.len() > 1;
        self.send(had_backlog);
    }

    fn checkin(&mut self, asks: &[Ask]) -> Vec<Directive> {
        let unanswered = vec![Directive::Unanswered; asks.len()];
        if self.refused.is_some() {
            return unanswered;
        }
        let subscriptions: Vec<Value> = asks
            .iter()
            .map(|ask| {
                let mut subscription = serde_json::json!({
                    "provider": ask.provider,
                    "account": ask.account,
                    "accountName": ask.account_name,
                    "active": ask.active,
                });
                if let Some(ms) = ask.min_interval_ms {
                    subscription["minIntervalMs"] = ms.into();
                }
                subscription
            })
            .collect();
        let request = serde_json::json!({
            "version": INGEST_VERSION,
            "agent": AGENT,
            "paced": true,
            "machine": self.machine,
            "subscriptions": subscriptions,
        });
        let url = format!("{}/v1/checkin", self.base);
        let answer = self
            .http
            .post(&url)
            .config()
            .timeout_global(Some(CHECKIN_TIMEOUT))
            .build()
            .header("Authorization", &format!("Bearer {}", self.token))
            .send_json(&request);
        // A question the hub did not answer is asked again soon; it does not hold back delivery.
        let mut response = match answer {
            Ok(response) => response,
            Err(e) => {
                self.report(Some(format!("the hub is unreachable: {e}")));
                return unanswered;
            }
        };
        match trouble(&mut response) {
            None => {}
            Some(Trouble::Refused(reason)) => {
                self.refused = Some(reason);
                return unanswered;
            }
            Some(Trouble::Rejected(reason) | Trouble::Later(reason)) => {
                self.report(Some(reason));
                return unanswered;
            }
        }
        let Ok(body) = response.body_mut().read_json::<Value>() else {
            self.report(Some("the hub answered a check-in with something else than JSON".into()));
            return unanswered;
        };
        let Some(directives) = body["subscriptions"].as_array().filter(|list| list.len() == asks.len()) else {
            self.report(Some("the hub answered a check-in about other subscriptions".into()));
            return unanswered;
        };
        // The hub answers: whatever was kept for it may go now.
        self.failures = 0;
        self.retry_at = None;
        self.report(None);
        let now = now_ms();
        directives.iter().map(|directive| read_directive(directive, now)).collect()
    }

    fn flush(&mut self) {
        if !self.spool.is_empty() && self.refused.is_none() && !self.resting() {
            self.send(true);
        }
    }

    fn takes_sessions(&self) -> bool {
        self.refused.is_none() && self.sessions_unknown_until.is_none_or(|at| Instant::now() >= at)
    }

    /// Best effort, and apart from measurements: a quick request that holds nothing back.
    /// A list the hub did not take is sent again at the next look; after a failure the hub
    /// is left alone for a minute. A hub that does not know this request (older than the
    /// agent: its own `not_found`, not a proxy's 404) is asked again in an hour, when it
    /// may have been upgraded.
    fn sessions(&mut self, sessions: &[RunningSession]) -> bool {
        if !self.takes_sessions() || self.sessions_retry_at.is_some_and(|at| Instant::now() < at) {
            return false;
        }
        let request = serde_json::json!({
            "version": INGEST_VERSION,
            "agent": AGENT,
            "machine": self.machine,
            "sentAt": ts::format(now_ms()),
            "sessions": sessions,
        });
        let url = format!("{}/v1/sessions", self.base);
        let answer = self
            .http
            .post(&url)
            .config()
            .timeout_global(Some(SESSIONS_TIMEOUT))
            .build()
            .header("Authorization", &format!("Bearer {}", self.token))
            .send_json(&request);
        let (status, older) = match answer {
            Ok(mut response) => {
                let status = response.status().as_u16();
                let older = status == 404
                    && not_the_hub(&response).is_none()
                    && response.body_mut().read_json::<Value>().is_ok_and(|body| body["error"] == "not_found");
                (status, older)
            }
            Err(_) => (0, false),
        };
        if (200..300).contains(&status) {
            if self.sessions_unknown_until.take().is_some() {
                (self.log)("running agents: the hub takes them now");
            }
            return true;
        }
        if older {
            if self.sessions_unknown_until.is_none() {
                (self.log)(
                    "running agents: the hub does not know them (it is older than this agent); asking again in an hour",
                );
            }
            self.sessions_unknown_until = Some(Instant::now() + SESSIONS_ASK_AGAIN);
        } else {
            self.sessions_retry_at = Some(Instant::now() + SESSIONS_RETRY);
        }
        false
    }

    fn refused(&self) -> Option<&str> {
        self.refused.as_deref()
    }
}

/// A promise of the next measurement the agent can keep (spec: `nextInMs`): its
/// `staleAfterMs` stays within what a hub takes.
const NEXT_IN_MS: std::ops::RangeInclusive<u64> = 60_000..=71_950_000;

/// One subscription of a check-in's answer. An element with `askInMs` follows the hub's
/// pace; any other is read as a hub without it answers: measure, or wait until `until`.
fn read_directive(directive: &Value, now: Millis) -> Directive {
    let measure = directive["measure"] != false;
    if let Some(ask_in) = directive["askInMs"].as_u64() {
        let ask_at = now + ask_in.min(STALE_LIMIT_MS) as Millis;
        if !measure {
            return Directive::Wait { ask_at, on_duty: directive["onDuty"] == true };
        }
        let paced = directive["nextInMs"]
            .as_u64()
            .filter(|ms| NEXT_IN_MS.contains(ms))
            .map(|next_in_ms| Paced { ask_at, next_in_ms });
        return Directive::Measure { paced };
    }
    match directive["until"].as_str().and_then(parse_time) {
        Some(until) if !measure => Directive::Wait { ask_at: until, on_duty: false },
        _ => Directive::Measure { paced: None },
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::{env, thread};

    use serde_json::json;

    use super::*;

    /// Status, header lines and body of an answer.
    type Answer = (u16, &'static str, String);
    type Seen = Arc<Mutex<Vec<(String, Value)>>>;

    fn json(status: u16, body: Value) -> Answer {
        (status, "content-type: application/json\r\n", body.to_string())
    }

    /// A hub on a local port: `answer` gets the path and JSON body of each request (`{hub}`
    /// in its headers stands for the hub's host and port); the requests are kept.
    fn hub(answer: impl Fn(&str, &Value) -> Answer + Send + 'static) -> (String, Seen) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let url = format!("http://{address}");
        let seen = Seen::default();
        let requests = seen.clone();
        thread::spawn(move || {
            for mut stream in listener.incoming().filter_map(Result::ok) {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let path = line.split(' ').nth(1).unwrap_or_default().to_string();
                let mut length = 0;
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    match header.split_once(':') {
                        Some((name, value)) if name.eq_ignore_ascii_case("content-length") => {
                            length = value.trim().parse().unwrap()
                        }
                        _ if header.trim().is_empty() => break,
                        _ => {}
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let body: Value = serde_json::from_slice(&body).unwrap_or_default();
                let (status, headers, text) = answer(&path, &body);
                let headers = headers.replace("{hub}", &address);
                requests.lock().unwrap().push((path, body));
                let length = text.len();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\n{headers}content-length: {length}\r\nconnection: close\r\n\r\n{text}"
                );
            }
        });
        (url, seen)
    }

    fn sink(url: &str, name: &str) -> (HubSink, Arc<Mutex<Vec<String>>>) {
        let spool = env::temp_dir().join(format!("quotum-spool-{}-{name}.jsonl", std::process::id()));
        let _ = fs::remove_file(&spool);
        let machine =
            Machine { id: "0123456789abcdef".into(), name: "test".into(), os: "linux".into(), arch: "x86_64".into() };
        let lines = Arc::new(Mutex::new(Vec::new()));
        let log = lines.clone();
        let hub = Hub { url: url.into(), token: "qt_d_test".into() };
        let sink =
            HubSink::new(&hub, machine, spool, Box::new(move |line: &str| log.lock().unwrap().push(line.into())));
        (sink, lines)
    }

    #[test]
    fn this_machine_is_told_by_the_host_of_the_address() {
        for local in [
            "http://127.0.0.1:8080",
            "http://127.1.2.3",
            "http://localhost:23456/",
            "http://LOCALHOST",
            "http://[::1]:8080",
            "http://[::ffff:127.0.0.1]:80",
        ] {
            assert!(is_loopback(local), "{local}");
        }
        for remote in [
            "http://localhost.example.com",
            "https://quotum.example.com",
            "http://10.0.0.1:8080",
            "http://[::2]",
            "not a url",
            "http://",
        ] {
            assert!(!is_loopback(remote), "{remote}");
        }
    }

    #[test]
    fn a_hub_on_this_machine_is_reached_past_a_proxy_of_the_environment() {
        let (url, seen) = hub(|_, _| json(200, json!({"accepted": 1, "duplicates": 0})));
        let dead = ureq::Proxy::new("http://127.0.0.1:9").ok();
        let spool = env::temp_dir().join(format!("quotum-spool-{}-proxy.jsonl", std::process::id()));
        let _ = fs::remove_file(&spool);
        let machine =
            Machine { id: "0123456789abcdef".into(), name: "test".into(), os: "linux".into(), arch: "x86_64".into() };
        let hub = Hub { url: url.clone(), token: "qt_m_test".into() };
        let mut sink = HubSink::with_proxy(&hub, machine, spool.clone(), Box::new(|_| {}), dead.clone());
        sink.deliver(&failed("x"));
        assert_eq!(seen.lock().unwrap().len(), 1, "delivered straight to the hub");
        let _ = fs::remove_file(&spool);
        assert!(agent("https://quotum.example.com", dead).config().proxy().is_some(), "others go through the proxy");
    }

    fn ask(provider: Provider, account: Option<&str>) -> Ask<'_> {
        Ask { provider, account, account_name: None, active: false, min_interval_ms: None }
    }

    #[test]
    fn a_check_in_asks_about_every_provider_at_once_and_reads_the_hub_s_pace() {
        let (url, seen) = hub(|_, _| {
            json(
                200,
                json!({"subscriptions": [
                    {"provider": "codex", "measure": true, "onDuty": true, "until": "2026-09-26T10:00:15Z", "askInMs": 15000, "nextInMs": 240000},
                    {"provider": "claude", "measure": false, "onDuty": true, "until": "2026-09-26T10:00:15Z", "askInMs": 12000},
                    {"provider": "antigravity", "measure": false, "onDuty": false, "until": "2026-09-26T10:10:00Z", "askInMs": 600000},
                ]}),
            )
        });
        let (mut sink, _) = sink(&url, "paced");
        let asks = [
            ask(Provider::Codex, Some("41ab")),
            Ask { active: true, min_interval_ms: Some(300_000), ..ask(Provider::Claude, Some("9c1e")) },
            Ask { account_name: Some("work"), ..ask(Provider::Antigravity, None) },
        ];
        let before = now_ms();
        let directives = sink.checkin(&asks);
        let after = now_ms();
        let (_, body) = seen.lock().unwrap()[0].clone();
        assert_eq!(body["paced"], true);
        assert_eq!(
            body["subscriptions"],
            json!([
                {"provider": "codex", "account": "41ab", "accountName": null, "active": false},
                {"provider": "claude", "account": "9c1e", "accountName": null, "active": true, "minIntervalMs": 300000},
                {"provider": "antigravity", "account": null, "accountName": "work", "active": false},
            ]),
            "the least interval only where it is set"
        );
        let Directive::Measure { paced: Some(paced) } = directives[0] else { panic!("{directives:?}") };
        assert_eq!(paced.next_in_ms, 240_000);
        assert!((before + 15_000..=after + 15_000).contains(&paced.ask_at), "by this machine's clock");
        let Directive::Wait { ask_at, on_duty: true } = directives[1] else { panic!("{directives:?}") };
        assert!((before + 12_000..=after + 12_000).contains(&ask_at));
        assert!(matches!(directives[2], Directive::Wait { on_duty: false, .. }));
    }

    #[test]
    fn a_promise_past_what_a_hub_takes_is_no_pace() {
        let read = |next_in: u64| read_directive(&json!({"measure": true, "askInMs": 15000, "nextInMs": next_in}), 0);
        assert!(matches!(read(71_950_000), Directive::Measure { paced: Some(_) }));
        assert_eq!(read(71_950_001), Directive::Measure { paced: None }, "measured on its own rhythm");
        assert_eq!(read(u64::MAX), Directive::Measure { paced: None });
    }

    #[test]
    fn an_answer_without_the_pace_is_read_as_before() {
        let now = 1_000;
        let read = |value: Value| read_directive(&value, now);
        let until = "2026-09-26T10:00:00Z";
        assert_eq!(read(json!({"measure": true, "until": until})), Directive::Measure { paced: None });
        assert_eq!(
            read(json!({"measure": false, "until": until})),
            Directive::Wait { ask_at: parse_time(until).unwrap(), on_duty: false }
        );
        assert_eq!(read(json!({"measure": false})), Directive::Measure { paced: None }, "no time to wait for");
        assert_eq!(
            read(json!({"measure": true, "askInMs": 15000})),
            Directive::Measure { paced: None },
            "no promise: measure on its own rhythm"
        );
        assert_eq!(
            read(json!({"measure": true, "askInMs": 15000, "nextInMs": 30000})),
            Directive::Measure { paced: None }
        );
        assert_eq!(read(json!({"measure": true, "askInMs": -1, "until": until})), Directive::Measure { paced: None });
        assert_eq!(
            read(json!({"measure": false, "askInMs": 15000, "onDuty": "yes", "until": until})),
            Directive::Wait { ask_at: now + 15_000, on_duty: false },
            "on duty only when it says so"
        );
    }

    #[test]
    fn a_check_in_the_hub_does_not_answer_is_asked_again_and_holds_back_no_delivery() {
        // A hub that fails every request, then answers again.
        let answers = Arc::new(AtomicBool::new(false));
        let now_answers = answers.clone();
        let (url, seen) = hub(move |path, body| {
            if !now_answers.load(Ordering::SeqCst) {
                return json(503, json!({"error": "unavailable"}));
            }
            match path {
                "/v1/checkin" => {
                    let count = body["subscriptions"].as_array().unwrap().len();
                    json(
                        200,
                        json!({"subscriptions": vec![json!({"provider": "codex", "measure": false, "onDuty": true, "until": "2026-09-26T10:00:15Z", "askInMs": 15000}); count]}),
                    )
                }
                _ => json(200, json!({"accepted": 1, "duplicates": 0})),
            }
        });
        let (mut kept, _) = sink(&url, "unanswered");
        let asks = [ask(Provider::Codex, Some("41ab")), ask(Provider::Claude, Some("9c1e"))];
        assert_eq!(kept.checkin(&asks), [Directive::Unanswered, Directive::Unanswered]);
        assert!(kept.retry_at.is_none() && kept.failures == 0, "a failed check-in holds back no delivery");
        kept.deliver(&failed("x"));
        assert!(kept.resting(), "a failed delivery does");
        assert_eq!(kept.checkin(&asks), [Directive::Unanswered; 2], "asked anyway");
        assert_eq!(seen.lock().unwrap().len(), 3);

        // The hub answers again: the check-in ends the rest, and what was kept goes at once.
        answers.store(true, Ordering::SeqCst);
        assert!(matches!(kept.checkin(&asks)[0], Directive::Wait { on_duty: true, .. }));
        assert!(!kept.resting());
        kept.flush();
        let _ = fs::remove_file(&kept.spool_file);
        assert!(kept.spool.is_empty(), "delivered");
        assert_eq!(seen.lock().unwrap().last().unwrap().0, "/v1/ingest");

        // Something else than an answer to what was asked is no answer.
        for answer in [json!({"subscriptions": []}), json!({"ok": true})] {
            let (url, _) = hub(move |_, _| json(200, answer.clone()));
            let (mut odd, _) = sink(&url, "odd");
            assert_eq!(odd.checkin(&asks), [Directive::Unanswered; 2]);
        }
        let (url, _) = hub(|_, _| (200, "content-type: text/html\r\n", "<!doctype html>".into()));
        let (mut page, _) = sink(&url, "page");
        assert_eq!(page.checkin(&asks), [Directive::Unanswered; 2]);
    }

    #[test]
    fn a_hub_that_does_not_answer_a_check_in_in_five_seconds_is_not_waited_for() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        // Takes the connection and never answers.
        thread::spawn(move || {
            let kept: Vec<_> = listener.incoming().take(1).collect();
            thread::sleep(Duration::from_secs(30));
            drop(kept);
        });
        let (mut sink, _) = sink(&url, "silent");
        let started = Instant::now();
        assert_eq!(sink.checkin(&[ask(Provider::Codex, None)]), [Directive::Unanswered]);
        let took = started.elapsed();
        assert!(took >= Duration::from_secs(4) && took < Duration::from_secs(10), "{took:?}");
        assert!(sink.retry_at.is_none(), "a silent hub is asked again all the same");
    }

    fn failed(detail: &str) -> Outcome {
        Err(Failure::new(Provider::Codex, ErrorKind::Failed, detail))
    }

    #[test]
    fn a_refused_batch_is_split_so_one_bad_measurement_does_not_take_the_rest_along() {
        let bad = |body: &Value| body["failures"].as_array().into_iter().flatten().any(|f| f["detail"] == "bad");
        let (url, seen) = hub(move |_, body| {
            if bad(body) {
                json(400, json!({"error": "invalid_batch", "detail": "failures.0.detail"}))
            } else {
                json(200, json!({"accepted": 0}))
            }
        });
        let (mut sink, log) = sink(&url, "split");
        for i in 0..9 {
            let detail = if i == 6 { "bad" } else { "fine" };
            sink.spool.push_back(Item::Failure(Failure::new(Provider::Codex, ErrorKind::Failed, detail)));
        }
        sink.deliver(&failed("fine"));
        let _ = fs::remove_file(&sink.spool_file);

        let seen = seen.lock().unwrap();
        let taken: usize =
            seen.iter().filter(|(_, b)| !bad(b)).map(|(_, b)| b["failures"].as_array().unwrap().len()).sum();
        assert_eq!(taken, 9, "everything but the bad one arrived");
        assert!(seen.len() < 12, "{} requests", seen.len());
        assert!(sink.spool.is_empty());
        assert_eq!(
            log.lock().unwrap().as_slice(),
            [
                "delivery: the hub refused the data (HTTP 400, invalid_batch: failures.0.detail); dropped 1 measurement it will never take"
            ]
        );
    }

    #[test]
    fn only_a_removed_or_conflicting_device_stops_for_good() {
        let (url, _) = hub(|_, _| json(403, json!({"error": "forbidden"})));
        let (mut forbidden, log) = sink(&url, "forbidden");
        forbidden.deliver(&failed("x"));
        let _ = fs::remove_file(&forbidden.spool_file);
        assert!(forbidden.refused().is_none());
        assert_eq!(forbidden.spool.len(), 1, "kept for later");
        assert!(log.lock().unwrap()[0].contains("(HTTP 403, forbidden)"), "{:?}", log.lock().unwrap());

        for code in ["device_revoked", "device_conflict"] {
            let (url, _) = hub(move |_, _| json(403, json!({"error": code})));
            let (mut stopped, _) = sink(&url, code);
            assert_eq!(stopped.checkin(&[ask(Provider::Antigravity, None)]), [Directive::Unanswered]);
            assert!(stopped.refused().is_some(), "{code}");
        }
    }

    #[test]
    fn a_sign_in_page_in_front_of_the_hub_is_named_and_nothing_is_lost() {
        let (url, seen) = hub(|path, _| match path {
            "/v1/checkin" => (
                302,
                "location: https://team.cloudflareaccess.com/cdn-cgi/access/login?redirect_url=%2F\r\n",
                String::new(),
            ),
            _ => (200, "content-type: text/html; charset=utf-8\r\n", "<!doctype html><title>Sign in</title>".into()),
        });
        let (mut sink, log) = sink(&url, "sign-in");
        assert_eq!(sink.checkin(&[ask(Provider::Claude, Some("a"))]), [Directive::Unanswered]);
        sink.deliver(&failed("x"));
        let _ = fs::remove_file(&sink.spool_file);

        assert_eq!(seen.lock().unwrap().len(), 2, "the redirect was not followed");
        assert_eq!(sink.spool.len(), 1, "a web page is no receipt");
        assert!(sink.refused().is_none());
        let log = log.lock().unwrap();
        assert!(
            log[0].contains(
                "a sign-in page stands in front of the hub (it sends the agent to team.cloudflareaccess.com)"
            )
        );
        assert!(log[1].contains("(it answers with a web page instead of JSON)"), "{log:?}");
        assert!(log.iter().all(|line| line.contains("direct access")));
    }

    #[test]
    fn a_hub_that_moved_to_https_is_not_taken_for_a_sign_in_page() {
        let (url, _) = hub(|_, _| (308, "location: https://{hub}/v1/ingest\r\n", String::new()));
        let (mut sink, log) = sink(&url, "https");
        sink.deliver(&failed("x"));
        let _ = fs::remove_file(&sink.spool_file);
        let https = url.replace("http://", "https://");
        assert!(log.lock().unwrap()[0].contains(&format!("the hub answers on https: use {https} as its address")));
    }

    #[test]
    fn a_redirect_is_described_by_where_it_leads() {
        assert_eq!(destination("https://coder.example.com/api/v2/applications/auth-redirect?x=1"), "coder.example.com");
        assert_eq!(destination("//login.example.com/start"), "login.example.com");
        assert_eq!(destination("/oauth2/start?rd=%2Fv1%2Fingest"), "/oauth2/start");
    }

    #[test]
    fn running_agents_are_told_to_the_hub_that_knows_them_and_an_older_one_is_left_alone() {
        let session = RunningSession {
            provider: Provider::Codex,
            account: Some("4b7e0c1d2e3f4a5b6c7d8e9f".into()),
            account_name: None,
            origin: "terminal",
            project: Some("quotum".into()),
            folder: Some("quotum.feat-18-desktop-app".into()),
            started_at: 1_790_000_000_000,
            last_worked_at: None,
            working: true,
        };
        let (url, seen) = hub(|_, _| json(200, json!({"accepted": 1})));
        let (mut current, _) = sink(&url, "sessions");
        let nameless = RunningSession { project: None, folder: None, working: false, ..session.clone() };
        assert!(current.sessions(&[session.clone(), nameless]), "taken");
        let (path, body) = seen.lock().unwrap()[0].clone();
        assert_eq!(path, "/v1/sessions");
        assert_eq!(
            body["sessions"],
            json!([
                {"provider": "codex", "account": "4b7e0c1d2e3f4a5b6c7d8e9f", "origin": "terminal", "project": "quotum", "folder": "quotum.feat-18-desktop-app", "startedAt": "2026-09-21T14:13:20Z", "working": true},
                {"provider": "codex", "account": "4b7e0c1d2e3f4a5b6c7d8e9f", "origin": "terminal", "startedAt": "2026-09-21T14:13:20Z", "working": false}
            ])
        );
        assert_eq!(body["machine"]["id"], "0123456789abcdef");
        let idle = RunningSession { working: false, last_worked_at: Some(1_790_000_015_000), ..session };
        assert!(current.sessions(&[idle]));
        assert_eq!(seen.lock().unwrap()[1].1["sessions"][0]["lastWorkedAt"], "2026-09-21T14:13:35Z");

        // A hub older than the agent: twice, then upgraded.
        let upgraded = Arc::new(AtomicBool::new(false));
        let now_known = upgraded.clone();
        let (url, seen) = hub(move |_, _| {
            if now_known.load(Ordering::SeqCst) {
                json(200, json!({"accepted": 0}))
            } else {
                json(404, json!({"error": "not_found"}))
            }
        });
        let (mut older, log) = sink(&url, "no-sessions");
        let hour_passes =
            |sink: &mut HubSink| sink.sessions_unknown_until = Some(Instant::now() - Duration::from_secs(1));
        assert!(!older.sessions(&[]));
        assert!(!older.takes_sessions(), "not asked again for a while");
        assert_eq!(seen.lock().unwrap().len(), 1, "asked once");
        assert_eq!(log.lock().unwrap().len(), 1, "said once: {:?}", log.lock().unwrap());
        assert!(older.retry_at.is_none(), "measurements are not held back");
        // An hour later it is asked again: still older, it waits another hour, without saying so again.
        hour_passes(&mut older);
        assert!(older.takes_sessions());
        assert!(!older.sessions(&[]));
        assert_eq!(seen.lock().unwrap().len(), 2, "asked again");
        assert!(!older.takes_sessions());
        assert_eq!(log.lock().unwrap().len(), 1, "not said again");
        // Upgraded since: the list is taken, and the agent says so.
        upgraded.store(true, Ordering::SeqCst);
        hour_passes(&mut older);
        assert!(older.sessions(&[]));
        assert!(older.takes_sessions() && older.sessions_unknown_until.is_none());
        assert!(log.lock().unwrap()[1].contains("takes them now"), "{:?}", log.lock().unwrap());

        // A 404 of something in front of the hub is only a failure: tried again in a minute.
        let (url, _) = hub(|_, _| (404, "content-type: text/plain\r\n", "404 page not found".into()));
        let (mut proxied, _) = sink(&url, "proxied-sessions");
        assert!(!proxied.sessions(&[]));
        assert!(proxied.takes_sessions());
        assert!(proxied.sessions_retry_at.is_some());
    }

    #[test]
    fn delivery_backs_off_from_a_minute_to_an_hour() {
        let minutes: Vec<u64> = (1..=9).map(|n| retry_wait(n).as_secs() / 60).collect();
        assert_eq!(minutes, [1, 2, 4, 8, 16, 32, 60, 60, 60]);
    }
}
