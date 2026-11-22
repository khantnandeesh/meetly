/**
 * The contract suite (./contract.ts) against the Durable Object entry point (PLAN K4), run by
 * `wrangler dev` on ports 4261 (HTTP) and 4262 (inspector). Nothing is deployed: `wrangler dev`
 * runs the Worker in a local workerd, with its storage in a temporary directory.
 *
 * Wrangler is found as ./wranglerDev.ts says; without it the suite says so and skips.
 */
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { coordinatorContract } from "./contract";
import type { ContractTarget } from "./contract";
import { ADMISSION_SECRET, SERVER_SECRET } from "./testkit";
import { cleanUp, findWrangler, killGroup, killOnExit, startWrangler } from "./wranglerDev";

const PORT = Number(process.env.OVERLAY_CONTRACT_WORKER_PORT ?? 4261);
const VIEWER_CAP = 4;
const wrangler = findWrangler();
const url = `http://127.0.0.1:${PORT}`;

if (!wrangler) {
  describe("coordinator contract: Durable Object (wrangler dev)", () => {
    it("needs wrangler", (t) => t.skip("wrangler not found: set OVERLAY_WRANGLER to its binary (CI does)"));
  });
} else {
  const persistTo = mkdtempSync(join(tmpdir(), "overlay-wrangler-"));
  const vars = { OVERLAY_ADMISSION_SECRET: ADMISSION_SECRET, OVERLAY_SERVER_SECRET: SERVER_SECRET, OVERLAY_VIEWER_CAP: String(VIEWER_CAP), OVERLAY_TEST_HOOKS: "1" };
  let child: ChildProcess | null = null;
  killOnExit(() => child);

  const target: ContractTarget = {
    url,
    viewerCap: VIEWER_CAP,
    kill: async () => {
      await killGroup(child);
      child = null;
    },
    restart: async () => {
      child = await startWrangler(wrangler, persistTo, PORT, vars);
    },
    evict: async (room) => {
      const response = await fetch(`${url}/overlay/v1/rooms/${encodeURIComponent(room)}/evict`, { method: "POST", headers: { authorization: `Bearer ${SERVER_SECRET}` } });
      if (!response.ok) throw new Error(`evict: ${response.status}`);
    },
  };

  before(target.restart, { timeout: 70_000 });
  after(async () => {
    await killGroup(child);
    rmSync(persistTo, { recursive: true, force: true });
    cleanUp();
  });

  coordinatorContract("Durable Object (wrangler dev)", () => target);
}
