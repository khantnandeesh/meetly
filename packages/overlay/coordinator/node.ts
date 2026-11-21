/**
 * The coordinator as a Node process: `CoordinatorCore` behind an HTTP server and `ws`. For unit
 * tests and the swarm harness, not for production. It must serve exactly the paths and messages
 * the Durable Object does (./durableObject.ts); a contract test runs one suite against both
 * (PLAN.md, E-coordinator M3).
 *
 * Owner: E-coordinator.
 */
import { notImplemented } from "../runtime";
import type { NodeCoordinator, NodeCoordinatorOptions } from "./types";

export const startNodeCoordinator: (options: NodeCoordinatorOptions) => Promise<NodeCoordinator> = () =>
  notImplemented("E-coordinator", "coordinator/node.startNodeCoordinator");
