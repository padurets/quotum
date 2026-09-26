import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/** A comma-separated environment list, or the default when unset. */
function list(value: string | undefined, fallback: string[]): string[] {
  const items = (value ?? '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  return items.length ? items : fallback;
}

/**
 * Which proxies to believe about the client's address and protocol: unset (or `false`,
 * `0`) for none, `true` for any, a number of hops, or addresses and CIDR ranges
 * (comma-separated).
 */
function trustProxy(value: string | undefined): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (!value || value === 'false' || value === '0') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return (_address, hop) => hop < Number(value);
  return list(value, []);
}

/** The hub's public address, checked at start: a typo here would break every sign-in later. */
function publicUrl(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`QUOTUM_PUBLIC_URL must be a full address like https://quotum.example.com, not "${value}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`QUOTUM_PUBLIC_URL must start with https:// or http://, not "${value}"`);
  return url.origin;
}

/** The desktop app's hub: one person who never signs in (docs/architecture.md, "Desktop app"). */
export type LocalMode = {
  /** Opens the board for the app's window (`/local?key=…`); new on every start. */
  key: string;
  /** The machine token of the app's agent; new on every start. */
  token: string;
};

/**
 * The local mode, from the environment the desktop app gives the hub: on when
 * `QUOTUM_LOCAL_KEY` is set, even to nothing, so an empty key never lets anyone in. It
 * refuses to start where the board would reach beyond this machine. Its errors name the
 * variable but never repeat its value: a key or token would end up in the log.
 */
export function localMode(env: Record<string, string | undefined>): LocalMode | null {
  const key = env.QUOTUM_LOCAL_KEY;
  if (key === undefined) return null;
  if (key.length < 32) throw new Error('QUOTUM_LOCAL_KEY must be at least 32 characters long');
  const token = env.QUOTUM_LOCAL_TOKEN;
  if (!token?.startsWith('qt_m_')) throw new Error('the local mode needs QUOTUM_LOCAL_TOKEN, a machine token (qt_m_…)');
  if (!['127.0.0.1', '::1', 'localhost'].includes(env.QUOTUM_BIND || '127.0.0.1')) throw new Error('the local mode listens on this machine only: QUOTUM_BIND must be 127.0.0.1, ::1 or localhost');
  if (list(env.QUOTUM_ALLOWED_HOSTS, []).includes('*')) throw new Error('the local mode answers its own host names only: QUOTUM_ALLOWED_HOSTS cannot be *');
  if (env.QUOTUM_PUBLIC_URL) throw new Error('the local mode has no public address: unset QUOTUM_PUBLIC_URL');
  if (env.QUOTUM_TRUST_PROXY) throw new Error('the local mode stands behind no proxy: unset QUOTUM_TRUST_PROXY');
  return {key, token};
}

/**
 * Where to read a reset tracker: its own API unless `variable` names another address
 * (a mirror, where the tracker's bot check stops the server). Checked at start; the value
 * is not repeated in the error, as it may carry a secret.
 */
export function trackerUrl(variable: string, value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} must be the full address of an endpoint, like https://mirror.example.com/api/v1/status`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${variable} must start with https:// or http://`);
  // Requests cannot carry them (fetch refuses such an address): the tracker would never be read.
  if (url.username || url.password) throw new Error(`${variable} must not contain a user name or password`);
  return url.href;
}

const here = path.dirname(fileURLToPath(import.meta.url));
/** The hub directory: two levels up from `dist/server` when built, one from `server` in source. */
export const appRoot = path.resolve(here, path.basename(path.dirname(here)) === 'dist' ? '../..' : '..');

