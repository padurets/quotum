import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Cadence, MAX_GAP_MS, type Answer, type Signals} from '../cadence.js';
import {Duty} from '../duty.js';
import {Ingest, type Credential} from '../ingest.js';
import {Invalid, parseCheckin} from '../domain/ingest.js';
import {newSecret} from '../domain/auth.js';
import type {Win} from '../domain/quota.js';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';

const S = 1000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const t0 = Date.parse('2026-09-22T12:00:00Z');

const win = (remaining: number, resetAt: number | null = null, id = '5h'): Win => ({id, kind: 'session', label: null, used: 100 - remaining, remaining, resetAt, minutes: 300});
const quiet: Signals = {windows: [win(50)], inUse: false};
const reading = (windows: Win[]) => windows.map(w => ({id: w.id, usedPercent: w.used}));
const staleFor = (nextInMs: number) => nextInMs * 1.2 + MIN;

type Holder = {
  windows?: (t: number) => Win[];
  inUse?: (t: number) => boolean;
  minIntervalMs?: number | null;
  device?: string;
  /** Whether a measurement told for at `t` is delivered; a lost one never arrives. */
  delivers?: (t: number) => boolean;
  /** Sees every answer. */
  told?: (answer: Answer, t: number) => void;
};

/**
 * A paced holder of `acc`: asks when told (every 15 s at most), measures when told and
 * delivers 5 s later. Returns when it measured.
 */
function run(cadence: Cadence, from: number, to: number, holder: Holder = {}): number[] {
  const {windows = () => quiet.windows, inUse = () => false, minIntervalMs = null, device = 'laptop', delivers = () => true, told} = holder;
  const measured: number[] = [];
  for (let t = from; t < to; ) {
    const signals = {windows: windows(t), inUse: inUse(t)};
    const answer = cadence.answer('acc', device, 'codex', t, minIntervalMs, signals);
    assert.ok(answer.askInMs <= 15 * S || !answer.measure, 'a holder asks at least every 15 s');
    told?.(answer, t);
    if (answer.measure) {
      measured.push(t);
      if (delivers(t)) cadence.delivered('acc', device, reading(signals.windows), t, staleFor(answer.nextInMs!), signals.inUse, t + 5 * S);
    }
    t += Math.max(S, answer.askInMs);
  }
  return measured;
}

const gaps = (times: number[]) => times.slice(1).map((t, i) => (t - times[i]) / MIN);

test('S1: an idle subscription is measured less and less often, up to every 15 minutes', () => {
  const promised: number[] = [];
  const measured = run(new Cadence(), t0, t0 + 50 * MIN, {told: a => a.nextInMs && promised.push(a.nextInMs / MIN)});
  assert.equal(measured[0], t0, 'the first holder measures at once');
  assert.deepEqual(gaps(measured), [2, 4, 8, 15, 15]);
  assert.deepEqual(promised, [4, 4, 8, 15, 15, 15], 'twice the interval, but never past 15 minutes');
  // 15 minutes is a cap even after a measurement that stays representative for longer.
  const cadence = new Cadence();
  run(cadence, t0, t0 + 30 * MIN);
  cadence.delivered('acc', 'laptop', reading(quiet.windows), t0 + 30 * MIN, HOUR, false, t0 + 30 * MIN);
  assert.equal(cadence.view('acc', 'laptop', t0 + 30 * MIN, quiet)?.next, t0 + 45 * MIN);
});

