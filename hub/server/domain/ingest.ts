import {providers, type Provider} from './sources.js';
import type {FreeResets, Kind, Measurement, Win} from './quota.js';

/**
 * Ingest format v1 (spec/ingest-v1.md): what an agent sends. Parsing is strict; a
 * batch that does not match is refused whole, so nothing half-understood is stored.
 */
export type AgentWindow = {
  id: string;
  kind: Kind;
  minutes: number | null;
  label: string | null;
  usedPercent: number;
  resetsAt: number | null;
};

export type AgentSnapshot = {
  provider: Provider;
  account: string | null;
  /** A name the owner gave a subscription whose client does not identify it. */
  accountName: string | null;
  plan: string | null;
  observedAt: number;
  via: string;
  client: string | null;
  staleAfterMs: number;
  windows: AgentWindow[];
  resets: FreeResets | null;
};

export type AgentFailure = {provider: Provider; observedAt: number; error: string; detail: string | null};

export type AgentBatch = {
  version: 1;
  agent: string;
  machine: {id: string; name: string; os: string; arch: string};
  sentAt: number;
  snapshots: AgentSnapshot[];
  failures: AgentFailure[];
};

export const AGENT_ERRORS = ['not_logged_in', 'unsupported', 'timeout', 'invalid_output', 'failed', 'not_installed'] as const;

const LIMITS = {items: 500, windows: 32, text: 120, staleAfterMs: 24 * 3_600_000};

/** A request that does not match the format; `what` names the first field that is wrong. */
export class Invalid extends Error {
  constructor(readonly what: string) {
    super(`invalid: ${what}`);
  }
}

/** Account pseudonyms: 24 lower-case hex characters (spec: Snapshot `account`). */
const PSEUDONYM = /^[0-9a-f]{24}$/;

function account(value: unknown): string | null {
  const given = text(value, 'account', true);
  if (given !== null && !PSEUDONYM.test(given)) throw new Invalid('account');
  return given;
}

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value);

/** Longer than `chars` characters, as the spec and the agent count them (a character may take two UTF-16 units). */
export const longerThan = (value: string, chars: number) => value.length > chars && (value.length > 2 * chars || Array.from(value).length > chars);
const tooLong = (value: string) => longerThan(value, LIMITS.text);

function text(value: unknown, what: string, optional = false): string | null {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || !value.length || tooLong(value)) throw new Invalid(what);
  return value;
}

/** Optional text that may run longer than the limit: cut to it, so one long value does not lose the rest of a request. */
function cut(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.length) throw new Invalid(what);
  // By characters, as the agent cuts, not by UTF-16 units, which could split one in two.
  return Array.from(value).slice(0, LIMITS.text).join('');
}

function time(value: unknown, what: string, optional = false): number | null {
  if (optional && (value === undefined || value === null)) return null;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) throw new Invalid(what);
  return parsed;
}

function provider(value: unknown): Provider {
  if (!providers.includes(value as Provider)) throw new Invalid('provider');
  return value as Provider;
}

function list(value: unknown, what: string, max: number): unknown[] {
  // An optional field may be left out or null (the spec); either way the list is empty.
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw new Invalid(what);
  return value;
}

function parseWindow(value: unknown): AgentWindow {
  if (!isObject(value)) throw new Invalid('window');
  const used = value.usedPercent;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) throw new Invalid('usedPercent');
  const kind = value.kind;
  if (kind !== 'session' && kind !== 'weekly' && kind !== 'other') throw new Invalid('kind');
  const minutes = value.minutes ?? null;
  if (minutes !== null && (!Number.isInteger(minutes) || (minutes as number) <= 0)) throw new Invalid('minutes');
  return {
    id: text(value.id, 'window id')!,
    kind,
    minutes: minutes as number | null,
    label: text(value.label, 'label', true),
    usedPercent: used,
    resetsAt: time(value.resetsAt, 'resetsAt', true),
  };
}

function parseResets(value: unknown): FreeResets | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || !Number.isInteger(value.available) || (value.available as number) < 0 || (value.available as number) > 1000) {
    throw new Invalid('resets');
  }
  const available = value.available as number;
  const expiring = list(value.expiring, 'resets expiring', 50).map(group => {
    if (!isObject(group) || !Number.isInteger(group.count) || (group.count as number) < 1) throw new Invalid('resets expiring');
    return {count: group.count as number, expiresAt: time(group.expiresAt, 'resets expiring expiresAt', true)};
  });
  if (expiring.reduce((sum, group) => sum + group.count, 0) > available) throw new Invalid('resets expiring');
  // Soonest first, one group per time, the one without a time last: the dashboard lists them as they come.
  expiring.forEach((group, i) => {
    const next = expiring[i + 1];
    if (next && (group.expiresAt === null || (next.expiresAt !== null && next.expiresAt <= group.expiresAt))) throw new Invalid('resets expiring');
  });
  return {available, expiring};
}

function parseSnapshot(value: unknown): AgentSnapshot {
  if (!isObject(value)) throw new Invalid('snapshot');
  const stale = value.staleAfterMs;
  if (!Number.isInteger(stale) || (stale as number) <= 0 || (stale as number) > LIMITS.staleAfterMs) throw new Invalid('staleAfterMs');
  const windows = list(value.windows, 'windows', LIMITS.windows).map(parseWindow);
  if (!windows.length) throw new Invalid('windows');
  return {
    provider: provider(value.provider),
    account: account(value.account),
    accountName: text(value.accountName, 'accountName', true),
    plan: text(value.plan, 'plan', true),
    observedAt: time(value.observedAt, 'observedAt')!,
    via: text(value.via, 'via')!,
    client: text(value.client, 'client', true),
    staleAfterMs: stale as number,
    windows,
    resets: parseResets(value.resets),
  };
}

