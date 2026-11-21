/**
 * Impairment: what a bad network does to one direction of one link, injected where the transport
 * hands a packet to its channel (SPEC §13.1). DevTools throttling does not reach data channels,
 * so this is the only way to test the overlay against delay, jitter, loss and a slow uplink.
 *
 * Two layers. `createLinkModel` is the arithmetic: given a packet's size and the time, it says
 * whether the packet is dropped and when it arrives. It has no timers, so its statistics are
 * unit tests over 100,000 packets (PLAN H1). `createImpairment` puts that model behind a
 * `PacketChannel` and delivers on a `Clock`.
 *
 * What the numbers of an `ImpairmentProfile` mean here (the meeting point with E-congestion):
 *
 * - `lossPct` is the share of packets lost, overall. With `burst`, losses come in runs
 *   (Gilbert–Elliott): the link is "good" or "bad", moves between them with `enterPct` and
 *   `leavePct` per packet, and loses `lossPctInBurst` of packets while bad. The loss while good
 *   is then whatever makes the overall share come to `lossPct`, so "3% in bursts" still loses 3%.
 *   A burst lasts 100 / `leavePct` packets on average.
 * - `kbps` is a bottleneck with a first-in-first-out queue. A packet that would wait longer than
 *   `queueMs` is dropped (tail drop). Loss is decided before the queue, so the cap is the most
 *   that is ever delivered.
 * - `delayMs` is added to every packet, after the queue. `jitterMs` adds a further delay, uniform
 *   in 0..jitterMs and independent per packet, so packets overtake each other. The mean added
 *   delay of an uncapped link is `delayMs + jitterMs / 2`.
 * - On the reliable channel nothing is lost and nothing overtakes: a packet that would have been
 *   dropped arrives `retransmitMs` later instead, and holds back everything behind it.
 *
 * Whose profile. SPEC §13.1 says each direction of a link suffers its sender's profile, and that
 * is what delay, jitter and loss do here. The rate cap is the exception, because it has to be:
 * the gate's "slow" viewers are capped at 900 kbps "under the session's bitrate" (§12.3), and a
 * viewer that slow is a leaf, which sends almost nothing. A cap on what it sends would cap
 * nothing. So `kbps` is the peer's access link in both directions: it caps what the peer sends
 * and, with a queue of its own, what the peer receives.
 *
 * Owner: E-harness.
 */
import type { Cancel, Clock } from "../runtime";
import type { PeerId } from "../protocol";
import type { ChannelKind, PacketChannel } from "../transport/types";
import { mixSeed, realClock, seededRandom } from "./clock";
import type { ImpairmentCounters, ImpairmentFactory, ImpairmentProfile } from "./types";

export const DEFAULT_QUEUE_MS = 300;
/** The retransmission time of a reliable channel when a profile does not give one. */
export const defaultRetransmitMs = (profile: ImpairmentProfile): number => profile.retransmitMs ?? Math.max(200, 2 * profile.delayMs);

/** What the model decides for one packet. */
export type Verdict = {
  /** Never delivered. */
  dropped: boolean;
  /** Why: lost on the way, or the bottleneck's queue was full. Null when delivered. */
  why: "loss" | "queue" | null;
  /** This machine's `Clock` time at which it arrives. Meaningless when dropped. */
  deliverAt: number;
  /** The link was in a burst when this packet was sent. */
  inBurst: boolean;
};

export interface LinkModel {
  /** Decides the fate of the next packet, `bytes` long, handed over at `now`. Call in sending order. */
  next(bytes: number, now: number): Verdict;
  /** Bytes waiting in the bottleneck's queue at `now`. */
  queuedBytes(now: number): number;
}

/** The loss while the link is "good" that makes a bursty profile's overall loss come to `lossPct`. */
export function goodStateLossPct(profile: ImpairmentProfile): number {
  const burst = profile.burst;
  if (!burst) return profile.lossPct;
  const enter = burst.enterPct / 100;
  const leave = burst.leavePct / 100;
  if (enter <= 0) return profile.lossPct;
  if (leave <= 0) return burst.lossPctInBurst;
  const bad = enter / (enter + leave);
  return Math.min(100, Math.max(0, (profile.lossPct - bad * burst.lossPctInBurst) / (1 - bad)));
}

