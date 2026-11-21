/**
 * A simulated network for congestion's own tests: virtual time, and one-way pipes that cap,
 * queue, delay, jitter and drop the way SPEC §13.1 says the harness's impairment shim will. It is
 * a model, not a measurement: PLAN §4 has the shim's statistical tests settle any disagreement.
 *
 * Nothing here is random unless seeded, so every run of a test is the same run.
 */

/** mulberry32: small, fast, and the same on every machine. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Virtual time in milliseconds, and what is due when. Events at the same instant run in the order they were scheduled. */
export class World {
  now = 0;
  private queue: { at: number; order: number; run: () => void }[] = [];
  private order = 0;

  at(time: number, run: () => void): void {
    const event = { at: Math.max(time, this.now), order: this.order++, run };
    // A binary heap, by time and then by order.
    const queue = this.queue;
    let i = queue.push(event) - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(queue[i], queue[parent])) break;
      [queue[i], queue[parent]] = [queue[parent], queue[i]];
      i = parent;
    }
  }

  after(ms: number, run: () => void): void {
    this.at(this.now + ms, run);
  }

  every(ms: number, run: () => void, firstAt = this.now): void {
    const tick = (): void => {
      run();
      this.after(ms, tick);
    };
    this.at(firstAt, tick);
  }

  /** Runs everything due up to and including `until`, and leaves the clock there. */
  runUntil(until: number): void {
    const queue = this.queue;
    while (queue.length > 0 && queue[0].at <= until) {
      const event = queue[0];
      const last = queue.pop()!;
      if (queue.length > 0) {
        queue[0] = last;
        let i = 0;
        for (;;) {
          const left = 2 * i + 1;
          const right = left + 1;
          let least = i;
          if (left < queue.length && before(queue[left], queue[least])) least = left;
          if (right < queue.length && before(queue[right], queue[least])) least = right;
          if (least === i) break;
          [queue[i], queue[least]] = [queue[least], queue[i]];
          i = least;
        }
      }
      this.now = event.at;
      event.run();
    }
    this.now = until;
  }
}

const before = (a: { at: number; order: number }, b: { at: number; order: number }): boolean => a.at < b.at || (a.at === b.at && a.order < b.order);

/**
 * A rate cap with a bounded queue: packets leave one after another at `kbps`, wait their turn in
 * a queue, and are dropped when the queue already holds `queueMs` of the rate. `backlog` is what
 * a data channel would show as `bufferedAmount`. Used by the simulated pipe and, pumped by a real
 * timer, by the browser run's capped channel.
 */
export class RateCap<T> {
  private queue: { item: T; bytes: number; leavesAt: number }[] = [];
  private head = 0;
  private lastLeaves = -Infinity;
  private held = 0;
  dropped = 0;

  constructor(
    public kbps: number,
    public queueMs: number,
  ) {}

  /** False if the queue was full and the packet dropped. */
  push(item: T, bytes: number, now: number): boolean {
    if (this.held + bytes > (this.kbps * this.queueMs) / 8 && this.held > 0) {
      this.dropped++;
      return false;
    }
    const leavesAt = Math.max(now, this.lastLeaves) + (bytes * 8) / this.kbps;
    this.lastLeaves = leavesAt;
    this.queue.push({ item, bytes, leavesAt });
    this.held += bytes;
    return true;
  }

  /** Packets whose turn has come by `now`, in order. */
  take(now: number): T[] {
    const out: T[] = [];
    while (this.head < this.queue.length && this.queue[this.head].leavesAt <= now) {
      const entry = this.queue[this.head++];
      this.held -= entry.bytes;
      out.push(entry.item);
    }
    if (this.head > 1024) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
    return out;
  }

  /** When the next packet leaves, or null if none is waiting. */
  nextAt(): number | null {
    return this.head < this.queue.length ? this.queue[this.head].leavesAt : null;
  }

  get backlog(): number {
    return this.held;
  }
}

