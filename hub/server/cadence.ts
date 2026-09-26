/**
 * When a subscription is measured, while its holder follows the hub's pace (spec: Asking
 * whether to measure). Duty decides who measures; this decides when, from what the hub
 * sees of the subscription everywhere: how much is left, whether it is in use on any
 * machine, whether its numbers just changed, when a window resets, whether the holder's
 * measurements fail. The holder asks every 15 seconds without starting its client and
 * measures only when told.
 *
 * Pure: the caller passes the time and the signals. Kept in memory next to duty: after a
 * restart the first holder to ask measures at once.
 */

import type {Win} from './domain/quota.js';

/** How often a holder asks while it waits for its next measurement. */
export const ASK_EVERY_MS = 15_000;
/** A holder's `active` counts as use for this long. */
export const ACTIVE_WITHIN_MS = 120_000;
const BASE_INTERVAL_MS = 120_000;
const IDLE_CAP_MS = 15 * 60_000;
/** Percent left in a window at or below which a subscription is measured more often. */
const LOW_LEFT = 10;
const RESET_GRACE_MS = 30_000;
/** The board shows no plan of a holder that has not asked for this long. */
const SILENT_AFTER_MS = 120_000;
/** The least interval a device may ask for, and the longest gap a measurement stays representative over (spec: `nextInMs`). */
const MIN_INTERVAL_MS = 60_000;
export const MAX_GAP_MS = (24 * 3_600_000 - 60_000) / 1.2;
/** When to tell again to measure after a `measure: true` nothing came back for: the first time, then each time after that. */
const UNANSWERED_MS = [90_000, 2 * 60_000, 4 * 60_000, 8 * 60_000, 15 * 60_000];
/** A measurement under way takes at most this long (the agent kills a client then): meanwhile the next one is the one being taken. */
const MEASURING_MS = 60_000;

/** Why the next measurement comes when it does, as the board says it. */
export type Why = 'low' | 'inUse' | 'changed' | 'idle' | 'reset';

/** What the hub knows of a subscription right now. */
export type Signals = {windows: Win[]; inUse: boolean};

/** The answer to a paced holder: measure now, or ask again in `askInMs`; `nextInMs` promises the next measurement after this one. */
export type Answer = {measure: boolean; onDuty: boolean; askInMs: number; nextInMs?: number};

type Pace = {
  /** How many times the idle interval has doubled: 1, 2, 4, 8. */
  stretch: number;
  /** The used percent of each window at the last measurement, and whether it differed from the one before. */
  signature: string | null;
  changed: boolean;
  /** When the last measurement was taken, and no later than when the next one is due by its own staleness. */
  lastAt: number | null;
  promiseAt: number | null;
  /** The last time its numbers changed or it was in use. */
  busyAt: number;
  /** Whom and when (by the hub's clock) the last `measure: true` went to, and whether a measurement or a failure came back since. */
  askedDevice: string | null;
  askedAt: number | null;
  answered: boolean;
  /** How many `measure: true` in a row got nothing back. */
  unanswered: number;
  /** The least interval of the asked device, and when it last asked. */
  minIntervalMs: number | null;
  askAt: number | null;
};

/** Failures in a row of one device's measurements of a subscription. */
type Pause = {count: number; kind: string; at: number};

/** How long a device waits after failing: at once for a client signed out or unfit, else longer each time in a row. */
function backOff(pause: Pause): number {
  if (pause.kind === 'not_logged_in' || pause.kind === 'unsupported') return IDLE_CAP_MS;
  return Math.min(BASE_INTERVAL_MS * 2 ** (pause.count - 1), IDLE_CAP_MS);
}

/** How often a subscription with little left is measured, by how long it has been quiet. */
function lowInterval(quietMs: number): number {
  if (quietMs < 3_600_000) return 60_000;
  if (quietMs < 3 * 3_600_000) return 120_000;
  return 300_000;
}

const signatureOf = (windows: {id: string; usedPercent: number}[]) =>
  JSON.stringify(windows.map(w => [w.id, Math.round(w.usedPercent * 100)]).sort(([a], [b]) => String(a).localeCompare(String(b))));

export class Cadence {
  private readonly paces = new Map<string, Pace>();
  /** By subscription and device. */
  private readonly pauses = new Map<string, Pause>();
  /** The subscription each device was last told to measure, by device and provider: whose its failures are. */
  private readonly measured = new Map<string, string>();

