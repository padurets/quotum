/**
 * One measurer per subscription, whoever's devices measure it and whatever boards show
 * it. Devices check in before they measure; the hub lets
 * one of them — the one on duty — measure each subscription and asks the others to
 * wait. Duty sticks with its holder while it keeps delivering, moves to a device where
 * someone is working when the holder is idle, and passes on when the holder goes quiet.
 *
 * Kept in memory: after a restart the first devices to check in simply take duty again.
 */

/** A holder that has not delivered yet keeps duty this long. */
const FIRST_LEASE_MS = 5 * 60_000;
/** How long a waiting device sleeps before asking again: sooner where someone works. */
const WAIT_ACTIVE_MS = 60_000;
const WAIT_IDLE_MS = 10 * 60_000;
/** Duty moves to a working device only when its holder has been idle this long. */
const HANDOVER_IDLE_MS = 10 * 60_000;

type Holder = {device: string; until: number; activeAt: number};

export type Directive = {measure: boolean; until: number};

export class Duty {
  private readonly holders = new Map<string, Holder>();

  /** A device asks whether it should measure a subscription now. */
  claim(subscription: string, device: string, active: boolean, now: number): Directive {
    const holder = this.holders.get(subscription);
    const mine = holder?.device === device;
    const activeAt = active ? now : mine ? holder!.activeAt : 0;

    if (!holder || mine || holder.until <= now) {
      // Asking again does not extend a lease: only delivering does.
      const until = mine && holder!.until > now ? holder!.until : now + FIRST_LEASE_MS;
      this.holders.set(subscription, {device, until, activeAt});
      return {measure: true, until: now};
    }
    if (active && now - holder.activeAt > HANDOVER_IDLE_MS) {
      this.holders.set(subscription, {device, until: now + FIRST_LEASE_MS, activeAt: now});
      return {measure: true, until: now};
    }
    return {measure: false, until: Math.min(holder.until, now + (active ? WAIT_ACTIVE_MS : WAIT_IDLE_MS))};
  }

  /** A measurement arrived: its sender holds duty until the measurement goes stale. */
  delivered(subscription: string, device: string, observedAt: number, staleAfterMs: number, now: number) {
    const holder = this.holders.get(subscription);
    if (holder && holder.device !== device && holder.until > now) return;
    const activeAt = holder?.device === device ? holder.activeAt : 0;
    this.holders.set(subscription, {device, until: Math.max(observedAt + staleAfterMs, now + 30_000), activeAt});
  }

  holder(subscription: string): string | null {
    return this.holders.get(subscription)?.device ?? null;
  }

  /** When the holder's lease runs out. */
  until(subscription: string): number | null {
    return this.holders.get(subscription)?.until ?? null;
  }

  /** When the holder last said its client is in use. */
  activeAt(subscription: string): number | null {
    return this.holders.get(subscription)?.activeAt || null;
  }
}
