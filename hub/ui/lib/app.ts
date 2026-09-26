import {useCallback, useEffect, useRef, useState} from 'react';
import type {Key} from '../i18n';
import {unlessSame} from './http';

/**
 * The desktop app, when the board is shown in its window (the hub's local mode): what it
 * says about itself and what it can be asked, through its narrow `invoke` bridge. In a browser there
 * is no bridge, and nothing that needs one is shown. The shapes follow desktop/src/ipc.rs.
 */

export type ProviderId = 'claude' | 'codex' | 'antigravity';
export type Holder = {pid?: number; hub?: string; yields: boolean};
export type Cause = 'config' | 'lock' | 'panic';
export type AgentState =
  | {state: 'starting' | 'taking_over' | 'measuring' | 'idle'}
  | {state: 'held'; holder: Holder; error?: string}
  | {state: 'failed'; cause: Cause; error: string};
export type Measured = {at: number; ok: boolean; error?: string; detail?: string};
/** Where an interval is set: for the provider alone, for all in the file, or by `QUOTUM_INTERVAL`. */
export type IntervalFrom = 'provider' | 'file' | 'env';
/**
 * `intervalS`: the most often the provider is measured, as the hub paces it; null when
 * nothing is set, and the hub measures as often as needed. `inheritedS`: the one set for
 * all clients, even when the provider has its own.
 */
export type ProviderSettings = {
  id: ProviderId;
  enabled: boolean;
  intervalS: number | null;
  intervalFrom: IntervalFrom | null;
  inheritedS: number | null;
  inheritedFrom: Exclude<IntervalFrom, 'provider'> | null;
  account?: string;
  client?: string;
  last?: Measured;
};
export type AppState = {
  agent: AgentState;
  providers: ProviderSettings[];
  sessions: boolean;
  autostart: boolean;
  configPath: string;
  logPath: string;
  version: string;
  commit: string;
};
/** `intervalS: null` takes the provider's own interval out of the file. */
export type Patch = {providers?: Partial<Record<ProviderId, {enabled?: boolean; intervalS?: number | null; account?: string}>>; sessions?: boolean};

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const bridge = (): Invoke | null => {
  const host = globalThis as {__QUOTUM__?: {invoke?: Invoke}; __TAURI__?: {core?: {invoke?: Invoke}}};
  return host.__QUOTUM__?.invoke ?? host.__TAURI__?.core?.invoke ?? null;
};

/** Whether the board is in the app's window. */
export const inApp = () => bridge() !== null;

/** The app's error is English text for people; the page puts a title of its own above it. */
async function ask<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = bridge();
  if (!invoke) throw new Error('not in the app');
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new Error(typeof error === 'string' ? error : String(error));
  }
}

/** Windows dispatches commands concurrently. Finish each mutation before invoking the
 * next, so their accepted snapshots reach the page in the person's action order. */
let mutations: Promise<void> = Promise.resolve();
function change(command: string, args?: Record<string, unknown>): Promise<AppState> {
  const accepted = mutations.then(() => ask<AppState>(command, args));
  // A rejected command still lets the next action proceed.
  mutations = accepted.then(() => {}, () => {});
  return accepted;
}

export const app = {
  state: () => ask<AppState>('app_state'),
  saveSettings: (patch: Patch) => change('save_settings', {patch}),
  takeOver: () => change('take_over'),
  setAutostart: (on: boolean) => change('set_autostart', {on}),
  /** Leads the window to the board again, with the key of the hub's current start. */
  reenter: () => ask<void>('reenter'),
  quit: () => ask<void>('quit'),
};

/**
 * The app's state, read when the board opens, after each action (`set`) and every ten
 * seconds, as the overview is. Null in a browser.
 */
export function useAppState() {
  const [state, setState] = useState<AppState | null>(null);
  const revision = useRef(0);
  const set = useCallback((next: AppState) => {
    // An older poll must not undo a command the app has already acknowledged.
    revision.current++;
    setState(unlessSame<AppState | null>(next));
  }, []);
  const refresh = useCallback(() => {
    const reading = ++revision.current;
    if (inApp()) app.state().then(next => {
      if (reading === revision.current) setState(unlessSame<AppState | null>(next));
    }, () => {});
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => {
      revision.current++;
      clearInterval(timer);
    };
  }, [refresh]);
  return {state, refresh, set};
}