test('S2: with little left it is measured every minute, less often only after hours of quiet, never less than every 5 minutes', () => {
  // Numbers change at every measurement: every minute.
  let used = 91;
  const changing = run(new Cadence(), t0, t0 + 10 * MIN, {windows: () => [win(100 - (used += 0.05))]});
  assert.ok(gaps(changing).every(g => g === 1), `every minute: ${gaps(changing)}`);

  // Nothing changes and nobody works: 1 minute for the first hour, 2 up to three hours, 5 after.
  const low = [win(5)];
  const cadence = new Cadence();
  const measured = run(cadence, t0, t0 + 5 * HOUR, {windows: () => low});
  const at = (from: number, to: number) => measured.slice(1).flatMap((t, i) => (t > t0 + from && t <= t0 + to ? [(t - measured[i]) / MIN] : []));
  assert.ok(at(0, HOUR).every(g => g === 1), `first hour: ${at(0, HOUR)}`);
  assert.ok(at(HOUR + 3 * MIN, 3 * HOUR).every(g => g === 2), `one to three hours: ${at(HOUR + 3 * MIN, 3 * HOUR)}`);
  assert.ok(at(3 * HOUR + 10 * MIN, 5 * HOUR).every(g => g === 5), `after three hours: ${at(3 * HOUR + 10 * MIN, 5 * HOUR)}`);
  assert.ok(gaps(measured).every(g => g <= 5), 'never less often than every 5 minutes');

  // A change brings it back to every minute.
  const after = run(cadence, t0 + 5 * HOUR, t0 + 5 * HOUR + 10 * MIN, {windows: t => (t < t0 + 5 * HOUR + 2 * MIN ? low : [win(4)])});
  assert.deepEqual(gaps(after).slice(-3), [1, 1, 1]);

  // Unchanged for two hours but in use: every minute.
  const busy = new Cadence();
  run(busy, t0, t0 + 2 * HOUR, {windows: () => low});
  assert.deepEqual(gaps(run(busy, t0 + 2 * HOUR, t0 + 2 * HOUR + 10 * MIN, {windows: () => low, inUse: () => true})).slice(-3), [1, 1, 1]);

  // An empty window is not little left: it waits for its reset as an idle one does. The edge is 10%.
  assert.deepEqual(gaps(run(new Cadence(), t0, t0 + 50 * MIN, {windows: () => [win(0)]})), [2, 4, 8, 15, 15]);
  assert.ok(gaps(run(new Cadence(), t0, t0 + 10 * MIN, {windows: () => [win(10)]})).every(g => g === 1));
  assert.deepEqual(gaps(run(new Cadence(), t0, t0 + 50 * MIN, {windows: () => [win(11)]})), [2, 4, 8, 15, 15]);
  // A window already reset is not little left either.
  assert.deepEqual(gaps(run(new Cadence(), t0, t0 + 50 * MIN, {windows: () => [win(5, t0 - MIN)]})), [2, 4, 8, 15, 15]);
});

test('S3: use anywhere brings it back to every 2 minutes, and a measurement then starts the stretching over', () => {
  const cadence = new Cadence();
  const idle = run(cadence, t0, t0 + 30 * MIN);
  const last = idle.at(-1)!;
  const busy = run(cadence, t0 + 30 * MIN, t0 + 40 * MIN, {inUse: () => true});
  assert.ok(busy[0] <= last + 2 * MIN, 'measured within 2 minutes of the last measurement');
  assert.ok(gaps([last, ...busy]).every(g => g <= 2));
  // Quiet again: 2, 4… from the last measurement in use.
  const again = run(cadence, t0 + 40 * MIN, t0 + 60 * MIN);
  assert.deepEqual(gaps([busy.at(-1)!, ...again]).slice(0, 3), [2, 4, 8]);
});

test('S5: a known reset pulls the next measurement to 30 seconds after it, never sooner than the device agrees to', () => {
  const stretched = () => {
    const cadence = new Cadence();
    const measured = run(cadence, t0, t0 + 30 * MIN);
    return {cadence, last: measured.at(-1)!};
  };
  const {cadence, last} = stretched();
  const reset = last + 3 * MIN;
  const view = cadence.view('acc', 'laptop', last + 15 * S, {windows: [win(50, reset)], inUse: false});
  assert.deepEqual(view, {next: reset + 30 * S, why: 'reset'});
  assert.deepEqual(run(cadence, last + 15 * S, last + 5 * MIN, {windows: () => [win(50, reset)]}), [reset + 30 * S]);

  // A reset before the last measurement is behind it already.
  const other = stretched();
  assert.equal(other.cadence.view('acc', 'laptop', other.last + 15 * S, {windows: [win(50, other.last - MIN)], inUse: false})?.next, other.last + 15 * MIN);

  // A device that measures at most every 5 minutes is not asked sooner.
  const least = new Cadence();
  const measured = run(least, t0, t0 + 30 * MIN, {minIntervalMs: 5 * MIN});
  const end = measured.at(-1)!;
  const soon = end + MIN;
  assert.equal(least.view('acc', 'laptop', end + 15 * S, {windows: [win(50, soon)], inUse: false})?.next, end + 5 * MIN);
});

