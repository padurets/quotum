import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clip, forecastLine, forecastRow, outlook, type Outlook} from '../lib/forecast';
import {DEFAULT_PLAN, type WeeklyPlan} from '../lib/plan';
import type {Win} from '../lib/types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The windows here start on Saturday 26 September 10:00. */
const start = Date.parse('2026-09-26T10:00:00Z');
const week = (remaining: number, change: Partial<Win> = {}): Win => ({id: 'weekly', kind: 'weekly', label: null, used: 100 - remaining, remaining, resetAt: start + 7 * DAY, minutes: 10080, ...change});
const hours = (remaining: number, change: Partial<Win> = {}): Win => ({id: 'session', kind: 'session', label: null, used: 100 - remaining, remaining, resetAt: start + 5 * HOUR, minutes: 300, ...change});
/** The outlook of a window measured `elapsed` into it, now. */
const at = (live: Win, elapsed: number, plan: WeeklyPlan | null = null, later = 0) => outlook(live, start + elapsed, start + elapsed + later, plan);
const pick = (ahead: Outlook) => ({key: ahead.key, tone: ahead.tone, ...('left' in ahead ? {left: Math.round(ahead.left * 10) / 10} : {})});

test('without a plan, the pace since the window started leads to where it runs out', () => {
  // Tuesday 10:00, 62% spent in 72 hours: 0.86%/h, and the 38% left last 44 hours more.
  const ahead = at(week(38), 72 * HOUR);
  assert.equal(ahead.key, 'runsOut');
  if (ahead.key !== 'runsOut' || ahead.pace.by !== 'hour') return;
  assert.ok(Math.abs(ahead.pace.rate - 62 / 72) < 1e-9);
  assert.ok(Math.abs(ahead.at - Date.parse('2026-10-01T06:07:44Z')) < MIN, new Date(ahead.at).toISOString());
  assert.equal(ahead.inMs, ahead.at - (start + 72 * HOUR));
  // 44 hours to zero, 96 to the reset: under half of the time left.
  assert.equal(ahead.tone, 'v-crit');
});

test('a week with a plan is foreseen along the shape of the plan', () => {
  // The same measurement: the default plan has spent 70 by then, and 62 is 0.89 of it.
  const behind = at(week(38), 72 * HOUR, DEFAULT_PLAN);
  assert.deepEqual(pick(behind), {key: 'leftPlan', tone: 'muted', left: 11.4});
  assert.ok('pace' in behind && behind.pace.by === 'plan' && Math.abs(behind.pace.k - 62 / 70) < 1e-9);
  // 80 spent against 70 planned: the plan's 87.5 comes at hour 102, 30 hours on, before half of the 72 left to its end.
  const ahead = at(week(20), 72 * HOUR, DEFAULT_PLAN);
  assert.equal(ahead.key, 'runsOut');
  if (ahead.key !== 'runsOut') return;
  assert.equal(ahead.at, start + 102 * HOUR);
  assert.equal(ahead.tone, 'v-crit');
});

test('spending as the plan does is on pace, a point or so ahead of it too', () => {
  const planned = [70, 45, 30, 15, 5];
  for (const [day, remaining] of planned.entries()) assert.equal(at(week(remaining), (day + 1) * DAY, DEFAULT_PLAN).key, 'onPacePlan', `day ${day + 1}`);
  for (const [elapsed, remaining] of [[36, 57], [72, 29], [100, 12]]) assert.equal(at(week(remaining), elapsed * HOUR, DEFAULT_PLAN).key, 'onPacePlan', `${elapsed}h`);
});

