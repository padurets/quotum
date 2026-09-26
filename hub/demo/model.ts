import {createHash} from 'node:crypto';
import {sourceId, type Provider} from '../server/domain/sources.js';
import {subscriptionKey} from '../server/domain/ingest.js';
import type {Cadence, Level, ResetLine} from '../ui/lib/quota.js';
import type {CadenceWhy} from '../ui/lib/types.js';
import type {Outlook, Spent} from '../ui/lib/forecast.js';
import type {ResetLabel} from '../ui/lib/resets.js';
import {DEFAULT_PLAN, weeklyPlanRemaining, type WeeklyPlan} from '../ui/lib/plan.js';

/**
 * What the demo board is made of, as functions of time. Every time here is in
 * milliseconds from `start`, the moment the demo started rounded down to a minute, so the
 * same catalogue gives the same board whenever it runs: nothing reads the clock or draws
 * a random number.
 */

export const SECOND = 1000;
export const MIN = 60 * SECOND;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

/** How long an expectation holds by default: every state the catalogue claims lasts this long from `start`. */
export const HOLDS = 12 * HOUR;

// ---------- windows ----------

/** A window as a client reports it at one moment, its reset time from `start`. */
export type Window = {id: string; kind: 'session' | 'weekly' | 'other'; minutes: number | null; label: string | null; used: number; resetsAt: number | null};

/** A window over time: what the client reports about it at `t`. */
export type WindowAt = (t: number) => Window;

/** Providers report shares with at most a decimal; the demo does too, within 0–100. */
const share = (value: number) => Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;

const mod = (value: number, by: number) => ((value % by) + by) % by;

/** Of a weekly window at `t`: which cycle (0 the one running at `start`), when it began, and when it was to reset. */
function cycleOf(t: number, since: number, early: number | undefined): {n: number; begin: number; reset: number} {
  if (t >= since) {
    const n = Math.floor((t - since) / WEEK);
    return {n, begin: since + n * WEEK, reset: since + (n + 1) * WEEK};
  }
  // The cycle before the current one was due to reset at `early` and was cut short at `since`.
  const due = early ?? since;
  if (t >= due - WEEK) return {n: -1, begin: due - WEEK, reset: due};
  const back = Math.ceil((due - WEEK - t) / WEEK);
  return {n: -1 - back, begin: due - WEEK - back * WEEK, reset: due - back * WEEK};
}

/** Another week, before `start` or long after it: spent evenly, to a little more or less of the limit each time. */
const anotherWeek = (elapsed: number, n: number) => ((60 + 8 * mod(n, 4)) * elapsed) / WEEK;

/**
 * A weekly window whose current cycle began at `since` (before `start`), so it resets a
 * week after. With `early`, the cycle before was due to reset then but came back at
 * `since`: an early reset (a free one used, or one for everyone). `use` gives the used
 * share `elapsed` into the current cycle, `before` into cycle `n` of the others (-1 the
 * one before…).
 */
export function weekly(options: {
  id?: string;
  label?: string;
  since: number;
  early?: number;
  use: (elapsed: number) => number;
  before?: (elapsed: number, n: number) => number;
}): WindowAt {
  const {id = 'weekly', label = null, since, early, use, before = anotherWeek} = options;
  return t => {
    const cycle = cycleOf(t, since, early);
    const elapsed = t - cycle.begin;
    return {id, kind: 'weekly', minutes: 7 * 24 * 60, label, used: share(cycle.n === 0 ? use(elapsed) : before(elapsed, cycle.n)), resetsAt: cycle.reset};
  };
}

/** The share of a week the plan expects spent `elapsed` into it, moved by `offset` points (ahead of the plan when positive). */
export const alongPlan =
  (offset: number, plan: WeeklyPlan = DEFAULT_PLAN) =>
  (elapsed: number) =>
    100 - weeklyPlanRemaining(elapsed, plan) + offset;

/**
 * A share through `points`, each `[days into the cycle, used]`, straight in between and
 * going on as the last stretch does. Straight around `start`, a day before it and a day
 * after spend alike, and what the table foresees from the whole cycle changes slowly.
 */
