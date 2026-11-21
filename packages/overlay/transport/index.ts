/**
 * transport's public face. Owner: E-transport+topology. See ./README.md.
 */
import { notImplemented } from "../runtime";
import type { Capabilities, IceServer } from "../protocol";
import { createReassembler as createReassemblerImpl } from "./reassembler";
import type { LinkManager, Reassembler, ReassemblerOptions, TransportOptions } from "./types";

export type * from "./types";

/** The data channels every link has. Negotiated out of band (`negotiated: true`), so no `datachannel` event is needed. */
export const CHANNELS = {
  /** Reliable and ordered: `PeerMessage` as JSON text. */
  ctl: { id: 0, label: "ctl", ordered: true },
  /** Unordered, no retransmission: every binary packet type. */
  media: { id: 1, label: "media", ordered: false, maxRetransmits: 0 },
} as const;

export const createLinkManager: (options: TransportOptions) => LinkManager = () =>
  notImplemented("E-transport+topology", "transport.createLinkManager");

export const createReassembler: (options: ReassemblerOptions) => Reassembler = createReassemblerImpl;

/**
 * What kind of NAT this browser is behind, for `Capabilities.nat` (SPEC §8.1): gathers
 * candidates against two STUN servers and compares the addresses they report.
 */
export const probeNat: (ice: IceServer[]) => Promise<Capabilities["nat"]> = () => notImplemented("E-transport+topology", "transport.probeNat");
