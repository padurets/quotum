//! When to measure what. Clients run strictly one at a time; each provider has its
//! own interval (at least a minute), and providers are spread evenly across it so
//! their starts never pile up. While the hub sets the pace of a provider's
//! subscription, the provider is measured when the hub says so and the hub is asked
//! often, about all such providers at once. Pure logic: the caller supplies time and
//! randomness.

use std::collections::VecDeque;

use crate::model::{ErrorKind, Millis, Outcome, STALE_LIMIT_MS};
use crate::sink::Directive;

/// Claude Code caches its answer for a minute; nothing changes faster than that.
pub const MIN_INTERVAL_MS: u64 = 60_000;
pub const DEFAULT_INTERVAL_MS: u64 = 120_000;
/// Eco mode never stretches an interval beyond this.
pub const ECO_CAP_MS: u64 = 15 * 60_000;
/// Measure this long after a known reset instead of long after it.
const RESET_GRACE_MS: u64 = 30_000;
/// Share of an interval used for random jitter, so machines do not synchronize.
const JITTER: f64 = 0.1;
/// Never asks the hub again sooner than this, whatever it says.
const ASK_FLOOR_MS: Millis = 10_000;
/// A hub that does not answer is asked again this often, while its silence is borne.
const ASK_AGAIN_MS: Millis = 15_000;
/// How long a silent hub is borne before a paced provider is measured without it.
const SILENCE_MS: Millis = 4 * 60_000;
/// Providers due this close together are asked about in one check-in.
const ASK_TOGETHER_MS: Millis = 5_000;

#[derive(Clone, Debug)]
struct Slot {
    base_ms: u64,
    due: Millis,
    /// Current multiple of the base interval (eco mode doubles it while nothing happens).
    stretch: u64,
    failures: u32,
    /// Share of the interval this slot is offset by; applied on the first run and after sleep.
    phase: f64,
    phased: bool,
    last: Option<Vec<(String, i64)>>,
    /// The hub sets the pace: `due` is when to ask it next, not when to measure.
    paced: bool,
    /// Until when a silent hub is borne before measuring without it.
    fallback_at: Option<Millis>,
}

impl Slot {
    /// The base interval times the current stretch, never beyond the eco cap.
    fn interval(&self) -> u64 {
        (self.base_ms * self.stretch).min(ECO_CAP_MS.max(self.base_ms))
    }
}

#[derive(Clone, Debug)]
pub struct Schedule {
    slots: Vec<Slot>,
    eco: bool,
    /// Slots the last check-in cleared to measure, in order, each with the hub's `nextInMs` when paced.
    cleared: VecDeque<(usize, Option<u64>)>,
}

impl Schedule {
    /// All providers are measured right away, one after another; afterwards each keeps
    /// its own rhythm, offset by an equal share of its interval.
    /// One slot per interval, in the order the runner keeps its providers.
    pub fn new(intervals: &[u64], now: Millis, eco: bool) -> Schedule {
        let count = intervals.len().max(1) as f64;
        let slots = intervals
            .iter()
            .enumerate()
            .map(|(i, &interval)| Slot {
                base_ms: interval.max(MIN_INTERVAL_MS),
                due: now,
                stretch: 1,
                failures: 0,
                phase: i as f64 / count,
                phased: false,
                last: None,
                paced: false,
                fallback_at: None,
            })
            .collect();
        Schedule { slots, eco, cleared: VecDeque::new() }
    }

    /// The slot to run next and when; ties go to the earlier-listed provider.
    pub fn next(&self) -> Option<(usize, Millis)> {
        self.slots.iter().enumerate().min_by_key(|(i, s)| (s.due, *i)).map(|(i, s)| (i, s.due))
    }