/** Every tunable the deployment owns, in one place. */
export const config = {
  dataDir: process.env.QUOTUM_DATA_DIR || path.join(appRoot, 'data'),
  databaseFile: 'quotum.sqlite',
  clientRoot: path.join(appRoot, 'dist/client'),

  http: {
    host: process.env.QUOTUM_BIND || '127.0.0.1',
    port: Number(process.env.QUOTUM_PORT || 8080),
    /** The hub answers only to these host names (comma-separated), or to any with `*`; anything else is 403. */
    hosts: list(process.env.QUOTUM_ALLOWED_HOSTS, ['127.0.0.1', 'localhost']),
    /** Origins allowed to embed the dashboard in a frame, besides itself. */
    frameAncestors: list(process.env.QUOTUM_FRAME_ANCESTORS, []),
    trustProxy: trustProxy(process.env.QUOTUM_TRUST_PROXY),
    /**
     * How long a request may take to arrive, headers and body, so one that trickles in
     * does not hold a connection for ever. Above the 20 seconds after which the agent
     * gives up itself. Node checks it every `checkMs`. The headers get the same limit:
     * once they are in, Node holds a request to the longer of the two (the headers' is 60
     * seconds by default).
     */
    requestTimeoutMs: 30_000,
    checkMs: 5_000,
  },

  /** Set by the desktop app for the hub it carries; null for a hub on a server. */
  local: localMode(process.env),

  auth: {
    /** Who may sign up after the first person (who always may): `invite` (default) or `open`. */
    signup: process.env.QUOTUM_SIGNUP === 'open' ? ('open' as const) : ('invite' as const),
    sessionTtlMs: 30 * 86_400_000,
    inviteTtlMs: 7 * 86_400_000,
    /** Device codes: how long one is valid, and how often an agent may ask about it. */
    codeTtlMs: 10 * 60_000,
    codeIntervalS: 5,
    /** The address people open, for links shown to agents; derived from the request when unset. */
    publicUrl: publicUrl(process.env.QUOTUM_PUBLIC_URL),
    /** The code the first account needs while the hub has none; a random one is printed at start when unset. */
    setupCode: process.env.QUOTUM_SETUP_CODE || null,
  },

  /** Agents push measurements (spec/ingest-v1.md) with a device or machine token. */
  ingest: {
    bodyLimit: 1024 * 1024,
  },

  retention: {
    sampleDays: 90,
  },

  history: {
    /**
     * The periods the chart offers, each ending now. Every period, one of these or a time
     * range selected on the chart, is drawn on one shared time grid: every series gets a
     * value for the same cells, so a hover always reads all of them at once. Totals still
     * use every raw sample.
     */
    ranges: {
      '1h': 3_600_000,
      '3h': 3 * 3_600_000,
      '6h': 6 * 3_600_000,
      '12h': 12 * 3_600_000,
      '24h': 86_400_000,
      '3d': 3 * 86_400_000,
      '7d': 7 * 86_400_000,
      '14d': 14 * 86_400_000,
      '30d': 30 * 86_400_000,
    } as Record<string, number>,
    /**
     * A period gets the finest of these cells that keeps it within `maxCells` (5% over
     * allowed), whether it is one of the ranges or selected on the chart: a period moved
     * back in time keeps its grid. A selected period's edges go out to whole cells. Shorter
     * than `minSpanMs` it would show a handful of measurements.
     */
    cells: [1, 5, 15, 30, 60, 120, 360, 720].map(minutes => minutes * 60_000),
    maxCells: 360,
    minSpanMs: 15 * 60_000,
    /** As long as the longest range (dragged on it, a little longer). */
    maxSpanMs: 31 * 86_400_000,
    /** A history that takes this long to put together is reused a while after new data (see api.ts). */
    costlyMs: 50,
  },

  /**
   * Community reset trackers (see domain/resets.ts); credited wherever shown. `QUOTUM_RESETS=off`
   * turns them off; `QUOTUM_RESETS_CODEX_URL` and `QUOTUM_RESETS_CLAUDE_URL` read them elsewhere.
   */
  resets: {
    enabled: process.env.QUOTUM_RESETS !== 'off',
    codexApi: trackerUrl('QUOTUM_RESETS_CODEX_URL', process.env.QUOTUM_RESETS_CODEX_URL, 'https://codex-resets.com/api/v1/status'),
    claudeApi: trackerUrl('QUOTUM_RESETS_CLAUDE_URL', process.env.QUOTUM_RESETS_CLAUDE_URL, 'https://claude-resets.com/api/resets'),
    intervalMs: 10 * 60_000,
    timeoutMs: 10_000,
  },
} as const;

export const version: string = JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
export const serviceName = 'Quotum';