test('S6: the least interval of a device holds, and a long one never lets a measurement go stale before the next', () => {
  assert.ok(gaps(run(new Cadence(), t0, t0 + 30 * MIN, {windows: () => [win(5)], minIntervalMs: 5 * MIN})).every(g => g === 5));
  const answer = new Cadence().answer('acc', 'laptop', 'codex', t0, 86_400_000, quiet);
  assert.equal(answer.measure, true);
  assert.equal(answer.nextInMs, MAX_GAP_MS);
  assert.ok(staleFor(answer.nextInMs!) <= 24 * HOUR, 'the agent can promise it');
});

test('S7: the next measurement is never later than the one promised when asked', () => {
  for (const skew of [0, -20 * S]) {
    const cadence = new Cadence();
    const last = run(cadence, t0, t0 + 30 * MIN).at(-1)!;
    // Stretched to 15 minutes; then someone works: measured within 2, promising the next within 4.
    let t = last + 15 * S;
    let answer: Answer;
    while (!(answer = cadence.answer('acc', 'laptop', 'codex', t, null, {...quiet, inUse: true})).measure) t += answer.askInMs;
    assert.ok(t <= last + 2 * MIN);
    assert.equal(answer.nextInMs, 4 * MIN);
    // The work stops before the measurement arrives, the numbers are the same: without the promise it would wait 15 minutes.
    const observedAt = t + skew;
    cadence.delivered('acc', 'laptop', reading(quiet.windows), observedAt, staleFor(answer.nextInMs!), false, t + 5 * S);
    const view = cadence.view('acc', 'laptop', t + 15 * S, quiet)!;
    assert.equal(view.next, observedAt + 4 * MIN, `skew ${skew}`);
  }
});

test('S10: after a restart the first paced holder measures at once', () => {
  const cadence = new Cadence();
  run(cadence, t0, t0 + 30 * MIN);
  assert.equal(new Cadence().answer('acc', 'laptop', 'codex', t0 + 31 * MIN, null, quiet).measure, true);
});

test('S11: a measurement nothing came back for is asked again after 90 s, then less and less often', () => {
  // The first answer is lost; so are the next four.
  const lost = new Set<number>();
  const cadence = new Cadence();
  const measured = run(cadence, t0, t0 + 60 * MIN, {
    delivers: t => {
      if (lost.size >= 5) return true;
      lost.add(t);
      return false;
    },
  });
  assert.deepEqual(gaps(measured).slice(0, 6), [1.5, 2, 4, 8, 15, 2], 'an answer ends the ladder: the pace is back');

  // An answer from an agent whose clock is behind still answers.
  const behind = new Cadence();
  const first = behind.answer('acc', 'laptop', 'codex', t0, null, quiet);
  behind.delivered('acc', 'laptop', reading(quiet.windows), t0 - 20 * S, staleFor(first.nextInMs!), false, t0 + 5 * S);
  assert.equal(behind.view('acc', 'laptop', t0 + 15 * S, quiet)?.next, t0 - 20 * S + 2 * MIN, 'the pace, not 90 s after asking');

  // A new holder measures at once, whatever the old one left unanswered.
  const handed = new Cadence();
  handed.answer('acc', 'laptop', 'codex', t0, null, quiet);
  assert.equal(handed.answer('acc', 'server', 'codex', t0 + 15 * S, null, quiet).measure, true);
});