export const through =
  (...points: [number, number][]) =>
  (elapsed: number) => {
    const days = elapsed / DAY;
    const next = points.findIndex(([at]) => at > days);
    const i = next < 0 ? points.length - 1 : Math.max(1, next);
    const [[a, u], [b, v]] = [points[i - 1], points[i]];
    return u + ((v - u) * (days - a)) / (b - a);
  };

/** A share growing evenly from `from` by `perDay` points a day. */
export const steady =
  (from: number, perDay: number) =>
  (elapsed: number) =>
    from + (perDay * elapsed) / DAY;

/** How much work was done on a subscription from `from` to `to`: in ms of time fully at work. */
export type Work = (from: number, to: number) => number;

/**
 * A rolling window of `minutes` (five hours by default) that runs back to back from
 * `offset`: it starts again as soon as the last one ends. `use` gives the share `elapsed`
 * into it, from the work done in it so far (`busy`, ms).
 */
export function rolling(options: {id?: string; label?: string; minutes?: number; offset?: number; kind?: 'session' | 'other'; use: (elapsed: number, busy: number) => number; work?: Work}): WindowAt {
  const {id = 'session', label = null, minutes = 300, offset = 0, kind = 'session', use, work = waveWork(ALWAYS)} = options;
  const length = minutes * MIN;
  return t => {
    const begin = offset + Math.floor((t - offset) / length) * length;
    return {id, kind, minutes, label, used: share(use(t - begin, work(begin, t))), resetsAt: begin + length};
  };
}

/** A window as its client reports it, only without a reset time: it does not know one. */
export const noReset =
  (window: WindowAt): WindowAt =>
  t => ({...window(t), resetsAt: null});

/** A rolling window nobody used lately: its reset is always its length from the measurement, and its start never comes. */
export const idle =
  (options: {id?: string; label?: string; minutes?: number} = {}): WindowAt =>
  t => ({id: options.id ?? 'session', kind: 'session', minutes: options.minutes ?? 300, label: options.label ?? null, used: 0, resetsAt: t + (options.minutes ?? 300) * MIN});

/** A window the client names without a length or a reset time (a pool of credits). */
export const fixed =
  (options: {id: string; label: string; used: number}): WindowAt =>
  () => ({id: options.id, kind: 'other', minutes: null, label: options.label, used: share(options.used), resetsAt: null});

// ---------- waves: when agents work ----------

/** Work that comes and goes: on for `on` ms of every `period`, from `phase`. */
export type Wave = {period: number; on: number; phase: number};

export const ALWAYS: Wave = {period: HOUR, on: HOUR, phase: 0};

export const isOn = (wave: Wave, t: number) => mod(t - wave.phase, wave.period) < wave.on;

/** The last millisecond a wave was on, including in the cycle before the demo starts. */
export function lastOn(wave: Wave, t: number): number | null {
  if (wave.on <= 0) return null;
  if (isOn(wave, t)) return t;
  return t - mod(t - wave.phase, wave.period) + wave.on - 1;
}

/** Work that follows a wave: someone working on and off, for a subscription without agents of its own. */
export const waveWork =
  (wave: Wave): Work =>
  (from, to) =>
    busyIn(wave, from, to);

/**
 * The work of a card's agents: while more of them work, its limits go faster. Averaged
 * over them, so a window spends at most its full pace when all of them work. Before the
 * first of them started the card was worked on as `before` goes: its history is spent
 * as its weeks are.
 */
export const agentsWork =
  (agents: Agent[], before: Wave): Work =>
  (from, to) => {
    const first = Math.min(...agents.map(agent => agent.since));
    const earlier = from < first ? busyIn(before, from, Math.min(to, first)) : 0;
    const theirs = agents.reduce((sum, agent) => {
      const [a, b] = [Math.max(from, agent.since), Math.min(to, agent.until ?? Infinity)];
      return sum + (agent.works && b > a ? busyIn(agent.works, a, b) : 0);
    }, 0);
    return earlier + theirs / Math.max(1, agents.length);
  };

/** How long a wave is on from `from` to `to`. */
export function busyIn(wave: Wave, from: number, to: number): number {
  const upTo = (t: number) => {
    const shifted = t - wave.phase;
    return Math.floor(shifted / wave.period) * wave.on + Math.min(wave.on, mod(shifted, wave.period));
  };
  return Math.max(0, upTo(to) - upTo(from));
}

