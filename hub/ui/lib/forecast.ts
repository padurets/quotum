import type {Win} from './types';
import type {Line} from './lines';
import {PLAN_TOLERANCE, planAt, started, weeklyPlanRemaining, type WeeklyPlan} from './plan';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A pace slower than this (percent per hour) spends nothing worth foreseeing. */
const MIN_RATE = 0.01;
/** How far (points) from spending all of it by the deadline still counts as on pace, either way: shares come in whole percents. */
const ON_PACE = 5;
/** A weekly window follows the shape of its plan once the plan has spent this much (points): before, its spending says little about the shape. */
const PLAN_FROM = 10;

/** How fast a window goes: percent per hour since it started, or `k` times as fast as its plan. */
export type Pace = {by: 'hour'; rate: number} | {by: 'plan'; k: number};

/**
 * Where a window's own pace leads, as the table's last column says it, and in which tone:
 * nothing to say (`none`), a rolling window not started yet (`idle`), started too
 * recently to tell (`needData`), used up, due to have run out already at `at`
 * (`pastZero`), runs out at `at`, on pace to spend it all by the deadline, or `left`
 * points left then.
 */
export type Outlook =
  | {key: 'none' | 'idle' | 'needData'; tone: ''}
  | {key: 'usedUp'; tone: 'v-crit'}
  | {key: 'pastZero'; at: number; tone: ''}
  | {key: 'runsOut'; at: number; inMs: number; tone: 'v-crit' | 'v-warn'; pace: Pace}
  | {key: 'onPacePlan' | 'onPaceReset'; tone: ''; pace: Pace}
  | {key: 'leftPlan'; left: number; tone: 'muted'; pace: Pace}
  | {key: 'leftReset'; left: number; tone: ''; pace: Pace};

/** How long a window must have run before its pace means something: half an hour, or a twentieth of the window. */
const forecastFrom = (minutes: number) => Math.max(30 * 60_000, (minutes * 60_000) / 20);

/**
 * Where a window goes from the moment it was measured until its reset: [time, remaining]
 * with straight stretches in between, not clamped at zero. Its pace is what was spent
 * since the window started over the calendar time since then, idle hours too. A weekly
 * window with a plan that has already planned `PLAN_FROM` points goes as the plan does,
 * `k` times as fast, and holds level past the plan's end, when the plan spends nothing.
 */
type Projection = {points: [number, number][]; pace: Pace; deadline: number; planned: boolean};

function projection(live: Win, measuredAt: number, weekly: WeeklyPlan | null): Projection {
  const resetAt = live.resetAt!;
  const start = resetAt - live.minutes! * 60_000;
  const spent = 100 - live.remaining;
  const plan = planAt(live, measuredAt, measuredAt, weekly);
  // Past the end of its plan a week has only its reset ahead.
  const planned = !!plan?.weekly && !plan.done;
  const deadline = planned ? plan!.deadline : resetAt;
  const planSpent = (t: number) => 100 - weeklyPlanRemaining(t - start, weekly!);
  if (plan?.weekly && planSpent(measuredAt) >= PLAN_FROM) {
    const k = spent / planSpent(measuredAt);
    // The plan bends at day boundaries; between them it is straight.
    const corners = Array.from({length: 7}, (_, day) => start + (day + 1) * DAY).filter(t => t > measuredAt && t < resetAt);
    const points = [measuredAt, ...corners, resetAt].map((t): [number, number] => [t, t === measuredAt ? live.remaining : 100 - k * planSpent(t)]);
    return {points, pace: {by: 'plan', k}, deadline, planned};
  }
  const rate = spent / ((measuredAt - start) / HOUR);
  const falls = rate > MIN_RATE ? rate : 0;
  return {points: [[measuredAt, live.remaining], [resetAt, live.remaining - (falls * (resetAt - measuredAt)) / HOUR]], pace: {by: 'hour', rate}, deadline, planned};
}

/** Value of a projection at `at`, within it. */
function valueAt(points: [number, number][], at: number): number {
  for (let i = 1; i < points.length; i++) {
    const [t0, v0] = points[i - 1];
    const [t1, v1] = points[i];
    if (at <= t1) return v0 + ((v1 - v0) * (at - t0)) / (t1 - t0);
  }
  return points.at(-1)![1];
}

/** The first moment a projection reaches zero, or null when it lasts until the reset. */
function zeroOf(points: [number, number][]): number | null {
  for (let i = 1; i < points.length; i++) {
    const [t0, v0] = points[i - 1];
    const [t1, v1] = points[i];
    if (v1 <= 0) return v0 <= 0 ? t0 : t0 + ((t1 - t0) * v0) / (v0 - v1);
  }
  return null;
}

