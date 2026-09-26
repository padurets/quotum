import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {connect, createServer, type Server, type Socket} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildApp} from '../api.js';
import {localMode} from '../config.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Ingest} from '../ingest.js';
import {bootstrapLocal} from '../local.js';
import {Pairing} from '../pairing.js';
import {ResetFeed} from '../resets.js';
import {Directory} from '../store/directory.js';
import {Store} from '../store/store.js';
import {Setup} from '../setup.js';

const KEY = 'k'.repeat(43);
const TOKEN = 'qt_m_first-start-token-0123456789ab';
const iso = (ms: number) => new Date(ms).toISOString();

/** A database, and hubs over it: each `start` is a start of the desktop app's hub (or a server's). */
function database() {
  const store = new Store(path.join(mkdtempSync(path.join(tmpdir(), 'quotum-local-')), 'db.sqlite'));
  const directory = new Directory(store.db);
  const start = async ({local = true, key = KEY, token = TOKEN} = {}) => {
    if (local) bootstrapLocal(directory, token, Date.now(), 'ann');
    const app = await buildApp({
      store,
      directory,
      resets: new ResetFeed(undefined, () => {}),
      ingest: new Ingest(store, directory, new Duty(), new Cadence()),
      pairing: new Pairing(directory),
      setup: new Setup(!local && directory.userCount() === 0, 'BCDF-GHJK'),
      local: local ? {key} : null,
    });
    const call = async (method: 'GET' | 'POST' | 'DELETE', url: string, options: {body?: object; headers?: Record<string, string>} = {}) => {
      const response = await app.inject({method, url, payload: options.body, headers: options.headers});
      const json = String(response.headers['content-type'] ?? '').includes('json');
      return {status: response.statusCode, body: json ? JSON.parse(response.body) : response.body, headers: response.headers};
    };
    /** The window's cookie after entering with `key`, or null. */
    const enter = async (given = key) => {
      const response = await call('GET', `/local?key=${encodeURIComponent(given)}`);
      const cookie = response.headers['set-cookie'];
      return {response, cookie: typeof cookie === 'string' ? cookie : null};
    };
    return {app, call, enter};
  };
  return {store, directory, start};
}

const batch = (provider: string, extra: object = {}) => ({
  version: 1,
  agent: 'quotum/0.3.0',
  machine: {id: 'machine-of-the-app-0123', name: 'laptop', os: 'linux', arch: 'x86_64'},
  sentAt: iso(Date.now()),
  snapshots: [
    {
      provider,
      observedAt: iso(Date.now() - 1000),
      via: 'test',
      staleAfterMs: 120_000,
      windows: [{id: 'weekly', kind: 'weekly', minutes: 10080, usedPercent: 20, resetsAt: iso(Date.now() + 86_400_000)}],
      ...extra,
    },
  ],
  failures: [],
});

/** Routes the local mode leaves out, and those it keeps; `b`, `u`, `d`… stand for ids. */
const LEFT_OUT: [string, string][] = [
  ['POST', '/api/auth/signup'],
  ['POST', '/api/auth/login'],
  ['POST', '/api/auth/logout'],
  ['POST', '/api/account'],
  ['POST', '/api/boards'],
  ['GET', '/api/boards/b/members'],
  ['DELETE', '/api/boards/b/members/u'],
  ['POST', '/api/boards/b/leave'],
  ['POST', '/api/boards/b/invites'],
  ['DELETE', '/api/boards/b/invites'],
  ['GET', '/api/invites/i'],
  ['POST', '/api/invites/i/accept'],
  ['POST', '/api/boards/b'],
  ['DELETE', '/api/boards/b'],
  ['GET', '/api/boards/b/shares'],
  ['POST', '/api/boards/b/shares'],
  ['DELETE', '/api/boards/b/shares/s'],
  ['DELETE', '/api/devices/d'],
  ['GET', '/api/tokens'],
  ['POST', '/api/tokens'],
  ['DELETE', '/api/tokens/t'],
  ['GET', '/api/device'],
  ['POST', '/api/device/approve'],
  ['POST', '/v1/device/code'],
  ['POST', '/v1/device/token'],
];
const KEPT: [string, string][] = [
  ['GET', '/health'],
  ['GET', '/api/resets'],
  ['GET', '/api/overview'],
  ['GET', '/api/history'],
  ['GET', '/api/session'],
  ['POST', '/api/boards/b/view'],
  ['GET', '/api/devices'],
  ['POST', '/api/devices/d'],
  ['GET', '/api/projects'],
  ['POST', '/api/projects'],
  ['POST', '/api/projects/restore'],
  ['POST', '/v1/checkin'],
  ['POST', '/v1/ingest'],
  ['POST', '/v1/sessions'],
];
/** A route that is not there answers the hub's own `not_found`; one that is answers otherwise, even with 404. */
const missing = (answer: {status: number; body: any}) => answer.status === 404 && answer.body?.error === 'not_found';

