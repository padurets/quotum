import {Agent, Person} from './client.js';
import {
  awake,
  boards,
  cards,
  delivered,
  failuresAt,
  historyTimes,
  holdersOf,
  homeOf,
  machineInfo,
  machines,
  MIN,
  people,
  personOf,
  problems,
  sessionsAt,
  snapshot,
  sourceOf,
  type Card,
  type DemoSet,
  type Machine,
} from './model.js';

/** Everyone signs in with this password: the demo is thrown away when it stops. */
export const PASSWORD = 'quotum-demo';

export const emailOf = (person: string) => `${person}@demo.quotum`;

/** A set brought up on a hub: who is who there, by the catalogue's names. */
export type Stand = {
  set: DemoSet;
  start: number;
  people: Map<string, Person>;
  /** Hub board ids by the catalogue's board ids; a person's id names their personal board. */
  boards: Map<string, string>;
  agents: Map<string, Agent>;
  /** Source ids by card id. */
  sources: Map<string, string>;
};

/** A batch holds at most this many measurements (spec: Batch). */
const BATCH = 500;

/**
 * Brings a set up on a fresh hub through its public requests, as people and agents would:
 * sign-ups and invites, boards, machine tokens and a code, the history of every card, the
 * failures, shares and every board's view. `now` is the hub's clock.
 */
export async function setUp(base: string, set: DemoSet, start: number, setupCode: string, now: () => number): Promise<Stand> {
  const wrong = problems(set);
  if (wrong.length) throw new Error(`the set ${set.id} is not right: ${wrong.join('; ')}`);
  const stand: Stand = {set, start, people: new Map(), boards: new Map(), agents: new Map(), sources: new Map()};
  await signUpEveryone(base, set, setupCode, stand);

  // Every machine says hello first, so it is known (and can be renamed) before it measures.
  const tokens = new Map<string, string>();
  for (const machine of machines(set)) {
    const person = stand.people.get(personOf(set, machine))!;
    const info = machineInfo(machine);
    let agent: Agent;
    if (machine.byCode) agent = await Agent.byCode(base, info, person);
    else {
      if (!tokens.has(person.id)) tokens.set(person.id, await person.machineToken('Demo machines'));
      agent = new Agent(base, info, tokens.get(person.id)!);
    }
    await agent.sessions([], now());
    stand.agents.set(machine.id, agent);
  }
  for (const machine of machines(set).filter(m => m.renamed)) {
    const person = stand.people.get(personOf(set, machine))!;
    const devices = await person.get<{id: string; reported: string}[]>('/api/devices');
    await person.renameDevice(devices.find(d => d.reported === machine.id)!.id, machine.renamed!);
  }
  // Before any agent reports: a name nothing has reported yet is corrected all the same.
  for (const person of people(set)) {
    for (const [reported, name] of Object.entries(person.projects ?? {})) await stand.people.get(person.id)!.renameProject(reported, name);
  }

  for (const card of cards(set)) {
    stand.sources.set(card.id, sourceOf(card, stand.people.get(homeOf(set, card))!.id));
    await seed(stand, card, now);
    // The other machines join: their first measurement (the hub has it already) makes
    // their people hold it, so their agents show on it from the first list.
    const last = historyTimes(set, card).at(-1)!;
    for (const machine of card.machines.slice(1)) await stand.agents.get(machine)!.ingest([snapshot(card, start, last.t, last.step)], [], now());
  }
  // Failures last: a later measurement of the same client would clear them.
  for (const machine of machines(set).filter(m => awake(m, -MIN))) {
    const failures = failuresAt(set, machine, start, -MIN);
    if (failures.length) await stand.agents.get(machine.id)!.ingest([], failures, now());
  }

  for (const card of cards(set)) {
    for (const board of Object.keys(card.on ?? {}).filter(key => !stand.people.has(key))) {
      await stand.people.get(homeOf(set, card))!.share(stand.boards.get(board)!, stand.sources.get(card.id)!);
    }
  }
  for (const [key, board] of stand.boards) await ownerOf(stand, key).saveView(board, viewOf(stand, key));
  return stand;
}