    /// Records a finished measurement and plans the next one of that provider.
    /// `activity` tells whether the agent was used on this machine since the last run;
    /// `jitter` is a random number in [-1, 1].
    pub fn complete(&mut self, index: usize, now: Millis, outcome: &Outcome, activity: bool, jitter: f64) -> Millis {
        let eco = self.eco;
        let slot = &mut self.slots[index];
        let overslept = now - slot.due > slot.interval() as i64;
        if overslept {
            // After sleep or suspend: start over, so providers spread out again.
            slot.phased = false;
            slot.stretch = 1;
        }

        let delay = match outcome {
            Err(failure) => {
                slot.failures += 1;
                slot.stretch = 1;
                match failure.error {
                    ErrorKind::NotInstalled => 30 * 60_000,
                    ErrorKind::NotLoggedIn | ErrorKind::Unsupported => ECO_CAP_MS,
                    _ => (slot.base_ms << (slot.failures - 1).min(4)).min(ECO_CAP_MS.max(slot.base_ms)),
                }
            }
            Ok(snapshot) => {
                slot.failures = 0;
                // Rolling windows move their reset time with the clock, so only usage counts as change.
                let signature: Vec<(String, i64)> =
                    snapshot.windows.iter().map(|w| (w.id.clone(), (w.used_percent * 100.0) as i64)).collect();
                let changed = slot.last.as_ref() != Some(&signature);
                slot.last = Some(signature);
                slot.stretch = if eco && !changed && !activity { (slot.stretch * 2).min(16) } else { 1 };

                let interval = slot.interval();
                let mut delay = (interval as f64 * (1.0 + JITTER * jitter.clamp(-1.0, 1.0))) as u64;
                if !slot.phased {
                    delay += (slot.base_ms as f64 * slot.phase) as u64;
                }
                let reset = snapshot.windows.iter().filter_map(|w| w.resets_at).filter(|&r| r > now).min();
                if let Some(reset) = reset {
                    let after_reset = (reset - now) as u64 + RESET_GRACE_MS;
                    delay = delay.min(after_reset.max(MIN_INTERVAL_MS));
                }
                delay
            }
        };
        slot.phased = true;
        slot.due = now + delay.max(MIN_INTERVAL_MS) as i64;
        slot.due
    }

    /// Which slots to ask the hub about now, if it is time to ask: every paced slot once
    /// any of them is due (they share one timer), and the others due within a few
    /// seconds. None while slots cleared by the last answer wait to be measured.
    pub fn asks(&self, now: Millis) -> Vec<usize> {
        if !self.cleared.is_empty() || !self.slots.iter().any(|s| s.due <= now) {
            return Vec::new();
        }
        let paced = self.slots.iter().any(|s| s.paced && s.due <= now + ASK_TOGETHER_MS);
        (0..self.slots.len())
            .filter(|&i| if self.slots[i].paced { paced } else { self.slots[i].due <= now + ASK_TOGETHER_MS })
            .collect()
    }

    /// A slot the check-in leaves out (its client is not here, its account not known):
    /// it is measured now, on its own rhythm.
    pub fn leave_out(&mut self, index: usize) {
        self.unpace(index);
        self.cleared.push_back((index, None));
    }

    /// The slot goes on its own rhythm, until the hub sets its pace again.
    pub fn unpace(&mut self, index: usize) {
        self.slots[index].paced = false;
        self.slots[index].fallback_at = None;
    }

    /// Takes in what the hub answered about the slots asked about (`None` for a slot
    /// that is due to measure at once without asking). The paced ones share the
    /// soonest time the hub named to ask again. Returns the slots now waiting for
    /// another device, to say so.
    pub fn answer(&mut self, answers: &[(usize, Directive)], now: Millis) -> Vec<usize> {
        let asked = |at: Millis| at.clamp(now + ASK_FLOOR_MS, now + ECO_CAP_MS as i64);
        let shared = answers
            .iter()
            .filter_map(|(_, d)| match d {
                Directive::Measure { paced: Some(p) } => Some(p.ask_at),
                Directive::Wait { ask_at, on_duty: true } => Some(*ask_at),
                _ => None,
            })
            .min()
            .map(asked);
        let mut waiting = Vec::new();
        for &(index, directive) in answers {
            let slot = &mut self.slots[index];
            match directive {
                Directive::Wait { ask_at, on_duty: false } => {
                    slot.paced = false;
                    slot.fallback_at = None;
                    slot.phased = true;
                    slot.due = asked(ask_at);
                    waiting.push(index);
                }
                Directive::Wait { on_duty: true, .. } => {
                    slot.paced = true;
                    slot.due = shared.unwrap_or(now + ASK_AGAIN_MS);
                    // Silence counts from when the hub said to ask again, however long that is.
                    slot.fallback_at = Some(slot.fallback_at.unwrap_or(now).max(slot.due + SILENCE_MS));
                }
                Directive::Measure { paced: Some(p) } => {
                    slot.paced = true;
                    slot.due = shared.unwrap_or(now + ASK_AGAIN_MS);
                    self.cleared.push_back((index, Some(p.next_in_ms)));
                }
                Directive::Measure { paced: None } => {
                    slot.paced = false;
                    slot.fallback_at = None;
                    self.cleared.push_back((index, None));
                }
                Directive::Unanswered if slot.paced => {
                    let fallback = *slot.fallback_at.get_or_insert(now + SILENCE_MS);
                    if now >= fallback {
                        // The hub stayed silent past what was promised: measure without it.
                        slot.paced = false;
                        slot.fallback_at = None;
                        self.cleared.push_back((index, None));
                    } else {
                        slot.due = (now + ASK_AGAIN_MS).min(fallback).max(now + ASK_FLOOR_MS);
                    }
                }
                Directive::Unanswered => self.cleared.push_back((index, None)),
            }
        }
        waiting
    }