test('on pace is five points either way of spending it all by the deadline', () => {
  // Half the week gone without a plan: what is left at the reset is twice the remaining less 100.
  assert.equal(at(week(47.5), 84 * HOUR).key, 'runsOut');
  assert.equal(at(week(47.6), 84 * HOUR).key, 'onPaceReset');
  assert.equal(at(week(52.4), 84 * HOUR).key, 'onPaceReset');
  assert.deepEqual(pick(at(week(52.5), 84 * HOUR)), {key: 'leftReset', tone: '', left: 5});
  // Along a plan of four days, half of it planned by hour 48: 5% over the plan by its end is the edge.
  const even = [25, 25, 25, 25, 0, 0, 0];
  assert.equal(at(week(47.49), 48 * HOUR, even).key, 'runsOut');
  assert.equal(at(week(47.51), 48 * HOUR, even).key, 'onPacePlan');
  assert.equal(at(week(52.49), 48 * HOUR, even).key, 'onPacePlan');
  assert.equal(at(week(52.51), 48 * HOUR, even).key, 'leftPlan');
});

test('a plan that has planned under ten points leaves the week to its calendar pace', () => {
  const late = [0, 0, 20, 20, 20, 20, 20];
  // Ten points exactly, at hour 60, is along the plan.
  const edge = at(week(97), 60 * HOUR, late);
  assert.ok('pace' in edge && edge.pace.by === 'plan');
  // 3 points over the weekend: at hour 59 the plan has planned 9.2, at hour 61 10.8.
  const before = at(week(97), 59 * HOUR, late);
  const after = at(week(97), 61 * HOUR, late);
  assert.ok('pace' in before && before.pace.by === 'hour');
  assert.ok('pace' in after && after.pace.by === 'plan');
  assert.deepEqual(pick(before), {key: 'leftPlan', tone: 'muted', left: 91.5});
  assert.deepEqual(pick(after), {key: 'leftPlan', tone: 'muted', left: 72.3});
});

test('past the end of its plan a week holds level until its reset', () => {
  assert.deepEqual(pick(at(week(10), 144.1 * HOUR, DEFAULT_PLAN)), {key: 'leftReset', tone: '', left: 10});
  assert.deepEqual(pick(at(week(50), 24.1 * HOUR, [100, 0, 0, 0, 0, 0, 0])), {key: 'leftReset', tone: '', left: 50});
  const line = forecastLine(week(10), start + 144.1 * HOUR, start + 144.1 * HOUR, DEFAULT_PLAN, start, start + 8 * DAY)!;
  assert.deepEqual(line.points.map(([, value]) => Math.round(value * 1e9) / 1e9), [10, 10]);
  assert.equal(line.points.at(-1)![0], start + 7 * DAY);
});

test('the forecast counts from the measurement: the moment it runs out stays, and so does its tone against now', () => {
  const measured = start + 72 * HOUR;
  const fresh = outlook(week(38), measured, measured, null);
  const older = outlook(week(38), measured, measured + 10 * MIN, null);
  assert.ok(fresh.key === 'runsOut' && older.key === 'runsOut');
  if (fresh.key !== 'runsOut' || older.key !== 'runsOut') return;
  assert.equal(older.at, fresh.at);
  assert.equal(older.inMs, fresh.at - (measured + 10 * MIN));
  // Numbers gone stale foresee the same, until that moment has come.
  assert.equal(outlook(week(38), measured, measured + 40 * HOUR, null).key, 'runsOut');
  assert.deepEqual(outlook(week(38), measured, fresh.at, null), {key: 'pastZero', at: fresh.at, tone: ''});
  // The tone is how soon from now: 60 points in 84 hours run out 56 hours on, past half of the 84 to the reset;
  // 30 hours later that is 26 hours of 54, under half.
  const half = start + 84 * HOUR;
  assert.equal(outlook(week(40), half, half, null).tone, 'v-warn');
  // 16 hours on, 40 hours to zero of 68 to the reset: still warn, judged against the time left from now.
  assert.equal(outlook(week(40), half, half + 16 * HOUR, null).tone, 'v-warn');
  assert.equal(outlook(week(40), half, half + 30 * HOUR, null).tone, 'v-crit');
});

