/**
 * topology's public face. Owner: E-transport+topology. See ./README.md.
 */
import { notImplemented } from "../runtime";
import type { GopCache, GopCacheOptions, JudgeRelay, OverlayNode, OverlayNodeOptions, ParentCost, ParentSelector } from "./types";

export type * from "./types";

export const createGopCache: (options: GopCacheOptions) => GopCache = () => notImplemented("E-transport+topology", "topology.createGopCache");

export const createParentSelector: (options: { rebalanceMinMs: number }) => ParentSelector = () =>
  notImplemented("E-transport+topology", "topology.createParentSelector");

/** SPEC §8.3. Also imported by the coordinator's placement, so both rank parents the same way. */
export const parentCost: ParentCost = () => notImplemented("E-transport+topology", "topology.parentCost");

/** SPEC §8.1–§8.2. Also imported by the coordinator, which is who decides. */
export const judgeRelay: JudgeRelay = () => notImplemented("E-transport+topology", "topology.judgeRelay");

export const createOverlayNode: (options: OverlayNodeOptions) => OverlayNode = () => notImplemented("E-transport+topology", "topology.createOverlayNode");