    /// The next slot cleared to measure now, with the hub's `nextInMs` when it sets the pace.
    pub fn take_cleared(&mut self) -> Option<(usize, Option<u64>)> {
        self.cleared.pop_front()
    }

    /// A paced slot was measured (or failed to be): the hub promised the next measurement
    /// within `next_in_ms`, and waits out failures itself. Returns how long the
    /// measurement stays representative. The slot asks again with the others.
    pub fn measured_paced(&mut self, index: usize, now: Millis, next_in_ms: u64) -> u64 {
        let slot = &mut self.slots[index];
        slot.fallback_at = Some(now + (next_in_ms as i64).max(SILENCE_MS));
        (next_in_ms + next_in_ms / 5 + 60_000).min(STALE_LIMIT_MS)
    }

    /// Whether the hub sets the pace of this slot.
    pub fn paced(&self, index: usize) -> bool {
        self.slots[index].paced
    }

    /// When the slot is due: to measure, or to ask the hub.
    pub fn due(&self, index: usize) -> Millis {
        self.slots[index].due
    }

    /// Moves every due time by `ms`, after the wall clock jumped by as much.
    pub fn shift(&mut self, ms: i64) {
        for slot in &mut self.slots {
            slot.due += ms;
            if let Some(at) = &mut slot.fallback_at {
                *at += ms;
            }
        }
    }

