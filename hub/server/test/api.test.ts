import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {buildApp} from '../api.js';
import {config} from '../config.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Ingest} from '../ingest.js';
import {Pairing} from '../pairing.js';
import {ResetFeed} from '../resets.js';
import {Directory} from '../store/directory.js';
import {Store} from '../store/store.js';
import {hashPassword, normalizeUserCode, verifyPassword} from '../domain/auth.js';
import {Setup} from '../setup.js';

const iso = (ms: number) => new Date(ms).toISOString();
const ORIGIN = 'http://localhost';
const SETUP = 'BCDF-GHJK';
const EMPTY = {order: [], sizes: {}, names: {}, hidden: [], shown: [], windows: [], plans: {}, unplanned: [], colors: {}, columns: {}, shownColumns: {}};

async function hub() {
  const store = new Store(path.join(mkdtempSync(path.join(tmpdir(), 'quotum-api-')), 'db.sqlite'));
  const directory = new Directory(store.db);
  const app = await buildApp({
    store,
    directory,
    resets: new ResetFeed(undefined, () => {}),
    ingest: new Ingest(store, directory, new Duty(), new Cadence()),
    pairing: new Pairing(directory),
    setup: new Setup(true, SETUP),
    local: null,
  });
  const cookies = new Map<string, string>();
  const call = async (method: 'GET' | 'POST' | 'DELETE', url: string, options: {as?: string; body?: object | string; headers?: Record<string, string>} = {}) => {
    const response = await app.inject({
      method,
      url,
      payload: options.body,
      headers: {
        ...(typeof options.body === 'string' ? {'content-type': 'application/json'} : {}),
        ...(options.as && cookies.get(options.as) ? {cookie: cookies.get(options.as)!} : {}),
        ...options.headers,
      },
    });
    const set = response.headers['set-cookie'];
    if (options.as && typeof set === 'string') cookies.set(options.as, set.split(';')[0]);
    const json = String(response.headers['content-type'] ?? '').includes('json');
    return {status: response.statusCode, body: json ? JSON.parse(response.body) : response.body, cookie: set};
  };
  /** Signs someone up and returns their personal board. */
  const person = async (as: string, invite?: string) => {
    const body = {email: `${as}@example.com`, name: as[0].toUpperCase() + as.slice(1), password: 'correct horse', invite, setupCode: SETUP};
    const signup = await call('POST', '/api/auth/signup', {as, body});
    assert.equal(signup.status, 200, JSON.stringify(signup.body));
    return signup.body.boards.find((b: any) => b.personal).id as string;
  };
  return {app, call, person, store};
}

const snapshot = (at: number) => ({
  provider: 'codex',
  account: 'a1b2c3d4e5f6a1b2c3d4e5f6',
  observedAt: iso(at),
  via: 'codex/app-server',
  staleAfterMs: 204_000,
  windows: [{id: 'weekly', kind: 'weekly', minutes: 10080, usedPercent: 8, resetsAt: iso(at + 86_400_000)}],
});
const machine = (id: string) => ({id, name: 'build-01', os: 'linux', arch: 'x86_64'});
const batch = (id: string, failures: object[] = []) => ({
  version: 1,
  agent: 'quotum/0.1.0',
  machine: machine(id),
  sentAt: iso(Date.now()),
  snapshots: [snapshot(Date.now() - 1000)],
  failures,
});

test('passwords are salted scrypt hashes; typed codes are forgiving', async () => {
  const stored = await hashPassword('correct horse');
  assert.match(stored, /^scrypt\$32768\$8\$1\$/);
  assert.notEqual(stored, await hashPassword('correct horse'));
  assert.equal(await verifyPassword('correct horse', stored), true);
  assert.equal(await verifyPassword('wrong horse', stored), false);
  assert.equal(normalizeUserCode('bcdf ghjk'), 'BCDF-GHJK');
  assert.equal(normalizeUserCode('BCDF-GHJ0'), null, 'zero is not in the alphabet');
});

test('the first person signs up freely and gets a personal board; later ones need an invite', async () => {
  const {call} = await hub();
  assert.deepEqual((await call('GET', '/api/session')).body.signup, {first: true, open: true});
  assert.equal((await call('GET', '/api/overview')).status, 401);

  const claim = {email: 'Alice@Example.com', name: 'Alice', password: 'correct horse'};
  assert.equal((await call('POST', '/api/auth/signup', {body: claim})).body.error, 'invalid_setup_code', 'a new hub needs the code from its log');
  assert.equal((await call('POST', '/api/auth/signup', {body: {...claim, setupCode: 'BCDF-GHJJ'}})).body.error, 'invalid_setup_code');
  const signup = await call('POST', '/api/auth/signup', {as: 'alice', body: {...claim, setupCode: 'bcdf ghjk'}});
  assert.equal(signup.status, 200);
  assert.match(String(signup.cookie), /quotum_session=qt_s_.+; Path=\/; HttpOnly; SameSite=Lax/);
  assert.deepEqual(signup.body.boards.map((b: any) => [b.name, b.personal, b.role]), [['', true, 'owner']]);
  assert.equal(signup.body.user.email, 'alice@example.com');
  const alices = signup.body.boards[0].id;

  assert.equal((await call('POST', '/api/auth/signup', {as: 'bob', body: {email: 'bob@example.com', name: 'Bob', password: 'correct horse'}})).body.error, 'signup_closed');

  const team = await call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}});
  assert.equal((await call('POST', `/api/boards/${alices}/invites`, {as: 'alice'})).status, 403, 'no invites to a personal board');
  const invite = await call('POST', `/api/boards/${team.body.id}/invites`, {as: 'alice'});
  const secret = invite.body.url.split('/invite/')[1];
  assert.equal((await call('GET', `/api/invites/${secret}`)).body.board.name, 'Team');
  const bob = await call('POST', '/api/auth/signup', {as: 'bob', body: {email: 'bob@example.com', name: 'Bob', password: 'correct horse', invite: secret}});
  assert.deepEqual(bob.body.boards.map((b: any) => [b.name, b.personal, b.role]), [['', true, 'owner'], ['Team', false, 'member']]);
  assert.equal(bob.body.joined, team.body.id);
  assert.equal((await call('GET', `/api/overview?board=${alices}`, {as: 'bob'})).status, 404, "bob cannot read alice's board");
  assert.equal((await call('POST', `/api/boards/${team.body.id}/invites`, {as: 'bob'})).status, 403, 'members do not invite');

  assert.equal((await call('POST', '/api/auth/login', {body: {email: 'alice@example.com', password: 'wrong'}})).status, 401);
  assert.equal((await call('POST', '/api/auth/login', {as: 'alice2', body: {email: 'alice@example.com', password: 'correct horse'}})).status, 200);
  await call('POST', '/api/auth/logout', {as: 'alice2'});
  assert.equal((await call('GET', '/api/session', {as: 'alice2'})).body.user, null);
});