// ---------- the catalogue's entries ----------

export type Origin = 'terminal' | 'editor' | 'app';

/**
 * A coding agent on a card: where it runs, in which project and, where that is not the
 * project (a worktree, a folder inside it), in which folder, from `since` (before `start`
 * when it already ran then) until `until`, and when it works. Without a wave it waits.
 */
export type Agent = {machine: string; origin: Origin; project: string | null; folder?: string; since: number; until?: number; works?: Wave};

/** How a card looks on one board: its name, colour, width, whether it or some of its windows are hidden, its plan. */
export type CardView = {name?: string; color?: string; span?: number; hidden?: boolean; windows?: string[]; plan?: WeeklyPlan | 'off'};

/** A time within which an expectation holds, from `start`: [from, to], by default the first twelve hours. */
export type Span = {from?: number; to?: number};

/**
 * What an entry shows, as codes the rules of the dashboard (hub/ui/lib) compute from what
 * the hub answers; the catalogue test checks each over its span. A card's codes are read
 * on `board` (by default the personal board of the person whose machine measures it
 * first).
 */
export type CardCheck = Span & {board?: string} & (
    | {error: string | null}
    | {stale: boolean}
    | {title: string}
    /** The dot by the logo: pulsing (just measured) or faded to grey. */
    | {fresh: 'pulse' | 'grey' | 'warn'}
    /** How many agents the tray counts, and whether it draws a mark for each. */
    | {agents: number; drawn: boolean}
    | {window: string; level?: Level; note?: 'ahead' | 'behind' | null; hint?: 'weekly' | 'reset'; name?: string; reset?: ResetLine['key']; hidden?: boolean; started?: boolean}
    /** A line of the table: what it spent over the last 24 hours, where the window's own pace leads (`tone` for `runsOut`), and how far from the plan, when notable. */
    | {forecast: string; outlook?: Outlook['key']; tone?: 'v-warn' | 'v-crit'; spent?: Spent['key']; plan?: 'ahead' | 'behind' | 'even' | 'none'}
    /** Something the chart marks on the card's source within the last 24 hours. */
    | {event: 'early_reset' | 'resets_granted'}
    /** What the dot's tooltip says of the next measurement, while the card is measured at the hub's pace, and why. */
    | {cadence: Cadence['when'] | null; why?: CadenceWhy}
    /** How many whole days back ‹ takes the chart from 30 days, step by step, on the card's board: where the history starts. */
    | {reachesBack: number}
  );

/**
 * A group in «My machines» → «Projects»: its name (null: no project), its machines by the name
 * shown, in the order the hub lists them, and the reported names it gathers besides its own, as
 * the tab lists them (ui/lib shown()); or that there is no such group.
 */
export type ProjectCheck = Span & ({project: string | null; machines?: string[]; reported?: string[]} | {project: string; absent: true});

export type BoardCheck = Span &
  (
    | {state: 'onboarding' | 'widgets' | 'allHidden'}
    /** The table of running agents: how many rows, or why it is empty. */
    | {rows: number | 'none' | 'noneShown'}
    /** Machines of the first rows after activity ordering. */
    | {firstMachines: string[]}
    /** Weekly series on the chart over the last 24 hours, at least. */
    | {weeklySeries: number}
    /**
     * Rows of the table of running agents under the project `agentsOf` (as the person named
     * it): the folders shown under it, by name, none where the folder is the project.
     */
    | {agentsOf: string; folders: (string | null)[]}
  );

export type SceneCheck = Span &
  (
    | {reset: 'claude' | 'codex'; label: ResetLabel['key'] | null; chance?: number | null; scope?: string}
    | {tracker: 'Codex Resets' | 'Claude Resets'; health: string}
    /** The chart over `range` (24 hours by default) marks `resets` resets for everyone of this provider, each once. */
    | {marked: 'claude' | 'codex'; resets: number; range?: '24h' | '7d'}
  );

/** A machine as the dialog «My machines» shows it. */
export type MachineCheck = Span & ({os: string} | {name: string} | {via: 'code' | 'token'} | {failure: {provider: Provider; error: string}});

