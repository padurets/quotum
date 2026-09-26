import {secretKind} from './domain/auth.js';
import {Invalid, parseBatch, parseCheckin, parseSessions, subscriptionKey, toMeasurement, type AgentSender} from './domain/ingest.js';
import {Sessions} from './sessions.js';
import {ACTIVE_WITHIN_MS, type Cadence, type Signals, type Why} from './cadence.js';
import type {Duty} from './duty.js';
import type {Provider} from './domain/sources.js';
import type {Device, Directory, Token} from './store/directory.js';
import type {Store} from './store/store.js';

export type IngestResult = {accepted: number; duplicates: number; failures: number; device: {id: string}};

/** What a device is told of each subscription; a device following the hub's pace also learns whether it is on duty and when to ask again. */
export type CheckinResult = {
  subscriptions: {provider: Provider; measure: boolean; until: string; onDuty?: boolean; askInMs?: number; nextInMs?: number}[];
};

/** Who is delivering: a device with its own token, or a machine with its person's machine token. */
export type Credential = {kind: 'device'; device: Device} | {kind: 'token'; token: Token};

/** Why a known agent is refused: its device or token was disconnected, or the machine is connected with a code already. */
export class IngestError extends Error {
  constructor(readonly code: 'device_revoked' | 'device_conflict') {
    super(code);
  }
}

/** Clocks within this of the hub's are taken as they are; beyond it, agent times are shifted. */
const CLOCK_TOLERANCE_MS = 30_000;

/**
 * Measurements pushed by agents (ingest format v1). A batch is parsed whole, then
 * stored in one transaction. Every batch comes from one device of one person; its
 * snapshots are filed under subscriptions kept once on the hub, so one account measured
 * by many devices, of one person or several, is one source, held by each of them.
 */
export class Ingest {
  /** The coding agents running on the devices right now. */
  readonly live: Sessions;

  constructor(
    private readonly store: Store,
    private readonly directory: Directory,
    private readonly duty: Duty,
    private readonly cadence: Cadence,
  ) {
    this.live = new Sessions(store);
  }

  /** The credential of an `Authorization` header; 'revoked' for a disconnected device or a revoked token. */
  authenticate(header: string | undefined): Credential | 'revoked' | null {
    const secret = /^Bearer (\S+)$/i.exec(header ?? '')?.[1];
    if (!secret) return null;
    switch (secretKind(secret)) {
      case 'qt_d': {
        const found = this.directory.deviceBySecret(secret);
        if (!found) return null;
        return found.revoked ? 'revoked' : {kind: 'device', device: found};
      }
      case 'qt_m': {
        const found = this.directory.tokenBySecret(secret);
        if (!found) return null;
        return found.revoked ? 'revoked' : {kind: 'token', token: found};
      }
      default:
        return null;
    }
  }

  accept(credential: Credential, body: unknown, now = Date.now()): IngestResult {
    const batch = parseBatch(body);
    // An agent whose clock is off: its times are moved by the difference, measured at sending.
    const skew = Math.abs(now - batch.sentAt) > CLOCK_TOLERANCE_MS ? now - batch.sentAt : 0;
    // A measurement from the future would hide every real one after it as a duplicate.
    const future = [...batch.snapshots, ...batch.failures].find(item => item.observedAt + skew > now + CLOCK_TOLERANCE_MS);
    if (future) throw new Invalid('observedAt');

    return this.directory.transaction(() => {
      const device = this.device(credential, batch, now);
      const result: IngestResult = {accepted: 0, duplicates: 0, failures: 0, device: {id: device.id}};

      for (const snapshot of [...batch.snapshots].sort((a, b) => a.observedAt - b.observedAt)) {
        const observedAt = snapshot.observedAt + skew;
        const account = subscriptionKey(snapshot, device.userId);
        const source = this.store.source(snapshot.provider, account, now);
        this.store.hold(source, device.userId, now);
        this.store.seenDevice(device.id, snapshot.provider, source, now);
        const {successAt} = this.store.state(source);
        // Resent after a lost answer, or already delivered by another device of the same account.
        if (successAt !== null && observedAt <= successAt) {
          result.duplicates++;
          continue;
        }
        this.store.record(source, {...toMeasurement(snapshot), observedAt});
        result.accepted++;
        this.duty.delivered(account, device.id, observedAt, snapshot.staleAfterMs, now);
        this.cadence.delivered(account, device.id, snapshot.windows, observedAt, snapshot.staleAfterMs, this.signals(source, account, now).inUse, now);
      }

      for (const failure of batch.failures) {
        const at = failure.observedAt + skew;
        const source = this.store.deviceSource(device.id, failure.provider);
        // The device waits out its failures, whether or not another device measures the subscription fine.
        const key = this.cadence.measuredBy(device.id, failure.provider) ?? (source && this.store.account(source));
        if (key) this.cadence.failed(key, device.id, failure.error, at);
        this.store.deviceFailed(device.id, failure.provider, failure.error, failure.detail, at);
        if (!source) continue;
        const state = this.store.state(source);
        // Another device may measure the same account fine; only a source gone quiet shows the problem.
        if (state.successAt !== null && state.staleAfterMs !== null && at - state.successAt <= state.staleAfterMs) continue;
        this.store.fail(source, failure.error);
        result.failures++;
      }
      return result;
    });
  }