test('S12: a device waits out its failures, the hub counts each once, and another device is not held back', () => {
  const told = (cadence: Cadence, device: string, t: number) => cadence.answer('acc', device, 'codex', t, null, quiet);
  const next = (cadence: Cadence, from: number, device = 'laptop') => {
    for (let t = from, answer: Answer; t < from + 2 * HOUR; t += Math.max(S, answer.askInMs)) if ((answer = told(cadence, device, t)).measure) return t;
    return null;
  };

  // Signed out: 15 minutes. Other failures: 2, 4, 8, 15 minutes in a row.
  const out = new Cadence();
  out.answer('acc', 'laptop', 'codex', t0, null, quiet);
  out.failed('acc', 'laptop', 'not_logged_in', t0 + 5 * S);
  assert.equal(next(out, t0 + 15 * S), t0 + 5 * S + 15 * MIN);

  const failing = new Cadence();
  let t = t0;
  failing.answer('acc', 'laptop', 'codex', t, null, quiet);
  const waits: number[] = [];
  for (let i = 0; i < 5; i++) {
    failing.failed('acc', 'laptop', 'timeout', t + 5 * S);
    const at = next(failing, t + 15 * S)!;
    waits.push((at - (t + 5 * S)) / MIN);
    t = at;
  }
  assert.deepEqual(waits, [2, 4, 8, 15, 15]);
  // A measurement of this device ends its pause: the next failure is the first in a row again.
  failing.delivered('acc', 'laptop', reading(quiet.windows), t + 5 * S, staleFor(4 * MIN), false, t + 6 * S);
  const again = next(failing, t + 15 * S)!;
  assert.equal(again, t + 5 * S + 2 * MIN);
  failing.failed('acc', 'laptop', 'timeout', again + 5 * S);
  assert.equal(failing.pausedUntil('acc', 'laptop', again + 15 * S), again + 5 * S + 2 * MIN);

  // Stretched to 15 minutes, then one timeout: measured again when its pause is over, not 15 minutes after asking.
  const stretched = new Cadence();
  const due = run(stretched, t0, t0 + 45 * MIN).at(-1)! + 15 * MIN;
  assert.equal(told(stretched, 'laptop', due).measure, true);
  stretched.failed('acc', 'laptop', 'timeout', due + 30 * S);
  assert.equal(next(stretched, due + 45 * S), due + 30 * S + 2 * MIN);

  // A failure of a device off duty does not change the holder's pace.
  const shared = new Cadence();
  const measured = run(shared, t0, t0 + 30 * MIN);
  shared.failed('acc', 'server', 'failed', t0 + 30 * MIN);
  assert.equal(shared.view('acc', 'laptop', t0 + 30 * MIN + 15 * S, quiet)?.next, measured.at(-1)! + 15 * MIN);
  assert.equal(shared.pausedUntil('acc', 'server', t0 + 31 * MIN), t0 + 32 * MIN);

  // A failure no later than the last measurement (from the spool) and the same failure again count once.
  const spool = new Cadence();
  run(spool, t0, t0 + 10 * MIN);
  spool.failed('acc', 'laptop', 'timeout', t0 + 5 * MIN);
  assert.equal(spool.pausedUntil('acc', 'laptop', t0 + 10 * MIN), null, 'older than the last measurement');
  spool.failed('acc', 'laptop', 'timeout', t0 + 10 * MIN);
  spool.failed('acc', 'laptop', 'timeout', t0 + 10 * MIN);
  assert.equal(spool.pausedUntil('acc', 'laptop', t0 + 10 * MIN), t0 + 12 * MIN, 'a repeat is not a second failure');
});

test('answers are whole milliseconds, whatever a measurement promised', () => {
  const cadence = new Cadence();
  run(cadence, t0, t0 + 30 * MIN);
  // Measured on its own schedule, as the agent says it: 131 234 ms to its next, a fifth more and a minute.
  const observedAt = t0 + 30 * MIN;
  cadence.delivered('acc', 'laptop', reading(quiet.windows), observedAt, 131_234 + 26_246 + 60_000, false, observedAt + S);
  let fractions = 0;
  run(cadence, observedAt + 15 * S, observedAt + 10 * MIN, {
    told: answer => {
      for (const value of [answer.askInMs, answer.nextInMs ?? 0]) if (!Number.isInteger(value)) fractions++;
    },
  });
  assert.equal(fractions, 0);
  assert.equal(Number.isInteger(cadence.view('acc', 'laptop', observedAt + 15 * S, quiet)!.next), true);
});

test('a measurement that says it holds for less than a minute is not asked for again sooner', () => {
  const cadence = new Cadence();
  run(cadence, t0, t0 + 30 * MIN);
  cadence.delivered('acc', 'laptop', reading(quiet.windows), t0 + 30 * MIN, 61_000, false, t0 + 30 * MIN);
  assert.equal(cadence.view('acc', 'laptop', t0 + 30 * MIN + 15 * S, quiet)?.next, t0 + 31 * MIN);
});

test('work starting on a subscription with little left, quiet for hours, is measured within the minute', () => {
  const cadence = new Cadence();
  const low = [win(5)];
  const last = run(cadence, t0, t0 + 4 * HOUR, {windows: () => low}).at(-1)!;
  const busy = run(cadence, last + 15 * S, last + 10 * MIN, {windows: () => low, inUse: () => true});
  assert.equal(busy[0], last + MIN, 'not 5 minutes after the last');
});

