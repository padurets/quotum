import {test} from 'node:test';
import assert from 'node:assert/strict';
import {agentRows, DRAWN, drawn, folderOf} from '../lib/agents';
import {chartEvents, chartResets, type Line} from '../lib/lines';
import {planCell} from '../lib/forecast';
import {DEFAULT_PLAN, planNote} from '../lib/plan';
import {cadenceOf, dotOf, PULSE_FOR, resetLine} from '../lib/quota';
import {resetLabel, type ResetStatus} from '../lib/resets';
import type {LiveSession, SourceState, View, Win} from '../lib/types';
import {boardState, cardId, isWindowHidden} from '../lib/view';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.parse('2026-09-24T12:00:00Z');
const EMPTY: View = {order: [], sizes: {}, names: {}, hidden: [], shown: [], windows: [], plans: {}, unplanned: [], colors: {}, columns: {}, shownColumns: {}};

test('a reset announced or possible outranks one that happened, which outranks a change of limits', () => {
  const event = (at: number) => ({url: 'https://codex-resets.com/', text: '', at});
  const status = (change: Partial<ResetStatus>): ResetStatus => ({scheduled: null, watch: null, latest: null, policy: null, credit: {name: 'Codex Resets', url: ''}, ...change});
  const scheduled = {...event(now - HOUR), scheduledFor: now + DAY, kind: 'regular' as const};
  const watch = {...event(now - HOUR), expiresAt: now + DAY, chance: 40, window: ''};
  const latest = {...event(now - HOUR), scope: 'Max'};
  const policy = event(now - HOUR);
  assert.equal(resetLabel(status({scheduled, watch, latest, policy}), now)?.key, 'in');
  assert.equal(resetLabel(status({watch, latest, policy}), now)?.key, 'possible');
  assert.equal(resetLabel(status({latest, policy}), now)?.key, 'done');
  assert.equal(resetLabel(status({policy}), now)?.key, 'policy');
  assert.equal(resetLabel(status({latest: {...latest, at: now - DAY}, policy}), now)?.key, 'policy', 'a reset is news for a day');
  assert.equal(resetLabel(status({policy: event(now - 3 * DAY)}), now), null, 'a change of limits, for three');
  assert.equal(resetLabel(status({scheduled: {...scheduled, scheduledFor: now - 1}}), now)?.key, 'awaiting');
  assert.equal(resetLabel(status({scheduled: {...scheduled, scheduledFor: null}}), now)?.key, 'announced');
  assert.equal(resetLabel(status({scheduled: {...scheduled, kind: 'banked'}}), now)?.key, 'bankedIn');
  assert.deepEqual(resetLabel(status({latest: {...latest, scope: 'all'}}), now), {event: {...latest, scope: 'all'}, link: 'https://codex-resets.com/', key: 'done', tone: 'quiet', scope: ''});
});

test('a note under a limit takes a gap of ten points to the plan; behind it only for a week', () => {
  const week = (remaining: number, elapsed: number): Win => ({id: 'weekly', kind: 'weekly', label: null, used: 100 - remaining, remaining, resetAt: now - elapsed + 7 * DAY, minutes: 10080});
  // A day and a half into the week the default plan leaves 57.5%.
  assert.equal(planNote(week(67.5, 1.5 * DAY), now, now)?.key, 'behind');
  assert.equal(planNote(week(66.5, 1.5 * DAY), now, now), null);
  assert.equal(planNote(week(47.5, 1.5 * DAY), now, now)?.key, 'ahead');
  assert.equal(planNote(week(48.5, 1.5 * DAY), now, now), null);
  assert.equal(planNote(week(0, 1.5 * DAY), now, now), null, 'used up is past any plan');
  const hours: Win = {id: 'session', kind: 'session', label: null, used: 10, remaining: 90, resetAt: now + 2.5 * HOUR, minutes: 300};
  assert.equal(planNote(hours, now, now), null, 'five hours behind an even pace say nothing');
  assert.deepEqual(planNote({...hours, used: 70, remaining: 30}, now, now), {key: 'ahead', value: 20, weekly: false});
});

test('the plan column marks a gap of three points to the plan', () => {
  const live: Win = {id: 'weekly', kind: 'weekly', label: null, used: 50, remaining: 50, resetAt: now + 5 * DAY, minutes: 10080};
  // The plan's column marks a gap of three points; a day and a half into the week the plan leaves 57.5%.
  const week = (remaining: number): Win => ({...live, used: 100 - remaining, remaining, resetAt: now + 5.5 * DAY});
  assert.equal(planCell(week(60.5), now, now, DEFAULT_PLAN)?.notable, true);
  assert.equal(planCell(week(60.4), now, now, DEFAULT_PLAN)?.notable, false);
  assert.equal(planCell(week(54.5), now, now, DEFAULT_PLAN)?.notable, true);
  assert.deepEqual(planCell(week(0), now, now, DEFAULT_PLAN), {remaining: 57.5, delta: 0, notable: false}, 'used up is past any plan');
});

test('agents are drawn up to ten; the table leaves out hidden cards and says why it is empty', () => {
  const session = (): LiveSession => ({device: {id: 'd', name: 'laptop'}, origin: 'terminal', project: null, folder: null, startedAt: now, lastWorkedAt: null, working: true});
  assert.equal(drawn(Array.from({length: DRAWN}, session)), true);
  assert.equal(drawn(Array.from({length: DRAWN + 1}, session)), false);
  const source = (id: string, sessions: LiveSession[]) => ({id, sessions}) as unknown as SourceState;
  const hidden = {...EMPTY, hidden: [cardId('b')]};
  assert.equal(agentRows([source('a', []), source('b', [session()])], hidden).empty, 'noneShown');
  assert.equal(agentRows([source('a', []), source('b', [])], hidden).empty, 'none');
  assert.equal(agentRows([source('a', [session()]), source('b', [session()])], hidden).rows.length, 1);
});