/** What an agent reports when it cannot measure (spec: Failure). */
export type AgentError = 'not_logged_in' | 'unsupported' | 'timeout' | 'invalid_output' | 'failed' | 'not_installed';

/** A subscription and how it looks: its client's windows over time, who measures it, its agents and where it is shown. */
export type Card = {
  kind: 'card';
  id: string;
  provider: Provider;
  /** How the client names its account: by a pseudonym (the default for Claude and Codex), by a name the owner gave, or not at all (Antigravity). */
  account?: 'pseudonym' | {name: string} | null;
  plan: string | null;
  /** Machines by name; the first sends the history, the others join at `start`. */
  machines: string[];
  /** How far back the first machine's history goes. */
  history: number;
  /** Measured every quarter of an hour, as an agent does a subscription nobody uses (eco mode). */
  eco?: boolean;
  /**
   * Measured live at the hub's pace, its one machine asking every 15 seconds (spec:
   * Following the hub's pace); its dot then says when the next measurement comes.
   */
  paced?: boolean;
  windows: WindowAt[];
  /** Free resets at `t`: how many, and how many expire when (left out when not given). */
  resets?: (t: number) => {available: number; expiring?: {count: number; expiresAt: number | null}[]};
  /** Its machines stop delivering it then. */
  until?: number;
  /** What its first machine reports from `from` on instead. */
  failure?: {error: AgentError; from: number};
  agents?: Agent[];
  /** Its looks by board: a person's id for their personal board; naming a shared board shares the card there. */
  on?: Record<string, CardView>;
  expect: CardCheck[];
  /** What only eyes can check, for the check by hand. */
  look?: string[];
};

export type Machine = {
  kind: 'machine';
  /** The name the machine reports; cards and agents refer to it. */
  id: string;
  /** Whose it is: the set's first person by default. */
  person?: string;
  os?: 'linux' | 'macos' | 'windows';
  /** Asleep at night in the history, then from the second minute for twelve, and so on. */
  sleeps?: boolean;
  /** It stopped then and never comes back. */
  gone?: number;
  /** Connected with a one-time code rather than its person's machine token. */
  byCode?: boolean;
  /** The name its person gave it on the hub. */
  renamed?: string;
  /** Failures of clients it never measured anything with: they show only in «My machines». */
  failures?: {provider: Provider; error: AgentError}[];
  expect: MachineCheck[];
  look?: string[];
};

/**
 * Someone on the hub; their codes are read on their personal board, where `agents` turns the
 * table of running agents on, and in «My machines». `projects` are the names they give the
 * projects their machines report, before any agent reports one (reported → shown).
 */
export type Person = {kind: 'person'; id: string; name: string; agents?: boolean; agentsSpan?: number; projects?: Record<string, string>; expect: (BoardCheck | ProjectCheck)[]; look?: string[]};

export type Board = {
  kind: 'board';
  id: string;
  name: string;
  owner: string;
  members: string[];
  /** The table of running agents is turned on. */
  agents?: boolean;
  agentsSpan?: number;
  expect: BoardCheck[];
  look?: string[];
};

/** What a tracker answers: a payload, or a way to fail. */
export type Answer = {json: unknown} | {status: number} | 'challenge' | 'format' | 'network' | 'timeout';

/**
 * How the two reset trackers answer during a run. Their times are from `start` (`at` turns
 * one into the trackers' form), so asking again tells the same.
 */
export type Scene = {kind: 'scene'; id: string; codex: (at: (t: number) => string) => Answer; claude: (at: (t: number) => string) => Answer; expect: SceneCheck[]; look?: string[]};

export type Entry = Card | Machine | Person | Board | Scene;

/** A board to open: its people, cards, machines and boards, and the reset scene it starts with. */
export type DemoSet = {id: string; about: string; scene: string; entries: Entry[]};

// ---------- what machines send ----------

/** A pseudonym of an account, the same for an entry every run (spec: Snapshot `account`). */
export const pseudonym = (id: string) => createHash('sha256').update(`quotum-demo:${id}`).digest('hex').slice(0, 24);

/** How long an agent says a measurement holds, from the time to the next one (agent/crates/core/src/schedule.rs). */
export const staleAfter = (next: number) => next + next / 5 + MIN;

