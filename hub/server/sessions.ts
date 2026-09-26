import type {Origin} from './domain/ingest.js';
import type {Store, WorkKey} from './store/store.js';

/** A running coding agent as its machine reported it, on the subscription it spends. */
export type LiveSession = {
  device: {id: string; name: string};
  origin: Origin;
  project: string | null;
  folder: string | null;
  /** On the hub's clock. */
  startedAt: number;
  /** As the agent sent it: the correction for its clock differs from request to request, so this tells the session. */
  sentStartedAt: number;
  lastWorkedAt: number | null;
  working: boolean;
};

/**
 * A running coding agent as a board shows it, on the card of the subscription it spends:
 * its project as its person named it («My machines» → «Projects»), and its folder where
 * that is another (a worktree, a folder inside the repository), so agents of one project
 * stay apart.
 */
export type BoardSession = {
  device: {id: string; name: string};
  origin: Origin;
  project: string | null;
  folder: string | null;
  startedAt: number;
  lastWorkedAt: number | null;
  working: boolean;
};

/** A machine's sessions, by the subscription they spend, as its agent last reported them, and when. */
type Machine = {at: number; user: string; sources: Map<string, LiveSession[]>};

/** A machine's list is kept this long after its last report (its agent reports at least every two minutes). */
export const KEEP_MS = 5 * 60_000;
/**
 * A list counts as true until the next one, but for at most this long: an agent with
 * anything running reports at least every two minutes (later by a look's 15 s and a
 * measurement it waits for, up to a minute), so a machine quiet for longer stopped
 * working, and is not credited for its silence. A hub slow to answer the calls around
 * that measurement can stretch a gap past this; the few seconds over are not counted.
 */
export const CREDIT_MS = 200_000;

/**
 * The coding agents running on people's machines right now (spec: Reporting running
 * agents). Only the latest list of each machine is kept, in memory: after a restart the
 * agents send theirs again within minutes. When each session worked, as the lists said,
 * is kept (Store.creditWork); how long agents worked is worked out from that when read
 * (domain/work.ts).
 */
export class Sessions {
  private readonly machines = new Map<string, Machine>();

  constructor(private readonly store: Store) {}

  /** A machine's new list, from its person `user`, each session filed under its subscription. */
  report(device: string, user: string, sessions: (LiveSession & {source: string})[], now: number) {
    this.sweep(now);
    const before = this.machines.get(device);
    if (before) this.credit(device, before, Math.min(now, before.at + CREDIT_MS));
    const sources = new Map<string, LiveSession[]>();
    for (const {source, ...session} of sessions) sources.set(source, [...(sources.get(source) ?? []), session]);
    if (sources.size) this.machines.set(device, {at: now, user, sources});
    else this.machines.delete(device);
  }

  /** Forgets machines gone quiet, crediting their last list as a new one would have. */
  sweep(now: number) {
    for (const [device, machine] of this.machines) {
      if (now - machine.at <= KEEP_MS) continue;
      this.credit(device, machine, machine.at + CREDIT_MS);
      this.machines.delete(device);
    }
  }

  /** Devices taken off the hub stop showing at once. */
  forget(devices: string[]) {
    for (const device of devices) this.machines.delete(device);
  }

  /**
   * The sessions running on a subscription on the machines of `people` (those who show
   * it on the board read), by machine name and then by age.
   */
  of(source: string, people: string[], now: number): BoardSession[] {
    const found: BoardSession[] = [];
    for (const machine of this.machines.values()) {
      if (now - machine.at > KEEP_MS || !people.includes(machine.user)) continue;
      const sessions = machine.sources.get(source) ?? [];
      const names = sessions.length ? this.store.projectNames(machine.user) : new Map<string, string>();
      for (const {device, origin, project, folder, startedAt, lastWorkedAt, working} of sessions) {
        const shown = project === null ? null : (names.get(project) ?? project);
        // The agent leaves out a folder that is its project; renamed, that name tells the folder.
        found.push({device, origin, project: shown, folder: folder ?? (shown !== project ? project : null), startedAt, lastWorkedAt, working});
      }
    }
    return found.sort((a, b) => a.device.name.localeCompare(b.device.name) || a.device.id.localeCompare(b.device.id) || a.startedAt - b.startedAt);
  }

  /** Whether an agent works on a subscription on any machine, by lists that still count as true. */
  working(source: string, now: number): boolean {
    for (const machine of this.machines.values()) {
      if (now - machine.at <= CREDIT_MS && machine.sources.get(source)?.some(s => s.working)) return true;
    }
    return false;
  }

  /**
   * Credits the working sessions of a machine's list with the time from its report to
   * `until`; the store leaves out what a clock set back would credit twice.
   */
  private credit(device: string, machine: Machine, until: number) {
    const from = machine.at;
    if (until <= from) return;
    const keys: WorkKey[] = [];
    // Sessions alike in everything (started together by a script) are told apart by their place among them.
    const alike = new Map<string, number>();
    for (const [source, sessions] of machine.sources) {
      for (const session of sessions) {
        if (!session.working) continue;
        const key = {source, origin: session.origin, startedAt: session.sentStartedAt, project: session.project ?? '', folder: session.folder ?? ''};
        const id = JSON.stringify(key);
        const ordinal = alike.get(id) ?? 0;
        alike.set(id, ordinal + 1);
        keys.push({...key, ordinal});
      }
    }
    this.store.creditWork(device, from, until, keys);
  }
}