/** Minutes between two measurements a provider can be set to; a value set by hand in the file shows as it is. */
export const INTERVALS = [1, 2, 5, 10, 15, 30, 60];

export function intervalChoices(currentS: number | null): number[] {
  if (currentS === null) return INTERVALS;
  const minutes = currentS / 60;
  return INTERVALS.includes(minutes) ? INTERVALS : [...INTERVALS, minutes].sort((a, b) => a - b);
}

/**
 * The choice of how often a provider is measured. First comes what taking its own
 * interval out gives: `auto` (the hub measures as often as needed), or `inherited` when
 * an interval is set for all clients; that one only the file or the environment changes,
 * so while the provider follows it, the first choice is not there to take. Then the
 * minutes, each the most often it is measured.
 */
export type IntervalMenu = {
  first: 'auto' | 'inherited';
  firstAvailable: boolean;
  selected: 'first' | number;
  choices: number[];
  hint: {key: Key; vars?: Record<string, string>} | null;
};

export function intervalMenu(p: Pick<ProviderSettings, 'intervalS' | 'intervalFrom' | 'inheritedS' | 'inheritedFrom'>): IntervalMenu {
  const choices = intervalChoices(p.intervalS);
  if (p.intervalS === null) return {first: 'auto', firstAvailable: true, selected: 'first', choices, hint: {key: 'measure.autoHint'}};
  if (p.intervalFrom !== 'provider') {
    const hint: IntervalMenu['hint'] = p.intervalFrom === 'env' ? {key: 'measure.setByEnv', vars: {key: 'QUOTUM_INTERVAL'}} : {key: 'measure.setInFile', vars: {file: 'config.toml'}};
    return {first: 'auto', firstAvailable: false, selected: p.intervalS / 60, choices, hint};
  }
  if (p.inheritedS !== null) return {first: 'inherited', firstAvailable: true, selected: p.intervalS / 60, choices, hint: null};
  return {first: 'auto', firstAvailable: true, selected: p.intervalS / 60, choices, hint: {key: 'measure.autoHint'}};
}

/** What the question about taking over says of who holds the machine, where it delivers and what becomes of it. */
export function takeOverText(holder: Holder): {who: Key; hub: Key | null; after: Key} {
  const who: Key = holder.pid ? 'takeover.holderPid' : 'takeover.holder';
  // A holder that makes way wrote run.info, which names its hub or says it has none.
  const hub: Key | null = holder.yields ? (holder.hub ? 'takeover.hubKnown' : null) : holder.hub ? 'takeover.hubMaybe' : 'takeover.hubUnknown';
  return {who, hub, after: holder.yields ? 'takeover.yields' : 'takeover.stops'};
}

/** The question stays on screen, with no way to close it, whenever `quotum` holds the machine. */
export const asksToTakeOver = (agent: AgentState | undefined): agent is Extract<AgentState, {state: 'held'}> => agent?.state === 'held';

export const takeOverTitle = (agent: Extract<AgentState, {state: 'held'}>): Key => (agent.error ? 'takeover.failedTitle' : 'takeover.title');

/** What an empty board says in the app: the first numbers come soon, or nothing is measured. */
export function onboardingText(agent: AgentState | undefined): Key {
  switch (agent?.state) {
    case undefined:
    case 'starting':
    case 'measuring':
      return 'local.onboardingMeasuring';
    case 'idle':
      return 'local.onboardingIdle';
    default:
      // Held, taking over or failed: the question or the banner above says what is going on.
      return 'local.onboardingWaiting';
  }
}

export const failedTitle = (cause: Cause): Key => (cause === 'config' ? 'failed.config' : cause === 'lock' ? 'failed.lock' : 'failed.panic');

/** Which sections the settings panel has: the app's two only in its window; an account only on a server. */
export function settingsSections(local: boolean, bridged: boolean): ('measuring' | 'app' | 'account' | 'browser')[] {
  if (!local) return ['account', 'browser'];
  return bridged ? ['measuring', 'app', 'browser'] : ['browser'];
}
