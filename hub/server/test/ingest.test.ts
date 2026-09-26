import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Ingest, IngestError, type Credential} from '../ingest.js';
import {Invalid, parseBatch, parseSessions} from '../domain/ingest.js';
import {edge, onGrid, series, type Sample} from '../domain/quota.js';
import {newSecret} from '../domain/auth.js';

const start = Date.parse('2026-09-22T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

const snapshot = (at: number, used: number, change: Record<string, unknown> = {}) => ({
  provider: 'codex',
  account: 'a1b2c3d4e5f6a1b2c3d4e5f6',
  plan: 'pro',
  observedAt: iso(at),
  via: 'codex/app-server',
  client: '0.154.0',
  staleAfterMs: 204_000,
  windows: [{id: 'weekly', kind: 'weekly', minutes: 10080, usedPercent: used, resetsAt: iso(start + 5 * 86_400_000)}],
  ...change,
});

const agy = (at: number, used: number, accountName?: string) =>
  snapshot(at, used, {
    provider: 'antigravity',
    account: undefined,
    accountName,
    plan: undefined,
    via: 'agy/usage',
    windows: [{id: 'gemini:weekly', kind: 'weekly', minutes: 10080, label: 'Gemini', usedPercent: used, resetsAt: null}],
  });

const batch = (snapshots: unknown[], failures: unknown[] = [], machine = 'machine-one-0123456789') => ({
  version: 1,
  agent: 'quotum/0.1.0',
  machine: {id: machine, name: `host-${machine.slice(8, 11)}`, os: 'linux', arch: 'x86_64'},
  // Agents send right after measuring: the clock at sending is the last measurement's.
  sentAt: iso(Math.max(start, ...[...snapshots, ...failures].map((item: any) => Date.parse(item.observedAt)))),
  snapshots,
  failures,
});

/** A hub with Alice, her personal board and a machine token of hers. */
function setup() {
  const store = new Store(path.join(mkdtempSync(path.join(tmpdir(), 'quotum-ingest-')), 'db.sqlite'), start);
  const directory = new Directory(store.db);
  const ingest = new Ingest(store, directory, new Duty(), new Cadence());
  const alice = directory.createUser('alice@example.com', 'Alice', 'x', start);
  const board = directory.boards(alice.id)[0].id;
  const secret = newSecret('qt_m');
  const tokenRow = directory.createToken(secret, '…', alice.id, 'images', start);
  const token = ingest.authenticate(`Bearer ${secret}`) as Credential;
  return {store, directory, ingest, alice, board, secret, tokenRow, token};
}

/** The state of the only source of a provider on a board. */
const only = (store: Store, board: string, provider: string) => {
  const states = store.states(board).filter(s => s.provider === provider);
  assert.equal(states.length, 1);
  return states[0];
};

test('machine and device tokens are told apart; anything else is refused', () => {
  const {ingest, secret} = setup();
  assert.equal((ingest.authenticate(`Bearer ${secret}`) as Credential).kind, 'token');
  assert.equal((ingest.authenticate(`bearer ${secret}`) as Credential).kind, 'token', 'the scheme is case-insensitive');
  assert.equal(ingest.authenticate(`Bearer ${secret}x`), null);
  assert.equal(ingest.authenticate(`Bearer ${newSecret('qt_d')}`), null);
  assert.equal(ingest.authenticate('Bearer test-token-0123456789abcdef'), null);
  assert.equal(ingest.authenticate(secret), null);
  assert.equal(ingest.authenticate(undefined), null);
});

test('a malformed batch is refused whole', () => {
  assert.throws(() => parseBatch({...batch([snapshot(start, 5)]), version: 2}), /invalid: version/);
  assert.throws(() => parseBatch(batch([snapshot(start, 5, {account: 'dev@example.com'})])), /account/, 'accounts are pseudonyms');
  assert.throws(() => parseBatch(batch([snapshot(start, 120)])), /usedPercent/);
  assert.throws(() => parseBatch(batch([snapshot(start, 5, {provider: 'cursor'})])), /provider/);
  assert.throws(() => parseBatch(batch([snapshot(start, 5, {staleAfterMs: 0})])), /staleAfterMs/);
  assert.throws(() => parseBatch(batch([snapshot(start, 5, {resets: {available: -1}})])), /resets/);
  assert.throws(() => parseBatch(batch([snapshot(start, 5, {resets: {available: 1, expiring: [{count: 2}]}})])), /resets expiring/, 'more by expiry than there are');
  assert.throws(() => parseBatch(batch([snapshot(start, 5, {resets: {available: 2, expiring: [{count: 0}]}})])), /resets expiring/);
  assert.throws(() => parseBatch(batch([snapshot(start, 5, {resets: {available: 2, expiring: [{count: 1, expiresAt: 'soon'}]}})])), /resets expiring expiresAt/);
  assert.throws(() => parseBatch(batch([snapshot(start, 5, {resets: {available: 2, expiring: [{count: 1.5}]}})])), /resets expiring/, 'a count is whole');
  // Soonest first, one group per time, the one without a time last.
  const day = (n: number) => iso(start + n * 86_400_000);
  const resets = (expiring: unknown) => parseBatch(batch([snapshot(start, 5, {resets: {available: 1000, expiring}})])).snapshots[0].resets;
  assert.throws(() => resets([{count: 1, expiresAt: day(2)}, {count: 1, expiresAt: day(1)}]), /resets expiring/, 'out of order');
  assert.throws(() => resets([{count: 1, expiresAt: day(1)}, {count: 1, expiresAt: day(1)}]), /resets expiring/, 'one time twice');
  assert.throws(() => resets([{count: 1}, {count: 1, expiresAt: day(1)}]), /resets expiring/, 'no time before a time');
  assert.throws(() => resets([{count: 1}, {count: 1, expiresAt: null}]), /resets expiring/, 'no time twice');
  const groups = (n: number) => Array.from({length: n}, (_, i) => ({count: 1, expiresAt: day(i + 1)}));
  assert.equal(resets(groups(50))?.expiring.length, 50, 'fifty groups, as many as an agent sends');
  assert.throws(() => resets(groups(51)), /resets expiring/);
  assert.deepEqual(resets(null), {available: 1000, expiring: []}, 'an optional list may be null');
  // Text is 1 to 120 characters, however many UTF-16 units they take.
  assert.equal(parseBatch(batch([snapshot(start, 5, {accountName: '🚀'.repeat(120)})])).snapshots[0].accountName, '🚀'.repeat(120));
  assert.throws(() => parseBatch(batch([snapshot(start, 5, {accountName: '🚀'.repeat(121)})])), /accountName/);
  const parsed = parseBatch(batch([snapshot(start, 5)]));
  assert.equal(parsed.snapshots[0].windows[0].resetsAt, start + 5 * 86_400_000);
});

test('a window keeps its kind and the scope label the agent gave, nothing else', () => {
  const parsed = parseBatch(batch([snapshot(start, 5, {windows: [{id: 'weekly:fable', kind: 'weekly', minutes: null, label: 'Fable', usedPercent: 1, resetsAt: null}]})]));
  const [w] = parsed.snapshots[0].windows;
  assert.deepEqual([w.kind, w.label, w.minutes], ['weekly', 'Fable', null]);
});

test('every account of a provider is a source of its own, with a stable id', () => {
  const {store, ingest, board, token} = setup();
  const result = ingest.accept(token, batch([snapshot(start, 5), snapshot(start, 7, {account: 'ffffeeeeddddccccbbbbaaaa'})]), start);
  assert.deepEqual([result.accepted, result.duplicates, result.failures], [2, 0, 0]);
  const states = store.states(board);
  assert.deepEqual(states.map(s => s.windows[0]?.used), [5, 7]);
  assert.ok(states.every(s => /^codex:[0-9a-f]{12}$/.test(s.id)));
  assert.equal(store.source('codex', 'a1b2c3d4e5f6a1b2c3d4e5f6', start), states[0].id);
});

test('free resets the client reports are kept with the source until it stops reporting them', () => {
  const {store, ingest, board, token} = setup();
  const expiresAt = start + 30 * 86_400_000;
  ingest.accept(token, batch([snapshot(start, 5, {resets: {available: 1}})]), start);
  assert.deepEqual(only(store, board, 'codex').resets, {available: 1, expiring: []}, 'a client that gives only how many');
  const later = expiresAt + 5 * 86_400_000;
  ingest.accept(
    token,
    batch([snapshot(start + 60_000, 5, {resets: {available: 4, expiring: [{count: 1, expiresAt: iso(expiresAt)}, {count: 2, expiresAt: iso(later)}, {count: 1, expiresAt: null}]}})]),
    start + 60_000,
  );
  assert.deepEqual(only(store, board, 'codex').resets, {available: 4, expiring: [{count: 1, expiresAt}, {count: 2, expiresAt: later}, {count: 1, expiresAt: null}]});
  ingest.accept(token, batch([snapshot(start + 120_000, 5)]), start + 120_000);
  assert.equal(only(store, board, 'codex').resets, null);
});

test('one account measured by several devices is one source', () => {
  const {store, ingest, board, token} = setup();
  ingest.accept(token, batch([snapshot(start, 5)], [], 'machine-one-0123456789'), start);
  ingest.accept(token, batch([snapshot(start + 120_000, 6)], [], 'machine-two-0123456789'), start + 120_000);
  const [series] = store.history(board, start - 1, 60_000).series;
  assert.deepEqual([store.states(board).length, series.samples, series.consumed], [1, 2, 1]);
});

test('a subscription the client does not name is its person\'s, not the machine\'s', () => {
  const {store, directory, ingest, board, token} = setup();
  ingest.accept(token, batch([agy(start, 10)], [], 'machine-one-0123456789'), start);
  ingest.accept(token, batch([agy(start + 60_000, 12)], [], 'machine-two-0123456789'), start + 60_000);
  ingest.accept(token, batch([agy(start + 60_000, 90, 'Work')], [], 'machine-one-0123456789'), start + 60_000);
  const used = store.states(board).map(s => s.windows[0].used).sort((a, b) => a - b);
  assert.deepEqual(used, [12, 90], "alice's two machines share one subscription; her named one is separate");
  // Bob's unnamed Antigravity is his own, even measured the same way.
  const bob = directory.createUser('bob@example.com', 'Bob', 'x', start);
  const secret = newSecret('qt_m');
  directory.createToken(secret, '…', bob.id, 'laptop', start);
  ingest.accept(ingest.authenticate(`Bearer ${secret}`) as Credential, batch([agy(start + 60_000, 50)], [], 'machine-bob-0123456789'), start + 60_000);
  assert.equal(store.states(board).length, 2);
  assert.deepEqual(store.states(directory.boards(bob.id)[0].id).map(s => s.windows[0].used), [50]);
});

test('an account measured by two people is one source on both of their boards', () => {
  const {store, directory, ingest, board, token} = setup();
  const bob = directory.createUser('bob@example.com', 'Bob', 'x', start);
  const secret = newSecret('qt_m');
  directory.createToken(secret, '…', bob.id, 'laptop', start);
  ingest.accept(token, batch([snapshot(start, 5)]), start);
  ingest.accept(ingest.authenticate(`Bearer ${secret}`) as Credential, batch([snapshot(start + 120_000, 6)], [], 'machine-bob-0123456789'), start + 120_000);
  const bobs = directory.boards(bob.id)[0].id;
  assert.deepEqual([store.states(board)[0].id, store.states(board)[0].windows[0].used], [store.states(bobs)[0].id, 6]);
});

test('a machine disconnected by hand stays out with its token; a new token takes it back; a revoked token is told so', () => {
  const {directory, ingest, alice, secret, tokenRow, token} = setup();
  const {device} = ingest.accept(token, batch([snapshot(start, 5)]), start);
  directory.revokeDevice(alice.id, device.id, start);
  assert.throws(() => ingest.accept(token, batch([snapshot(start + 60_000, 6)]), start + 60_000), (e: unknown) => e instanceof IngestError && e.code === 'device_revoked');
  // A leaked token is rotated: machines set up with the new one come back.
  const fresh = newSecret('qt_m');
  directory.createToken(fresh, '…', alice.id, 'images', start);
  const rotated = ingest.authenticate(`Bearer ${fresh}`) as Credential;
  assert.equal(ingest.accept(rotated, batch([snapshot(start + 120_000, 7)]), start + 120_000).device.id, device.id);
  directory.revokeToken(alice.id, tokenRow.id, start);
  assert.equal(ingest.authenticate(`Bearer ${secret}`), 'revoked', 'the agent hears it was disconnected and stops');
  directory.revokeToken(alice.id, directory.tokens(alice.id)[0].id, start);
  assert.deepEqual(directory.devices(alice.id), [], 'revoking a token disconnects the machines that joined with it');
});

test('a measurement from the future is refused, so it cannot hide the real ones after it', () => {
  const {ingest, token} = setup();
  const future = {...batch([snapshot(start + 365 * 86_400_000, 5)]), sentAt: iso(start)};
  assert.throws(() => ingest.accept(token, future, start), Invalid);
});

test('an agent whose clock is off has its times moved by the difference', () => {
  const {store, ingest, board, token} = setup();
  const ahead = 10 * 60_000;
  // The machine's clock is ten minutes fast: what it measured "at start + 10 min" happened at start.
  ingest.accept(token, {...batch([snapshot(start + ahead, 5)]), sentAt: iso(start + ahead)}, start);
  assert.equal(only(store, board, 'codex').successAt, start);
  const late = ingest.accept(token, {...batch([snapshot(start + 20_000, 6)]), sentAt: iso(start + 20_000)}, start + 30_000);
  assert.equal(late.accepted, 1, 'within the tolerance nothing is moved');
});

/** A report of running agents from the machine of `batch`, sent at `sentAt` by its clock. */
const running = (sessions: object[], sentAt = start) => ({
  version: 1,
  agent: 'quotum/0.4.0',
  machine: {id: 'machine-one-0123456789', name: 'host-one', os: 'linux', arch: 'x86_64'},
  sentAt: iso(sentAt),
  sessions: sessions.map(session => ({provider: 'codex', origin: 'terminal', startedAt: iso(start - 3_600_000), working: true, ...session})),
});

test('a session names its project and, where that differs, its folder; long names are cut, not refused', () => {
  const parsed = (session: object) => parseSessions(running([session])).sessions[0];
  assert.deepEqual([parsed({project: 'quotum', folder: 'hub'}).project, parsed({project: 'quotum', folder: 'hub'}).folder], ['quotum', 'hub']);
  assert.equal(parsed({project: 'quotum'}).folder, null, 'an older agent sends no folder');
  assert.deepEqual([parsed({folder: 'scratch'}).project, parsed({folder: 'scratch'}).folder], [null, 'scratch']);
  assert.equal(parsed({folder: '🚀'.repeat(130)}).folder, '🚀'.repeat(120), 'by characters');
  assert.throws(() => parsed({folder: ''}), (error: Invalid) => error.what === 'folder');
  assert.throws(() => parsed({folder: 7}), (error: Invalid) => error.what === 'folder');
});

test("a session is told by the start its agent sends, however far off and unsteady the agent's clock is", () => {
  const {store, ingest, token} = setup();
  ingest.accept(token, batch([snapshot(start, 10)]), start);
  const session = {account: 'a1b2c3d4e5f6a1b2c3d4e5f6', project: 'quotum'};
  // A minute behind, give or take the delay of each request.
  for (const [i, behind] of [61_000, 64_000, 58_000].entries()) {
    const now = start + i * 120_000;
    assert.equal(ingest.sessions(token, running([session], now - behind), now).accepted, 1);
  }
  ingest.sessions(token, running([], start + 300_000), start + 300_000);
  assert.equal((store.db.prepare('SELECT count(*) AS n FROM agent_sessions').get() as {n: number}).n, 1);
  assert.deepEqual(
    store.agentWork(0, Number.MAX_SAFE_INTEGER).map(s => [s.project, s.from - start, s.to - start]),
    [['quotum', 0, 300_000]],
  );
});

test('resent and older measurements are duplicates, not errors', () => {
  const {store, ingest, board, token} = setup();
  ingest.accept(token, batch([snapshot(start + 120_000, 6)]), start + 120_000);
  const again = ingest.accept(token, batch([snapshot(start, 5), snapshot(start + 120_000, 6)]), start + 130_000);
  assert.deepEqual([again.accepted, again.duplicates], [0, 2]);
  assert.equal(only(store, board, 'codex').error, null);
});

test('a device failure shows only once its source has gone quiet', () => {
  const {store, ingest, board, token} = setup();
  ingest.accept(token, batch([snapshot(start, 5)]), start);
  const failure = (at: number) => ({provider: 'codex', observedAt: iso(at), error: 'not_logged_in', detail: 'run codex login'});
  assert.equal(ingest.accept(token, batch([], [failure(start + 60_000)]), start + 60_000).failures, 0);
  assert.equal(ingest.accept(token, batch([], [failure(start + 600_000)]), start + 600_000).failures, 1);
  assert.equal(only(store, board, 'codex').error, 'not_logged_in');
  // A device that never delivered this provider keeps its failure to itself (shown on its row).
  assert.equal(ingest.accept(token, batch([], [failure(start + 600_000)], 'machine-two-0123456789'), start + 600_000).failures, 0);
});

test('an agent-declared staleness keeps sparse measurements continuous', () => {
  const sample = (at: number, used: number, staleAfterMs: number): Sample => ({
    sourceId: 'codex',
    provider: 'codex',
    id: 'weekly',
    kind: 'weekly',
    label: null,
    used,
    remaining: 100 - used,
    resetAt: start + 5 * 86_400_000,
    minutes: 10080,
    at,
    staleAfterMs,
  });
  // Eco mode: 15 minutes between measurements, announced by the agent.
  const eco = [sample(start, 10, 1_080_000), sample(start + 900_000, 12, 1_080_000)];
  assert.deepEqual(edge(eco[0], eco[1]), {valid: true, delta: 2, reason: 'continuous'});
  assert.equal(series(eco).consumed, 2);
  assert.deepEqual(onGrid(series(eco).points, 300_000).map(p => p.segment), [0, 0]);
  // Measured every two minutes: a quarter of an hour without a sample is a gap.
  const busy = [sample(start, 10, 204_000), sample(start + 900_000, 12, 204_000)];
  assert.equal(edge(busy[0], busy[1]).reason, 'gap');
  assert.deepEqual(onGrid(series(busy).points, 300_000).map(p => p.segment), [0, 1]);
});

test('stored agent samples carry their staleness into history', () => {
  const {store, ingest, board, token} = setup();
  ingest.accept(token, batch([snapshot(start, 10, {staleAfterMs: 1_080_000})]), start);
  ingest.accept(token, batch([snapshot(start + 900_000, 12, {staleAfterMs: 1_080_000})]), start + 900_000);
  const [history] = store.history(board, start - 1, 300_000).series;
  assert.equal(history.consumed, 2);
  assert.deepEqual(history.points.map(p => p[2]), [0, 0]);
});


test('an idle session may tell when it last worked, on the same corrected clock as its start', () => {
  const {store, ingest, token, alice, board} = setup();
  ingest.accept(token, batch([snapshot(start, 30)]), start);
  const source = only(store, board, 'codex').id;
  const session = {provider: 'codex', origin: 'terminal', startedAt: iso(start - 3_600_000), working: false};
  const report = (change: object = {}, sentAt = start) => ({...batch([]), sentAt: iso(sentAt), sessions: [{...session, ...change}]});
  const shown = (change: object = {}, sentAt = start) => {
    assert.equal(ingest.sessions(token, report(change, sentAt), start).accepted, 1);
    return ingest.live.of(source, [alice.id], start)[0];
  };
  assert.equal(shown().lastWorkedAt, null, 'an older agent');
  assert.equal(shown({lastWorkedAt: null}).lastWorkedAt, null);
  assert.equal(shown({lastWorkedAt: iso(start - 60_000)}).lastWorkedAt, start - 60_000);
  assert.equal(shown({lastWorkedAt: iso(start + 60_000)}).lastWorkedAt, start, 'never in the future');
  assert.equal(shown({lastWorkedAt: iso(start - 7_200_000)}).lastWorkedAt, start - 3_600_000, 'never before its start');
  for (const shift of [-3_600_000, 3_600_000]) {
    const found = shown({startedAt: iso(start - 3_600_000 + shift), lastWorkedAt: iso(start - 60_000 + shift)}, start + shift);
    assert.deepEqual([found.startedAt, found.lastWorkedAt], [start - 3_600_000, start - 60_000]);
  }
  for (const lastWorkedAt of ['never', 42, {}, false]) assert.throws(() => parseSessions(report({lastWorkedAt})), /lastWorkedAt/);
  store.close();
});
