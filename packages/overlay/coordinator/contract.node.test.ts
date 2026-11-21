/**
 * The contract suite (./contract.ts) against the Node entry point (PLAN K3), on port 4260.
 */
import { after, before } from "node:test";
import { coordinatorContract } from "./contract";
import type { ContractTarget } from "./contract";
import { startNodeCoordinator } from "./node";
import { ADMISSION_SECRET, SERVER_SECRET } from "./testkit";
import type { NodeCoordinator } from "./types";

const PORT = Number(process.env.OVERLAY_CONTRACT_NODE_PORT ?? 4260);
const VIEWER_CAP = 4;

/** What a Durable Object's storage is in production: kept across a kill, so a restart resumes. */
const storage = new Map<string, Map<string, string>>();
let server: NodeCoordinator | null = null;
const start = async () => {
  server = await startNodeCoordinator({ port: PORT, admissionSecret: ADMISSION_SECRET, serverSecret: SERVER_SECRET, viewerCap: VIEWER_CAP, storage, seed: 1 });
};

const target: ContractTarget = {
  url: `http://127.0.0.1:${PORT}`,
  viewerCap: VIEWER_CAP,
  kill: async () => {
    await server?.kill();
    server = null;
  },
  restart: start,
};

before(start);
after(async () => {
  await server?.close();
});

coordinatorContract("Node (ws)", () => target);