test('only the device told to measure answers the question', () => {
  // Another device's measurement is no answer: the one told is asked again after 90 s.
  const other = new Cadence();
  assert.equal(other.answer('acc', 'laptop', 'codex', t0, null, quiet).measure, true);
  other.delivered('acc', 'server', reading(quiet.windows), t0 + 10 * S, staleFor(4 * MIN), false, t0 + 10 * S);
  assert.equal(other.answer('acc', 'laptop', 'codex', t0 + 90 * S, null, quiet).measure, true);

  // A new holder starts its own questions: its first lost answer is asked again after 90 s too.
  const handed = new Cadence();
  handed.answer('acc', 'laptop', 'codex', t0, null, quiet);
  handed.answer('acc', 'laptop', 'codex', t0 + 90 * S, null, quiet);
  assert.equal(handed.answer('acc', 'server', 'codex', t0 + 100 * S, null, quiet).measure, true);
  assert.equal(handed.answer('acc', 'server', 'codex', t0 + 189 * S, null, quiet).measure, false);
  assert.equal(handed.answer('acc', 'server', 'codex', t0 + 190 * S, null, quiet).measure, true);

  // Failures answer too: after three in a row, a lost answer is still asked again after 90 s.
  const failing = new Cadence();
  const next = (from: number) => {
    for (let t = from, answer: Answer; t < from + HOUR; t += Math.max(S, answer.askInMs)) if ((answer = failing.answer('acc', 'laptop', 'codex', t, null, quiet)).measure) return t;
    return null;
  };
  let t = t0;
  failing.answer('acc', 'laptop', 'codex', t, null, quiet);
  for (let i = 0; i < 3; i++) {
    failing.failed('acc', 'laptop', 'timeout', t + 5 * S);
    t = next(t + 15 * S)!;
  }
  assert.equal(next(t + 15 * S), t + 90 * S);
});

test('a device that measures at most every hour is not asked sooner, even when its answers are lost', () => {
  const measured = run(new Cadence(), t0, t0 + 3 * HOUR, {minIntervalMs: HOUR, delivers: () => false});
  assert.deepEqual(gaps(measured), [60, 60]);
});

test('while a measurement is under way, the board says the next one comes any moment', () => {
  const cadence = new Cadence();
  run(cadence, t0, t0 + 30 * MIN);
  const due = t0 + 44 * MIN;
  assert.equal(cadence.answer('acc', 'laptop', 'codex', due, null, quiet).measure, true);
  assert.equal(cadence.view('acc', 'laptop', due + 30 * S, quiet)?.next, due);
  assert.equal(cadence.view('acc', 'laptop', due + 2 * MIN, quiet)?.next, due + 90 * S, 'then, not heard from, it is asked again');
});

test('S14: a measurement taken without asking is not left to go stale', () => {
  const cadence = new Cadence();
  run(cadence, t0, t0 + 30 * MIN);
  // The agent measured on its own (the hub did not answer in time), promising its next in 2 minutes.
  const observedAt = t0 + 30 * MIN;
  cadence.delivered('acc', 'laptop', reading(quiet.windows), observedAt, 204 * S, false, observedAt + S);
  assert.ok(cadence.view('acc', 'laptop', observedAt + 15 * S, quiet)!.next <= observedAt + 2 * MIN);
});

test('S13: the board sees the plan of a paced holder that asks, and it stays put between asks', () => {
  const cadence = new Cadence();
  const last = run(cadence, t0, t0 + 30 * MIN).at(-1)!;
  const view = cadence.view('acc', 'laptop', last + MIN, quiet);
  assert.deepEqual(view, {next: last + 15 * MIN, why: 'idle'});
  assert.deepEqual(cadence.view('acc', 'laptop', last + 2 * MIN, quiet), view, 'the same until the plan moves');
  assert.equal(cadence.view('acc', 'server', last + MIN, quiet), null, 'another device on duty');
  assert.equal(cadence.view('acc', null, last + MIN, quiet), null);
  assert.equal(cadence.view('acc', 'laptop', t0 + 32 * MIN + S, quiet), null, 'a holder quiet for over 2 minutes');
  cadence.failed('acc', 'laptop', 'timeout', last + MIN);
  assert.equal(cadence.view('acc', 'laptop', last + 70 * S, quiet), null, 'a holder waiting out a failure');
  assert.equal(new Cadence().view('acc', 'laptop', t0, quiet), null, 'a holder that never followed the pace');

  // Why: numbers that just changed, use, little left.
  const why = (signals: Signals, used = 50) => {
    const c = new Cadence();
    run(c, t0, t0 + 3 * MIN);
    c.delivered('acc', 'laptop', [{id: '5h', usedPercent: used}], t0 + 3 * MIN, staleFor(4 * MIN), false, t0 + 3 * MIN);
    return c.view('acc', 'laptop', t0 + 3 * MIN, signals)?.why;
  };
  assert.equal(why(quiet, 51), 'changed');
  assert.equal(why(quiet), 'idle');
  assert.equal(why({...quiet, inUse: true}), 'inUse');
  assert.equal(why({windows: [win(5)], inUse: false}), 'low');
});

