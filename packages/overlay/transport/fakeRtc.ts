/**
 * A stand-in for `RTCPeerConnection`, for tests: offer and answer with rollback, candidates,
 * negotiated data channels, and a "network" that opens them. Not used by the engine itself.
 *
 * Owner: E-transport+topology.
 */
import type { Clock } from "../runtime";

type FakeDescription = { type: "offer" | "answer"; sdp: string };

/**
 * The world fake connections live in: it finds the other end from the "SDP" and opens the
 * channels once offer and answer have been exchanged.
 */
export class FakeNet {
  readonly pcs = new Map<number, FakePeerConnection>();
  private nextId = 1;
  /** How long after the answer the channels open, and how long a message takes. */
  connectMs = 20;
  latencyMs = 1;
  /** Counted over every connection, for tests that check how much signalling was needed. */
  offers = 0;

  constructor(readonly clock: Clock) {}

  /** What `TransportOptions.peerConnection` wants. */
  factory = (): RTCPeerConnection => {
    const pc = new FakePeerConnection(this, this.nextId++);
    this.pcs.set(pc.id, pc);
    return pc as unknown as RTCPeerConnection;
  };
}

/** One data channel end. The other end is found by its id when the connection opens. */
export class FakeDataChannel {
  readyState: "connecting" | "open" | "closing" | "closed" = "connecting";
  /** Tests set this to play a backed-up channel. */
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;
  other: FakeDataChannel | null = null;
  /** Everything handed to `send`, in order. */
  readonly sent: (Uint8Array | string)[] = [];
  /** Tests set this to lose what is sent. */
  blackhole = false;

  constructor(
    private readonly net: FakeNet,
    readonly label: string,
    readonly id: number,
  ) {}

  send(data: Uint8Array | string): void {
    if (this.readyState !== "open") throw new Error("InvalidStateError: channel is not open");
    const copy = typeof data === "string" ? data : data.slice();
    this.sent.push(copy);
    const other = this.other;
    if (!other || this.blackhole) return;
    this.net.clock.setTimeout(() => {
      if (other.readyState === "open") other.onmessage?.({ data: typeof copy === "string" ? copy : (copy.buffer as ArrayBuffer) });
    }, this.net.latencyMs);
  }

  open(): void {
    if (this.readyState !== "connecting") return;
    this.readyState = "open";
    this.onopen?.();
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.onclose?.();
    const other = this.other;
    if (other) this.net.clock.setTimeout(() => other.close(), this.net.latencyMs);
  }
}

