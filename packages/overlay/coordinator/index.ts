/**
 * coordinator's public face: the core and the browser's client. The two entry points are
 * imported by path (./durableObject, ./node), never from here, so a browser bundle cannot pull
 * in Node's `http` or a Worker's globals by accident. Owner: E-coordinator. See ./README.md.
 */
import { createClient } from "./client";
import { createCore } from "./core";
import type { CoordinatorClient, CoordinatorClientOptions, CoordinatorCore, CoordinatorCoreOptions } from "./types";

export type * from "./types";

/** The HTTP and WebSocket paths, under the coordinator's origin (SPEC §6.2). */
export const ROUTES = {
  health: "/overlay/v1/health",
  room: (room: string) => `/overlay/v1/rooms/${encodeURIComponent(room)}`,
  ws: (room: string) => `/overlay/v1/rooms/${encodeURIComponent(room)}/ws`,
} as const;

/** WebSocket close codes the coordinator uses (4000–4999 are free for applications). */
export const CLOSE = { badTicket: 4001, full: 4002, kicked: 4003, ended: 4004, badMessage: 4005, replaced: 4006 } as const;

export const createCoordinatorCore: (options: CoordinatorCoreOptions) => CoordinatorCore = createCore;

export const createCoordinatorClient: (options: CoordinatorClientOptions) => CoordinatorClient = createClient;