test('someone with an account who signs in from an invite link joins the board', async () => {
  const {call, person} = await hub();
  await person('alice');
  const team = await call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}});
  const secret = (await call('POST', `/api/boards/${team.body.id}/invites`, {as: 'alice'})).body.url.split('/invite/')[1];
  await call('POST', '/api/auth/signup', {as: 'carol', body: {email: 'carol@example.com', name: 'Carol', password: 'correct horse', invite: secret}});
  const carol = await call('POST', '/api/auth/login', {as: 'carol2', body: {email: 'carol@example.com', password: 'correct horse', invite: secret}});
  assert.equal(carol.body.joined, team.body.id);
});

test('a machine token lets any number of machines deliver as its person; revoking it disconnects them and tells them so', async () => {
  const {call, person} = await hub();
  await person('alice');
  const token = await call('POST', '/api/tokens', {as: 'alice', body: {name: 'Dev images'}});
  assert.match(token.body.secret, /^qt_m_/);
  const listed = (await call('GET', '/api/tokens', {as: 'alice'})).body;
  assert.deepEqual([listed[0].secret, listed[0].name, listed[0].userId], [undefined, 'Dev images', undefined], 'shown once, no user ids');

  const auth = {authorization: `Bearer ${token.body.secret}`};
  for (const id of ['machine-one-0123456789', 'machine-two-0123456789']) {
    const delivered = await call('POST', '/v1/ingest', {body: batch(id), headers: auth});
    assert.deepEqual([delivered.status, delivered.body.accepted + delivered.body.duplicates], [200, 1]);
  }
  const devices = (await call('GET', '/api/devices', {as: 'alice'})).body;
  const overview = (await call('GET', '/api/overview', {as: 'alice'})).body;
  const [codex] = overview.sources;
  assert.deepEqual([overview.sources.length, codex.provider, codex.windows[0].remaining, codex.windows[0].kind, codex.owners], [1, 'codex', 92, 'weekly', ['Alice']]);
  assert.deepEqual(devices.map((d: any) => [d.via, d.sources.map((s: any) => s.source)]), [['token', [codex.id]], ['token', [codex.id]]]);
  assert.equal(devices[0].machineId, undefined, 'machine ids stay on the hub');

  await call('DELETE', `/api/tokens/${token.body.id}`, {as: 'alice'});
  const refused = await call('POST', '/v1/ingest', {body: batch('machine-one-0123456789'), headers: auth});
  assert.deepEqual([refused.status, refused.body.error], [403, 'device_revoked'], 'the agent hears it and stops');
  assert.deepEqual((await call('GET', '/api/devices', {as: 'alice'})).body, []);
});

