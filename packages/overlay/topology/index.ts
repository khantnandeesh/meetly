/**
 * topology's public face. Owner: E-transport+topology. See ./README.md.
 */
import { createOverlayNode as createOverlayNodeImpl } from "./node";
import { createGopCache as createGopCacheImpl } from "./gopCache";
import type { GopCache, GopCacheOptions, OverlayNode, OverlayNodeOptions } from "./types";

export type * from "./types";

export const createGopCache: (options: GopCacheOptions) => GopCache = createGopCacheImpl;

/**
 * SPEC §8, all pure. `parentCost` (§8.3) and `judgeRelay` (§8.1–§8.2) are also imported by the
 * coordinator's placement, so that it and every peer rank the same way.
 */
export { createParentSelector, judgeRelay, parentCost } from "./scoring";

export const createOverlayNode: (options: OverlayNodeOptions) => OverlayNode = createOverlayNodeImpl;
