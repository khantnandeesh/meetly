/**
 * The harness from a terminal, and from CI. Run it through ./swarm.mjs, which adds Node's flags:
 *
 *   node packages/overlay/harness/swarm.mjs scenarios
 *   node packages/overlay/harness/swarm.mjs run proof-tree
 *   node packages/overlay/harness/swarm.mjs run gate-small --peers 8 --churn-s 40
 *   node packages/overlay/harness/swarm.mjs run gate --shard 2/8 --coordinator https://… --start-at 1767000000000 --ice stun
 *   node packages/overlay/harness/swarm.mjs coordinator --scenario gate --port 4280 --for 800
 *   node packages/overlay/harness/swarm.mjs report out/ --require valid
 *
 * Owner: E-harness.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startNodeCoordinator } from "../coordinator/node";
import type { NodeCoordinator } from "../coordinator/types";
import { buildReport, renderReport, reportJson } from "./report";
import { SCENARIOS, churnSteps, scenario, type ScenarioName } from "./scenarios";
import { runShard } from "./shard";
import { startStandinCoordinator, type StandinCoordinator } from "./standin/coordinator";
import { probeStubs } from "./stubs";
import type { ShardResult, SwarmConfig } from "./types";

function parse(argv: string[]): { words: string[]; flags: Map<string, string> } {
  const words: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) words.push(arg);
    else if (arg.includes("=")) flags.set(arg.slice(2, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1));
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags.set(arg.slice(2), argv[++i]);
    else flags.set(arg.slice(2), "true");
  }
  return { words, flags };
}

const number = (flags: Map<string, string>, name: string): number | undefined => {
  const text = flags.get(name);
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error(`--${name}: "${text}" is not a number`);
  return value;
};

function configFrom(name: string, flags: Map<string, string>): SwarmConfig {
  if (!(name in SCENARIOS)) throw new Error(`no scenario "${name}". There are: ${Object.keys(SCENARIOS).join(", ")}`);
  const shard = /^(\d+)\/(\d+)$/.exec(flags.get("shard") ?? "0/1");
  if (!shard || Number(shard[1]) >= Number(shard[2])) throw new Error("--shard: give it as index/count, like 0/4");
  const config = scenario(name as ScenarioName, {
    runId: flags.get("run-id"),
    seed: number(flags, "seed"),
    peers: number(flags, "peers"),
    churnS: number(flags, "churn-s"),
    shard: { index: Number(shard[1]), count: Number(shard[2]) },
    coordinatorUrl: flags.get("coordinator"),
    admissionSecret: flags.get("secret"),
    ice: flags.get("ice") as SwarmConfig["ice"] | undefined,
    port: number(flags, "port"),
  });
  const startAt = number(flags, "start-at");
  if (startAt !== undefined) config.startAtMs = startAt;
  const engine = flags.get("engine");
  if (engine) config.engine = engine as SwarmConfig["engine"];
  const pages = number(flags, "pages-per-browser");
  if (pages !== undefined) config.pagesPerBrowser = pages;
  const decodeEvery = number(flags, "decode-every");
  if (decodeEvery !== undefined) config.decodeEvery = decodeEvery;
  const stun = flags.get("stun");
  if (stun) config.iceServers = stun.split(",").map((urls) => ({ urls: [urls] }));
  return config;
}

function readResults(paths: string[]): ShardResult[] {
  const files: string[] = [];
  const walk = (path: string): void => {
    if (statSync(path).isDirectory()) for (const entry of readdirSync(path)) walk(join(path, entry));
    else if (/shard-\d+\.json$/.test(path)) files.push(path);
  };
  for (const path of paths) walk(path);
  if (files.length === 0) throw new Error(`no shard-N.json under ${paths.join(", ")}`);
  return files.sort().map((file) => JSON.parse(readFileSync(file, "utf8")) as ShardResult);
}

function writeReport(results: ShardResult[], out: string | undefined, require: string): number {
  const report = buildReport(results);
  const text = renderReport(report);
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "report.json"), reportJson(report));
    writeFileSync(join(out, "report.md"), text);
  }
  console.log(text);
  if (require === "pass" && !report.gate.pass) return 1;
  if (require === "valid" && !report.gate.valid) return 2;
  return 0;
}

async function main(): Promise<number> {
  const { words, flags } = parse(process.argv.slice(2));
  const [command, ...rest] = words;
  const out = flags.get("out");
  const log = (line: string): void => console.log(`[${new Date().toISOString().slice(11, 23)}] ${line}`);

  if (command === "scenarios") {
    for (const [name, what] of Object.entries(SCENARIOS)) console.log(`${name.padEnd(12)} ${what}`);
    console.log(`\nStill stubs: ${probeStubs().join(", ") || "nothing"}`);
    return 0;
  }

  if (command === "run") {
    const config = configFrom(rest[0] ?? "", flags);
    config.log = log;
    const result = await runShard(config);
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `shard-${config.shard.index}.json`), JSON.stringify(result));
    }
    log(`shard ${config.shard.index}: ${result.peersStarted} peers, ${result.samples.length} samples, ${result.peersFailed.length} failed`);
    // One shard of several cannot be judged alone: the report job does that.
    if (config.shard.count > 1) return 0;
    return writeReport([result], out, flags.get("require") ?? "none");
  }

  if (command === "report") {
    return writeReport(readResults(rest.length ? rest : ["."]), out, flags.get("require") ?? "none");
  }

  if (command === "coordinator") {
    // The coordinator alone, for shards on other machines to join; it carries out its own death, on the run's clock.
    const name = flags.get("scenario") ?? "gate";
    const config = configFrom(name, flags);
    const startAt = config.startAtMs ?? Date.now();
    const forS = number(flags, "for") ?? config.durationS + 60;
    const stun = flags.get("stun");
    const options = {
      port: number(flags, "port") ?? 4280,
      host: flags.get("host") ?? "127.0.0.1",
      admissionSecret: config.admissionSecret,
      serverSecret: flags.get("server-secret") ?? "harness-server-secret",
      params: config.params,
      seed: config.seed,
      iceServers: stun ? stun.split(",").map((urls) => ({ urls: [urls] })) : [],
    };
    const real = !probeStubs().includes("coordinator.startNodeCoordinator") && flags.get("standin") !== "true";
    let coordinator: NodeCoordinator | StandinCoordinator = real ? await startNodeCoordinator(options) : await startStandinCoordinator(options);
    log(`coordinator: ${real ? "the package's" : "STAND-IN"} at ${coordinator.url}, for ${forS} s`);
    for (const step of churnSteps(config)) {
      const event = step.event;
      if (event.action !== "kill-coordinator") continue;
      setTimeout(
        () => {
          void (async () => {
            log(`the coordinator dies for ${event.forS} s`);
            await coordinator.kill();
            await new Promise((resolve) => setTimeout(resolve, event.forS * 1000));
            if ("restart" in coordinator) await coordinator.restart();
            else coordinator = await startNodeCoordinator(options);
            log("the coordinator is back");
          })();
        },
        Math.max(0, startAt + event.atS * 1000 - Date.now()),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, startAt + forS * 1000 - Date.now())));
    await coordinator.close();
    return 0;
  }

  console.log("usage: swarm.mjs scenarios | run <scenario> [--peers N --seed N --churn-s N --shard i/n --coordinator URL --secret S --start-at MS --ice host|stun|turn --stun URL --out DIR --require valid|pass] | coordinator [--scenario S --port N --for S] | report <dir> [--out DIR --require valid|pass]");
  return command ? 64 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
