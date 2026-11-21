/**
 * Running the coordinator's Worker locally with `wrangler dev`, for the contract suite and the
 * load measurement. Nothing here deploys anything: `wrangler dev` runs the Worker in a local
 * workerd, with its storage in a directory of the caller's choosing.
 *
 * Wrangler is not a dependency of the repository. It is found through `OVERLAY_WRANGLER` (the
 * path of its binary, as CI sets it), or `node_modules/.bin/wrangler`.
 *
 * Owner: E-coordinator. Not used outside tests and measurements.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CONFIG = join(import.meta.dirname, "wrangler.jsonc");

export function findWrangler(): string | null {
  const candidates = [process.env.OVERLAY_WRANGLER, join(ROOT, "node_modules", ".bin", "wrangler")];
  return candidates.find((path): path is string => !!path && existsSync(path)) ?? null;
}

/**
 * Runs `wrangler dev` on `port` (and its inspector on `port + 1`) until killed; resolves once it
 * answers health. In its own process group, so that `killGroup` takes workerd with it.
 */
export async function startWrangler(binary: string, persistTo: string, port: number, vars: Record<string, string>): Promise<ChildProcess> {
  const args = ["dev", "-c", CONFIG, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(port + 1), "--persist-to", persistTo, "--show-interactive-dev-session=false", "--log-level", "warn"];
  for (const [key, value] of Object.entries(vars)) args.push("--var", `${key}:${value}`);
  const child = spawn(binary, args, { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" } });
  let output = "";
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-4000);
    if (process.env.OVERLAY_WRANGLER_LOG) process.stderr.write(chunk);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited (${child.exitCode}):\n${output}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/overlay/v1/health`)).ok) return child;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await killGroup(child);
  throw new Error(`wrangler dev did not answer within 60 s:\n${output}`);
}

export function killGroup(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.pid === undefined) return Promise.resolve();
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  return exited;
}

/** Removes what `wrangler dev` leaves beside the config (its bundle), which lint would otherwise read. */
export function cleanUp(): void {
  rmSync(join(import.meta.dirname, ".wrangler"), { recursive: true, force: true });
}

/** Makes sure a runner stopped from outside does not leave workerd behind. */
export function killOnExit(current: () => ChildProcess | null): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void killGroup(current()).finally(() => process.exit(130));
    });
  }
  process.once("exit", () => {
    const child = current();
    if (child?.pid !== undefined && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Gone already.
      }
    }
  });
}