/** How often a card is measured live: every minute, or every quarter of an hour in eco mode. */
export const liveStep = (card: Card) => (card.eco ? 15 * MIN : MIN);

export const machineOf = (set: DemoSet, name: string): Machine =>
  (set.entries.find(e => e.kind === 'machine' && e.id === name) as Machine | undefined) ?? {kind: 'machine', id: name, expect: []};

export const people = (set: DemoSet) => set.entries.filter((e): e is Person => e.kind === 'person');
export const cards = (set: DemoSet) => set.entries.filter((e): e is Card => e.kind === 'card');
export const boards = (set: DemoSet) => set.entries.filter((e): e is Board => e.kind === 'board');

/** Every machine the set names: those with an entry and those cards and agents only refer to, in the order they come. */
export function machines(set: DemoSet): Machine[] {
  const names: string[] = [];
  for (const entry of set.entries) {
    if (entry.kind === 'machine') names.push(entry.id);
    if (entry.kind === 'card') names.push(...entry.machines, ...(entry.agents ?? []).map(a => a.machine));
  }
  return [...new Set(names)].map(name => machineOf(set, name));
}

export const personOf = (set: DemoSet, machine: Machine) => machine.person ?? people(set)[0].id;

/** The people whose machines measure a card: it shows on each one's personal board. */
export const holdersOf = (set: DemoSet, card: Card) => [...new Set(card.machines.map(name => personOf(set, machineOf(set, name))))];

/** The board a card's codes are read on by default: the personal board of whoever measures it first. */
export const homeOf = (set: DemoSet, card: Card) => personOf(set, machineOf(set, card.machines[0]));

/** A sleeping machine's schedule: asleep 8 hours every night before `start`; from the second minute on, 12 of every 45 minutes. */
const NIGHT = {from: 14 * HOUR, to: 6 * HOUR};
const SLEEP = {first: 2 * MIN, asleep: 12 * MIN, cycle: 45 * MIN};

export function awake(machine: Machine, t: number): boolean {
  if (machine.gone !== undefined && t > machine.gone) return false;
  if (!machine.sleeps) return true;
  if (t < 0) {
    // Nights end 6 hours before `start`, the same time every day.
    const sinceMidnight = mod(-t, DAY);
    return !(sinceMidnight > NIGHT.to && sinceMidnight <= NIGHT.from);
  }
  return t < SLEEP.first || mod(t - SLEEP.first, SLEEP.cycle) >= SLEEP.asleep;
}

/** Whether a card is measured at `t` by its machines at all. */
export const delivered = (card: Card, t: number) => card.until === undefined || t <= card.until;

/** The times the first machine measured a card before `start`: every 15 minutes, the last day every 5 (unless in eco mode). */
export function historyTimes(set: DemoSet, card: Card): {t: number; step: number}[] {
  const machine = machineOf(set, card.machines[0]);
  const times: {t: number; step: number}[] = [];
  const first = -card.history;
  for (let t = first; t < 0; ) {
    const step = t < -DAY || card.eco ? 15 * MIN : 5 * MIN;
    if (delivered(card, t) && awake(machine, t)) times.push({t, step});
    // Aligned to the step, so every card's history lies on the same grid.
    t = Math.floor(t / step) * step + step;
  }
  return times;
}

/** The earliest measurement a set seeds: where the chart's history begins. */
export const earliest = (set: DemoSet) => Math.min(...cards(set).flatMap(card => historyTimes(set, card).slice(0, 1).map(s => s.t)));

const iso = (start: number, t: number) => new Date(start + t).toISOString();

/** How the snapshot names the account, as its client would. */
function accountOf(card: Card): {account?: string; accountName?: string} {
  const account = card.account === undefined ? (card.provider === 'antigravity' ? null : 'pseudonym') : card.account;
  if (account === 'pseudonym') return {account: pseudonym(card.id)};
  return account ? {accountName: account.name} : {};
}

/** The id of a card's source on the hub, given the person whose machine measures it first: as the hub files it. */
export function sourceOf(card: Card, userId: string): string {
  const {account = null, accountName = null} = accountOf(card);
  return sourceId(card.provider, subscriptionKey({provider: card.provider, account, accountName}, userId));
}