export type PipeProfile = {
  /** Added to every packet. */
  delayMs: number;
  /** Extra delay, different for each packet, up to this much. */
  jitterMs?: number;
  /** Packets dropped, in percent, overall. */
  lossPct?: number;
  /**
   * Losses in runs (Gilbert–Elliott), as the harness's shim has them: a packet enters a burst
   * with `enterPct`, leaves it with `leavePct`, and is lost in one with `lossPctInBurst`; outside,
   * with whatever brings the overall loss to `lossPct`.
   */
  burst?: { enterPct: number; leavePct: number; lossPctInBurst: number };
  /**
   * A policer: a token bucket at this rate, `policeBurstMs` of it deep, that drops what is over
   * the rate instead of queueing it. Nothing waits, so the sender sees no backlog and the
   * receiver no queue: only loss.
   */
  policeKbps?: number;
  policeBurstMs?: number;
  /** The most the pipe carries; more queues, up to `queueMs`, and then is dropped. */
  kbps?: number;
  queueMs?: number;
};

/** The least of a channel that a sender needs. `RTCDataChannel` and transport's `PacketChannel` both are one. */
export type Pipe = { readonly bufferedAmount: number; send(packet: Uint8Array): void };

/** One direction of one link. `send` copies its argument, as `RTCDataChannel.send` does. */
export class SimPipe implements Pipe {
  onmessage: ((packet: Uint8Array, at: number) => void) | null = null;
  private cap: RateCap<Uint8Array> | null = null;
  private pumping = false;
  sent = 0;
  lost = 0;
  delivered = 0;

  constructor(
    private readonly world: World,
    private profile: PipeProfile,
    private readonly random: () => number,
  ) {
    this.setProfile(profile);
  }

  /** Changes the pipe mid-run. What is already queued leaves at the new rate. */
  setProfile(profile: PipeProfile): void {
    this.profile = profile;
    if (profile.kbps === undefined) {
      if (this.cap) for (const packet of this.cap.take(Infinity)) this.fly(packet);
      this.cap = null;
    } else if (this.cap) {
      this.cap.kbps = profile.kbps;
      this.cap.queueMs = profile.queueMs ?? 300;
    } else {
      this.cap = new RateCap(profile.kbps, profile.queueMs ?? 300);
    }
  }

  get bufferedAmount(): number {
    if (!this.cap) return 0;
    this.pump();
    return this.cap.backlog;
  }

  send(packet: Uint8Array): void {
    this.sent++;
    const copy = packet.slice();
    if (!this.cap) return this.fly(copy);
    this.pump();
    if (!this.cap.push(copy, copy.byteLength, this.world.now)) this.lost++;
    else this.schedule();
  }

  private pump(): void {
    if (!this.cap) return;
    for (const packet of this.cap.take(this.world.now)) this.fly(packet);
  }

  private schedule(): void {
    if (this.pumping || !this.cap) return;
    const next = this.cap.nextAt();
    if (next === null) return;
    this.pumping = true;
    this.world.at(next, () => {
      this.pumping = false;
      this.pump();
      this.schedule();
    });
  }

  private inBurst = false;

  /** Whether the next packet is lost. */
  private loses(): boolean {
    const burst = this.profile.burst;
    const lossPct = this.profile.lossPct ?? 0;
    if (!burst) return this.random() * 100 < lossPct;
    if (this.inBurst) {
      if (this.random() * 100 < burst.leavePct) this.inBurst = false;
    } else if (this.random() * 100 < burst.enterPct) this.inBurst = true;
    // The share of packets sent in a burst, and the loss outside one that makes the whole lossPct.
    const share = burst.enterPct / (burst.enterPct + burst.leavePct);
    const goodPct = Math.max(0, Math.min(100, (lossPct - share * burst.lossPctInBurst) / (1 - share)));
    return this.random() * 100 < (this.inBurst ? burst.lossPctInBurst : goodPct);
  }

  private tokens = 0;
  private tokensAt = 0;

  /** The policer's verdict on a packet: false if it is over the rate. */
  private policed(bytes: number): boolean {
    const kbps = this.profile.policeKbps;
    if (kbps === undefined) return false;
    const depth = (kbps * (this.profile.policeBurstMs ?? 50)) / 8;
    const now = this.world.now;
    this.tokens = Math.min(depth, this.tokens + ((now - this.tokensAt) * kbps) / 8);
    this.tokensAt = now;
    if (this.tokens < bytes) return true;
    this.tokens -= bytes;
    return false;
  }

  private fly(packet: Uint8Array): void {
    if (this.policed(packet.byteLength) || this.loses()) {
      this.lost++;
      return;
    }
    const delay = this.profile.delayMs + this.random() * (this.profile.jitterMs ?? 0);
    this.world.after(delay, () => {
      this.delivered++;
      this.onmessage?.(packet, this.world.now);
    });
  }
}