test('an agent shows its folder under its project only where the folder tells it apart', () => {
  const session = (project: string | null, folder: string | null) => ({project, folder}) as LiveSession;
  assert.equal(folderOf(session('quotum', 'quotum.feat-18')), 'quotum.feat-18', 'a worktree');
  assert.equal(folderOf(session('quotum', null)), null, 'in the project itself');
  assert.equal(folderOf(session('core', 'core')), null, 'renamed to its folder');
  assert.equal(folderOf(session(null, 'scratch')), 'scratch', 'no project');
});

test('a board without subscriptions invites to connect one; with every widget hidden, offers them back', () => {
  assert.equal(boardState([], EMPTY), 'onboarding');
  assert.equal(boardState([{id: 'a'}], EMPTY), 'widgets');
  assert.equal(boardState([{id: 'a'}], {...EMPTY, hidden: [cardId('a'), 'history', 'forecast']}), 'allHidden');
  assert.equal(boardState([{id: 'a'}], {...EMPTY, hidden: [cardId('a'), 'history', 'forecast'], shown: ['agents']}), 'widgets');
  assert.equal(isWindowHidden({...EMPTY, windows: ['a/weekly']}, 'a', 'weekly'), true);
  assert.equal(resetLine({resetAt: null}, now).key, 'resetUnknown');
  const measured = (age: number, change: Partial<SourceState> = {}) => ({stale: false, error: null, successAt: now - age, ...change});
  assert.deepEqual(dotOf(measured(PULSE_FOR - 1), now), {warn: false, pulsing: true, fresh: 1});
  assert.deepEqual(dotOf(measured(PULSE_FOR), now), {warn: false, pulsing: false, fresh: 1});
  assert.deepEqual(dotOf(measured(0, {stale: true}), now), {warn: true}, 'numbers gone stale outweigh their age');
  assert.deepEqual(dotOf(measured(0, {error: 'signed_out'}), now), {warn: true});
  assert.equal(dotOf(measured(0, {error: 'waiting'}), now).warn, false, 'waiting for a first measurement is no trouble');
});

test('the dot tells when the next measurement comes and why, while the hub sets the pace and nothing is wrong', () => {
  const MIN = 60_000;
  const source = (next: number, change: Partial<SourceState> = {}) =>
    ({stale: false, error: null, successAt: now - MIN, cadence: {next, why: 'idle' as const}, ...change}) as Pick<SourceState, 'stale' | 'error' | 'successAt' | 'cadence'>;
  assert.deepEqual(cadenceOf(source(now + 3 * MIN), now), {when: 'nextIn', next: now + 3 * MIN, why: 'idle'});
  assert.equal(cadenceOf(source(now + 15_001), now)?.when, 'nextIn');
  assert.equal(cadenceOf(source(now + 15_000), now)?.when, 'nextSoon');
  assert.equal(cadenceOf(source(now - MIN), now)?.when, 'nextSoon', 'a time passed: any moment');
  assert.equal(cadenceOf(source(now, {cadence: null}), now), null, 'the hub does not set the pace');
  assert.equal(cadenceOf(source(now, {stale: true}), now), null);
  assert.equal(cadenceOf(source(now, {error: 'timeout'}), now), null);
  for (const why of ['low', 'inUse', 'changed', 'idle', 'reset'] as const) {
    assert.equal(cadenceOf(source(now + MIN, {cadence: {next: now + MIN, why}}), now)?.why, why);
  }
});

test('the chart marks what happened after it begins, on a line it draws', () => {
  const line = (sourceId: string, windowId: string, provider: string) => ({sourceId, windowId, provider}) as Line;
  const lines = [line('a', 'weekly', 'codex'), line('b', 'session', 'claude')];
  const from = now - DAY;
  const early = (sourceId: string, at: number, windows: string[]) => ({sourceId, at, kind: 'early_reset' as const, windows});
  assert.deepEqual(chartEvents([early('a', now - HOUR, ['weekly'])], lines, from).map(m => m.lines.length), [1]);
  assert.deepEqual(chartEvents([early('a', now - 2 * DAY, ['weekly'])], lines, from), [], 'before the chart begins');
  assert.deepEqual(chartEvents([early('a', now - HOUR, ['session'])], lines, from), [], 'a window the chart does not draw');
  assert.deepEqual(chartEvents([early('c', now - HOUR, ['weekly'])], lines, from), [], 'a source the chart does not draw');
  assert.equal(chartEvents([{sourceId: 'b', at: now - HOUR, kind: 'resets_granted', count: 2}], lines, from).length, 1, 'free resets, on any line of the source');
  const reset = (at: number) => ({url: '', text: '', at});
  const marked = (past: Parameters<typeof chartResets>[0], drawn = lines) => chartResets(past, drawn, from, now).map(m => m.provider);
  assert.deepEqual(marked({codex: [reset(now - HOUR)], claude: [reset(now - 2 * HOUR)]}), ['codex', 'claude']);
  assert.deepEqual(marked({codex: [reset(now - 2 * DAY), reset(now + HOUR)]}), [], 'before the chart begins, or after it was measured');
  assert.deepEqual(marked({claude: [reset(now - HOUR)]}, [lines[0]]), [], 'a provider the chart does not draw');
});