/** A card's measurement at `t` as an agent sends it (spec: Snapshot), the next one due `next` later. */
export function snapshot(card: Card, start: number, t: number, next: number) {
  const resets = card.resets?.(t);
  return {
    provider: card.provider,
    ...accountOf(card),
    plan: card.plan,
    observedAt: iso(start, t),
    via: `demo/${card.provider}`,
    client: 'demo',
    staleAfterMs: staleAfter(next),
    windows: card.windows.map(at => {
      const w = at(t);
      return {id: w.id, kind: w.kind, minutes: w.minutes, label: w.label, usedPercent: w.used, resetsAt: w.resetsAt === null ? null : iso(start, w.resetsAt)};
    }),
    ...(resets
      ? {
          resets: {
            available: resets.available,
            ...(resets.expiring ? {expiring: resets.expiring.map(g => ({count: g.count, expiresAt: g.expiresAt === null ? null : iso(start, g.expiresAt)}))} : {}),
          },
        }
      : {}),
  };
}

export type Snapshot = ReturnType<typeof snapshot>;

/** The failures a machine reports at `t`: of the cards it measured first once they failed, and of clients it never measured. */
export function failuresAt(set: DemoSet, machine: Machine, start: number, t: number) {
  const failures = cards(set)
    .filter(card => card.failure && card.machines[0] === machine.id && t >= card.failure.from)
    .map(card => ({provider: card.provider, error: card.failure!.error}));
  failures.push(...(machine.failures ?? []));
  return failures.map(f => ({...f, observedAt: iso(start, t), detail: 'demo'}));
}

/** The agents a machine runs at `t`, as its agent reports them (spec: Reporting running agents). */
export function sessionsAt(set: DemoSet, machine: Machine, start: number, t: number) {
  if (!awake(machine, t)) return [];
  return cards(set).flatMap(card =>
    (card.agents ?? [])
      .filter(agent => agent.machine === machine.id && agent.since <= t && (agent.until === undefined || t < agent.until))
      .map(agent => {
        const working = !!agent.works && isOn(agent.works, t);
        const last = agent.works ? lastOn(agent.works, t) : null;
        return {
          provider: card.provider,
          ...accountOf(card),
          origin: agent.origin,
          project: agent.project,
          folder: agent.folder,
          startedAt: iso(start, agent.since),
          working,
          ...(!working && last !== null && last >= agent.since ? {lastWorkedAt: iso(start, last)} : {}),
        };
      }),
  );
}

/** Who a machine is to the hub (spec: `machine`). */
export const machineInfo = (machine: Machine) => ({
  id: `quotum-demo-${machine.id}`,
  name: machine.id,
  os: machine.os ?? 'linux',
  arch: machine.os === 'macos' ? 'aarch64' : 'x86_64',
});

/**
 * What a set must get right for the hub to show what it claims: unique ids, codes on every
 * entry, agents only on machines of people who hold the card (the hub leaves out any
 * other, spec: Reporting running agents), failures where the hub files them, and looks
 * the hub takes.
 */
