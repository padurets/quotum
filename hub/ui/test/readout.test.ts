import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gapText, gapTone, readout, type ForecastLine, type PlanLine} from '../lib/readout';
import type {Line} from '../lib/lines';

const minute = 60_000;
const cellMs = 5 * minute;
const now = 1_800_000_000_000;
const cell = now - 60 * minute;

const line = (key: string, points: [number, number, number][]) => ({key, points, staleAfterMs: 10 * minute}) as Line;
const plan = (lines: string[], value: number): PlanLine => ({key: lines[0], lines, color: '', runs: [[[now - 120 * minute, value], [now, value]]]});

test('a row for every line, in the legend’s order, empty where a line has nothing in the cell', () => {
  const lines = [line('b', [[cell, 80, 0]]), line('a', [[cell - 60 * minute, 20, 0]]), line('c', [[cell, 10.4, 0]])];
  const {rows, planned} = readout(lines, [], cell, cellMs, now, now);
  assert.deepEqual(
    rows.map(row => [row.line.key, row.left, row.plan, row.gap]),
    [
      ['b', 80, null, null],
      ['a', null, null, null],
      ['c', 10, null, null],
    ],
  );
  assert.equal(planned, false, 'no plan columns without a plan on the chart');
});

test('the plan is read beside the lines it plans, and the gap is of the numbers shown', () => {
  const lines = [line('weekly', [[cell, 42.4, 0]]), line('fable', [[cell, 49.6, 0]]), line('other', [[cell, 30, 0]])];
  const {rows, planned} = readout(lines, [plan(['weekly', 'fable'], 50.4)], cell, cellMs, now, now);
  assert.equal(planned, true);
  assert.deepEqual(
    rows.map(row => [row.left, row.plan, row.gap]),
    [
      [42, 50, -8],
      [50, 50, 0],
      [30, null, null],
    ],
  );
  assert.ok(!Object.is(rows[1].gap, -0), 'never a negative zero');
  const nothing = readout([line('empty', [[cell, -0.3, 0]])], [plan(['empty'], 0)], cell, cellMs, now, now).rows[0];
  assert.ok(!Object.is(nothing.gap, -0), 'not even from a value that rounds to −0');
  assert.equal(rows[0].value, 42.4, 'the point is drawn where the value is');
});

test('plan columns only where the chart draws a plan in the period', () => {
  const lines = [line('weekly', [[cell, 42, 0]])];
  assert.equal(readout(lines, [{...plan(['weekly'], 50), runs: []}], cell, cellMs, now, now).planned, false, 'a range older than the week');
  const later = readout(lines, [{...plan(['weekly'], 50), runs: [[[now - 10 * minute, 60], [now, 60]]]}], cell, cellMs, now, now);
  assert.deepEqual([later.planned, later.rows[0].plan, later.rows[0].gap], [true, null, null], 'a plan elsewhere in the period: the cell is empty');
});

test('a gap reads with its sign, and one ahead of the plan by 3 or more is marked as the table marks it', () => {
  assert.deepEqual([7, -8, 0].map(gapText), ['+7', '−8', '0']);
  assert.deepEqual([-3, -2, 5].map(gapTone), ['v-warn', '', '']);
});

test('ahead of now a line reads where its pace leads, beside its plan, until it runs out', () => {
  const lines = [line('weekly', [[now - 5 * minute, 40, 0]]), line('other', [[now - 5 * minute, 70, 0]])];
  const forecast: ForecastLine = {key: 'weekly', name: 'Weekly', color: '', dash: '', points: [[now, 40], [now + 40 * minute, 0]], at: now + 40 * minute};
  const ahead = now + 10 * minute;
  const {rows, columns} = readout(lines, [plan(['weekly'], 50)].map(p => ({...p, runs: [[[now - 60 * minute, 50], [now + 60 * minute, 50]]]})), ahead, cellMs, now, now + 60 * minute, [forecast]);
  assert.deepEqual(columns, {left: false, plan: true, gap: false, forecast: true});
  // Read at the cell's middle, 12.5 minutes on: 40 less a quarter of it and a bit.
  assert.deepEqual(rows.map(row => [row.left, row.plan, row.gap, row.forecast]), [
    [null, 50, null, 28],
    [null, null, null, null],
  ]);
  assert.equal(readout(lines, [], now + 45 * minute, cellMs, now, now + 60 * minute, [forecast]).rows[0].forecast, null, 'past where it runs out');
  assert.equal(readout(lines, [], now - 2 * minute, cellMs, now, now + 60 * minute, [forecast]).rows[0].forecast, null, 'not in the cell holding now');
});

test('columns stay put up to now, and ahead of it are the values the cell reads', () => {
  const lines = [line('weekly', [[now - 5 * minute, 40, 0]])];
  const forecast: ForecastLine = {key: 'weekly', name: 'Weekly', color: '', dash: '', points: [[now, 40], [now + 40 * minute, 0]], at: now + 40 * minute};
  const planned = [{...plan(['weekly'], 50), runs: [[[now - 60 * minute, 50], [now + 20 * minute, 50]]] as PlanLine['runs']}];
  const at = (cell: number, plans: PlanLine[], forecasts: ForecastLine[]) => readout(lines, plans, cell, cellMs, now, now + 60 * minute, forecasts).columns;
  assert.deepEqual(at(cell, planned, [forecast]), {left: true, plan: true, gap: true, forecast: false}, 'before now');
  assert.deepEqual(at(cell, [], [forecast]), {left: true, plan: false, gap: false, forecast: false}, 'before now, no plan drawn');
  assert.deepEqual(at(now + 30 * minute, planned, [forecast]), {left: false, plan: false, gap: false, forecast: true}, 'past the plan’s end');
  assert.deepEqual(at(now + 45 * minute, planned, [forecast]), {left: false, plan: false, gap: false, forecast: false}, 'past the plan and where it runs out');
  assert.deepEqual(at(now + 10 * minute, [], []), {left: false, plan: false, gap: false, forecast: false}, 'nothing drawn ahead');
});
