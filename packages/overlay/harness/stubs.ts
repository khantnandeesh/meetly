/**
 * Which parts of the package are still stubs. Every report names them, so a number measured
 * against a stand-in is never mistaken for a number about the overlay (PLAN H6).
 *
 * Owner: E-harness.
 */
import { NotImplementedError, createOverlaySource, createOverlayViewer } from "../index";
import { createLayerGate, createLinkEstimator } from "../congestion/index";
import { createCoordinatorCore } from "../coordinator/index";
import { startNodeCoordinator } from "../coordinator/node";
import { createJitterBuffer, createPlayer } from "../media/index";
import { createGopCache, createOverlayNode, judgeRelay } from "../topology/index";
import { createLinkManager, createReassembler } from "../transport/index";

const PROBES: [name: string, call: () => unknown][] = [
  ["index.createOverlayViewer", () => createOverlayViewer({ coordinatorUrl: "", ticket: async () => "" })],
  ["index.createOverlaySource", () => createOverlaySource({ coordinatorUrl: "", ticket: async () => "" })],
  ["transport.createLinkManager", () => createLinkManager(undefined as never)],
  ["transport.createReassembler", () => createReassembler(undefined as never)],
  ["topology.createGopCache", () => createGopCache({ maxMs: 0, maxBytes: 0 })],
  ["topology.createOverlayNode", () => createOverlayNode(undefined as never)],
  ["topology.judgeRelay", () => judgeRelay(undefined as never, undefined as never, 0, undefined as never)],
  ["media.createJitterBuffer", () => createJitterBuffer(undefined as never)],
  ["media.createPlayer", () => createPlayer(undefined as never)],
  ["congestion.createLinkEstimator", () => createLinkEstimator()],
  ["congestion.createLayerGate", () => createLayerGate({ bitrateKbps: 0, temporalLayers: 1, frameIntervalMs: 33 })],
  ["coordinator.createCoordinatorCore", () => createCoordinatorCore(undefined as never)],
  ["coordinator.startNodeCoordinator", () => startNodeCoordinator(undefined as never)],
];

const OWNERS: Record<string, string> = {
  index: "architect",
  transport: "E-transport+topology",
  topology: "E-transport+topology",
  media: "E-media",
  congestion: "E-congestion",
  coordinator: "E-coordinator",
};

/** Every factory a gate run depends on, and whose it is. */
export const MODULES: { name: string; owner: string }[] = PROBES.map(([name]) => ({ name, owner: OWNERS[name.split(".")[0]] ?? "?" }));

/** The names of the factories that still throw `NotImplementedError`. A factory that throws anything else is built: it only disliked the probe's arguments. */
export function probeStubs(): string[] {
  const stubbed: string[] = [];
  for (const [name, call] of PROBES) {
    try {
      const result = call();
      // An async factory reports through its promise; a probe must not leave a rejection unhandled.
      if (result instanceof Promise) result.catch(() => undefined);
    } catch (error) {
      if (error instanceof NotImplementedError) stubbed.push(name);
    }
  }
  return stubbed;
}