export function problems(set: DemoSet): string[] {
  const found: string[] = [];
  const ids = set.entries.map(e => `${e.kind}:${e.id}`);
  for (const id of ids.filter((id, i) => ids.indexOf(id) !== i)) found.push(`${id} is there twice`);
  for (const entry of set.entries) if (!entry.expect.length) found.push(`${entry.kind} ${entry.id} expects nothing`);
  if (!people(set).length) found.push('nobody to sign in');
  const known = new Set(people(set).map(p => p.id));
  const shared = new Set(boards(set).map(b => b.id));
  for (const machine of machines(set)) if (!known.has(personOf(set, machine))) found.push(`machine ${machine.id} is of nobody known`);
  for (const board of boards(set)) {
    // A person's id names their personal board.
    if (known.has(board.id)) found.push(`board ${board.id} is named as a person`);
    for (const person of [board.owner, ...board.members]) if (!known.has(person)) found.push(`board ${board.id} names nobody known: ${person}`);
  }
  for (const person of people(set)) {
    for (const [reported, name] of Object.entries(person.projects ?? {})) {
      if (!name.trim() || name.trim() !== name || name === reported) found.push(`person ${person.id}: a name for ${reported} the hub keeps no correction for`);
    }
    // Only working agents are credited: a project of theirs none of whose agents works never shows.
    const working = cards(set).flatMap(card => (card.agents ?? []).filter(agent => agent.works && personOf(set, machineOf(set, agent.machine)) === person.id));
    const shownAs = (project: string | null) => (project === null ? null : (person.projects?.[project] ?? project));
    for (const check of person.expect) {
      if (!('project' in check) || 'absent' in check) continue;
      if (!working.some(agent => shownAs(agent.project) === check.project)) found.push(`person ${person.id} expects the project ${check.project}, which no working agent of theirs has`);
    }
  }
  // A machine's failure of a client shows on the card of the source it last delivered for that client, once it is quiet.
  const delivering = (machine: string, provider: Provider) => cards(set).filter(c => c.provider === provider && c.machines.includes(machine));
  for (const machine of machines(set)) {
    for (const failure of machine.failures ?? []) {
      if (delivering(machine.id, failure.provider).length) found.push(`machine ${machine.id} measures ${failure.provider}: its failure would go to a card, not only to «My machines»`);
    }
  }
  const sources = new Map<string, string>();
  for (const card of cards(set)) {
    // Another machine's measurements would move the pace it shows.
    if (card.paced && card.machines.length !== 1) found.push(`card ${card.id} is measured at the hub's pace by one machine only`);
    const holders = new Set(holdersOf(set, card));
    const shownOn = (board: string) => (known.has(board) ? holders.has(board) : !!card.on?.[board]);
    if (card.failure) {
      if (card.until === undefined || card.until >= card.failure.from) found.push(`card ${card.id} fails while it is still measured: the next measurement clears the failure`);
      if (delivering(card.machines[0], card.provider).length > 1) found.push(`card ${card.id}: its first machine measures another ${card.provider} subscription, which its failure may go to`);
    }
    // Cards the hub files under their person's name (no pseudonym) are one source per name.
    const key = card.account === 'pseudonym' || (card.account === undefined && card.provider !== 'antigravity') ? card.id : `${homeOf(set, card)}/${card.provider}/${typeof card.account === 'object' && card.account ? card.account.name.toLowerCase() : ''}`;
    if (sources.has(key)) found.push(`cards ${sources.get(key)} and ${card.id} are one subscription to the hub`);
    sources.set(key, card.id);
    if (key !== card.id) {
      // The hub files such a subscription per person, and an agent of it under what its machine delivers for the client.
      if (new Set(card.machines.map(m => personOf(set, machineOf(set, m)))).size > 1) found.push(`card ${card.id}: machines of different people measure it, a subscription each to the hub`);
      for (const agent of card.agents ?? []) {
        const there = delivering(agent.machine, card.provider);
        if (there.length !== 1 || there[0] !== card) found.push(`card ${card.id}: an agent on ${agent.machine}, which the hub files under what that machine delivers for ${card.provider}`);
      }
    }
    for (const agent of card.agents ?? []) {
      if (!holders.has(personOf(set, machineOf(set, agent.machine)))) found.push(`card ${card.id}: an agent on ${agent.machine}, whose person does not measure it`);
    }
    for (const [board, looks] of Object.entries(card.on ?? {})) {
      if (!known.has(board) && !shared.has(board)) found.push(`card ${card.id} is on an unknown board ${board}`);
      else if (known.has(board) && !holders.has(board)) found.push(`card ${card.id} has looks on the board of ${board}, who does not measure it`);
      if (looks.name !== undefined && (looks.name.trim() !== looks.name || !looks.name || looks.name.length > 60)) found.push(`card ${card.id}: a name the hub does not take`);
      if (looks.color !== undefined && !/^#[0-9a-f]{6}$/.test(looks.color)) found.push(`card ${card.id}: a colour the hub does not take`);
      if (looks.span !== undefined && (!Number.isInteger(looks.span) || looks.span < 4 || looks.span > 12)) found.push(`card ${card.id}: a width the hub does not take`);
    }
    for (const check of card.expect) {
      if (check.board !== undefined && !shownOn(check.board)) found.push(`card ${card.id} expects something on ${check.board}, where it is not shown`);
    }
  }
  return found;
}