test('the period on screen does not change the forecast', () => {
  const live = week(38);
  const day = forecastRow({consumed: 40, coveredMs: 20 * HOUR}, live, start + 72 * HOUR, start + 72 * HOUR, DEFAULT_PLAN);
  const month = forecastRow({consumed: 150, coveredMs: 20 * DAY}, live, start + 72 * HOUR, start + 72 * HOUR, DEFAULT_PLAN);
  assert.deepEqual(day.outlook, month.outlook);
  assert.notDeepEqual(day.spent, month.spent);
});

test('a window started too recently waits: half an hour, or a twentieth of the window', () => {
  const later = 5 * MIN;
  assert.equal(at(hours(80), 30 * MIN - 1, null, later).key, 'needData');
  assert.equal(at(hours(80), 30 * MIN, null, later).key, 'runsOut');
  assert.equal(at(week(99), 504 * MIN - 1, null, later).key, 'needData');
  assert.equal(at(week(99), 504 * MIN, null, later).key, 'leftReset');
});

test('a window without a forecast says why', () => {
  const measured = start + 3 * DAY;
  // An idle rolling window: its reset is its length from the measurement.
  assert.equal(outlook(hours(100, {resetAt: measured + 5 * HOUR}), measured, measured, null).key, 'idle');
  // Judged at the measurement, however long ago: an idle window measured seldom stays idle.
  assert.equal(outlook(hours(100, {resetAt: measured + 5 * HOUR}), measured, measured + 10 * MIN, null).key, 'idle');
  // Used, but within the tolerance of `started`: it has only just started.
  assert.equal(outlook(hours(99, {resetAt: measured + 5 * HOUR - MIN}), measured, measured, null).key, 'needData');
  // Back early: a new reset a week on, nothing used yet.
  assert.equal(outlook(week(100, {resetAt: measured + 7 * DAY - 10 * MIN}), measured, measured, DEFAULT_PLAN).key, 'needData');
  assert.deepEqual(outlook(week(0), measured, measured, DEFAULT_PLAN), {key: 'usedUp', tone: 'v-crit'});
  assert.equal(outlook(week(50, {resetAt: null}), measured, measured, null).key, 'none');
  assert.equal(outlook(week(50), measured, start + 7 * DAY, null).key, 'none', 'the reset has come');
  assert.equal(outlook(undefined, measured, measured, null).key, 'none');
  // Measured by a clock ahead of the page's, after the reset the page has not reached yet.
  assert.equal(outlook(week(50), start + 7 * DAY + MIN, start + 7 * DAY - MIN, null).key, 'none');
});

test('the deadline is the end of the plan while it runs, else the reset', () => {
  assert.equal(at(week(50), 48 * HOUR, DEFAULT_PLAN).key, 'leftPlan');
  assert.equal(at(week(80), 48 * HOUR).key, 'leftReset');
  assert.equal(at(week(20), 150 * HOUR, DEFAULT_PLAN).key, 'leftReset');
  assert.equal(at(hours(80), 2 * HOUR, DEFAULT_PLAN).key, 'leftReset', 'five hours are judged against their reset');
  // The plan's end, not the reset, sets the tone: 38 hours to zero of 72 to the plan's end
  // is warn, where 96 to the reset would have made it crit.
  assert.deepEqual(pick(at(week(23), 72 * HOUR, DEFAULT_PLAN)), {key: 'runsOut', tone: 'v-warn'});
  // The plan is judged when the window was measured: before its end, even if now is past it.
  assert.equal(outlook(week(3), start + 140 * HOUR, start + 146 * HOUR, DEFAULT_PLAN).key, 'onPacePlan');
  // A plan that has planned under ten points still sets the deadline: 10 left when it ends.
  assert.deepEqual(pick(at(week(87.5), 20 * HOUR, [5, 20, 20, 20, 20, 15, 0])), {key: 'leftPlan', tone: 'muted', left: 10});
  // Five hours never follow a week's plan, however much it front-loads.
  const front = at(hours(20), 4 * HOUR, [100, 0, 0, 0, 0, 0, 0]);
  assert.equal(front.key, 'onPaceReset');
  assert.ok('pace' in front && front.pace.by === 'hour' && front.pace.rate === 20);
  // Spending next to nothing leads to what is left.
  assert.deepEqual(pick(at(week(99.5), 100 * HOUR)), {key: 'leftReset', tone: '', left: 99.5});
  assert.equal(at(week(99.5), 100 * HOUR, DEFAULT_PLAN).key, 'leftPlan');
});