/** The first person with the setup code, then everyone else with an invite to a board they are on. */
async function signUpEveryone(base: string, set: DemoSet, setupCode: string, stand: Stand) {
  const invites = new Map<string, string[]>();
  const signUp = async (id: string, access: {setupCode: string} | {invite: string}) => {
    const entry = people(set).find(p => p.id === id)!;
    const person = await Person.signUp(base, {email: emailOf(id), name: entry.name, password: PASSWORD}, access);
    stand.people.set(id, person);
    stand.boards.set(id, person.personalBoard);
    for (const invite of (invites.get(id) ?? []).slice('invite' in access ? 1 : 0)) await person.accept(invite);
    invites.delete(id);
  };
  await signUp(people(set)[0].id, {setupCode});
  for (let progress = true; progress; ) {
    progress = false;
    for (const board of boards(set)) {
      const owner = stand.people.get(board.owner);
      if (stand.boards.has(board.id) || !owner) continue;
      stand.boards.set(board.id, await owner.createBoard(board.name));
      for (const member of board.members) {
        const invite = await owner.invite(stand.boards.get(board.id)!);
        const person = stand.people.get(member);
        if (person) await person.accept(invite);
        else invites.set(member, [...(invites.get(member) ?? []), invite]);
      }
      progress = true;
    }
    for (const [member, pending] of invites) {
      await signUp(member, {invite: pending[0]});
      progress = true;
    }
  }
  const missing = people(set).filter(p => !stand.people.has(p.id));
  if (missing.length) throw new Error(`the catalogue invites nobody of ${missing.map(p => p.id).join(', ')} to a board, so they cannot sign up`);
}

/** Sends a card's history from its first machine, oldest first; every measurement must be new to the hub. */
async function seed(stand: Stand, card: Card, now: () => number) {
  const agent = stand.agents.get(card.machines[0])!;
  const times = historyTimes(stand.set, card);
  for (let i = 0; i < times.length; i += BATCH) {
    const batch = times.slice(i, i + BATCH).map(({t, step}) => snapshot(card, stand.start, t, step));
    const answer = await agent.ingest(batch, [], now());
    if (answer.accepted !== batch.length || answer.duplicates) {
      throw new Error(`card ${card.id}: the hub took ${answer.accepted} of ${batch.length} measurements (${answer.duplicates} duplicates)`);
    }
  }
}

const ownerOf = (stand: Stand, key: string) => stand.people.get(boards(stand.set).find(b => b.id === key)?.owner ?? key)!;

/** A board's view: its cards in the catalogue's order with their looks there, then the agents, the chart and the table. */
export function viewOf(stand: Stand, key: string) {
  const {set} = stand;
  const personal = stand.people.has(key);
  const shown = cards(set).filter(card => (personal ? holdersOf(set, card).includes(key) : !!card.on?.[key]));
  const board = boards(set).find(b => b.id === key) ?? people(set).find(p => p.id === key);
  const view = {
    order: [...shown.map(card => `source:${stand.sources.get(card.id)}`), 'agents', 'history', 'forecast'],
    sizes: {} as Record<string, number>,
    names: {} as Record<string, string>,
    hidden: [] as string[],
    shown: board?.agents ? ['agents'] : [],
    windows: [] as string[],
    plans: {} as Record<string, number[]>,
    unplanned: [] as string[],
    colors: {} as Record<string, string>,
    columns: {},
    shownColumns: {},
  };
  if (board?.agentsSpan) view.sizes.agents = board.agentsSpan;
  for (const card of shown) {
    const source = stand.sources.get(card.id)!;
    const looks = card.on?.[key] ?? {};
    if (looks.span) view.sizes[`source:${source}`] = looks.span;
    if (looks.name) view.names[source] = looks.name;
    if (looks.color) view.colors[source] = looks.color;
    if (looks.hidden) view.hidden.push(`source:${source}`);
    for (const window of looks.windows ?? []) view.windows.push(`${source}/${window}`);
    if (looks.plan === 'off') view.unplanned.push(source);
    else if (looks.plan) view.plans[source] = looks.plan;
  }
  return view;
}

/** How often each card is measured at `t` by a machine: the demo measures on the agent's schedule, the test faster or slower. */
export type Rhythm = (card: Card, machine: Machine, t: number) => number;

