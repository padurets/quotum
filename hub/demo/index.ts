import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {createServer} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {firstSignup, haltRequests, healthy} from './client.js';
import {SCENES, SETS} from './catalogue.js';
import {earliest, liveStep, MIN, people, SECOND, type DemoSet} from './model.js';
import {emailOf, Live, PASSWORD, setUp, type Stand} from './setup.js';
import {Trackers} from './trackers.js';

/**
 * `npm run demo -- [set] [--resets <scene>]`: a hub on throwaway data, filled with the
 * catalogue (demo/catalogue.ts) through its public requests and kept alive: machines
 * measure, agents start, work and stop, one machine sleeps. The reset trackers are stood
 * in for, so nothing goes to the network. Ctrl+C stops it and leaves nothing behind.
 *
 * It runs the built hub (`npm run build` first), as `npm start` does, with the
 * developer's address settings (QUOTUM_PORT, QUOTUM_BIND, QUOTUM_ALLOWED_HOSTS,
 * QUOTUM_PUBLIC_URL, QUOTUM_TRUST_PROXY, QUOTUM_FRAME_ANCESTORS) and nothing else of theirs.
 */

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETUP_CODE = 'BCDF-GHJK';
const ADDRESS = ['QUOTUM_PORT', 'QUOTUM_BIND', 'QUOTUM_ALLOWED_HOSTS', 'QUOTUM_PUBLIC_URL', 'QUOTUM_TRUST_PROXY', 'QUOTUM_FRAME_ANCESTORS'];
/** How long the hub may take to answer after it starts, and to stop. */
const READY_MS = 10_000;
const STOP_MS = 5_000;
/** How long a signal may take to reach the demo after the hub, stopped by it too, went away. */
const SETTLE_MS = 1_000;
/** How often machines tell their lists of running agents, as agents do. */
const TICK = 15 * SECOND;

class Stop extends Error {}

const usage = () =>
  [
    'Usage: npm run demo -- [set] [--resets <scene>]',
    `  sets:   ${SETS.map(set => `${set.id} (${set.about})`).join(', ')}`,
    `  scenes: ${SCENES.map(scene => scene.id).join(', ')}`,
  ].join('\n');

export function parseArgs(argv: string[]): {set: DemoSet; scene: string} {
  let set: DemoSet | undefined;
  let scene: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--resets') {
      scene = argv[++i];
      if (!SCENES.some(s => s.id === scene)) throw new Stop(`Unknown reset scene "${scene ?? ''}".\n${usage()}`);
    } else if (!arg.startsWith('-') && !set) {
      set = SETS.find(s => s.id === arg);
      if (!set) throw new Stop(`Unknown set "${arg}".\n${usage()}`);
    } else throw new Stop(`Unknown argument "${arg}".\n${usage()}`);
  }
  set ??= SETS[0];
  return {set, scene: scene ?? set.scene};
}

/**
 * Where the demo reaches the hub, and the host names the hub must answer: the developer's
 * list (or the hub's default) and the one the demo uses.
 */
export function addressOf(env: NodeJS.ProcessEnv) {
  const port = Number(env.QUOTUM_PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Stop(`QUOTUM_PORT must be a port number from 1 to 65535, not "${env.QUOTUM_PORT}".`);
  const bind = env.QUOTUM_BIND || '127.0.0.1';
  const any = bind === '0.0.0.0' || bind === '::';
  const host = any ? '127.0.0.1' : bind.includes(':') ? `[${bind}]` : bind;
  const hosts = [...new Set([...(env.QUOTUM_ALLOWED_HOSTS || '127.0.0.1,localhost').split(',').map(h => h.trim()).filter(Boolean), host])];
  return {port, bind, host, base: `http://${host}:${port}`, hosts: hosts.join(',')};
}

/** Fails at once, with what to do, when something already listens where the hub would. */
async function portFree(bind: string, port: number) {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error: NodeJS.ErrnoException) =>
      reject(new Stop(error.code === 'EADDRINUSE' ? `Port ${port} is taken; set QUOTUM_PORT to a free one.` : `Cannot listen on ${bind}:${port}: ${error.message}`)),
    );
    probe.listen({host: bind, port}, () => probe.close(() => resolve()));
  });
}