// ---------- through check-ins and deliveries ----------

const iso = (ms: number) => new Date(ms).toISOString();
const ACCOUNT = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const machine = (id: string) => ({id: `${id}-0123456789`, name: id, os: 'linux', arch: 'x86_64'});

/** A hub with Alice and a machine token of hers; her machines ask about one Codex account. */
function hub() {
  const store = new Store(path.join(mkdtempSync(path.join(tmpdir(), 'quotum-cadence-')), 'db.sqlite'), t0);
  const directory = new Directory(store.db);
  const duty = new Duty();
  const ingest = new Ingest(store, directory, duty, new Cadence());
  const alice = directory.createUser('alice@example.com', 'Alice', 'x', t0);
  const secret = newSecret('qt_m');
  directory.createToken(secret, '…', alice.id, 'images', t0);
  const token = ingest.authenticate(`Bearer ${secret}`) as Credential;
  const ask = (device: string, t: number, change: {active?: boolean; minIntervalMs?: number; paced?: boolean} = {}) => {
    const {paced = true, ...subscription} = change;
    const body = {version: 1, agent: 'quotum/0.4.0', paced, machine: machine(device), subscriptions: [{provider: 'codex', account: ACCOUNT, active: false, ...subscription}]};
    return ingest.checkin(token, body, t).subscriptions[0];
  };
  const deliver = (device: string, t: number, used = 50, nextInMs = 4 * MIN, failure?: string) =>
    ingest.accept(
      token,
      {
        version: 1,
        agent: 'quotum/0.4.0',
        machine: machine(device),
        sentAt: iso(t),
        snapshots: failure
          ? []
          : [
              {
                provider: 'codex',
                account: ACCOUNT,
                plan: 'pro',
                observedAt: iso(t),
                via: 'codex/app-server',
                staleAfterMs: staleFor(nextInMs),
                windows: [{id: '5h', kind: 'session', minutes: 300, usedPercent: used, resetsAt: null}],
              },
            ],
        failures: failure ? [{provider: 'codex', observedAt: iso(t), error: failure}] : [],
      },
      t,
    );
  const working = (device: string, t: number, busy = true) =>
    ingest.sessions(
      token,
      {
        version: 1,
        agent: 'quotum/0.4.0',
        machine: machine(device),
        sentAt: iso(t),
        sessions: [{provider: 'codex', account: ACCOUNT, origin: 'app', startedAt: iso(t - MIN), lastWorkedAt: iso(t), working: busy}],
      },
      t,
    );
  /** Asks every 15 s as a paced holder does, measuring and delivering when told; returns when it measured. */
  const follow = (device: string, from: number, to: number, change: Parameters<typeof ask>[2] = {}, used = () => 50) => {
    const measured: number[] = [];
    for (let t = from; t < to; ) {
      const answer = ask(device, t, change);
      if (answer.measure) {
        measured.push(t);
        deliver(device, t, used(), answer.nextInMs);
      }
      t += Math.max(10 * S, answer.askInMs!);
    }
    return measured;
  };
  const source = () => store.findSource('codex', ACCOUNT)!;
  return {store, ingest, duty, ask, deliver, working, follow, source, device: (name: string) => directory.deviceByMachine(alice.id, machine(name).id)!.id};
}