  /**
   * Tells a device which of its subscriptions to measure now and when to ask again for the
   * rest. A device following the hub's pace measures a subscription it is on duty for only
   * when its pace says so, and does not take duty while it waits out its failures.
   */
  checkin(credential: Credential, body: unknown, now = Date.now()): CheckinResult {
    const request = parseCheckin(body);
    const device = this.device(credential, request, now);
    const iso = (ms: number) => new Date(ms).toISOString();
    return {
      subscriptions: request.subscriptions.map(s => {
        const key = subscriptionKey(s, device.userId);
        if (!request.paced) {
          const directive = this.duty.claim(key, device.id, s.active, now);
          return {provider: s.provider, measure: directive.measure, until: iso(directive.until)};
        }
        const paused = this.cadence.pausedUntil(key, device.id, now);
        const holder = this.duty.holder(key);
        const leased = (this.duty.until(key) ?? 0) > now;
        if (paused !== null && !(holder === device.id && leased)) {
          // Another device measures it, or none does until this one's pause is over.
          const askInMs = Math.ceil(Math.min(paused - now, 10 * 60_000));
          return {provider: s.provider, measure: false, onDuty: !(holder !== null && holder !== device.id && leased), askInMs, until: iso(now + askInMs)};
        }
        const directive = this.duty.claim(key, device.id, s.active, now);
        if (!directive.measure) {
          return {provider: s.provider, measure: false, onDuty: false, askInMs: directive.until - now, until: iso(directive.until)};
        }
        const source = this.store.findSource(s.provider, key);
        const answer = this.cadence.answer(key, device.id, s.provider, now, s.minIntervalMs, this.signals(source, key, now));
        return {provider: s.provider, ...answer, until: iso(now + answer.askInMs)};
      }),
    };
  }

  /** When a subscription is measured next and why, while its holder follows the hub's pace; null otherwise. */
  nextMeasurement(source: string, key: string, now: number): {next: number; why: Why} | null {
    return this.cadence.view(key, this.duty.holder(key), now, this.signals(source, key, now));
  }

  /** What the hub knows of a subscription now: its windows, and whether it is in use on any machine. */
  private signals(source: string | null, key: string, now: number): Signals {
    const activeAt = this.duty.activeAt(key);
    return {
      windows: source ? this.store.state(source).windows : [],
      inUse: (source !== null && this.live.working(source, now)) || (activeAt !== null && now - activeAt <= ACTIVE_WITHIN_MS),
    };
  }

  /**
   * Which coding agents run on a device now. A session is filed under the subscription
   * it names, else under the one this device last delivered for its provider; one the
   * hub does not know, or its person does not hold, is left out.
   */
  sessions(credential: Credential, body: unknown, now = Date.now()): {accepted: number} {
    const report = parseSessions(body);
    const skew = Math.abs(now - report.sentAt) > CLOCK_TOLERANCE_MS ? now - report.sentAt : 0;
    return this.directory.transaction(() => {
      const device = this.device(credential, report, now);
      const name = device.label ?? device.name;
      const sessions = report.sessions.flatMap(({provider, account, accountName, ...session}) => {
        const source =
          account || accountName
            ? this.store.findSource(provider, subscriptionKey({provider, account, accountName}, device.userId))
            : this.store.deviceSource(device.id, provider);
        // Only a subscription the device's person holds: naming someone else's account shows nothing on it.
        if (!source || !this.store.holds(device.userId, source)) return [];
        const startedAt = Math.min(now, session.startedAt + skew);
        const lastWorkedAt = session.lastWorkedAt === null ? null : Math.max(startedAt, Math.min(now, session.lastWorkedAt + skew));
        return [{...session, startedAt, sentStartedAt: session.startedAt, lastWorkedAt, source, device: {id: device.id, name}}];
      });
      this.live.report(device.id, device.userId, sessions, now);
      return {accepted: sessions.length};
    });
  }

  /**
   * The device a request comes from. A device token names it; with a machine token the
   * machine joins its person on first contact. A machine disconnected by hand cannot
   * come back with the token it had, but a new token (after rotating a leaked one)
   * takes it back.
   */
  private device(credential: Credential, sender: AgentSender, now: number): Device {
    if (credential.kind === 'device') {
      this.directory.touchDevice(credential.device.id, sender.machine, sender.agent, now);
      return credential.device;
    }
    const {token} = credential;
    const existing = this.directory.deviceByMachine(token.userId, sender.machine.id);
    // A machine connected with a code keeps its own token; a machine token cannot take it over.
    if (existing?.byCode && !existing.revoked) throw new IngestError('device_conflict');
    if (existing?.revoked && existing.tokenId === token.id) throw new IngestError('device_revoked');
    this.directory.touchToken(token.id, now);
    return this.directory.saveDevice({userId: token.userId, machine: sender.machine, agent: sender.agent, tokenId: token.id}, now);
  }
}
