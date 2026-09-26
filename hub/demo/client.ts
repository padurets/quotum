/**
 * The hub's public requests, as people and agents make them: people sign in and keep a
 * session cookie (held here by hand, as a browser would), agents send a bearer token.
 * Nothing here reaches into the hub's insides.
 */

/** A refused request: its status and the hub's `{error}`. */
export class Refused extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    what: string,
  ) {
    super(`${what}: HTTP ${status} ${JSON.stringify(body)}`);
  }
}

type Method = 'GET' | 'POST' | 'DELETE';

/**
 * Stops every request of the demo, those under way too. Each request also closes its
 * connection when answered: a stopping hub waits for open ones, and the demo's, kept alive
 * for reuse, would hold it up for seconds.
 */
const halted = new AbortController();
export const haltRequests = () => halted.abort();

async function call<T>(base: string, method: Method, path: string, options: {body?: unknown; cookie?: string; token?: string} = {}): Promise<{body: T; cookie: string | null}> {
  const response = await fetch(base + path, {
    method,
    headers: {
      connection: 'close',
      ...(options.body !== undefined ? {'content-type': 'application/json'} : {}),
      ...(options.cookie ? {cookie: options.cookie} : {}),
      ...(options.token ? {authorization: `Bearer ${options.token}`} : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: halted.signal,
  });
  const text = await response.text();
  const body = response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  if (!response.ok) throw new Refused(response.status, body, `${method} ${path}`);
  // Only the name and value: a hub behind https marks it Secure, which fetch here does not mind.
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? null;
  return {body: body as T, cookie};
}

export type Board = {id: string; name: string; personal: boolean; role: 'owner' | 'member'};

/** A person signed in to the hub. */
export class Person {
  constructor(
    readonly base: string,
    readonly id: string,
    readonly personalBoard: string,
    private readonly cookie: string,
  ) {}

  /** Signs someone up: the first person with the setup code, anyone else with an invite. */
  static async signUp(base: string, who: {email: string; name: string; password: string}, access: {setupCode: string} | {invite: string}): Promise<Person> {
    const {body, cookie} = await call<{user: {id: string}; boards: Board[]}>(base, 'POST', '/api/auth/signup', {body: {...who, ...access}});
    return new Person(base, body.user.id, body.boards.find(b => b.personal)!.id, cookie!);
  }

  async get<T>(path: string): Promise<T> {
    return (await call<T>(this.base, 'GET', path, {cookie: this.cookie})).body;
  }

  async post<T>(path: string, body: unknown = {}): Promise<T> {
    return (await call<T>(this.base, 'POST', path, {body, cookie: this.cookie})).body;
  }

  /** A machine token for this person's machines. */
  async machineToken(name: string): Promise<string> {
    return (await this.post<{secret: string}>('/api/tokens', {name})).secret;
  }

  async createBoard(name: string): Promise<string> {
    return (await this.post<Board>('/api/boards', {name})).id;
  }

  /** An invite to a board, as the secret at the end of its link. */
  async invite(board: string): Promise<string> {
    const {url} = await this.post<{url: string}>(`/api/boards/${encodeURIComponent(board)}/invites`);
    return url.split('/').at(-1)!;
  }

  async accept(invite: string) {
    await this.post(`/api/invites/${encodeURIComponent(invite)}/accept`);
  }

  async share(board: string, source: string) {
    await this.post(`/api/boards/${encodeURIComponent(board)}/shares`, {source});
  }

  async saveView(board: string, view: object) {
    await this.post(`/api/boards/${encodeURIComponent(board)}/view`, view);
  }

  async approve(code: string) {
    await this.post('/api/device/approve', {code});
  }

  async renameDevice(device: string, name: string) {
    await this.post(`/api/devices/${encodeURIComponent(device)}`, {name});
  }

  /** Names a project as its machines report it, whether or not any has yet. */
  async renameProject(reported: string, name: string) {
    await this.post('/api/projects', {groups: [reported], name});
  }
}

export type MachineInfo = {id: string; name: string; os: string; arch: string};

/** An agent on a machine, with its person's machine token or its own device token. */
export class Agent {
  constructor(
    readonly base: string,
    readonly machine: MachineInfo,
    private readonly token: string,
  ) {}

  static readonly VERSION = 'quotum-demo/1';

  /** Connects a machine with a one-time code that `person` approves, as `quotum connect` does. */
  static async byCode(base: string, machine: MachineInfo, person: Person): Promise<Agent> {
    const started = (await call<{deviceCode: string; userCode: string}>(base, 'POST', '/v1/device/code', {body: {machine, agent: Agent.VERSION}})).body;
    await person.approve(started.userCode);
    const {token} = (await call<{token: string}>(base, 'POST', '/v1/device/token', {body: {deviceCode: started.deviceCode}})).body;
    return new Agent(base, machine, token);
  }

  /** Delivers measurements and failures (spec: Batch), sent now. */
  async ingest(snapshots: object[], failures: object[], now: number) {
    const body = {version: 1, agent: Agent.VERSION, machine: this.machine, sentAt: new Date(now).toISOString(), snapshots, failures};
    return (await call<{accepted: number; duplicates: number; failures: number}>(this.base, 'POST', '/v1/ingest', {body, token: this.token})).body;
  }

  /** Asks whether to measure its subscriptions now, following the hub's pace (spec: Asking whether to measure). */
  async checkin(subscriptions: object[]) {
    const body = {version: 1, agent: Agent.VERSION, paced: true, machine: this.machine, subscriptions};
    type Told = {provider: string; measure: boolean; onDuty?: boolean; askInMs?: number; nextInMs?: number};
    return (await call<{subscriptions: Told[]}>(this.base, 'POST', '/v1/checkin', {body, token: this.token})).body;
  }

  /** Tells the hub the machine's whole list of running agents, as of now. */
  async sessions(sessions: object[], now: number) {
    const body = {version: 1, agent: Agent.VERSION, machine: this.machine, sentAt: new Date(now).toISOString(), sessions};
    return (await call<{accepted: number}>(this.base, 'POST', '/v1/sessions', {body, token: this.token})).body;
  }
}

/** Whether the hub answers its health check. */
export async function healthy(base: string): Promise<boolean> {
  try {
    return (await fetch(`${base}/health`, {headers: {connection: 'close'}, signal: halted.signal})).ok;
  } catch {
    return false;
  }
}

/** What `/api/session` says to someone not signed in: whether the hub still waits for its first person. */
export async function firstSignup(base: string): Promise<boolean | null> {
  try {
    return (await call<{signup: {first: boolean}}>(base, 'GET', '/api/session')).body.signup.first;
  } catch {
    return null;
  }
}