test('S3, S4: use on another machine or on the holder brings the pace to 2 minutes', () => {
  // An agent open but idle on another machine is not use.
  const idle = hub();
  const quietly = idle.follow('laptop', t0, t0 + 30 * MIN).at(-1)!;
  idle.working('server', t0 + 30 * MIN, false);
  assert.deepEqual(idle.follow('laptop', t0 + 30 * MIN, t0 + 45 * MIN), [quietly + 15 * MIN]);

  const h = hub();
  const last = h.follow('laptop', t0, t0 + 30 * MIN).at(-1)!;
  // An agent works on the server, which does not measure: the laptop measures within 2 minutes, and again while it lasts.
  h.working('server', t0 + 30 * MIN);
  const busy = h.follow('laptop', t0 + 30 * MIN, t0 + 34 * MIN);
  assert.deepEqual(busy, [last + 2 * MIN, last + 4 * MIN]);
  // The server's list no longer counts after 200 s: stretching starts again.
  const quiet = h.follow('laptop', t0 + 34 * MIN, t0 + 50 * MIN);
  assert.deepEqual(gaps([busy.at(-1)!, ...quiet]).slice(0, 2), [2, 4]);

  // The holder says its client is in use: 2 minutes; two minutes without it, stretching again.
  const g = hub();
  const end = g.follow('laptop', t0, t0 + 30 * MIN).at(-1)!;
  assert.equal(g.ask('laptop', end + 15 * S, {active: true}).measure, false);
  const active = g.follow('laptop', end + 30 * S, end + 3 * MIN);
  assert.deepEqual(active, [end + 2 * MIN]);
  const after = g.follow('laptop', end + 3 * MIN, end + 20 * MIN);
  assert.deepEqual(gaps([end + 2 * MIN, ...after]).slice(0, 2), [2, 4], 'the measurement in use starts the stretching over');
});

test('S8: a device that does not follow the pace is answered as before', () => {
  const h = hub();
  const answer = h.ask('laptop', t0, {paced: false});
  assert.deepEqual(answer, {provider: 'codex', measure: true, until: iso(t0)});
  h.deliver('laptop', t0);
  assert.equal(h.ask('laptop', t0 + 15 * S, {paced: false}).measure, true, 'the holder measures whenever it asks');
  assert.equal(h.ingest.nextMeasurement(h.source(), ACCOUNT, t0 + 15 * S), null, 'and the board shows no plan');
});

test('S9: a paced holder asks often without extending its lease; a device waiting out failures does not take duty', () => {
  const h = hub();
  const laptop = () => h.device('laptop');
  assert.equal(h.ask('laptop', t0).measure, true);
  h.deliver('laptop', t0);
  const early = h.ask('laptop', t0 + 15 * S);
  assert.deepEqual([early.measure, early.onDuty, early.askInMs], [false, true, 15 * S]);
  assert.equal(early.until, iso(t0 + 30 * S));
  assert.equal(h.duty.until(ACCOUNT), t0 + staleFor(4 * MIN), 'asking does not extend the lease');
  assert.equal(h.duty.holder(ACCOUNT), laptop());

  // The laptop fails; its lease runs out; it asks before the healthy server does and is refused duty.
  const failedAt = t0 + 2 * MIN;
  assert.equal(h.ask('laptop', failedAt).measure, true);
  h.deliver('laptop', failedAt, 50, 4 * MIN, 'not_logged_in');
  // The server, not on duty and healthy, is told when the holder's lease runs out.
  const waits = h.ask('server', t0 + 3 * MIN);
  assert.deepEqual([waits.measure, waits.onDuty, waits.askInMs], [false, false, t0 + staleFor(4 * MIN) - (t0 + 3 * MIN)]);
  const lease = h.duty.until(ACCOUNT)!;
  const refused = h.ask('laptop', lease + S);
  assert.equal(refused.askInMs, 10 * MIN, 'at most ten minutes, though its pause lasts longer');
  assert.deepEqual([refused.measure, refused.onDuty], [false, true], 'no one else holds it: its own pause, quietly');
  assert.equal(h.duty.holder(ACCOUNT), laptop(), 'not claimed');
  const server = h.ask('server', lease + 2 * S);
  assert.deepEqual([server.measure, server.onDuty], [true, true], 'the healthy server takes duty and measures at once');
  const other = h.ask('laptop', lease + 3 * S);
  assert.deepEqual([other.measure, other.onDuty], [false, false], 'another device measures');

  // A device in its pause and in use does not take duty from an idle holder either.
  h.deliver('server', lease + 2 * S);
  h.follow('server', lease + 15 * S, lease + 20 * MIN);
  h.deliver('laptop', lease + 20 * MIN, 50, 4 * MIN, 'timeout');
  const busy = h.ask('laptop', lease + 20 * MIN + S, {active: true});
  assert.deepEqual([busy.measure, busy.onDuty], [false, false]);
  assert.notEqual(h.duty.holder(ACCOUNT), laptop());

  // Handed over to a working device that measures at most every 30 minutes: it measures at once and keeps its own pace.
  const g = hub();
  g.follow('server', t0, t0 + 20 * MIN);
  const taken = g.follow('laptop', t0 + 20 * MIN, t0 + 90 * MIN, {active: true, minIntervalMs: 30 * MIN});
  assert.equal(taken[0], t0 + 20 * MIN);
  assert.deepEqual(gaps(taken), [30, 30]);
});