/** A window's outlook, and where it goes when there is a forecast to draw. */
function forecast(live: Win | undefined, measuredAt: number | null, now: number, weekly: WeeklyPlan | null): {outlook: Outlook; projection?: Projection; zero?: number | null} {
  if (live && live.remaining <= 0) return {outlook: {key: 'usedUp', tone: 'v-crit'}};
  if (!live?.resetAt || !live.minutes || live.resetAt <= now || measuredAt === null || live.resetAt <= measuredAt) return {outlook: {key: 'none', tone: ''}};
  // An idle rolling window starts with its first use; one used and not `started` yet has only just started.
  if (!started(live, measuredAt) && live.used === 0) return {outlook: {key: 'idle', tone: ''}};
  if (measuredAt - (live.resetAt - live.minutes * 60_000) < forecastFrom(live.minutes)) return {outlook: {key: 'needData', tone: ''}};

  const projected = projection(live, measuredAt, weekly);
  const {pace, deadline, planned} = projected;
  const zero = zeroOf(projected.points);
  // The moment is absolute: a measurement some time ago foresees it as well until then.
  if (zero !== null && zero <= now) return {outlook: {key: 'pastZero', at: zero, tone: ''}};
  const atDeadline = valueAt(projected.points, deadline);
  const shown = {projection: projected, zero};
  if (Math.abs(atDeadline) < ON_PACE) return {outlook: {key: planned ? 'onPacePlan' : 'onPaceReset', tone: '', pace}, ...shown};
  if (atDeadline <= -ON_PACE && zero !== null) {
    const inMs = zero - now;
    return {outlook: {key: 'runsOut', at: zero, inMs, tone: inMs < (deadline - now) / 2 ? 'v-crit' : 'v-warn', pace}, ...shown};
  }
  return {outlook: planned ? {key: 'leftPlan', left: atDeadline, tone: 'muted', pace} : {key: 'leftReset', left: atDeadline, tone: '', pace}, ...shown};
}

/**
 * Where the window's own pace leads, whatever period is on screen. Weekly windows with a
 * plan are judged against the end of the plan (everything should be spent by then);
 * other windows, and a week past the end of its plan, against their reset. Counted from
 * the moment the window was measured (`measuredAt`), so numbers gone stale foresee the
 * same moment; `now` only says whether it has come.
 */
export const outlook = (live: Win | undefined, measuredAt: number | null, now: number, weekly: WeeklyPlan | null): Outlook => forecast(live, measuredAt, now, weekly).outlook;

/**
 * The forecast as a line over [from, to]: from the window's last value at the moment it
 * was measured, at its pace, to zero or to the reset, whichever comes first; cut at the
 * edges. `at` is where it runs out when the table says it does, wherever the line is cut.
 * Null for a window without a forecast.
 */
export function forecastLine(live: Win | undefined, measuredAt: number | null, now: number, weekly: WeeklyPlan | null, from: number, to: number): {points: [number, number][]; at: number | null} | null {
  const {outlook: ahead, projection: projected, zero} = forecast(live, measuredAt, now, weekly);
  if (!projected) return null;
  const end = zero ?? live!.resetAt!;
  const whole = projected.points.filter(([t]) => t < end).concat([[end, Math.max(0, valueAt(projected.points, end))]]);
  return {points: clip(whole, from, to), at: ahead.key === 'runsOut' ? ahead.at : null};
}

/** A line of [time, value] cut to [from, to], with its ends where it crosses them. */
export function clip(points: [number, number][], from: number, to: number): [number, number][] {
  if (!points.length || points[0][0] > to || points.at(-1)![0] < from) return [];
  const [begin, end] = [Math.max(from, points[0][0]), Math.min(to, points.at(-1)![0])];
  const edge = (t: number): [number, number] => [t, valueAt(points, t)];
  return [edge(begin), ...points.filter(([t]) => t > begin && t < end), edge(end)];
}

/** What a line spent over the period: points, nothing while measured (`unused`), or unknown. */
export type Spent = {key: 'points'; value: number} | {key: 'unused'} | {key: 'unknown'};

export const spentOf = (line: Pick<Line, 'consumed' | 'coveredMs'>): Spent =>
  line.consumed > 0 ? {key: 'points', value: line.consumed} : line.coveredMs ? {key: 'unused'} : {key: 'unknown'};

/**
 * The plan's column: what it expects to be left now, and how far the window is from
 * it (positive: behind the plan, a reserve), marked when it is `notable`. A limit used up
 * is past any plan.
 */
export type PlanCell = {remaining: number; delta: number; notable: boolean};

export function planCell(live: Win | undefined, measuredAt: number | null, now: number, weekly: WeeklyPlan | null): PlanCell | null {
  const plan = live ? planAt(live, measuredAt, now, weekly) : null;
  if (!plan || !live) return null;
  const delta = live.remaining > 0 ? live.remaining - plan.remaining : 0;
  return {remaining: plan.remaining, delta, notable: Math.abs(delta) >= PLAN_TOLERANCE};
}

/** A line of the table over a period up to now: what the period spent, the plan, and where the window's pace leads. */
export type ForecastRow = {spent: Spent; plan: PlanCell | null; outlook: Outlook};

export const forecastRow = (line: Pick<Line, 'consumed' | 'coveredMs'>, live: Win | undefined, measuredAt: number | null, now: number, weekly: WeeklyPlan | null): ForecastRow => ({
  spent: spentOf(line),
  plan: planCell(live, measuredAt, now, weekly),
  outlook: outlook(live, measuredAt, now, weekly),
});