test('the local mode leaves out accounts, sharing and connecting; a server keeps them all', async () => {
  const local = await database().start();
  for (const [method, url] of LEFT_OUT) assert.ok(missing(await local.call(method as any, url)), `${method} ${url} is left out`);
  for (const [method, url] of KEPT) assert.ok(!missing(await local.call(method as any, url)), `${method} ${url} is kept`);
  const server = await database().start({local: false});
  for (const [method, url] of [...LEFT_OUT, ...KEPT]) assert.ok(!missing(await server.call(method as any, url)), `${method} ${url} on a server`);
});

test('without the window’s session nothing of the board can be read, and the hub answers its own host and pages only', async () => {
  const {call} = await database().start();
  const open = new Set(['/api/session', '/api/resets']);
  for (const [method, url] of KEPT.filter(([, url]) => url.startsWith('/api/') && !open.has(url))) {
    assert.equal((await call(method as any, url)).status, 401, `${method} ${url}`);
  }
  const session = (await call('GET', '/api/session')).body;
  assert.deepEqual([session.user, session.local, session.signup], [null, true, {first: false, open: false}]);
  for (const url of ['/v1/checkin', '/v1/ingest', '/v1/sessions']) {
    assert.equal((await call('POST', url, {body: {}})).status, 401, `${url} without a token`);
    const foreign = {authorization: 'Bearer qt_m_someone-elses-token-0123456789'};
    assert.equal((await call('POST', url, {body: {}, headers: foreign})).status, 401, `${url} with another token`);
  }
  assert.equal((await call('GET', '/api/session', {headers: {host: 'evil.example'}})).status, 403);
  const fromAnotherPage = {origin: 'http://evil.example', cookie: 'quotum_session=x'};
  assert.equal((await call('POST', '/api/boards/b/view', {body: {}, headers: fromAnotherPage})).status, 403);
});

test('the window enters with the key of this start, for as long as it is open', async () => {
  const {call, enter} = await database().start();
  for (const wrong of ['wrong', '']) {
    const {response, cookie} = await enter(wrong);
    assert.deepEqual([response.status, response.headers.location, cookie], [303, '/', null], `key "${wrong}"`);
  }
  const bare = await call('GET', '/local');
  assert.deepEqual([bare.status, bare.headers.location, bare.headers['set-cookie']], [303, '/', undefined]);

  const {response, cookie} = await enter();
  assert.deepEqual([response.status, response.headers.location], [303, '/']);
  assert.match(cookie!, /^quotum_session=qt_s_[^;]+; Path=\/; HttpOnly; SameSite=Lax$/, 'no Max-Age: gone with the window');
  const headers = {cookie: cookie!.split(';')[0]};
  const session = (await call('GET', '/api/session', {headers})).body;
  assert.equal(session.user.name, 'ann');
  assert.deepEqual(session.boards.map((b: any) => [b.personal, b.role]), [[true, 'owner']]);
  assert.equal((await call('GET', '/api/overview', {headers})).status, 200);

  const server = await database().start({local: false});
  assert.equal((await server.call('GET', `/local?key=${KEY}`)).headers['set-cookie'], undefined, 'no way in on a server');
});