/**
 * What the machines of a stand send as time goes on: their measurements on each card's
 * rhythm while awake, their failures every five minutes, and their lists of running
 * agents. The demo's loop and the catalogue test both drive it. With `paced`, the cards
 * measured at the hub's pace are left to `pace` instead.
 */
export class Live {
  /** Up to when each machine has measured. */
  private readonly measured = new Map<string, number>();

  constructor(
    private readonly stand: Stand,
    private readonly rhythm: Rhythm,
    private readonly paced = false,
  ) {}

  /** Measurement times of a card by a machine in (from, to]: minutes on its cadence. */
  private times(card: Card, machine: Machine, from: number, to: number): number[] {
    const found: number[] = [];
    for (let t = Math.floor(from / MIN) * MIN + MIN; t <= to; t += MIN) {
      if (t % this.rhythm(card, machine, t) === 0) found.push(t);
    }
    return found;
  }

  /** When a card is measured next after `t`. */
  private next(card: Card, machine: Machine, t: number): number {
    for (let at = t + MIN; ; at += MIN) if (at % this.rhythm(card, machine, at) === 0) return at - t;
  }

  /** Every machine sends what it measured since last time, up to `t`; `now` is the hub's clock. */
  async measure(t: number, now: number) {
    const {set, start} = this.stand;
    for (const machine of machines(set)) {
      const from = this.measured.get(machine.id) ?? -MIN;
      if (t <= from) continue;
      this.measured.set(machine.id, t);
      const snapshots = cards(set)
        .filter(card => card.machines.includes(machine.id) && !(this.paced && card.paced))
        .flatMap(card =>
          this.times(card, machine, from, t)
            .filter(at => awake(machine, at) && delivered(card, at))
            .map(at => snapshot(card, start, at, this.next(card, machine, at))),
        )
        .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
      const failing = Math.floor(t / (5 * MIN)) > Math.floor(from / (5 * MIN)) && awake(machine, t);
      const failures = failing ? failuresAt(set, machine, start, Math.floor(t / (5 * MIN)) * 5 * MIN) : [];
      const agent = this.stand.agents.get(machine.id)!;
      for (let i = 0; i < Math.max(snapshots.length, failures.length ? 1 : 0); i += BATCH) {
        await agent.ingest(snapshots.slice(i, i + BATCH), i + BATCH >= snapshots.length ? failures : [], now);
      }
    }
  }

  /**
   * Every machine awake asks the hub about its cards measured at the hub's pace, in one
   * check-in as agents do every 15 seconds, and delivers those it is told to measure,
   * promising the next as the hub did.
   */
  async pace(t: number, now: number) {
    const {set, start} = this.stand;
    for (const machine of machines(set)) {
      const paced = cards(set).filter(card => card.paced && card.machines[0] === machine.id && delivered(card, t));
      if (!paced.length || !awake(machine, t)) continue;
      const agent = this.stand.agents.get(machine.id)!;
      const asks = paced.map(card => {
        const {provider, account, accountName} = snapshot(card, start, t, MIN) as {provider: string; account?: string; accountName?: string};
        return {provider, account, accountName, active: false};
      });
      const {subscriptions} = await agent.checkin(asks);
      const told = paced.flatMap((card, i) => (subscriptions[i].measure && subscriptions[i].nextInMs ? [snapshot(card, start, t, subscriptions[i].nextInMs)] : []));
      if (told.length) await agent.ingest(told, [], now);
    }
  }

  /** Every machine tells its list of running agents as of `t`, as agents do every 15 seconds; one asleep says nothing. */
  async report(t: number, now: number) {
    for (const machine of machines(this.stand.set)) await this.reportOne(machine, t, now);
  }

  /** One machine tells its list as of `t`; the hub must file every agent on it. */
  async reportOne(machine: Machine, t: number, now: number) {
    if (!awake(machine, t)) return;
    const sessions = sessionsAt(this.stand.set, machine, this.stand.start, t);
    const {accepted} = await this.stand.agents.get(machine.id)!.sessions(sessions, now);
    if (accepted !== sessions.length) throw new Error(`machine ${machine.id}: the hub filed ${accepted} of its ${sessions.length} running agents`);
  }
}
