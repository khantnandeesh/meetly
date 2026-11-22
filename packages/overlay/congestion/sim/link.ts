/**
 * A fake of transport's `Link` (transport/types.ts), over one outgoing `Pipe` and whatever the
 * caller feeds back in. It is what congestion's fake node sends through, so the send path of
 * SPEC §3.3 runs against the interface the real node uses, not a shortcut around it. It stands in
 * until E-transport+topology's link is merged; nothing here imports their implementation.
 *
 * What it does of the real one: `sendPacket` sets `linkSeq` and `sendMs` in the packet, in place,
 * and nothing else (the MEDIA header's per-hop pair, or the common one at bytes 2–5); it counts;
 * `bufferedAmount` is the channel's. What it does not: no peer connection, no `hello`, no send
 * classes or shedding (`packetsShed` stays 0: congestion's gate is the only thing that decides
 * what not to send here), and the reliable channel is whatever `ctl` the caller passes.
 */
import { PacketType, ms16, peekPacketType, type PeerId, type PeerMessage } from "../../protocol";
import type { Link, LinkCloseReason, LinkCounters, LinkEvents, LinkState, SendClass } from "../../transport/types";
import { Emitter } from "../emitter";
import type { Pipe } from "./world";

export class PipeLink extends Emitter<LinkEvents> implements Link {
  state: LinkState = "open";
  readonly turn = false;
  /** Every packet handed to `sendPacket`, by class: what a test reads the send path from. */
  readonly sentByClass: Record<SendClass, number> = { control: 0, audio: 0, video: 0, replay: 0 };
  /** Every message handed to `sendMessage`, in order. */
  readonly messagesSent: PeerMessage[] = [];
  private linkSeq = 0;
  private readonly count: LinkCounters = { packetsSent: 0, packetsReceived: 0, bytesSent: 0, bytesReceived: 0, packetsShed: 0 };

  /**
   * @param clock this peer's clock, as transport's `Clock.now()` would be.
   * @param ctl what carries `sendMessage` to the other side; absent, messages are only recorded.
   */
  constructor(
    readonly peer: PeerId,
    private readonly out: Pipe,
    private readonly clock: () => number,
    private readonly ctl?: (message: PeerMessage) => void,
  ) {
    super();
  }

  get bufferedAmount(): number {
    return this.out.bufferedAmount;
  }

  sendPacket(packet: Uint8Array, sendClass: SendClass): boolean {
    if (this.state !== "open") return false;
    const type = peekPacketType(packet);
    const at = type === PacketType.Media || type === PacketType.Parity ? 26 : 2;
    if (type === null || packet.byteLength < at + 4) return false;
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    view.setUint16(at, this.linkSeq);
    view.setUint16(at + 2, ms16(this.clock()));
    this.linkSeq = (this.linkSeq + 1) & 0xffff;
    this.out.send(packet);
    this.sentByClass[sendClass]++;
    this.count.packetsSent++;
    this.count.bytesSent += packet.byteLength;
    return true;
  }

  sendMessage(message: PeerMessage): void {
    if (this.state === "closed") return;
    this.messagesSent.push(message);
    this.ctl?.(message);
  }

  counters(): LinkCounters {
    return { ...this.count };
  }

  close(reason: LinkCloseReason = "local"): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.emit("state", "closed", reason);
  }

  /** A packet arrived from the other side, at this peer's `receivedAt`. */
  deliver(packet: Uint8Array, receivedAt: number): void {
    if (this.state !== "open") return;
    this.count.packetsReceived++;
    this.count.bytesReceived += packet.byteLength;
    this.emit("packet", packet, receivedAt);
  }

  /** A message arrived on the reliable channel. */
  deliverMessage(message: PeerMessage): void {
    if (this.state !== "open") return;
    this.emit("message", message);
  }
}