test('every start has one person, the app’s token with a new secret, and no session of an earlier start', async () => {
  const db = database();
  const first = await db.start();
  const auth = (token: string) => ({authorization: `Bearer ${token}`});
  assert.equal((await first.call('POST', '/v1/ingest', {body: batch('antigravity'), headers: auth(TOKEN)})).status, 200);
  const {cookie} = await first.enter();
  const overview = (await first.call('GET', '/api/overview', {headers: {cookie: cookie!.split(';')[0]}})).body;
  const [source] = overview.sources;
  const person = db.directory.soleUser()!;
  const [token] = db.directory.tokens(person.id);
  const [device] = db.directory.devices(person.id);

  const next = 'qt_m_second-start-token-0123456789a';
  const again = await db.start({token: next, key: 'n'.repeat(43)});
  assert.equal(db.directory.userCount(), 1);
  assert.equal(db.directory.soleUser()!.id, person.id, 'the same person');
  assert.deepEqual(db.directory.tokens(person.id).map(t => [t.id, t.name]), [[token.id, 'Quotum app']], 'the same token, with a new secret');
  assert.equal((await again.call('GET', '/api/session', {headers: {cookie: cookie!.split(';')[0]}})).body.user, null, 'the earlier window’s session ended');
  assert.equal((await again.call('POST', '/v1/ingest', {body: batch('antigravity'), headers: auth(TOKEN)})).status, 401, 'the old secret');
  assert.equal((await again.call('POST', '/v1/ingest', {body: batch('antigravity'), headers: auth(next)})).status, 200);
  assert.deepEqual(
    db.directory.devices(person.id).map(d => [d.id, d.tokenId]),
    [[device.id, token.id]],
    'the machine is the same device, connected',
  );
  const {cookie: now} = await again.enter('n'.repeat(43));
  const sources = (await again.call('GET', '/api/overview', {headers: {cookie: now!.split(';')[0]}})).body.sources;
  assert.deepEqual(sources.map((s: any) => s.id), [source.id], 'an Antigravity subscription keeps its key');

  db.directory.createUser('bob@example.com', 'Bob', '!', Date.now());
  assert.throws(() => bootstrapLocal(db.directory, next, Date.now()), /one person/);
});

test('the local mode refuses to start where the board would reach beyond this machine, and never echoes a secret', () => {
  const env = {QUOTUM_LOCAL_KEY: KEY, QUOTUM_LOCAL_TOKEN: TOKEN};
  assert.deepEqual(localMode(env), {key: KEY, token: TOKEN});
  assert.equal(localMode({}), null);
  const refused: [Record<string, string>, RegExp][] = [
    [{QUOTUM_ALLOWED_HOSTS: 'localhost,*'}, /QUOTUM_ALLOWED_HOSTS/],
    [{QUOTUM_BIND: '0.0.0.0'}, /QUOTUM_BIND/],
    [{QUOTUM_PUBLIC_URL: 'https://quotum.example.com'}, /QUOTUM_PUBLIC_URL/],
    [{QUOTUM_TRUST_PROXY: 'true'}, /QUOTUM_TRUST_PROXY/],
    [{QUOTUM_LOCAL_KEY: ''}, /QUOTUM_LOCAL_KEY/],
    [{QUOTUM_LOCAL_KEY: 'short-secret-key'}, /QUOTUM_LOCAL_KEY/],
    [{QUOTUM_LOCAL_TOKEN: ''}, /QUOTUM_LOCAL_TOKEN/],
    [{QUOTUM_LOCAL_TOKEN: 'qt_d_a-device-token-0123456789'}, /QUOTUM_LOCAL_TOKEN/],
  ];
  for (const [change, error] of refused) {
    const given = {...env, ...change};
    assert.throws(
      () => localMode(given),
      (e: Error) => error.test(e.message) && !e.message.includes('short-secret-key') && !e.message.includes('qt_d_a-device') && !e.message.includes(KEY),
      JSON.stringify(change),
    );
  }
});

// ---------- the hub as the app runs it: a child process with its stdin held open ----------

