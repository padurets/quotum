import {chmodSync, mkdirSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import path from 'node:path';
import {config} from './config.js';
import {Store} from './store/store.js';
import {ResetFeed} from './resets.js';
import {buildApp} from './api.js';
import {Ingest} from './ingest.js';
import {Duty} from './duty.js';
import {Cadence} from './cadence.js';
import {Pairing} from './pairing.js';
import {Directory} from './store/directory.js';
import {Setup} from './setup.js';
import {bootstrapLocal} from './local.js';

/** One line of JSON on stdout about the hub itself: the desktop app reads these. */
const say = (event: object) => console.log(JSON.stringify(event));

/** Says it and exits once the line is out: on a pipe it could be lost to an exit right away. */
function sayAndExit(event: object, code: number): Promise<never> {
  return new Promise(() => {
    process.stdout.write(`${JSON.stringify(event)}\n`, () => process.exit(code));
    setTimeout(() => process.exit(code), 5000);
  });
}

const local = config.local;

// The database and its WAL files are readable by this user only.
process.umask(0o077);
mkdirSync(config.dataDir, {recursive: true, mode: 0o700});
const databaseFile = path.join(config.dataDir, config.databaseFile);
const store = new Store(databaseFile);
chmodSync(databaseFile, 0o600);
const directory = new Directory(store.db);

if (local) bootstrapLocal(directory, local.token, Date.now());
const resets = new ResetFeed((provider, reset) => store.announce(provider, reset));
const setup = new Setup(!local && directory.userCount() === 0, config.auth.setupCode);
const ingest = new Ingest(store, directory, new Duty(), new Cadence());
const app = await buildApp({store, directory, resets, ingest, pairing: new Pairing(directory), setup, local: local && {key: local.key}});

let closing = false;
let pruning: ReturnType<typeof setInterval> | undefined;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(pruning);
  resets.stop();
  await app.close();
  store.close();
  process.exit(0);
}

if (local) {
  /**
   * The desktop app's hub lives as long as the app: the app holds its stdin open and never
   * writes to it, so its end (the app quit or crashed, on any system) stops the hub. So does
   * a signal. It says so first (the app then treats this start as over), and exits within
   * two seconds even when a request hangs: a hub that stopped listening must not linger.
   */
  let stopping = false;
  const stop = (reason: 'stdin' | 'signal') => {
    if (stopping) return;
    stopping = true;
    say({event: 'stop', reason});
    setTimeout(() => process.exit(0), 2000).unref();
    void shutdown();
  };
  // Without resume() a pipe reports neither its end nor its closing.
  process.stdin.on('end', () => stop('stdin')).on('error', () => stop('stdin'));
  process.stdin.resume();
  process.on('SIGTERM', () => stop('signal'));
  process.on('SIGINT', () => stop('signal'));
} else {
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

try {
  await app.listen({host: config.http.host, port: config.http.port});
} catch (error) {
  // Taken, or not allowed (on Windows, Hyper-V, WSL and Docker reserve ranges of ports): the app picks another.
  if (['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL'].includes((error as NodeJS.ErrnoException).code ?? '')) {
    await sayAndExit({event: 'error', code: 'port_in_use'}, 1);
  }
  throw error;
}
// The port it listens on, also when it was given port 0.
const port = (app.server.address() as AddressInfo).port;
say({event: 'start', users: directory.userCount(), port, ...(local ? {local: true} : {})});
if (setup.pending) {
  const where = config.auth.publicUrl ? `Open ${config.auth.publicUrl}` : `Open the hub in a browser (it listens on port ${port})`;
  console.log(`\nQuotum has no account yet. ${where} and create the first one with the setup code ${setup.pending}\n`);
}
resets.start();

const prune = () => {
  const now = Date.now();
  store.prune(now);
  directory.prune(now);
  ingest.live.sweep(now);
};
prune();
pruning = setInterval(prune, 3_600_000);