/** The hub's own output, the last part of it, to show when it fails. */
class Output {
  private text = '';
  add(chunk: Buffer) {
    this.text = (this.text + chunk.toString()).slice(-16_000);
  }
  toString() {
    return this.text.trim() || '(nothing)';
  }
}

async function main() {
  const {set, scene} = parseArgs(process.argv.slice(2));
  for (const built of ['dist/server/index.js', 'dist/client/index.html']) {
    if (!existsSync(path.join(HUB, built))) throw new Stop(`The hub is not built (no ${built}): run npm run build first.`);
  }
  const address = addressOf(process.env);
  await portFree(address.bind, address.port);

  const start = Math.floor(Date.now() / MIN) * MIN;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'quotum-demo-'));
  const output = new Output();
  let hub: ChildProcess | undefined;
  let trackers: Trackers | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopping = false;

  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    // Whatever the demo was sending (the history, a tick) goes no further.
    haltRequests();
    if (hub && hub.exitCode === null && hub.signalCode === null) {
      const exited = new Promise(resolve => hub!.once('exit', resolve));
      hub.kill('SIGTERM');
      const late = setTimeout(() => hub!.kill('SIGKILL'), STOP_MS);
      await exited;
      clearTimeout(late);
    }
    await trackers?.close();
    rmSync(dir, {recursive: true, force: true, maxRetries: 5});
    process.exit(code);
  };
  // A terminal closed (SIGHUP) stops it as Ctrl+C does.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void stop(0));
  /**
   * Ctrl+C reaches the hub too, and a request can fail on its closing before the demo hears
   * of the signal: before calling a failed request a failure, give the signal and the hub's
   * exit a moment to arrive.
   */
  const settled = () =>
    new Promise<void>(resolve => {
      if (!hub || hub.exitCode !== null || hub.signalCode !== null) return resolve();
      const exited = () => {
        clearTimeout(wait);
        resolve();
      };
      const wait = setTimeout(() => {
        hub!.off('exit', exited);
        resolve();
      }, SETTLE_MS);
      hub.once('exit', exited);
    });

  try {
    trackers = await Trackers.start(SCENES, start);
    const urls = trackers.urls(scene);
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('QUOTUM_') || ADDRESS.includes(key)));
    Object.assign(env, {
      QUOTUM_DATA_DIR: dir,
      QUOTUM_SETUP_CODE: SETUP_CODE,
      QUOTUM_SIGNUP: 'invite',
      QUOTUM_RESETS: 'on',
      QUOTUM_RESETS_CODEX_URL: urls.codex,
      QUOTUM_RESETS_CLAUDE_URL: urls.claude,
      QUOTUM_ALLOWED_HOSTS: address.hosts,
    });
    hub = spawn(process.execPath, ['dist/server/index.js'], {cwd: HUB, env, stdio: ['ignore', 'pipe', 'pipe']});
    hub.stdout!.on('data', chunk => output.add(chunk));
    hub.stderr!.on('data', chunk => output.add(chunk));
    hub.on('exit', (code, signal) => {
      if (stopping) return;
      // Ctrl+C reaches the hub too, which may be done before the demo hears of it: a clean exit is a stop.
      if (code === 0) return void stop(0);
      console.error(`\nThe hub stopped by itself (${signal ? `killed by ${signal}` : `exit ${code}`}). Its output:\n${output}`);
      void stop(1);
    });

    await ready(hub, address.base, output);
    const stand = await setUp(address.base, set, start, SETUP_CODE, () => Date.now());
    await selfCheck(stand, trackers);

    const live = new Live(stand, card => liveStep(card), true);
    const tick = async () => {
      const t = Date.now() - start;
      try {
        await live.report(t, Date.now());
        await live.pace(t, Date.now());
        await live.measure(t, Date.now());
      } catch (error) {
        await settled();
        if (!stopping) console.error(`demo: ${(error as Error).message}`);
      }
      if (!stopping) timer = setTimeout(() => void tick(), TICK - ((Date.now() - start) % TICK));
    };
    await tick();
    if (!stopping) greet(stand, address, hub.pid!, scene, process.uptime());
  } catch (error) {
    if (!(error instanceof Stop)) await settled();
    if (stopping) return;
    console.error(error instanceof Stop ? error.message : `The demo could not start: ${(error as Error).stack ?? error}`);
    await stop(1);
  }
}