/** Enough of `RTCPeerConnection` for the link: offer/answer with rollback, candidates, negotiated channels. */
export class FakePeerConnection {
  signalingState: "stable" | "have-local-offer" | "have-remote-offer" | "closed" = "stable";
  connectionState = "new";
  iceConnectionState = "new";
  localDescription: FakeDescription | null = null;
  remoteDescription: FakeDescription | null = null;
  onicecandidate: ((event: { candidate: { toJSON(): unknown } | null }) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly channels = new Map<number, FakeDataChannel>();
  private negotiated = false;
  private remoteId: number | null = null;
  private sentCandidate = false;
  private busy = 0;
  /** Tests set this to make the route look like a TURN one: this end's candidate is a relay. */
  relayed = false;
  /** The same for the other end's candidate: the route goes through the other side's TURN. */
  remoteRelayed = false;
  /** What `setConfiguration` was last given, and how many times ICE was restarted ([D82]). */
  configuration: { iceServers?: unknown[] } = {};
  iceRestarts = 0;

  getConfiguration(): { iceServers?: unknown[] } {
    return { ...this.configuration };
  }

  setConfiguration(configuration: { iceServers?: unknown[] }): void {
    this.configuration = configuration;
  }

  restartIce(): void {
    this.iceRestarts++;
  }

  constructor(
    private readonly net: FakeNet,
    readonly id: number,
  ) {}

  createDataChannel(label: string, init: { id?: number }): FakeDataChannel {
    const channel = new FakeDataChannel(this.net, label, init.id ?? this.channels.size);
    const first = this.channels.size === 0;
    this.channels.set(channel.id, channel);
    if (first) {
      // A task of its own, as in a browser, and not while a description is being applied.
      this.net.clock.setTimeout(() => {
        if (!this.negotiated && this.busy === 0 && this.signalingState === "stable") this.onnegotiationneeded?.();
      }, 1);
    }
    return channel;
  }

  async setLocalDescription(): Promise<void> {
    this.busy++;
    await Promise.resolve();
    this.busy--;
    if (this.signalingState === "closed") throw new Error("InvalidStateError: closed");
    if (this.signalingState === "have-remote-offer") {
      this.localDescription = { type: "answer", sdp: `fake ${this.id}` };
      this.signalingState = "stable";
      this.settle();
    } else {
      this.localDescription = { type: "offer", sdp: `fake ${this.id}` };
      this.signalingState = "have-local-offer";
      this.net.offers++;
    }
    if (!this.sentCandidate) {
      this.sentCandidate = true;
      this.net.clock.setTimeout(() => {
        this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: `candidate:fake ${this.id}`, sdpMid: "0", sdpMLineIndex: 0 }) } });
        this.onicecandidate?.({ candidate: null });
      }, 0);
    }
  }

  async setRemoteDescription(description: FakeDescription): Promise<void> {
    this.busy++;
    await Promise.resolve();
    this.busy--;
    if (this.signalingState === "closed") throw new Error("InvalidStateError: closed");
    const remoteId = Number(description.sdp.split(" ")[1]);
    if (description.type === "offer") {
      // From have-local-offer this is the implicit rollback of perfect negotiation.
      this.remoteDescription = description;
      this.remoteId = remoteId;
      this.signalingState = "have-remote-offer";
    } else {
      if (this.signalingState !== "have-local-offer") throw new Error("InvalidStateError: an answer without an offer");
      this.remoteDescription = description;
      this.remoteId = remoteId;
      this.signalingState = "stable";
      this.settle();
    }
  }

  async addIceCandidate(candidate: unknown): Promise<void> {
    await Promise.resolve();
    if (!this.remoteDescription) throw new Error("InvalidStateError: a candidate before a description");
    void candidate;
  }

  async getStats(): Promise<Map<string, Record<string, unknown>>> {
    return new Map<string, Record<string, unknown>>([
      ["pair", { id: "pair", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "local", remoteCandidateId: "remote" }],
      ["local", { id: "local", type: "local-candidate", candidateType: this.relayed ? "relay" : "host" }],
      ["remote", { id: "remote", type: "remote-candidate", candidateType: this.remoteRelayed ? "relay" : "host" }],
    ]);
  }

  /** Offer and answer are done on this side: when they are on the other too, the channels open. */
  private settle(): void {
    this.negotiated = true;
    const other = this.remoteId === null ? undefined : this.net.pcs.get(this.remoteId);
    if (!other || !other.negotiated || other.remoteId !== this.id) return;
    this.net.clock.setTimeout(() => {
      for (const pc of [this as FakePeerConnection, other]) {
        if (pc.signalingState === "closed") return;
        pc.iceConnectionState = "connected";
        pc.oniceconnectionstatechange?.();
        pc.connectionState = "connected";
        pc.onconnectionstatechange?.();
      }
      for (const [id, channel] of this.channels) {
        const peer = other.channels.get(id);
        if (!peer) continue;
        channel.other = peer;
        peer.other = channel;
        channel.open();
        peer.open();
      }
    }, this.net.connectMs);
  }

  /** A tab that is killed: nothing more arrives from it, and nobody is told. */
  vanish(): void {
    for (const channel of this.channels.values()) {
      channel.blackhole = true;
      channel.onmessage = null;
      if (channel.other) channel.other.other = null;
    }
  }

  close(): void {
    if (this.signalingState === "closed") return;
    this.signalingState = "closed";
    this.connectionState = "closed";
    for (const channel of this.channels.values()) channel.close();
  }
}