test('the forecast line runs from the measurement to zero or to the reset', () => {
  const measured = start + 72 * HOUR;
  const wide = [start, start + 8 * DAY] as const;
  // Straight without a plan, to the moment the table says.
  const straight = forecastLine(week(38), measured, measured, null, ...wide)!;
  const said = outlook(week(38), measured, measured, null);
  assert.equal(straight.points.length, 2);
  assert.deepEqual(straight.points[0], [measured, 38]);
  assert.ok(said.key === 'runsOut' && straight.at === said.at && straight.points[1][0] === said.at && straight.points[1][1] === 0);
  // Along the plan: through its day corners, to zero at hour 102.
  const bent = forecastLine(week(20), measured, measured, DEFAULT_PLAN, ...wide)!;
  assert.deepEqual(bent.points.map(([t]) => (t - start) / HOUR), [72, 96, 102]);
  assert.deepEqual(bent.points.map(([, value]) => Math.round(value * 100) / 100), [20, 2.86, 0]);
  // Lasting until the reset, it ends there, level past the plan's end.
  const lasting = forecastLine(week(38), measured, measured, DEFAULT_PLAN, ...wide)!;
  assert.deepEqual(lasting.points.map(([t]) => (t - start) / HOUR), [72, 96, 120, 144, 168]);
  assert.equal(lasting.at, null);
  assert.ok(lasting.points.at(-1)![1] > 0 && Math.abs(lasting.points.at(-1)![1] - lasting.points.at(-2)![1]) < 1e-9);
  // On pace may touch zero a little before the deadline; the line ends there, but the table does not say it runs out.
  const touching = forecastLine(week(47.5 + 0.2), start + 84 * HOUR, start + 84 * HOUR, null, ...wide)!;
  assert.equal(touching.at, null);
  assert.equal(touching.points.at(-1)![1], 0);
});

test('the forecast line is cut at the chart edges where it crosses them', () => {
  const measured = start + 72 * HOUR;
  const cut = forecastLine(week(38), measured, measured, null, measured + 10 * HOUR, measured + 20 * HOUR)!;
  assert.deepEqual(cut.points.map(([t]) => (t - measured) / HOUR), [10, 20]);
  assert.ok(Math.abs(cut.points[1][1] - (38 - (62 / 72) * 20)) < 1e-9);
  assert.ok(cut.at! > measured + 20 * HOUR, 'where it runs out is known beyond the edge');
  assert.deepEqual(clip([[0, 100], [10, 0]], 20, 30), []);
  assert.deepEqual(clip([[0, 100], [4, 60], [10, 0]], 2, 8), [[2, 80], [4, 60], [8, 20]]);
});

test('no line where the table has no forecast', () => {
  const measured = start + 3 * DAY;
  const none = (live: Win | undefined, now = measured) => forecastLine(live, measured, now, null, start, start + 8 * DAY);
  assert.equal(none(week(0)), null, 'used up');
  assert.equal(none(hours(100, {resetAt: measured + 5 * HOUR})), null, 'idle');
  assert.equal(none(week(100, {resetAt: measured + 7 * DAY - 10 * MIN})), null, 'just started');
  assert.equal(none(week(38), measured + 3 * DAY), null, 'past its zero');
  assert.equal(none(week(50, {resetAt: null})), null, 'no reset known');
});