/**
 * One direction of one link, as arithmetic. `reliable` is the ordered, reliable channel: late
 * instead of lost, and never out of order.
 */
export function createLinkModel(profile: ImpairmentProfile, random: () => number, reliable = false): LinkModel {
  const goodLoss = goodStateLossPct(profile) / 100;
  const burst = profile.burst;
  const bytesPerMs = profile.kbps ? profile.kbps / 8 : 0;
  const queueMs = profile.queueMs ?? DEFAULT_QUEUE_MS;
  const retransmitMs = defaultRetransmitMs(profile);
  let inBurst = false;
  /** When the bottleneck has sent everything it holds. */
  let queueFreeAt = -Infinity;
  /** The reliable channel's last delivery: nothing arrives before it. */
  let lastDeliverAt = -Infinity;

  return {
    next(bytes, now) {
      if (burst) {
        if (inBurst) {
          if (random() < burst.leavePct / 100) inBurst = false;
        } else if (random() < burst.enterPct / 100) inBurst = true;
      }
      const lost = random() < (inBurst && burst ? burst.lossPctInBurst / 100 : goodLoss);
      // Drawn for every packet, lost or not, so one packet's fate never shifts the next one's.
      const jitter = profile.jitterMs > 0 ? random() * profile.jitterMs : 0;
      if (lost && !reliable) return { dropped: true, why: "loss", deliverAt: 0, inBurst };

      let leaves = now;
      if (bytesPerMs > 0) {
        const starts = Math.max(now, queueFreeAt);
        if (starts - now > queueMs && !reliable) return { dropped: true, why: "queue", deliverAt: 0, inBurst };
        queueFreeAt = starts + bytes / bytesPerMs;
        leaves = queueFreeAt;
      }
      let deliverAt = leaves + profile.delayMs + jitter + (lost ? retransmitMs : 0);
      if (reliable) {
        deliverAt = Math.max(deliverAt, lastDeliverAt);
        lastDeliverAt = deliverAt;
      }
      return { dropped: false, why: null, deliverAt, inBurst };
    },
    queuedBytes(now) {
      return bytesPerMs > 0 ? Math.max(0, (queueFreeAt - now) * bytesPerMs) : 0;
    },
  };
}

/* ------------------------------ the channel ------------------------------ */

type Held = { at: number; order: number; data: Uint8Array | ArrayBuffer | string; bytes: number; inbound: boolean };
const before = (a: Held, b: Held): boolean => a.at < b.at || (a.at === b.at && a.order < b.order);

/** A binary heap of what is on its way, earliest first; ties in sending order. */
class Flight {
  private readonly heap: Held[] = [];
  get size(): number {
    return this.heap.length;
  }
  peek(): Held | undefined {
    return this.heap[0];
  }
  push(item: Held): void {
    const heap = this.heap;
    let i = heap.push(item) - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(heap[i], heap[parent])) break;
      [heap[i], heap[parent]] = [heap[parent], heap[i]];
      i = parent;
    }
  }
  pop(): Held | undefined {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let least = i;
        if (l < heap.length && before(heap[l], heap[least])) least = l;
        if (r < heap.length && before(heap[r], heap[least])) least = r;
        if (least === i) break;
        [heap[i], heap[least]] = [heap[least], heap[i]];
        i = least;
      }
    }
    return top;
  }
  clear(): void {
    this.heap.length = 0;
  }
}

export const emptyImpairmentCounters = (): ImpairmentCounters => ({ sent: 0, delivered: 0, lost: 0, queueDropped: 0, lateMsSum: 0, lateMsMax: 0 });

const byteLength = (data: Uint8Array | ArrayBuffer | string): number => (typeof data === "string" ? data.length : data.byteLength);

/**
 * The transport's `wrapChannel` hook, made from profiles. Only sending is impaired: each
 * direction of a link suffers its sender's profile (SPEC §13.1). `pick` is asked again whenever
 * a packet is sent, so a peer's network can change during a run; a link's random sequence
 * depends only on the seed, the two peers and the channel, so the same seed gives the same drops.
 */