  /** A measurement of subscription `key` was accepted; `busy` is whether it is in use as it arrives. */
  delivered(key: string, device: string, windows: {id: string; usedPercent: number}[], observedAt: number, staleAfterMs: number, busy: boolean, now: number) {
    const pace = this.pace(key, now);
    const signature = signatureOf(windows);
    if (pace.signature === null) {
      pace.stretch = 1;
      pace.changed = false;
    } else {
      pace.changed = signature !== pace.signature;
      pace.stretch = pace.changed || busy ? 1 : Math.min(pace.stretch * 2, 8);
    }
    if (pace.changed || busy) pace.busyAt = now;
    pace.signature = signature;
    // Never later than this measurement goes stale, whoever took it and however it was asked for.
    // Whole milliseconds: the times the hub answers with are whole numbers (spec).
    pace.promiseAt = observedAt + Math.ceil(Math.max(MIN_INTERVAL_MS, (staleAfterMs - 60_000) / 1.2));
    pace.lastAt = observedAt;
    this.answeredBy(pace, device);
    this.pauses.delete(pauseKey(key, device));
  }

  /** The subscription a device was last told to measure for a provider: its failures are about that one. */
  measuredBy(device: string, provider: string): string | null {
    return this.measured.get(`${device}\n${provider}`) ?? null;
  }

  /** A device failed to measure subscription `key` at `at`: it waits longer each time. Older failures and repeats count once. */
  failed(key: string, device: string, kind: string, at: number) {
    const pace = this.paces.get(key);
    const pause = this.pauses.get(pauseKey(key, device));
    if ((pace?.lastAt != null && at <= pace.lastAt) || (pause && at <= pause.at)) return;
    this.pauses.set(pauseKey(key, device), {count: (pause?.count ?? 0) + 1, kind, at});
    if (pace) this.answeredBy(pace, device);
  }

  /** When a device's pause after failing ends, if it is in one at `now`. */
  pausedUntil(key: string, device: string, now: number): number | null {
    const pause = this.pauses.get(pauseKey(key, device));
    if (!pause) return null;
    const end = pause.at + backOff(pause);
    return end > now ? end : null;
  }

  /** A paced holder of subscription `key` asks whether to measure now. */
  answer(key: string, device: string, provider: string, now: number, minIntervalMs: number | null, signals: Signals): Answer {
    const pace = this.pace(key, now);
    const floor = floorOf(minIntervalMs);
    if (pace.askedDevice !== null && pace.askedDevice !== device) {
      // A new holder measures at once, as a device taking duty always has; the old one's questions and failures are its own.
      pace.askedAt = null;
      pace.answered = false;
      pace.unanswered = 0;
      const paused = this.pausedUntil(key, device, now);
      if (paused !== null) return {measure: false, onDuty: true, askInMs: askIn(paused - now)};
      const {interval} = pace.lastAt === null ? {interval: BASE_INTERVAL_MS} : this.interval(pace, now, signals, floor);
      return this.ask(pace, key, device, provider, now, minIntervalMs, interval);
    }
    pace.minIntervalMs = minIntervalMs;
    pace.askAt = now;
    const plan = this.plan(pace, key, device, now, signals, floor);
    if (plan.at <= now) return this.ask(pace, key, device, provider, now, minIntervalMs, plan.interval);
    return {measure: false, onDuty: true, askInMs: askIn(plan.at - now)};
  }

  /**
   * When the next measurement of subscription `key` comes and why, for the board: only
   * while `holder`, on duty, follows the pace, asks and is not waiting out failures.
   */
  view(key: string, holder: string | null, now: number, signals: Signals): {next: number; why: Why} | null {
    const pace = this.paces.get(key);
    if (!pace || holder === null || pace.askedDevice !== holder || pace.lastAt === null || pace.askAt === null) return null;
    if (now - pace.askAt > SILENT_AFTER_MS || this.pausedUntil(key, holder, now) !== null) return null;
    const plan = this.plan(pace, key, holder, now, signals, floorOf(pace.minIntervalMs));
    // Told to measure and not heard from yet: the measurement is under way, the next one is that.
    const measuring = pace.askedAt !== null && !pace.answered && now - pace.askedAt <= MEASURING_MS;
    return {next: measuring ? pace.askedAt! : plan.at, why: plan.why as Why};
  }

