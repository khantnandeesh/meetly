/**
 * transport's public face. Owner: E-transport+topology. See ./README.md.
 */
import { createLinkManager as createLinkManagerImpl } from "./link";
import { probeNat as probeNatImpl } from "./nat";
import type { Capabilities, IceServer } from "../protocol";
import { createReassembler as createReassemblerImpl } from "./reassembler";
import type { LinkManager, Reassembler, ReassemblerOptions, TransportOptions } from "./types";

export type * from "./types";

export { CHANNELS } from "./link";

export const createLinkManager: (options: TransportOptions) => LinkManager = createLinkManagerImpl;

export const createReassembler: (options: ReassemblerOptions) => Reassembler = createReassemblerImpl;

/**
 * What kind of NAT this browser is behind, for `Capabilities.nat` (SPEC §8.1): gathers
 * candidates against two STUN servers and compares the addresses they report.
 */
export const probeNat: (ice: IceServer[]) => Promise<Capabilities["nat"]> = probeNatImpl;