test('S9: a new holder waiting out its failures measures when its pause is over', () => {
  const h = hub();
  // The server measures, then goes silent; the laptop, not following the pace, delivers once its lease is over, then fails.
  h.follow('server', t0, t0 + 3 * MIN);
  h.deliver('laptop', t0 + 8 * MIN);
  assert.equal(h.duty.holder(ACCOUNT), h.device('laptop'));
  h.deliver('laptop', t0 + 9 * MIN, 50, 4 * MIN, 'failed');
  const paused = h.ask('laptop', t0 + 9 * MIN + 15 * S);
  assert.deepEqual([paused.measure, paused.onDuty], [false, true]);
  assert.equal(h.follow('laptop', t0 + 9 * MIN + 15 * S, t0 + 15 * MIN)[0], t0 + 11 * MIN, 'at the end of its 2-minute pause');
});

test('S12: failures reach the pace through the hub, even when the subscription is fresh from another device', () => {
  const h = hub();
  h.follow('laptop', t0, t0 + 5 * MIN);
  // The laptop is told to measure, and fails a minute after its last good measurement.
  const due = h.follow('laptop', t0 + 5 * MIN, t0 + 7 * MIN).at(-1)!;
  h.deliver('laptop', due + 30 * S, 50, 4 * MIN, 'timeout');
  assert.equal(h.store.state(h.source()).error, null, 'the source is fresh: no failure on the card');
  assert.equal(h.ingest.nextMeasurement(h.source(), ACCOUNT, due + 45 * S), null, 'the holder waits out its failure');
  assert.equal(h.ask('laptop', due + 45 * S).askInMs, 15 * S);
  assert.equal(h.ingest.nextMeasurement(h.source(), ACCOUNT, due + 30 * S + 2 * MIN - S), null);
  assert.notEqual(h.ingest.nextMeasurement(h.source(), ACCOUNT, due + 45 * S + 2 * MIN), null, 'over');

  // A device that never delivered for the provider: its failure is about the subscription it was told to measure.
  const g = hub();
  assert.equal(g.ask('laptop', t0).measure, true);
  g.deliver('laptop', t0 + 5 * S, 50, 4 * MIN, 'timeout');
  const waiting = g.ask('laptop', t0 + 15 * S);
  assert.deepEqual([waiting.measure, waiting.askInMs], [false, 15 * S]);
  // Its pause ends at 2:05; asked at 2:00, it comes back no sooner than 10 s later.
  assert.equal(g.follow('laptop', t0 + 15 * S, t0 + 5 * MIN)[0], t0 + 2 * MIN + 10 * S);
});

test('S13: the overview tells when a paced holder measures next and why', () => {
  const h = hub();
  const last = h.follow('laptop', t0, t0 + 10 * MIN, {}, () => 50).at(-1)!;
  assert.deepEqual(h.ingest.nextMeasurement(h.source(), ACCOUNT, last + 15 * S), {next: last + 8 * MIN, why: 'idle'});
  h.working('server', last + 30 * S);
  assert.deepEqual(h.ingest.nextMeasurement(h.source(), ACCOUNT, last + 30 * S), {next: last + 2 * MIN, why: 'inUse'});
});

test('S15: a check-in with a malformed pace is refused', () => {
  const body = (change: object) => ({version: 1, agent: 'quotum/0.4.0', machine: machine('laptop'), subscriptions: [{provider: 'codex', active: false}], ...change});
  const sub = (change: object) => body({subscriptions: [{provider: 'codex', active: false, ...change}]});
  assert.throws(() => parseCheckin(body({paced: 'yes'})), Invalid);
  for (const minIntervalMs of [59_999, 86_400_001, 90_000.5, '120000']) assert.throws(() => parseCheckin(sub({minIntervalMs})), Invalid, String(minIntervalMs));
  const parsed = parseCheckin(sub({minIntervalMs: 60_000}));
  assert.deepEqual([parsed.paced, parsed.subscriptions[0].minIntervalMs], [false, 60_000]);
  assert.equal(parseCheckin(body({paced: true})).subscriptions[0].minIntervalMs, null);
});