  /** Tells a holder to measure now, promising the next measurement within twice the interval (it never slows down faster than that). */
  private ask(pace: Pace, key: string, device: string, provider: string, now: number, minIntervalMs: number | null, interval: number): Answer {
    const floor = floorOf(minIntervalMs);
    pace.unanswered = pace.askedAt !== null && !pace.answered ? pace.unanswered + 1 : 0;
    pace.askedDevice = device;
    pace.askedAt = now;
    pace.answered = false;
    pace.minIntervalMs = minIntervalMs;
    pace.askAt = now;
    this.measured.set(`${device}\n${provider}`, key);
    // The floor is at most the longest gap: the promise never outlives the measurement.
    const nextInMs = Math.max(Math.min(IDLE_CAP_MS, 2 * interval), floor);
    return {measure: true, onDuty: true, askInMs: ASK_EVERY_MS, nextInMs: Math.round(nextInMs)};
  }

  /** When `device` should measure next. */
  private plan(pace: Pace, key: string, device: string, now: number, signals: Signals, floor: number): {at: number; why: Why | 'first'; interval: number} {
    if (pace.lastAt === null && pace.askedAt === null) return {at: now, why: 'first', interval: BASE_INTERVAL_MS};
    let {interval, why} = this.interval(pace, now, signals, floor);
    let at: number;
    if (pace.askedAt !== null && !pace.answered) {
      // Nothing came back for the last `measure: true`: ask again, later each time it stays unanswered.
      // Never more often than the device agrees to, though.
      at = pace.askedAt + Math.max(UNANSWERED_MS[Math.min(pace.unanswered, UNANSWERED_MS.length - 1)], floor);
    } else {
      at = (pace.lastAt ?? pace.askedAt!) + interval;
      if (pace.lastAt !== null) {
        const lastAt = pace.lastAt;
        const reset = Math.min(...signals.windows.flatMap(w => (w.resetAt !== null && w.resetAt > lastAt ? [w.resetAt] : [])));
        const afterReset = Math.max(reset + RESET_GRACE_MS, lastAt + floor);
        if (afterReset < at) {
          at = afterReset;
          why = 'reset';
        }
        // A measurement taken without asking, or promised sooner when the pace was quicker, is not left to go stale.
        if (pace.promiseAt !== null && pace.promiseAt < at) at = pace.promiseAt;
      }
    }
    const paused = this.pausedUntil(key, device, now);
    if (paused !== null) at = Math.max(at, paused);
    return {at, why, interval};
  }

  /** The interval the signals call for, never below the device's own least one. */
  private interval(pace: Pace, now: number, signals: Signals, floor: number): {interval: number; why: Why} {
    if (signals.inUse) pace.busyAt = now;
    const low = signals.windows.some(w => w.remaining > 0 && w.remaining <= LOW_LEFT && (w.resetAt === null || w.resetAt > now));
    let interval: number;
    let why: Why;
    if (low) [interval, why] = [lowInterval(now - pace.busyAt), 'low'];
    else if (signals.inUse) [interval, why] = [BASE_INTERVAL_MS, 'inUse'];
    else [interval, why] = [Math.min(BASE_INTERVAL_MS * pace.stretch, IDLE_CAP_MS), pace.changed ? 'changed' : 'idle'];
    return {interval: Math.max(interval, floor), why};
  }

  /** A measurement or a failure came from the device last told to measure: its question is answered. */
  private answeredBy(pace: Pace, device: string) {
    if (device !== pace.askedDevice) return;
    pace.answered = true;
    pace.unanswered = 0;
  }

  private pace(key: string, now: number): Pace {
    let pace = this.paces.get(key);
    if (!pace) {
      pace = {
        stretch: 1,
        signature: null,
        changed: false,
        lastAt: null,
        promiseAt: null,
        busyAt: now,
        askedDevice: null,
        askedAt: null,
        answered: false,
        unanswered: 0,
        minIntervalMs: null,
        askAt: null,
      };
      this.paces.set(key, pace);
    }
    return pace;
  }
}

const pauseKey = (key: string, device: string) => `${key}\n${device}`;

/** How soon to ask again: a whole number of milliseconds, never later than a regular ask. */
const askIn = (ms: number) => Math.ceil(Math.min(ms, ASK_EVERY_MS));

/** The least interval a device accepts: its own if it set one, never below a minute nor past the longest gap. */
const floorOf = (minIntervalMs: number | null) => Math.min(Math.max(MIN_INTERVAL_MS, minIntervalMs ?? 0), MAX_GAP_MS);