/** Waits until the hub answers as a new hub: this one, not another on the same port. */
async function ready(hub: ChildProcess, base: string, output: Output) {
  const until = Date.now() + READY_MS;
  let last = 'no answer';
  while (Date.now() < until) {
    if (hub.exitCode !== null || hub.signalCode !== null) throw new Stop(`The hub exited before it was ready. Its output:\n${output}`);
    if (await healthy(base)) {
      const first = await firstSignup(base);
      if (first === true) return;
      last = first === false ? 'it already has people: another hub answers there' : 'no answer from /api/session';
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Stop(`The hub did not get ready in ${READY_MS / 1000} s (${last}). Its output:\n${output}`);
}

/** The hub shows what was seeded: it asked the stand-in trackers, and its history begins at the earliest measurement. */
async function selfCheck(stand: Stand, trackers: Trackers) {
  for (let i = 0; i < 20 && !trackers.asked; i++) await new Promise(resolve => setTimeout(resolve, 100));
  if (!trackers.asked) throw new Stop(`The hub did not ask the stand-in reset trackers: dist is out of date, run npm run build.`);
  const first = people(stand.set)[0].id;
  const overview = await stand.people.get(first)!.get<{historyStart: number}>(`/api/overview?board=${encodeURIComponent(stand.boards.get(first)!)}`);
  const expected = stand.start + earliest(stand.set);
  if (overview.historyStart !== expected) {
    throw new Stop(
      `The hub's history starts at ${new Date(overview.historyStart).toISOString()}, not at the first seeded measurement (${new Date(expected).toISOString()}): dist is out of date, run npm run build.`,
    );
  }
}

/** Where to go and how to sign in; `took` is seconds since the command started. */
function greet(stand: Stand, address: ReturnType<typeof addressOf>, pid: number, scene: string, took: number) {
  const url = process.env.QUOTUM_PUBLIC_URL || address.base;
  const others = SETS.filter(s => s.id !== stand.set.id).map(s => s.id);
  console.log(
    [
      '',
      `Quotum demo is up in ${took.toFixed(1)} s: ${url}  (hub pid ${pid})`,
      '',
      `  set    ${stand.set.id}: ${stand.set.about}`,
      `  resets ${scene}`,
      '',
      `  Sign in as (password ${PASSWORD}):`,
      ...people(stand.set).map(p => `    ${emailOf(p.id).padEnd(20)} ${p.name}`),
      '',
      `  Other sets: ${others.join(', ')}; reset scenes: ${SCENES.map(s => s.id).join(', ')}`,
      `  npm run demo -- ${others[0] ?? stand.set.id} --resets <scene>`,
      '',
      '  Stop with Ctrl+C: the hub and its data go away.',
      '',
    ].join('\n'),
  );
}

/** Run as the command, not imported: by real paths, as a symlinked or junctioned checkout names them differently. */
const isMain = () => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  main().catch(error => {
    console.error(error instanceof Stop ? error.message : error);
    process.exit(error instanceof Stop ? 2 : 1);
  });
}