test('people see and manage only their own machines and tokens; a device is named on the hub', async () => {
  const {call, person} = await hub();
  await person('alice');
  const team = (await call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  await person('bob', (await call('POST', `/api/boards/${team}/invites`, {as: 'alice'})).body.url.split('/invite/')[1]);
  const alices = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body;
  assert.equal(alices.name, '', 'no name: the dashboard shows a default in its language');
  await call('POST', '/v1/ingest', {body: batch('alices-box-0123456789'), headers: {authorization: `Bearer ${alices.secret}`}});
  const [box] = (await call('GET', '/api/devices', {as: 'alice'})).body;
  assert.deepEqual([box.name, box.reported], ['build-01', 'build-01']);

  assert.deepEqual((await call('GET', '/api/devices', {as: 'bob'})).body, []);
  assert.deepEqual((await call('GET', '/api/tokens', {as: 'bob'})).body, []);
  assert.equal((await call('DELETE', `/api/tokens/${alices.id}`, {as: 'bob'})).status, 404);
  assert.equal((await call('DELETE', `/api/devices/${box.id}`, {as: 'bob'})).status, 404);
  assert.equal((await call('POST', `/api/devices/${box.id}`, {as: 'bob', body: {name: 'mine'}})).status, 404);

  assert.equal((await call('POST', `/api/devices/${box.id}`, {as: 'alice', body: {name: 'Build server'}})).status, 200);
  assert.deepEqual((await call('GET', '/api/devices', {as: 'alice'})).body.map((d: any) => [d.name, d.reported]), [['Build server', 'build-01']]);
  await call('POST', '/v1/ingest', {body: batch('alices-box-0123456789'), headers: {authorization: `Bearer ${alices.secret}`}});
  assert.equal((await call('GET', '/api/devices', {as: 'alice'})).body[0].name, 'Build server', 'the machine reporting its name again does not undo it');
  await call('POST', `/api/devices/${box.id}`, {as: 'alice', body: {name: ''}});
  assert.equal((await call('GET', '/api/devices', {as: 'alice'})).body[0].name, 'build-01', 'an empty name gives back the reported one');
  assert.equal((await call('DELETE', `/api/devices/${box.id}`, {as: 'alice'})).status, 200);
});

test('a disconnected machine takes along what only it measured, from every board', async () => {
  const {call, person} = await hub();
  await person('alice');
  const team = (await call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  const laptop = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body;
  const images = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body;
  await call('POST', '/v1/ingest', {body: batch('alices-laptop-0123456789'), headers: {authorization: `Bearer ${laptop.secret}`}});
  await call('POST', '/v1/ingest', {body: batch('alices-image-0123456789'), headers: {authorization: `Bearer ${images.secret}`}});
  const [source] = (await call('GET', '/api/overview', {as: 'alice'})).body.sources;
  await call('POST', `/api/boards/${team}/shares`, {as: 'alice', body: {source: source.id}});
  const shown = async () => [
    (await call('GET', '/api/overview', {as: 'alice'})).body.sources.length,
    (await call('GET', `/api/overview?board=${team}`, {as: 'alice'})).body.sources.length,
  ];

  await call('DELETE', `/api/tokens/${laptop.id}`, {as: 'alice'});
  assert.deepEqual(await shown(), [1, 1], 'another machine of hers still measures it');
  const [image] = (await call('GET', '/api/devices', {as: 'alice'})).body;
  await call('DELETE', `/api/devices/${image.id}`, {as: 'alice'});
  assert.deepEqual(await shown(), [0, 0], 'no machine does any more: gone from her board and the team');

  await call('POST', '/v1/ingest', {body: batch('alices-laptop-0123456789'), headers: {authorization: `Bearer ${(await call('POST', '/api/tokens', {as: 'alice', body: {}})).body.secret}`}});
  assert.deepEqual(await shown(), [1, 0], 'measured again, it is hers again; sharing it is up to her');
});

test('people share their subscriptions with a shared board; its owner arranges, names, hides and takes them off', async () => {
  const {call, person} = await hub();
  await person('alice');
  const team = (await call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  await person('bob', (await call('POST', `/api/boards/${team}/invites`, {as: 'alice'})).body.url.split('/invite/')[1]);
  const bobs = (await call('POST', '/api/tokens', {as: 'bob', body: {}})).body.secret;
  await call('POST', '/v1/ingest', {body: batch('bobs-laptop-0123456789'), headers: {authorization: `Bearer ${bobs}`}});

  assert.equal((await call('GET', '/api/overview', {as: 'bob'})).body.sources.length, 1, 'on his own board at once');
  assert.deepEqual((await call('GET', `/api/overview?board=${team}`, {as: 'bob'})).body.sources, [], 'on a shared board only when shared');
  const offer = (await call('GET', `/api/boards/${team}/shares`, {as: 'bob'})).body;
  const source = offer.mine[0].source;
  assert.deepEqual([offer.shared, offer.mine[0].shared], [[], false]);
  assert.equal((await call('POST', `/api/boards/${team}/shares`, {as: 'alice', body: {source}})).status, 404, 'only those who measure it share it');
  assert.equal((await call('POST', `/api/boards/${team}/shares`, {as: 'bob', body: {source}})).status, 200);
  const shared = (await call('GET', `/api/overview?board=${team}`, {as: 'alice'})).body;
  assert.deepEqual(shared.sources.map((s: any) => [s.id, s.owners]), [[source, ['Bob']]]);
  assert.deepEqual((await call('GET', `/api/boards/${team}/shares`, {as: 'alice'})).body.shared, [{source, provider: 'codex', sharedBy: 'Bob', mine: false}]);

  assert.deepEqual(shared.view, EMPTY, 'nothing arranged yet');
  const view = {...EMPTY, order: ['history', `source:${source}`], sizes: {[`source:${source}`]: 6}, names: {[source]: 'Bob’s Codex'}, hidden: ['forecast'], shown: ['agents'], windows: [`${source}/weekly`], plans: {[source]: [50, 50, 0, 0, 0, 0, 0]}, unplanned: [source], colors: {[source]: '#1fa89c'}, columns: {agents: ['machine', 'origin']}, shownColumns: {agents: ['state']}};
  assert.deepEqual((await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: view})).body, view);
  assert.deepEqual((await call('GET', `/api/overview?board=${team}`, {as: 'bob'})).body.view, view);
  assert.equal((await call('POST', `/api/boards/${team}/view`, {as: 'bob', body: EMPTY})).status, 403, 'a member only looks');
  assert.equal((await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: {...view, plans: {[source]: [50, 60, 0, 0, 0, 0, 0]}}})).status, 400);
  assert.equal((await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: {...view, sizes: {history: 13}}})).status, 400, 'no wider than the grid');
  assert.equal((await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: {...view, colors: {[source]: 'red; background: url(x)'}}})).status, 400, 'a colour is a hex colour');
  assert.equal((await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: {...view, columns: {agents: ['<b>']}}})).status, 400, 'a column is a short name');
  assert.equal((await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: {...view, shownColumns: {agents: ['<b>']}}})).status, 400);
  const {shownColumns: _, ...older} = view;
  assert.deepEqual((await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: older})).body.shownColumns, {});
  const narrow = await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: {...view, sizes: {history: 3}}});
  assert.deepEqual(narrow.body.sizes, {history: 4}, 'a third of the grid at least: narrower ones, saved before, are taken as that');
  await call('POST', `/api/boards/${team}/view`, {as: 'alice', body: view});

  assert.equal((await call('DELETE', `/api/boards/${team}/shares/${source}`, {as: 'alice'})).status, 200, 'the owner takes anything off');
  assert.deepEqual((await call('GET', `/api/overview?board=${team}`, {as: 'bob'})).body.sources, []);
  assert.equal((await call('GET', '/api/overview', {as: 'bob'})).body.sources.length, 1, 'it stays on his own board');

  assert.equal((await call('POST', `/api/boards/${team}`, {as: 'bob', body: {name: 'Mine now'}})).status, 403, 'only the owner renames');
  assert.equal((await call('POST', `/api/boards/${team}`, {as: 'alice', body: {name: ''}})).status, 400, 'a shared board needs a name');
  const personal = (await call('GET', '/api/session', {as: 'bob'})).body.boards.find((b: any) => b.personal).id;
  assert.equal((await call('POST', `/api/boards/${personal}`, {as: 'bob', body: {name: 'Work'}})).body.name, 'Work');
  assert.equal((await call('POST', `/api/boards/${personal}`, {as: 'bob', body: {name: ''}})).body.name, '', 'a personal board gets its default name back');
  assert.equal((await call('GET', `/api/boards/${personal}/shares`, {as: 'bob'})).status, 403, 'a personal board shows everything of its person by itself');
});