    /// How long a measurement taken now stays representative: until the next one is due,
    /// with room for a slow client, but never beyond what a hub takes.
    pub fn stale_after_ms(&self, index: usize, now: Millis) -> u64 {
        let until_next = (self.slots[index].due - now).max(0) as u64;
        (until_next + until_next / 5 + 60_000).min(STALE_LIMIT_MS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Failure, Provider, Snapshot, Window};
    use crate::sink::Paced;

    const MIN: i64 = 60_000;

    fn measured(used: f64, resets_at: Option<Millis>) -> Outcome {
        Ok(Snapshot {
            provider: Provider::Codex,
            account: None,
            account_name: None,
            plan: None,
            observed_at: 0,
            via: String::new(),
            client: None,
            stale_after_ms: 0,
            windows: vec![Window::new("weekly", Some(10_080), None, used, resets_at)],
            resets: None,
        })
    }

    fn all() -> Vec<u64> {
        vec![120_000; Provider::ALL.len()]
    }

    #[test]
    fn first_round_runs_now_then_providers_spread_across_the_interval() {
        let mut s = Schedule::new(&all(), 0, false);
        let mut dues = Vec::new();
        for _ in 0..3 {
            let (i, due) = s.next().unwrap();
            assert_eq!(due, 0);
            dues.push(s.complete(i, 5_000, &measured(1.0, None), false, 0.0));
        }
        assert_eq!(dues, [125_000, 165_000, 205_000]);
        // The next round keeps the spacing.
        let (i, _) = s.next().unwrap();
        assert_eq!(s.complete(i, 126_000, &measured(1.0, None), false, 0.0), 246_000);
    }

    #[test]
    fn intervals_never_go_below_a_minute() {
        let mut s = Schedule::new(&[10_000], 0, false);
        assert_eq!(s.complete(0, 0, &measured(1.0, None), false, -1.0), 60_000);
    }

    #[test]
    fn eco_mode_stretches_idle_providers_and_snaps_back_on_activity() {
        let mut s = Schedule::new(&[120_000], 0, true);
        let mut now = 0;
        let mut gaps = Vec::new();
        for round in 0..6 {
            let activity = round == 5;
            let due = s.complete(0, now, &measured(5.0, None), activity, 0.0);
            gaps.push((due - now) / MIN);
            now = due;
        }
        // 2 min (first value), then unchanged: 4, 8, 15 (cap), 15; activity → back to 2.
        assert_eq!(gaps, [2, 4, 8, 15, 15, 2]);
    }

    #[test]
    fn a_change_resets_the_stretch_and_a_known_reset_pulls_the_next_run_in() {
        let mut s = Schedule::new(&[120_000], 0, true);
        s.complete(0, 0, &measured(5.0, None), false, 0.0);
        s.complete(0, 2 * MIN, &measured(5.0, None), false, 0.0);
        let due = s.complete(0, 6 * MIN, &measured(6.0, None), false, 0.0);
        assert_eq!(due - 6 * MIN, 2 * MIN);
        // Idle and stretched to 15 minutes, but the window resets in 3.
        let mut s = Schedule::new(&[900_000], 0, false);
        let due = s.complete(0, 0, &measured(5.0, Some(3 * MIN)), false, 0.0);
        assert_eq!(due, 3 * MIN + 30_000);
    }

    #[test]
    fn failures_back_off_by_kind() {
        let mut s = Schedule::new(&[120_000], 0, false);
        let fail = |kind| Err(Failure::new(Provider::Antigravity, kind, ""));
        assert_eq!(s.complete(0, 0, &fail(ErrorKind::NotInstalled), false, 0.0), 30 * MIN);
        assert_eq!(s.complete(0, 30 * MIN, &fail(ErrorKind::Timeout), false, 0.0) - 30 * MIN, 4 * MIN);
        assert_eq!(s.complete(0, 34 * MIN, &fail(ErrorKind::Timeout), false, 0.0) - 34 * MIN, 8 * MIN);
        assert_eq!(s.complete(0, 42 * MIN, &measured(1.0, None), false, 0.0) - 42 * MIN, 2 * MIN);
    }

    #[test]
    fn after_a_long_sleep_providers_spread_out_again() {
        let mut s = Schedule::new(&all(), 0, false);
        for _ in 0..3 {
            let (i, _) = s.next().unwrap();
            s.complete(i, 0, &measured(1.0, None), false, 0.0);
        }
        // The machine slept for an hour; everything is overdue.
        let wake = 60 * MIN;
        let dues: Vec<_> = (0..3).map(|i| s.complete(i, wake, &measured(1.0, None), false, 0.0) - wake).collect();
        assert_eq!(dues, [120_000, 160_000, 200_000]);
        assert_eq!(s.stale_after_ms(0, wake), 120_000 + 24_000 + 60_000);
    }

    #[test]
    fn a_day_long_interval_stays_within_what_a_hub_takes() {
        let day = 24 * 60 * MIN;
        let mut s = Schedule::new(&[day as u64], 0, false);
        s.complete(0, 0, &measured(1.0, None), false, 1.0);
        assert_eq!(s.stale_after_ms(0, 0), STALE_LIMIT_MS);
    }

    const S: i64 = 1_000;

    fn measure(ask_at: Millis, next_in_ms: u64) -> Directive {
        Directive::Measure { paced: Some(Paced { ask_at, next_in_ms }) }
    }

    fn wait(ask_at: Millis) -> Directive {
        Directive::Wait { ask_at, on_duty: true }
    }

    /// Everything the last answer cleared, in order.
    fn cleared(s: &mut Schedule) -> Vec<(usize, Option<u64>)> {
        std::iter::from_fn(|| s.take_cleared()).collect()
    }

    #[test]
    fn paced_slots_ask_together_every_15_seconds_and_measure_when_told() {
        let mut s = Schedule::new(&all(), 0, true);
        assert_eq!(s.asks(0), [0, 1, 2], "all at once at the start");
        s.answer(&[(0, measure(15 * S, 240_000)), (1, wait(15 * S)), (2, wait(12 * S))], 0);
        assert_eq!(cleared(&mut s), [(0, Some(240_000))]);
        assert_eq!(s.measured_paced(0, 20 * S, 240_000), 240_000 * 6 / 5 + 60_000);
        // One shared time, the soonest the hub named, for all three.
        assert_eq!((s.due(0), s.due(1), s.due(2)), (12 * S, 12 * S, 12 * S));
        assert!(s.asks(11 * S).is_empty());
        assert_eq!(s.asks(12 * S), [0, 1, 2]);
        // Never sooner than 10 s, never later than 15 minutes.
        s.answer(&[(0, wait(13 * S)), (1, wait(13 * S)), (2, wait(13 * S))], 12 * S);
        assert_eq!(s.due(0), 22 * S);
        s.answer(&[(0, wait(2 * 3_600_000)), (1, wait(2 * 3_600_000)), (2, wait(2 * 3_600_000))], 22 * S);
        assert_eq!(s.due(0), 22 * S + 15 * MIN);
        // A clock set back moves the times to ask and to bear silence with it.
        let fallback = s.slots[0].fallback_at.unwrap();
        s.shift(-60 * MIN);
        assert_eq!((s.due(0), s.slots[0].fallback_at), (22 * S + 15 * MIN - 60 * MIN, Some(fallback - 60 * MIN)));
    }

    #[test]
    fn paced_slots_measured_at_different_times_still_ask_together() {
        let mut s = Schedule::new(&[120_000, 120_000, 3_600_000], 0, true);
        s.answer(&[(0, measure(15 * S, 240_000)), (1, wait(15 * S)), (2, Directive::Measure { paced: None })], 0);
        assert_eq!(cleared(&mut s), [(0, Some(240_000)), (2, None)]);
        s.measured_paced(0, 5 * S, 240_000);
        s.complete(2, 6 * S, &measured(1.0, None), false, 0.0);
        // The one on its own rhythm waits an hour; the paced two are asked about together.
        assert_eq!(s.asks(15 * S), [0, 1]);
        s.answer(&[(0, wait(15 * S)), (1, measure(15 * S, 480_000))], 15 * S);
        assert_eq!(cleared(&mut s), [(1, Some(480_000))]);
        s.measured_paced(1, 40 * S, 480_000);
        assert_eq!(s.asks(30 * S), [0, 1], "one set, however far apart they were measured");

        // A slot the check-in leaves out goes on its own rhythm, measured at once.
        s.leave_out(1);
        assert!(!s.paced(1));
        assert_eq!(cleared(&mut s), [(1, None)]);

        // Two slots cleared by one answer are both measured before the next question.
        let mut s = Schedule::new(&[120_000, 120_000], 0, true);
        s.answer(&[(0, measure(15 * S, 240_000)), (1, measure(15 * S, 240_000))], 0);
        assert_eq!(s.take_cleared(), Some((0, Some(240_000))));
        s.measured_paced(0, 70 * S, 240_000);
        assert!(s.asks(70 * S).is_empty(), "the second is still cleared: no new question to overwrite it");
        assert_eq!(s.take_cleared(), Some((1, Some(240_000))));
        assert_eq!(s.asks(70 * S), [0, 1]);
    }

    #[test]
    fn a_silent_hub_is_asked_again_every_15_seconds_and_borne_for_4_minutes() {
        let mut s = Schedule::new(&[120_000], 0, true);
        s.answer(&[(0, measure(15 * S, 240_000))], 0);
        cleared(&mut s);
        s.measured_paced(0, 5 * S, 240_000);
        // Silent from then on: asked every 15 s until the promised measurement is due.
        let mut now = 15 * S;
        let mut asked = 0;
        while s.paced(0) {
            assert!(asked < 100, "still borne at {now}");
            assert_eq!(s.asks(now), [0]);
            s.answer(&[(0, Directive::Unanswered)], now);
            if s.paced(0) {
                assert_eq!(s.due(0) - now, (15 * S).min(s.slots[0].fallback_at.unwrap() - now).max(10 * S));
                now = s.due(0);
                asked += 1;
            }
        }
        // Silence is borne until 4:05; the last question came at 4:00, and none comes sooner than 10 s after it.
        assert_eq!(now, 10 * S + 4 * MIN, "measured without the hub once the promise is due");
        assert!(asked >= 15);
        assert_eq!(cleared(&mut s), [(0, None)]);

        // It answers on a question again: the slot goes on at its pace.
        let mut s = Schedule::new(&[120_000], 0, true);
        s.answer(&[(0, wait(15 * S))], 0);
        assert_eq!(s.slots[0].fallback_at, Some(15 * S + 4 * MIN), "from when it is to ask again");
        s.answer(&[(0, Directive::Unanswered)], 15 * S);
        s.answer(&[(0, wait(15 * S))], 30 * S);
        assert!(s.paced(0));
        assert_eq!(s.slots[0].fallback_at, Some(40 * S + 4 * MIN), "borne anew from the answer's time to ask");
        // A slot not yet measured in this run bears 4 minutes of silence too.
        let mut s = Schedule::new(&[120_000], 0, true);
        s.answer(&[(0, wait(15 * S))], 0);
        s.slots[0].fallback_at = None;
        s.answer(&[(0, Directive::Unanswered)], 15 * S);
        assert_eq!(s.slots[0].fallback_at, Some(15 * S + 4 * MIN));
        // One that does not follow the pace is measured at once, as without a hub.
        let mut s = Schedule::new(&[120_000], 0, true);
        s.answer(&[(0, Directive::Unanswered)], 0);
        assert_eq!(cleared(&mut s), [(0, None)]);
    }

    #[test]
    fn a_failed_paced_measurement_is_the_hub_s_to_wait_out() {
        let mut s = Schedule::new(&[120_000], 0, true);
        s.answer(&[(0, measure(15 * S, 240_000))], 0);
        cleared(&mut s);
        s.measured_paced(0, 5 * S, 240_000);
        assert!(s.paced(0));
        assert_eq!((s.slots[0].failures, s.slots[0].stretch), (0, 1), "no local back-off");
        assert_eq!(s.due(0), 15 * S, "asks again with the others");
        assert_eq!(s.slots[0].fallback_at, Some(5 * S + 4 * MIN));
        s.measured_paced(0, 5 * S, 15 * MIN as u64);
        assert_eq!(s.slots[0].fallback_at, Some(5 * S + 15 * MIN), "no sooner than the promise");
    }

    #[test]
    fn another_device_on_duty_takes_the_slot_off_the_pace() {
        let mut s = Schedule::new(&[120_000, 120_000], 0, true);
        s.answer(&[(0, measure(15 * S, 240_000)), (1, measure(15 * S, 240_000))], 0);
        cleared(&mut s);
        let waiting = s.answer(&[(0, wait(15 * S)), (1, Directive::Wait { ask_at: 10 * MIN, on_duty: false })], 15 * S);
        assert_eq!(waiting, [1]);
        assert!(s.paced(0) && !s.paced(1));
        assert_eq!(s.due(1), 10 * MIN);
        assert_eq!(s.asks(30 * S), [0], "asked about on its own");
        // Waiting for another device is bounded: never a busy loop, never longer than the eco cap.
        let other = |ask_at| Directive::Wait { ask_at, on_duty: false };
        s.answer(&[(1, other(0))], MIN);
        assert_eq!(s.due(1), MIN + 10 * S);
        s.answer(&[(1, other(5 * 3_600_000))], MIN);
        assert_eq!(s.due(1), MIN + 15 * MIN);
    }

    #[test]
    fn a_hub_silent_right_after_a_long_wait_it_asked_for_is_borne_as_any_silence() {
        // On duty, told to ask again in ten minutes (a pause after failures): one lost
        // answer then is asked again, not taken for four minutes of silence.
        let mut s = Schedule::new(&[120_000], 0, true);
        s.answer(&[(0, wait(10 * MIN))], 0);
        s.answer(&[(0, Directive::Unanswered)], 10 * MIN);
        assert!(s.paced(0));
        assert_eq!(s.due(0), 10 * MIN + 15 * S);
        assert_eq!(cleared(&mut s), []);
    }

    #[test]
    fn paced_slots_asked_about_apart_are_asked_about_together_from_then_on() {
        // One became paced at one answer, the other at another: their times to ask differ.
        let mut s = Schedule::new(&[120_000, 120_000], 0, true);
        s.answer(&[(0, wait(25 * S))], 0);
        s.answer(&[(1, wait(40 * S))], 0);
        assert_eq!((s.due(0), s.due(1)), (25 * S, 40 * S));
        assert_eq!(s.asks(25 * S), [0, 1], "one check-in for both");
        s.answer(&[(0, wait(40 * S)), (1, wait(40 * S))], 25 * S);
        assert_eq!(s.due(0), s.due(1));
    }

    #[test]
    fn a_clock_set_back_moves_every_due_time_with_it() {
        let mut s = Schedule::new(&all(), 0, false);
        for _ in 0..3 {
            let (i, _) = s.next().unwrap();
            s.complete(i, 0, &measured(1.0, None), false, 0.0);
        }
        s.shift(-60 * MIN);
        assert_eq!(s.next(), Some((0, 120_000 - 60 * MIN)));
    }
}
