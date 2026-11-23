/**
 * transport: one `Link` per neighbour, each a WebRTC peer connection with two data channels.
 * It knows about bytes, packets and frames; it does not know about trees (topology), bitrates
 * (congestion) or codecs (media). SPEC §3, §4.3, §5.
 *
 * Owner: E-transport+topology. This file is the module's contract with the others: change it
 * only as docs/overlay/PLAN.md "Changing an interface" says.
 */
import type { Clock, Listenable, Logger } from "../runtime";
import type { IceServer, MediaHeader, NackItem, PeerId, PeerMessage, SignalData } from "../protocol";
import type { ReceivedFrame } from "../types";

/**
 * The least a data channel has to be for the transport to use it. `RTCDataChannel` is one. The
 * harness wraps each channel in another that delays, drops and throttles (`wrapChannel`), which
 * is the only way to impair a data channel: DevTools throttling does not reach them.
 */
export interface PacketChannel {
  readonly readyState: "connecting" | "open" | "closing" | "closed";
  /** Bytes accepted by `send` that have not left yet. */
  readonly bufferedAmount: number;
  send(data: Uint8Array | string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((data: ArrayBuffer | string) => void) | null;
}

/** Which of a link's two channels. SPEC §3.2. */
export type ChannelKind = "ctl" | "media";

/**
 * What a packet is, to the send queue. When a link cannot take everything, lower classes are
 * dropped or delayed first: control (heartbeat, feedback, nack) and audio always go ahead of
 * video, and live video ahead of replay.
 */
export type SendClass = "control" | "audio" | "video" | "replay";

export type LinkState = "connecting" | "open" | "closed";

/** Why a link closed, as far as this side knows. */
export type LinkCloseReason = "local" | "remote-bye" | "ice-failed" | "channel-closed" | "auth-failed" | "timeout";

export type LinkCounters = {
  packetsSent: number;
  packetsReceived: number;
  bytesSent: number;
  bytesReceived: number;
  /** Packets the send queue dropped rather than hand to a channel that was backed up. */
  packetsShed: number;
};

export type LinkEvents = {
  state: [state: LinkState, reason?: LinkCloseReason];
  /**
   * A packet arrived on the unreliable channel. `packet` is only valid during the call: copy it
   * to keep it. `receivedAt` is this machine's `Clock`.
   */
  packet: [packet: Uint8Array, receivedAt: number];
  /** A message arrived on the reliable channel, already validated. `hello` is handled by the link itself. */
  message: [message: PeerMessage];
};

/** A connection to one other peer. There is at most one per peer, whatever flows on it. */
export interface Link extends Listenable<LinkEvents> {
  readonly peer: PeerId;
  readonly state: LinkState;
  /**
   * The connection goes through a TURN server: the selected candidate pair's local or remote
   * candidate is "relay". Known once `state` is "open", and read again when the selected pair
   * changes or ICE reconnects (SPEC §5.1 [D80]).
   */
  readonly turn: boolean;
  /** Bytes the media channel is holding (`bufferedAmount`). */
  readonly bufferedAmount: number;
  /**
   * Sends one packet, already encoded, on the unreliable channel. The link sets `linkSeq` and
   * `sendMs` in it (and nothing else), in place. False if the packet was shed.
   */
  sendPacket(packet: Uint8Array, sendClass: SendClass): boolean;
  /** Sends on the reliable channel. Queued until the link is open. */
  sendMessage(message: PeerMessage): void;
  counters(): LinkCounters;
  close(reason?: LinkCloseReason): void;
}

/** How signalling reaches another peer: through the coordinator, or over the overlay (`sig`). */
export interface Signaler {
  send(to: PeerId, data: SignalData): void;
  onSignal(listener: (from: PeerId, data: SignalData) => void): () => void;
}

export type TransportOptions = {
  self: PeerId;
  /** This peer's grant, shown in `hello` on every link. */
  grant: () => string;
  /** Checks the other side's `hello`. A link whose peer fails it is closed with "auth-failed". */
  verifyPeer: (peer: PeerId, grant: string) => Promise<boolean>;
  signaler: Signaler;
  /** The ICE servers links start with; `LinkManager.setIce` replaces them. */
  ice: IceServer[];
  clock: Clock;
  logger?: Logger;
  /** The harness's impairment shim. Called once per channel as it is made. */
  wrapChannel?: (channel: PacketChannel, info: { peer: PeerId; kind: ChannelKind }) => PacketChannel;
  /** For tests: something that behaves like `RTCPeerConnection`. */
  peerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
  /**
   * Above this much in the media channel's own buffer, packets wait in the link's queue, where
   * their class decides the order. Default 64 kB.
   */
  highWaterBytes?: number;
  /** The most video and replay a link's queue holds before shedding. Default 1 MB. */
  maxQueueBytes?: number;
};

export type LinkManagerEvents = {
  /** Another peer opened a link to us. */
  incoming: [link: Link];
};

/** Every link this peer has. */
export interface LinkManager extends Listenable<LinkManagerEvents> {
  /** The link to `peer`, started if there is none. Both sides may call this at once (SPEC §5.1). */
  connect(peer: PeerId): Link;
  get(peer: PeerId): Link | undefined;
  links(): Link[];
  closeAll(): void;
  /**
   * SPEC §5.1 [D80]: fresh ICE servers (new TURN credentials, before the old ones expire). Links
   * made from now on use them; open links are given them, and one whose route goes through TURN
   * restarts ICE, make-before-break, to be allocated a relay with them. Optional: a test double
   * may leave it out.
   */
  setIce?(ice: IceServer[]): void;
}

/**
 * Puts frames back together from packets, for this peer's own playout. Forwarding does not wait
 * for it: a relay sends each packet on as it arrives.
 */
export interface Reassembler {
  /** A whole frame if `packet` completed one, else null. Duplicates and packets of expired frames are counted and dropped. */
  push(packet: Uint8Array, header: MediaHeader, from: PeerId, receivedAt: number): ReceivedFrame | null;
  /**
   * Fragments that should have arrived by `now` and have not, oldest first, at most `max` items:
   * what to NACK. A gap is "due" once a later packet has arrived and the reordering window has passed.
   * Each call counts as asking: a fragment is named once, and then `nackRetries` more times.
   */
  missing(now: number, max: number): NackItem[];
  /** Forget frames older than `frameId` on `streamId`: they are past their playout time. */
  expireBefore(streamId: number, frameId: number): void;
  /**
   * Any packet arrived from `from` with this `linkSeq` (pushed media is noted by `push`). It
   * lets `missing` tell a frame that was lost from one the sender never sent on this link (a
   * layer it is shedding): see ./reassembler.ts.
   */
  noteLinkPacket(from: PeerId, linkSeq: number): void;
  /**
   * Whether frame `frameId`, which never arrived, was never sent on the link either: the frames
   * on each side of it arrived from the same sender with nothing missing from its link sequence
   * between them (a layer it was shedding). False when that cannot be told.
   */
  neverSent(streamId: number, frameId: number): boolean;
  /**
   * `late`: packets of frames already expired. `malformed`: packets that contradict their
   * frame's other packets, or claim more fragments than `maxFragments`.
   */
  counters(): { frames: number; duplicates: number; expiredIncomplete: number; late: number; malformed: number };
}

export type ReassemblerOptions = {
  clock: Clock;
  /** How long a gap may be mere reordering, before it is called missing. */
  reorderMs: number | (() => number);
  /** The most incomplete frames held per stream. */
  maxPending: number;
  /** How many more times `missing` names a fragment after the first (SPEC §4.6). Default 1. */
  nackRetries?: number;
  /** How long after naming a fragment `missing` may name it again: about a round trip. Default 100 ms. */
  retryMs?: () => number;
  /** A frame claiming more fragments than this is dropped, so a peer cannot make this one hold much. Default 4,096. */
  maxFragments?: number;
};