test('the owner removes people and resets invite links; what someone shared leaves with them; deleting a board keeps the data', async () => {
  const {call, person} = await hub();
  const personal = await person('alice');
  const board = (await call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  const invite = async () => (await call('POST', `/api/boards/${board}/invites`, {as: 'alice'})).body.url.split('/invite/')[1];
  const bob = await person('bob', await invite());
  const link = await invite();
  await person('carol', link);
  const bobs = (await call('POST', '/api/tokens', {as: 'bob', body: {}})).body.secret;
  await call('POST', '/v1/ingest', {body: batch('machine-bob-0123456789'), headers: {authorization: `Bearer ${bobs}`}});
  const source = (await call('GET', `/api/boards/${board}/shares`, {as: 'bob'})).body.mine[0].source;
  await call('POST', `/api/boards/${board}/shares`, {as: 'bob', body: {source}});
  const members = (await call('GET', `/api/boards/${board}/members`, {as: 'alice'})).body;
  const bobId = members.find((m: any) => m.name === 'Bob').id;

  assert.equal((await call('DELETE', `/api/boards/${board}/members/${bobId}`, {as: 'carol'})).status, 403, 'only the owner removes people');
  assert.equal((await call('DELETE', `/api/boards/${board}/members/${bobId}`, {as: 'alice'})).status, 200);
  assert.equal((await call('GET', `/api/overview?board=${board}`, {as: 'bob'})).status, 404);
  assert.deepEqual((await call('GET', `/api/overview?board=${board}`, {as: 'alice'})).body.sources, [], 'what he shared left with him');
  assert.equal((await call('GET', '/api/overview', {as: 'bob'})).body.sources.length, 1, 'and stays his');
  void bob;

  assert.deepEqual((await call('DELETE', `/api/boards/${board}/invites`, {as: 'alice'})).body, {revoked: 2});
  assert.equal((await call('GET', `/api/invites/${link}`)).status, 404, 'links given out stop working');

  assert.equal((await call('POST', `/api/boards/${board}/leave`, {as: 'alice'})).status, 403, 'the owner deletes it instead');
  assert.equal((await call('POST', `/api/boards/${board}/leave`, {as: 'carol'})).status, 200);
  assert.equal((await call('DELETE', `/api/boards/${personal}`, {as: 'alice'})).status, 403, 'a personal board stays');
  assert.equal((await call('DELETE', `/api/boards/${board}`, {as: 'alice'})).status, 200);
  assert.deepEqual((await call('GET', '/api/session', {as: 'carol'})).body.boards.map((b: any) => b.personal), [true]);
  assert.equal((await call('GET', '/api/overview', {as: 'bob'})).body.sources.length, 1, 'measurements belong to their people, not to boards');
});

test('a person changes their name freely, their email and password only with the current password', async () => {
  const {call, person} = await hub();
  await person('alice');
  await call('POST', '/api/auth/login', {as: 'alice-phone', body: {email: 'alice@example.com', password: 'correct horse'}});
  assert.equal((await call('POST', '/api/account', {as: 'alice', body: {name: 'Alice L.'}})).body.user.name, 'Alice L.');
  const wrong = await call('POST', '/api/account', {as: 'alice', body: {email: 'al@example.com', currentPassword: 'wrong'}});
  assert.deepEqual([wrong.status, wrong.body.error], [403, 'wrong_password']);
  const changed = await call('POST', '/api/account', {as: 'alice', body: {email: 'AL@example.com', password: 'battery staple', currentPassword: 'correct horse'}});
  assert.equal(changed.body.user.email, 'al@example.com');
  assert.equal((await call('GET', '/api/session', {as: 'alice'})).body.user?.name, 'Alice L.', 'this session stays');
  assert.equal((await call('GET', '/api/session', {as: 'alice-phone'})).body.user, null, 'the other ones end with the old password');
  assert.equal((await call('POST', '/api/auth/login', {body: {email: 'al@example.com', password: 'battery staple'}})).status, 200);
});

test('only failed sign-ins count against the limit', async () => {
  const {call, person} = await hub();
  await person('alice');
  const signIn = (password: string) => call('POST', '/api/auth/login', {body: {email: 'alice@example.com', password}});
  for (let i = 0; i < 12; i++) assert.equal((await signIn('correct horse')).status, 200, 'a team behind one address signs in freely');
  for (let i = 0; i < 10; i++) assert.equal((await signIn('wrong horse')).status, 401);
  assert.equal((await signIn('correct horse')).status, 429);
});

test('a device shows the failures it reports until it delivers again', async () => {
  const {call, person} = await hub();
  await person('alice');
  const token = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body;
  const auth = {authorization: `Bearer ${token.secret}`};
  const failure = {provider: 'claude', observedAt: iso(Date.now()), error: 'not_logged_in', detail: 'run claude and /login'};
  await call('POST', '/v1/ingest', {body: {...batch('machine-one-0123456789', [failure]), snapshots: []}, headers: auth});
  const [device] = (await call('GET', '/api/devices', {as: 'alice'})).body;
  assert.deepEqual(device.failures.map((f: any) => [f.provider, f.error, f.detail]), [['claude', 'not_logged_in', 'run claude and /login']]);
});

test('a machine connects with a one-time code approved by a signed-in person, and becomes theirs', async () => {
  const {call, person} = await hub();
  await person('alice');
  const started = await call('POST', '/v1/device/code', {body: {machine: machine('laptop-0123456789ab'), agent: 'quotum/0.2.0'}});
  assert.match(started.body.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(started.body.verificationUriComplete, `${ORIGIN}/device?code=${started.body.userCode}`);
  const poll = () => call('POST', '/v1/device/token', {body: {deviceCode: started.body.deviceCode}});
  assert.equal((await poll()).body.error, 'authorization_pending');
  assert.equal((await poll()).body.error, 'slow_down');

  const typed = started.body.userCode.toLowerCase().replace('-', ' ');
  const pending = await call('GET', `/api/device?code=${encodeURIComponent(typed)}`, {as: 'alice'});
  assert.equal(pending.body.machine.name, 'build-01');
  assert.equal((await call('POST', '/api/device/approve', {as: 'alice', body: {code: 'BCDF-GHJK'}})).status, 400);
  assert.equal((await call('POST', '/api/device/approve', {as: 'alice', body: {code: typed}})).status, 200);

  const connected = await call('POST', '/v1/device/token', {body: {deviceCode: started.body.deviceCode}});
  assert.match(connected.body.token, /^qt_d_/);
  assert.deepEqual([connected.body.account, connected.body.device.name, connected.body.board], [{name: 'Alice'}, 'build-01', undefined]);
  assert.equal((await poll()).body.error, 'expired_token', 'a code gives one device');

  const device = {authorization: `Bearer ${connected.body.token}`};
  assert.equal((await call('POST', '/v1/ingest', {body: batch('laptop-0123456789ab'), headers: device})).status, 200);
  // A machine token cannot take over the machine connected with a code.
  const machines = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body.secret;
  const takeover = await call('POST', '/v1/ingest', {body: batch('laptop-0123456789ab'), headers: {authorization: `Bearer ${machines}`}});
  assert.deepEqual([takeover.status, takeover.body.error], [403, 'device_conflict']);

  const [listed] = (await call('GET', '/api/devices', {as: 'alice'})).body;
  assert.equal(listed.via, 'code');
  await call('DELETE', `/api/devices/${listed.id}`, {as: 'alice'});
  const removed = await call('POST', '/v1/ingest', {body: batch('laptop-0123456789ab'), headers: device});
  assert.deepEqual([removed.status, removed.body.error], [403, 'device_revoked']);
  assert.equal((await call('POST', '/v1/checkin', {body: {version: 1}, headers: device})).status, 403);
});

test('agents get errors in the spec’s terms', async () => {
  const {call, person} = await hub();
  await person('alice');
  const auth = {authorization: `bearer ${(await call('POST', '/api/tokens', {as: 'alice', body: {}})).body.secret}`};
  const checkin = await call('POST', '/v1/checkin', {body: {version: 1, agent: 'quotum/0.2.0', machine: machine('m-0123456789ab')}, headers: auth});
  assert.deepEqual([checkin.status, checkin.body.subscriptions], [200, []], 'the scheme is case-insensitive');
  const bad = await call('POST', '/v1/checkin', {body: {version: 1, agent: 'quotum/0.2.0', machine: machine('m-0123456789ab'), subscriptions: [{provider: 'claude', account: 'someone@example.com'}]}, headers: auth});
  assert.deepEqual([bad.status, bad.body], [400, {error: 'invalid_request', detail: 'account'}], 'accounts are pseudonyms, never raw ids');
  const broken = await call('POST', '/v1/ingest', {body: '{"version": 1,', headers: auth});
  assert.deepEqual([broken.status, broken.body], [400, {error: 'invalid_batch'}]);
  const wrong = await call('POST', '/v1/ingest', {body: {...batch('m-0123456789ab'), version: 2}, headers: auth});
  assert.deepEqual([wrong.status, wrong.body], [400, {error: 'invalid_batch', detail: 'version'}]);
});

test('a device following the hub’s pace is told when to ask again, and the card says when it measures next', async () => {
  const {call, person} = await hub();
  await person('alice');
  const headers = {authorization: `Bearer ${(await call('POST', '/api/tokens', {as: 'alice', body: {}})).body.secret}`};
  const checkin = (paced: unknown, change: object = {}) =>
    call('POST', '/v1/checkin', {
      body: {version: 1, agent: 'quotum/0.4.0', paced, machine: machine('m-0123456789ab'), subscriptions: [{provider: 'codex', account: 'a1b2c3d4e5f6a1b2c3d4e5f6', active: false, ...change}]},
      headers,
    });
  const cadence = async () => (await call('GET', '/api/overview', {as: 'alice'})).body.sources[0]?.cadence;

  const first = (await checkin(true)).body.subscriptions[0];
  assert.deepEqual([first.measure, first.onDuty, first.askInMs, first.nextInMs], [true, true, 15_000, 240_000]);
  const measured = Date.now() - 1000;
  await call('POST', '/v1/ingest', {body: {...batch('m-0123456789ab'), snapshots: [{...snapshot(measured), staleAfterMs: 240_000 * 1.2 + 60_000}]}, headers});
  const waiting = (await checkin(true)).body.subscriptions[0];
  assert.deepEqual([waiting.measure, waiting.onDuty, waiting.nextInMs], [false, true, undefined]);
  assert.ok(waiting.askInMs > 0 && waiting.askInMs <= 15_000);
  assert.deepEqual(await cadence(), {next: measured + 120_000, why: 'idle'});

  const plain = (await checkin(false)).body.subscriptions[0];
  assert.deepEqual(Object.keys(plain), ['provider', 'measure', 'until'], 'without the pace, the answer is as before');
  const bad = await checkin(true, {minIntervalMs: 30_000});
  assert.deepEqual([bad.status, bad.body], [400, {error: 'invalid_request', detail: 'minIntervalMs'}]);
  assert.deepEqual((await checkin('yes')).body, {error: 'invalid_request', detail: 'paced'});
});

test('an agent request without a valid token is refused before its body arrives', async t => {
  const {app, call, person} = await hub();
  await person('alice');
  const revokedToken = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body;
  await call('DELETE', `/api/tokens/${revokedToken.id}`, {as: 'alice'});
  const started = (await call('POST', '/v1/device/code', {body: {machine: machine('laptop-0123456789ab'), agent: 'quotum/0.2.0'}})).body;
  await call('POST', '/api/device/approve', {as: 'alice', body: {code: started.userCode}});
  const revokedDevice = (await call('POST', '/v1/device/token', {body: {deviceCode: started.deviceCode}})).body.token;
  const [device] = (await call('GET', '/api/devices', {as: 'alice'})).body;
  await call('DELETE', `/api/devices/${device.id}`, {as: 'alice'});

  /** Sends the start of a body that never ends; before the fix such a request waited for the rest for ever. */
  const hanging = async (url: string, headers: Record<string, string>) => {
    const body = new PassThrough();
    t.after(() => body.destroy());
    body.write('{"version": 1,');
    const answer = app.inject({method: 'POST', url, payload: body, headers: {'content-type': 'application/json', ...headers}});
    const late = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${url} waited for the body`)), 1000).unref());
    const response = await Promise.race([answer, late]);
    return [response.statusCode, JSON.parse(response.body).error];
  };
  for (const url of ['/v1/checkin', '/v1/sessions', '/v1/ingest']) {
    assert.deepEqual(await hanging(url, {}), [401, 'unauthorized'], `${url} without a token`);
    assert.deepEqual(await hanging(url, {authorization: 'Bearer qt_m_someone-elses-token-0123456789'}), [401, 'unauthorized'], `${url} with an unknown token`);
    assert.deepEqual(await hanging(url, {authorization: `Bearer ${revokedToken.secret}`}), [403, 'device_revoked'], `${url} with a revoked token`);
    assert.deepEqual(await hanging(url, {authorization: `Bearer ${revokedDevice}`}), [403, 'device_revoked'], `${url} from a removed device`);
  }
  assert.deepEqual(await hanging('/v1/ingest', {host: 'evil.example'}), [403, 'forbidden_host'], 'the host is checked first');
});

test('a device removed or a token revoked while its body arrives delivers nothing, nor does its old secret once it is connected anew', async t => {
  const {app, call, person} = await hub();
  await person('alice');
  /** Connects a machine with a one-time code; returns its secret. */
  const pair = async (id: string) => {
    const started = (await call('POST', '/v1/device/code', {body: {machine: machine(id), agent: 'quotum/0.2.0'}})).body;
    await call('POST', '/api/device/approve', {as: 'alice', body: {code: started.userCode}});
    return (await call('POST', '/v1/device/token', {body: {deviceCode: started.deviceCode}})).body.token as string;
  };
  const removeDevice = async () => {
    const [device] = (await call('GET', '/api/devices', {as: 'alice'})).body;
    await call('DELETE', `/api/devices/${device.id}`, {as: 'alice'});
  };
  /** Sends the headers and half of a batch, lets `meanwhile` happen, then sends the rest. */
  const midway = async (secret: string, id: string, meanwhile: () => Promise<unknown>) => {
    const body = new PassThrough();
    t.after(() => body.destroy());
    const text = JSON.stringify(batch(id));
    body.write(text.slice(0, text.length / 2));
    const answer = app.inject({method: 'POST', url: '/v1/ingest', payload: body, headers: {'content-type': 'application/json', authorization: `Bearer ${secret}`}});
    await new Promise(resolve => setTimeout(resolve, 50));
    await meanwhile();
    body.end(text.slice(text.length / 2));
    const response = await answer;
    return [response.statusCode, JSON.parse(response.body).error];
  };

  const device = await pair('laptop-0123456789ab');
  assert.deepEqual(await midway(device, 'laptop-0123456789ab', removeDevice), [403, 'device_revoked']);
  const token = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body;
  assert.deepEqual(await midway(token.secret, 'build-0123456789ab', () => call('DELETE', `/api/tokens/${token.id}`, {as: 'alice'})), [403, 'device_revoked']);
  assert.deepEqual((await call('GET', '/api/devices', {as: 'alice'})).body, [], 'no device comes back or joins');
  assert.deepEqual((await call('GET', '/api/overview', {as: 'alice'})).body.sources, [], 'nothing was kept');

  // A secret a device was disconnected for never works again, even when it comes back meanwhile.
  const old = await pair('desk-0123456789abcd');
  assert.deepEqual(await midway(old, 'desk-0123456789abcd', () => removeDevice().then(() => pair('desk-0123456789abcd'))), [401, 'unauthorized'], 'connected with a new code');
  const again = await pair('desk-0123456789abcd');
  const joining = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body.secret;
  const join = async () => {
    await removeDevice();
    const joined = await call('POST', '/v1/checkin', {body: {version: 1, agent: 'quotum/0.2.0', machine: machine('desk-0123456789abcd')}, headers: {authorization: `Bearer ${joining}`}});
    assert.equal(joined.status, 200);
  };
  assert.deepEqual(await midway(again, 'desk-0123456789abcd', join), [401, 'unauthorized'], 'joined with a machine token');
  assert.deepEqual((await call('GET', '/api/overview', {as: 'alice'})).body.sources, [], 'nothing was kept');
});

test('a request is given 30 seconds to arrive, and one that takes longer is answered in the spec’s terms', async () => {
  const {app} = await hub();
  // Node keeps the checking interval on the server, but its types do not declare it.
  const server = app.server as typeof app.server & {connectionsCheckingInterval: number};
  assert.equal(server.requestTimeout, 30_000);
  // Once the headers are in, Node holds a request to the longer of the two limits.
  assert.ok(server.headersTimeout <= server.requestTimeout, `headersTimeout ${server.headersTimeout}`);
  assert.equal(server.connectionsCheckingInterval, 5_000);

  const answered = (code: string, answering = false) => {
    let written = '';
    const socket = Object.assign(new PassThrough(), {writable: true, _httpMessage: answering ? {headersSent: true} : null});
    socket.write = (chunk: string) => ((written += chunk), true);
    // The hub closes it with the error, as Node does.
    socket.on('error', () => {});
    server.emit('clientError', Object.assign(new Error(code), {code}), socket);
    return {written, destroyed: socket.destroyed};
  };
  const late = answered('ERR_HTTP_REQUEST_TIMEOUT');
  assert.ok(late.destroyed, 'the connection is closed');
  const [head, body] = late.written.split('\r\n\r\n');
  assert.match(head, /^HTTP\/1\.1 408 Request Timeout\r\n/);
  assert.match(head, /\r\nContent-Type: application\/json\r\n/);
  assert.match(head, new RegExp(`\r\nContent-Length: ${body.length}\r\n`));
  assert.match(head, /\r\nConnection: close$/);
  assert.deepEqual(JSON.parse(body), {error: 'request_timeout'});
  assert.deepEqual(JSON.parse(answered('HPE_HEADER_OVERFLOW').written.split('\r\n\r\n')[1]), {error: 'headers_too_large'});
  assert.deepEqual(JSON.parse(answered('HPE_INVALID_METHOD').written.split('\r\n\r\n')[1]), {error: 'invalid_request'});
  assert.equal(answered('ECONNRESET').written, '', 'a reset connection has no one to answer');
  const midway = answered('HPE_INVALID_METHOD', true);
  assert.deepEqual([midway.written, midway.destroyed], ['', true], 'an answer on its way is cut short, not spliced with another');
});

test('history reads a period selected on the chart, up to a month, on a grid fine enough for it', async () => {
  const {call, person} = await hub();
  await person('alice');
  const now = Date.now();
  const read = (query: string) => call('GET', `/api/history?${query}`, {as: 'alice'});
  const minute = 60_000;
  const hour = await read(`from=${now - 3_600_000}&to=${now - 1_800_000}`);
  assert.deepEqual(
    [hour.status, hour.body.since, hour.body.to, hour.body.cellMs],
    [200, Math.floor((now - 3_600_000) / minute) * minute, Math.ceil((now - 1_800_000) / minute) * minute, minute],
    'out to whole cells',
  );
  const nearly = await read(`from=${now - 3_600_000 + 1}&to=${now - 1_800_000 - 1}`);
  assert.deepEqual([nearly.body.since, nearly.body.to], [hour.body.since, hour.body.to], 'less than a cell apart: one answer');
  const week = await read(`from=${now - 7 * 86_400_000}&to=${now}`);
  assert.equal(week.body.cellMs, 30 * 60_000, 'as dense as the ranges ending now');
  const month = await read(`from=${now - 31 * 86_400_000 + 3_600_000}&to=${now}`);
  assert.equal(month.body.cellMs, 2 * 3_600_000, 'a day over a month keeps the grid of a month');
  const ahead = await read(`from=${now - 3_600_000}&to=${now + 86_400_000}`);
  assert.ok(ahead.body.to <= Date.now(), 'it ends now at the latest');
  const fixed = await read('range=24h');
  assert.equal(fixed.body.to, fixed.body.now, 'a period of the list ends now');
  for (const query of [`from=${now - 600_000}&to=${now}`, `from=${now - 40 * 86_400_000}&to=${now}`, `from=${now - 100 * 86_400_000}&to=${now - 90 * 86_400_000}`, `from=${now - 3_600_000}`, 'from=abc&to=def']) {
    assert.equal((await read(query)).status, 400, query);
  }
});

test('a costly history is reused a while after new data, says when a newer one is ready, and never outlives a change of sources', async () => {
  const {call, person} = await hub();
  await person('alice');
  const team = (await call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  const token = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body.secret;
  const ingest = (at: number) =>
    call('POST', '/v1/ingest', {body: {...batch('alices-laptop-0123456789'), snapshots: [snapshot(at)]}, headers: {authorization: `Bearer ${token}`}});
  await ingest(Date.now() - 60_000);
  const [source] = (await call('GET', '/api/overview', {as: 'alice'})).body.sources;
  await call('POST', `/api/boards/${team}/shares`, {as: 'alice', body: {source: source.id}});
  const read = async () => (await call('GET', `/api/history?board=${team}&range=30d`, {as: 'alice'})).body;
  // Every answer costly, however small the board (the settings are read-only only to the type checker).
  const history = config.history as {costlyMs: number};
  const costly = history.costlyMs;
  history.costlyMs = 0;
  try {
    const first = await read();
    assert.equal(first.refreshInMs, null);
    await ingest(Date.now() - 1_000);
    const kept = await read();
    assert.ok(kept.refreshInMs > 0, 'reused, and it says when a newer one is ready');
    assert.equal(kept.series[0].samples, first.series[0].samples);
    await call('DELETE', `/api/boards/${team}/shares/${source.id}`, {as: 'alice'});
    assert.deepEqual((await read()).series, [], 'a source taken off the board is gone at once');
  } finally {
    history.costlyMs = costly;
  }
});

test('agents report the coding agents running on their machines; the cards of their subscriptions show them', async () => {
  const {call, person} = await hub();
  await person('alice');
  const token = (await call('POST', '/api/tokens', {as: 'alice', body: {}})).body.secret;
  const headers = {authorization: `Bearer ${token}`};
  await call('POST', '/v1/ingest', {body: batch('alices-laptop-0123456789'), headers});
  const report = (sessions: object[]) =>
    call('POST', '/v1/sessions', {body: {version: 1, agent: 'quotum/0.3.0', machine: machine('alices-laptop-0123456789'), sentAt: iso(Date.now()), sessions}, headers});
  const started = iso(Date.now() - 3_600_000);
  const codex = {provider: 'codex', account: 'a1b2c3d4e5f6a1b2c3d4e5f6', origin: 'terminal', project: 'quotum', startedAt: started, working: true};
  const unknown = {...codex, account: 'ffffffffffffffffffffffff'};
  const guessed = {provider: 'codex', origin: 'editor', startedAt: started, working: false};
  const answer = await report([codex, unknown, guessed]);
  assert.deepEqual([answer.status, answer.body], [200, {accepted: 2}], 'a subscription the hub does not know is left out');
  const shown = async () => (await call('GET', '/api/overview', {as: 'alice'})).body.sources[0].sessions;
  const [first, second] = await shown();
  assert.deepEqual([first.origin, first.project, first.folder, first.working, first.device.name, first.startedAt], ['terminal', 'quotum', null, true, 'build-01', Date.parse(started)]);
  assert.equal(second.lastWorkedAt, null, 'an older agent omits the date');
  assert.equal(second.origin, 'editor', 'without an account: the subscription this machine delivers');
  assert.deepEqual(Object.keys(first).sort(), ['device', 'folder', 'lastWorkedAt', 'origin', 'project', 'startedAt', 'working'], 'nothing of how the hub tells sessions apart');
  assert.equal((await report([])).status, 200);
  assert.deepEqual(await shown(), [], 'an empty list: none runs');
  const long = await report([{...codex, project: 'x'.repeat(300), folder: 'y'.repeat(300)}]);
  assert.equal(long.body.accepted, 1, 'long names are cut, not refused');
  assert.deepEqual([(await shown())[0].project, (await shown())[0].folder], ['x'.repeat(120), 'y'.repeat(120)]);
  // Boards show the project, and the folder where the agent tells one; an older agent tells only the project.
  await report([
    {...codex, folder: 'quotum.feat-18', startedAt: iso(Date.now() - 4_000_000)},
    {...codex, startedAt: iso(Date.now() - 3_000_000)},
    {...codex, project: undefined, folder: 'scratch', startedAt: iso(Date.now() - 2_000_000)},
    {...codex, project: undefined, startedAt: iso(Date.now() - 1_000_000)},
  ]);
  assert.deepEqual(
    (await shown()).map((s: {project: string | null; folder: string | null}) => [s.project, s.folder]),
    [
      ['quotum', 'quotum.feat-18'],
      ['quotum', null],
      [null, 'scratch'],
      [null, null],
    ],
  );

  const team = (await call('POST', '/api/boards', {as: 'alice', body: {name: 'Team'}})).body.id;
  await person('bob', (await call('POST', `/api/boards/${team}/invites`, {as: 'alice'})).body.url.split('/invite/')[1]);
  const bobs = (await call('POST', '/api/tokens', {as: 'bob', body: {}})).body.secret;
  const borrowed = await call('POST', '/v1/sessions', {
    body: {version: 1, agent: 'quotum/0.3.0', machine: machine('bobs-laptop-0123456789'), sentAt: iso(Date.now()), sessions: [codex]},
    headers: {authorization: `Bearer ${bobs}`},
  });
  assert.equal(borrowed.body.accepted, 0, "naming someone else's account shows nothing on it");

  const invalidTime = await report([{...guessed, lastWorkedAt: 'never'}]);
  assert.deepEqual([invalidTime.status, invalidTime.body], [400, {error: 'invalid_request', detail: 'lastWorkedAt'}]);
  const wrong = await report([{...codex, origin: 'browser'}]);
  assert.deepEqual([wrong.status, wrong.body], [400, {error: 'invalid_request', detail: 'origin'}]);
  // As many as a list may hold, every name at its longest, in the widest script or escaped in JSON, fit in one request.
  for (const char of ['🚀', '\u0001']) {
    const name = char.repeat(120);
    const longest = {...guessed, provider: 'antigravity', accountName: name, project: name, folder: name};
    const full = await call('POST', '/v1/sessions', {
      body: {version: 1, agent: 'quotum/0.3.0', machine: {...machine('alices-laptop-0123456789'), name}, sentAt: iso(Date.now()), sessions: Array.from({length: 200}, () => longest)},
      headers,
    });
    assert.equal(full.status, 200, JSON.stringify(full.body));
  }
  assert.equal((await call('POST', '/v1/sessions', {body: {version: 1}})).status, 401);
});

test('every period ending now is drawn on the finest cell that keeps it within about 360 cells, as a range as long moved back is', async () => {
  const {call, person} = await hub();
  await person('alice');
  const minute = 60_000;
  const cells: Record<string, number> = {'1h': 1, '3h': 1, '6h': 1, '12h': 5, '24h': 5, '3d': 15, '7d': 30, '14d': 60, '30d': 120};
  assert.deepEqual(Object.keys(cells), Object.keys(config.history.ranges), 'every period the hub offers');
  for (const [range, cell] of Object.entries(cells)) {
    const live = await call('GET', `/api/history?range=${range}`, {as: 'alice'});
    const durationMs = config.history.ranges[range];
    assert.deepEqual([live.status, live.body.cellMs, live.body.to - live.body.since], [200, cell * minute, durationMs], range);
    assert.ok(durationMs / live.body.cellMs <= 378, range);
    const now = Date.now();
    const moved = await call('GET', `/api/history?from=${now - durationMs * 1.5}&to=${now - durationMs / 2}`, {as: 'alice'});
    assert.equal(moved.body.cellMs, live.body.cellMs, `${range} moved back`);
  }
  for (const range of ['2h', '1y', 'toString']) assert.equal((await call('GET', `/api/history?range=${range}`, {as: 'alice'})).status, 400, range);
});

test('past resets for everyone are listed over the history kept, not only the last month', async () => {
  const {call, store} = await hub();
  const now = Date.now();
  const old = {at: now - 40 * 86_400_000, url: 'https://example.com/old', text: 'A reset for everyone'};
  store.announce('codex', old);
  store.announce('codex', {...old, at: now - 100 * 86_400_000});
  assert.deepEqual((await call('GET', '/api/resets')).body.past, {codex: [old]});
});

test('changes from another origin, unknown hosts and other methods are refused', async () => {
  const {call, person} = await hub();
  await person('alice');
  assert.equal((await call('POST', '/api/boards', {as: 'alice', body: {name: 'x'}, headers: {origin: 'https://evil.example'}})).status, 403);
  assert.equal((await call('POST', '/api/boards', {as: 'alice', body: {name: 'x'}, headers: {origin: 'http://localhost:9999'}})).status, 403, 'the port is part of the origin');
  assert.equal((await call('POST', '/api/boards', {as: 'alice', body: {name: 'x'}, headers: {origin: ORIGIN}})).status, 200);
  assert.equal((await call('GET', '/api/session', {headers: {host: 'evil.example'}})).status, 403);
  assert.equal((await call('GET', '/api/session', {headers: {cookie: 'quotum_session=%E0%A4%A'}})).body.user, null, 'a malformed cookie is no session');
  assert.equal((await call('GET', '/api/history?range=1y', {as: 'alice'})).status, 400);
  assert.equal((await call('DELETE', '/v1/ingest')).status, 405);
  assert.equal((await call('POST', '/v1/ingest', {body: batch('x-0123456789abcdef')})).status, 401);
  assert.equal((await call('GET', '/health', {headers: {host: 'evil.example'}})).status, 200, 'the health check answers any host');
  if (existsSync(path.join(config.clientRoot, 'index.html'))) {
    assert.equal((await call('GET', '/device')).status, 200, 'client pages are served by the single-page client');
  }
  assert.equal((await call('GET', '/api/nothing')).status, 404);
});