const here = path.dirname(fileURLToPath(import.meta.url));
const hubDir = path.resolve(here, '../..');

type Running = {child: ChildProcess; lines: string[]; port: number; exited: Promise<number | null>};

/** The local hub with exactly the environment given here, nothing of this process's. */
async function startHub(port = 0): Promise<Running> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: tmpdir(),
    QUOTUM_LOCAL_KEY: KEY,
    QUOTUM_LOCAL_TOKEN: TOKEN,
    QUOTUM_RESETS: 'off',
    QUOTUM_PORT: String(port),
    QUOTUM_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'quotum-local-hub-')),
  };
  if (process.platform === 'win32') Object.assign(env, {SystemRoot: process.env.SystemRoot ?? '', TEMP: tmpdir()});
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {cwd: hubDir, env, stdio: ['pipe', 'pipe', 'inherit']});
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
  const lines: string[] = [];
  let buffered = '';
  const started = new Promise<number>((resolve, reject) => {
    child.stdout!.on('data', chunk => {
      buffered += chunk;
      const parts = buffered.split('\n');
      buffered = parts.pop()!;
      for (const line of parts) {
        lines.push(line);
        const event = JSON.parse(line.startsWith('{') ? line : 'null');
        if (event?.event === 'start') resolve(event.port);
        if (event?.event === 'error') resolve(-1);
      }
    });
    void exited.then(() => reject(new Error(`the hub exited: ${lines.join(' | ')}`)));
  });
  return {child, lines, port: await started, exited};
}

/** Resolves with the exit code, or rejects if it takes longer than `ms`. */
const within = (exited: Promise<number | null>, ms: number) =>
  Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still running after ${ms} ms`)), ms).unref())]);

/** A request whose body never arrives: it keeps a connection of the hub busy. */
function hangingRequest(port: number): Promise<Socket> {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write('POST /v1/ingest HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{');
      setTimeout(() => resolve(socket), 200);
    });
    socket.on('error', () => {});
  });
}

const stopEvent = (lines: string[]) => lines.map(line => (line.startsWith('{') ? JSON.parse(line) : null)).find(event => event?.event === 'stop');

test('the local hub says where it listens and stops when its stdin closes', async t => {
  const hub = await startHub();
  t.after(() => hub.child.kill('SIGKILL'));
  assert.deepEqual(JSON.parse(hub.lines.find(line => line.includes('"start"'))!), {event: 'start', users: 1, port: hub.port, local: true});
  hub.child.stdin!.end();
  assert.equal(await within(hub.exited, 3000), 0);
  assert.deepEqual(stopEvent(hub.lines), {event: 'stop', reason: 'stdin'});
});

test('a request that hangs does not keep a stopped local hub alive', async t => {
  const hub = await startHub();
  t.after(() => hub.child.kill('SIGKILL'));
  const socket = await hangingRequest(hub.port);
  t.after(() => socket.destroy());
  hub.child.stdin!.end();
  assert.equal(await within(hub.exited, 3000), 0);
});

test('a signal stops the local hub the same way, a hanging request or not', {skip: process.platform === 'win32' && 'Windows has no signals to send'}, async t => {
  const hub = await startHub();
  t.after(() => hub.child.kill('SIGKILL'));
  const socket = await hangingRequest(hub.port);
  t.after(() => socket.destroy());
  hub.child.kill('SIGTERM');
  assert.equal(await within(hub.exited, 3000), 0);
  assert.deepEqual(stopEvent(hub.lines), {event: 'stop', reason: 'signal'});
});

test('a local hub on a taken port says so and exits', async t => {
  const taken: Server = createServer();
  await new Promise<void>(resolve => taken.listen(0, '127.0.0.1', resolve));
  t.after(() => taken.close());
  const port = (taken.address() as {port: number}).port;
  const hub = await startHub(port);
  t.after(() => hub.child.kill('SIGKILL'));
  assert.equal(await within(hub.exited, 5000), 1);
  assert.ok(hub.lines.includes('{"event":"error","code":"port_in_use"}'), hub.lines.join(' | '));
});