function parseFailure(value: unknown): AgentFailure {
  if (!isObject(value)) throw new Invalid('failure');
  if (!(AGENT_ERRORS as readonly unknown[]).includes(value.error)) throw new Invalid('error');
  return {
    provider: provider(value.provider),
    observedAt: time(value.observedAt, 'observedAt')!,
    error: value.error as string,
    detail: typeof value.detail === 'string' ? value.detail.slice(0, 200) : null,
  };
}

/** Who is sending: the part every agent request shares. */
export type AgentSender = Pick<AgentBatch, 'agent' | 'machine'>;

/** The machine an agent runs on, as every agent request describes it. */
export function parseMachine(machine: unknown): AgentBatch['machine'] {
  if (!isObject(machine)) throw new Invalid('machine');
  return {
    id: text(machine.id, 'machine id')!,
    name: text(machine.name, 'machine name')!,
    os: text(machine.os, 'machine os')!,
    arch: text(machine.arch, 'machine arch')!,
  };
}

export const parseAgent = (value: unknown) => text(value, 'agent')!;

function parseSender(body: unknown): AgentSender {
  if (!isObject(body)) throw new Invalid('body');
  if (body.version !== 1) throw new Invalid('version');
  return {agent: parseAgent(body.agent), machine: parseMachine(body.machine)};
}

export function parseBatch(body: unknown): AgentBatch {
  const sender = parseSender(body);
  const input = body as Obj;
  return {
    version: 1,
    ...sender,
    sentAt: time(input.sentAt, 'sentAt')!,
    snapshots: list(input.snapshots, 'snapshots', LIMITS.items).map(parseSnapshot),
    failures: list(input.failures, 'failures', LIMITS.items).map(parseFailure),
  };
}

/**
 * A check-in: which subscriptions a device could measure now, and whether it is in use.
 * `paced`: the device follows the hub's pace; `minIntervalMs`: the most often it agrees
 * to measure a subscription.
 */
export type Checkin = AgentSender & {
  paced: boolean;
  subscriptions: {provider: Provider; account: string | null; accountName: string | null; active: boolean; minIntervalMs: number | null}[];
};

export function parseCheckin(body: unknown): Checkin {
  const sender = parseSender(body);
  const paced = (body as Obj).paced ?? false;
  if (typeof paced !== 'boolean') throw new Invalid('paced');
  const subscriptions = list((body as Obj).subscriptions, 'subscriptions', 16).map(value => {
    if (!isObject(value) || typeof (value.active ?? false) !== 'boolean') throw new Invalid('subscription');
    const least = value.minIntervalMs ?? null;
    if (least !== null && (!Number.isInteger(least) || (least as number) < 60_000 || (least as number) > 86_400_000)) throw new Invalid('minIntervalMs');
    return {
      provider: provider(value.provider),
      account: account(value.account),
      accountName: text(value.accountName, 'accountName', true),
      active: value.active === true,
      minIntervalMs: least as number | null,
    };
  });
  return {...sender, paced, subscriptions};
}

/**
 * Which subscription a snapshot belongs to. Clients that identify the account give
 * its pseudonym, the same whoever measures it; otherwise the subscription is the
 * device's person's own (optionally one of several, by the name they gave it), never
 * the machine's.
 */
export function subscriptionKey(snapshot: Pick<AgentSnapshot, 'account' | 'accountName' | 'provider'>, userId: string): string {
  if (snapshot.account) return snapshot.account;
  const name = snapshot.accountName ? `/${snapshot.accountName.trim().toLowerCase()}` : '';
  return `user:${userId}/${snapshot.provider}${name}`;
}

export function toMeasurement(snapshot: AgentSnapshot): Measurement {
  const windows: Win[] = snapshot.windows.map(w => ({
    id: w.id,
    kind: w.kind,
    label: w.label,
    used: w.usedPercent,
    remaining: 100 - w.usedPercent,
    resetAt: w.resetsAt,
    minutes: w.minutes,
  }));
  return {observedAt: snapshot.observedAt, plan: snapshot.plan ?? '', windows, staleAfterMs: snapshot.staleAfterMs, resets: snapshot.resets};
}

/** Where an agent's session runs (spec: Reporting running agents). */
export const ORIGINS = ['terminal', 'editor', 'app'] as const;
export type Origin = (typeof ORIGINS)[number];

export type AgentSession = {
  provider: Provider;
  account: string | null;
  accountName: string | null;
  origin: Origin;
  /** The project it works in, which its time counts under: its repository, else its folder. */
  project: string | null;
  /** Its folder, where that is not its project; an older agent sends none. */
  folder: string | null;
  startedAt: number;
  lastWorkedAt: number | null;
  working: boolean;
};

/** Every coding agent running on a machine right now. */
export type SessionReport = AgentSender & {sentAt: number; sessions: AgentSession[]};

export function parseSessions(body: unknown): SessionReport {
  const sender = parseSender(body);
  const input = body as Obj;
  const sessions = list(input.sessions, 'sessions', 200).map(value => {
    if (!isObject(value)) throw new Invalid('session');
    if (!(ORIGINS as readonly unknown[]).includes(value.origin)) throw new Invalid('origin');
    if (typeof value.working !== 'boolean') throw new Invalid('working');
    return {
      provider: provider(value.provider),
      account: account(value.account),
      accountName: text(value.accountName, 'accountName', true),
      origin: value.origin as Origin,
      project: cut(value.project, 'project'),
      folder: cut(value.folder, 'folder'),
      startedAt: time(value.startedAt, 'startedAt')!,
      lastWorkedAt: time(value.lastWorkedAt, 'lastWorkedAt', true),
      working: value.working,
    };
  });
  return {...sender, sentAt: time(input.sentAt, 'sentAt')!, sessions};
}