export const createImpairment: ImpairmentFactory = (pick, seed, options = {}) => {
  const clock: Clock = options.clock ?? realClock();
  const self = options.self ?? "";
  const counters = options.counters ?? emptyImpairmentCounters();

  return (inner: PacketChannel, info: { peer: PeerId; kind: ChannelKind }): PacketChannel => {
    const reliable = info.kind === "ctl";
    const random = seededRandom(mixSeed(seed, self, info.peer, info.kind));
    const flight = new Flight();
    let profile: ImpairmentProfile | null = null;
    let model: LinkModel | null = null;
    /** The cap on what this peer receives: its own access link, the other way. */
    let downProfile: ImpairmentProfile | null = null;
    let down: LinkModel | null = null;
    let order = 0;
    let heldBytes = 0;
    let cancel: Cancel | null = null;
    let wakeAt = Infinity;
    /** While a reliable channel has anything on its way, nothing may go around it. */
    let lastReliableAt = -Infinity;

    const handOver = (data: Uint8Array | string): void => {
      if (inner.readyState !== "open") return;
      counters.delivered++;
      try {
        inner.send(data);
      } catch {
        // The channel closed under us: the packet is lost, as it would be.
      }
    };
    const pump = (): void => {
      cancel = null;
      wakeAt = Infinity;
      const now = clock.now();
      for (let head = flight.peek(); head && head.at <= now; head = flight.peek()) {
        flight.pop();
        heldBytes -= head.bytes;
        const late = now - head.at;
        counters.lateMsSum += late;
        if (late > counters.lateMsMax) counters.lateMsMax = late;
        if (head.inbound) wrapped.onmessage?.(head.data as ArrayBuffer | string);
        else handOver(head.data as Uint8Array | string);
      }
      schedule();
    };
    const schedule = (): void => {
      const head = flight.peek();
      if (!head) return;
      if (cancel && wakeAt <= head.at) return;
      cancel?.();
      wakeAt = head.at;
      cancel = clock.setTimeout(pump, Math.max(0, head.at - clock.now()));
    };
    const drop = (): void => {
      cancel?.();
      cancel = null;
      wakeAt = Infinity;
      flight.clear();
      heldBytes = 0;
    };

    const wrapped: PacketChannel = {
      get readyState() {
        return inner.readyState;
      },
      get bufferedAmount() {
        return inner.bufferedAmount + heldBytes;
      },
      send(data) {
        const wanted = pick({ self, peer: info.peer, kind: info.kind });
        if (wanted !== profile) {
          profile = wanted;
          model = wanted ? createLinkModel(wanted, random, reliable) : null;
        }
        counters.sent++;
        const now = clock.now();
        const bytes = byteLength(data);
        let at = now;
        if (model) {
          const verdict = model.next(bytes, now);
          if (verdict.dropped) {
            if (verdict.why === "queue") counters.queueDropped++;
            else counters.lost++;
            return;
          }
          at = verdict.deliverAt;
        }
        if (reliable) {
          at = Math.max(at, lastReliableAt);
          lastReliableAt = at;
        }
        if (at <= now) {
          // Nothing to wait for: do not pay for a timer.
          handOver(data);
          return;
        }
        // The caller may reuse its buffer for the next child (`writeHopFields`): keep our own copy.
        flight.push({ at, order: order++, data: typeof data === "string" ? data : data.slice(), bytes, inbound: false });
        heldBytes += bytes;
        schedule();
      },
      close() {
        drop();
        inner.close();
      },
      onopen: null,
      onclose: null,
      onmessage: null,
    };
    inner.onopen = () => wrapped.onopen?.();
    inner.onclose = () => {
      drop();
      wrapped.onclose?.();
    };
    inner.onmessage = (data) => {
      const wanted = pick({ self, peer: info.peer, kind: info.kind });
      if (wanted !== downProfile) {
        downProfile = wanted;
        down = wanted?.kbps ? createLinkModel({ name: wanted.name, delayMs: 0, jitterMs: 0, lossPct: 0, kbps: wanted.kbps, queueMs: wanted.queueMs }, random, reliable) : null;
      }
      if (!down) {
        wrapped.onmessage?.(data);
        return;
      }
      const now = clock.now();
      const bytes = byteLength(data);
      const verdict = down.next(bytes, now);
      if (verdict.dropped) {
        counters.queueDropped++;
        return;
      }
      if (verdict.deliverAt <= now) {
        wrapped.onmessage?.(data);
        return;
      }
      flight.push({ at: verdict.deliverAt, order: order++, data, bytes, inbound: true });
      schedule();
    };
    return wrapped;
  };
};
