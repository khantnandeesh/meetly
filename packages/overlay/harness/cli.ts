/**
 * The harness from a terminal, and from CI. Run it through ./swarm.mjs, which adds Node's flags:
 *
 *   node packages/overlay/harness/swarm.mjs scenarios
 *   node packages/overlay/harness/swarm.mjs run proof-tree
 *   node packages/overlay/harness/swarm.mjs run gate-small --peers 8 --churn-s 40
 *   node packages/overlay/harness/swarm.mjs run gate --shard 2/8 --coordinator https://… --start-at 1767000000000 --ice stun
 *   node packages/overlay/harness/swarm.mjs coordinator --scenario gate --port 4280 --for 800
 *   node packages/overlay/harness/swarm.mjs report out/ --require valid
 *   node packages/overlay/harness/swarm.mjs sizes out-30/ out-45/ out-60/   (H4: the largest valid size)
 *   node packages/overlay/harness/swarm.mjs modules                         (H6: what is real, what is a stub)
 *
 * Owner: E-harness.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startNodeCoordinator } from "../coordinator/node";
import type { NodeCoordinator } from "../coordinator/types";
import { buildReport, largestValid, renderReport, renderSizes, reportJson } from "./report";
import { SCENARIOS, churnSteps, scenario, type ScenarioName } from "./scenarios";
import { runShard } from "./shard";
import { renderSlowChild, slowChildReport } from "./slowChild";
import { startStandinCoordinator, type StandinCoordinator } from "./standin/coordinator";
import { MODULES, probeStubs } from "./stubs";
import { decideLayout, type NatReport } from "./layout";
import type { ShardLayout, ShardResult, SwarmConfig } from "./types";

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
  const alternates = flags.get("coordinator-alt");
  if (alternates) config.coordinatorAlternates = alternates.split(",").filter((url) => url && url !== config.coordinatorUrl);
  const engine = flags.get("engine");
  if (engine) config.engine = engine as SwarmConfig["engine"];
  const pages = number(flags, "pages-per-browser");
  if (pages !== undefined) config.pagesPerBrowser = pages;
  const decodeEvery = number(flags, "decode-every");
  if (decodeEvery !== undefined) config.decodeEvery = decodeEvery;
  const stun = flags.get("stun");
  if (stun) config.iceServers = stun.split(",").map((urls) => ({ urls: [urls] }));
  // The run's layout (./layout.ts), from shard 0's rendezvous or a file of its own.
  const layoutFile = flags.get("layout");
  if (layoutFile) {
    const parsed = JSON.parse(readFileSync(layoutFile, "utf8")) as ShardLayout | { layout: ShardLayout };
    config.layout = "layout" in parsed ? parsed.layout : parsed;
  }
  const durationS = number(flags, "duration-s");
  if (durationS !== undefined) config.durationS = durationS;
  return config;
}

/** Every shard-N.json under `paths`, grouped by the directory it is in: one run per directory. */
function readRuns(paths: string[]): ShardResult[][] {
  const runs = new Map<string, ShardResult[]>();
  const walk = (path: string): void => {
    if (statSync(path).isDirectory()) for (const entry of readdirSync(path)) walk(join(path, entry));
    else if (/shard-\d+\.json$/.test(path)) {
      const dir = path.slice(0, path.lastIndexOf("/"));
      runs.set(dir, [...(runs.get(dir) ?? []), JSON.parse(readFileSync(path, "utf8")) as ShardResult]);
    }
  };
  for (const path of paths) walk(path);
  return [...runs.values()];
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
  // slow-child has measures of its own (PLAN C3), set beside E-congestion's numbers.
  const text = renderReport(report) + (report.scenario === "slow-child" && results.length === 1 ? "\n" + renderSlowChild(slowChildReport(results[0])) : "");
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
    const nat = flags.get("nat");
    if (nat) {
      try {
        const found = JSON.parse(readFileSync(nat, "utf8")) as { symmetric: boolean | null; mapped: { server: string; mapped: { ip: string; port: number } | null }[] };
        result.host.nat = { symmetric: found.symmetric, mapped: found.mapped.map((m) => `${m.server} sees ${m.mapped ? `${m.mapped.ip}:${m.mapped.port}` : "nothing"}`) };
        if (found.symmetric) (result.notes ??= []).push("this machine is behind a symmetric NAT: its peers cannot hole-punch to another machine, and without TURN every such link fails");
      } catch {
        (result.notes ??= []).push("the NAT check left nothing readable");
      }
    }
    const merged = flags.get("merged");
    if (merged) {
      // What merge.sh brought in before this run (PLAN H6): the report names it beside the stubs.
      for (const m of JSON.parse(readFileSync(merged, "utf8")) as { branch: string; sha?: string; result: string }[]) {
        (result.notes ??= []).push(`${m.branch}${m.sha ? ` at ${m.sha}` : ""}: ${m.result === "merged" ? "merged in before the run" : `NOT merged (${m.result})`}`);
      }
    }
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `shard-${config.shard.index}.json`), JSON.stringify(result));
    }
    log(`shard ${config.shard.index}: ${result.peersStarted} peers, ${result.samples.length} samples, ${result.peersFailed.length} failed`);
    // One shard of several cannot be judged alone: the report job does that.
    if (config.shard.count > 1) return 0;
    return writeReport([result], out, flags.get("require") ?? "none");
  }

  if (command === "layout") {
    // Shard 0: lay the run out from what the others said of their NAT (ci/natcheck.mjs, one nat-N.json each).
    const count = number(flags, "shards");
    const dir = flags.get("nat-dir");
    if (!count || !dir) throw new Error("layout: --shards N --nat-dir DIR");
    const reports: NatReport[] = [];
    for (const entry of readdirSync(dir)) {
      const match = /^nat-(\d+)\.json$/.exec(entry);
      if (!match) continue;
      try {
        const found = JSON.parse(readFileSync(join(dir, entry), "utf8")) as { symmetric: boolean | null };
        reports.push({ shard: Number(match[1]), symmetric: found.symmetric });
      } catch {
        reports.push({ shard: Number(match[1]), symmetric: null });
      }
    }
    const layout = decideLayout(count, reports);
    console.log(JSON.stringify(layout));
    return 0;
  }

  if (command === "excluded") {
    // A shard the layout left out: it starts no peer, and says why, so the report counts it as excluded and not as missing.
    const config = configFrom(rest[0] ?? "", flags);
    const why = config.layout?.excluded.find((e) => e.shard === config.shard.index)?.why ?? flags.get("why") ?? "excluded";
    const now = Date.now();
    const result: ShardResult = {
      runId: config.runId,
      shard: config.shard,
      startedAt: now,
      endedAt: now,
      peersStarted: 0,
      peersFailed: [],
      samples: [],
      host: { cores: 0, loadAvg1: [], maxEventLoopLagMs: 0 },
      peers: config.peers,
      durationS: config.durationS,
      scenario: config.scenario,
      seed: config.seed,
      expect: config.expect,
      excluded: why,
      role: "excluded",
      peersOfRun: 0,
      ice: config.ice,
    };
    const nat = flags.get("nat");
    if (nat) {
      try {
        const found = JSON.parse(readFileSync(nat, "utf8")) as { symmetric: boolean | null; mapped: { server: string; mapped: { ip: string; port: number } | null }[] };
        result.host.nat = { symmetric: found.symmetric, mapped: found.mapped.map((m) => `${m.server} sees ${m.mapped ? `${m.mapped.ip}:${m.mapped.port}` : "nothing"}`) };
      } catch {
        // Nothing readable: the reason above stands.
      }
    }
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `shard-${config.shard.index}.json`), JSON.stringify(result));
    }
    log(`shard ${config.shard.index}: excluded (${why})`);
    return 0;
  }

  if (command === "sizes") {
    // H4: one run per directory, each of one size; which was the largest that was valid?
    const runs = readRuns(rest.length ? rest : ["."]);
    if (runs.length === 0) throw new Error(`no shard-N.json under ${rest.join(", ")}`);
    const result = largestValid(runs.map((run) => buildReport(run)));
    const text = renderSizes(result);
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "sizes.md"), text);
      writeFileSync(join(out, "sizes.json"), JSON.stringify(result, null, 1));
    }
    console.log(text);
    return result.peers === null && flags.get("require") === "valid" ? 2 : 0;
  }

  if (command === "modules") {
    // H6: what a gate run would be running, before it is run.
    const stubbed = new Set(probeStubs());
    console.log("| Module | Factory | Owner | |\n| --- | --- | --- | --- |");
    for (const m of MODULES) console.log(`| ${m.name.split(".")[0]} | \`${m.name.split(".")[1]}\` | ${m.owner} | ${stubbed.has(m.name) ? "**STUB**" : "real"} |`);
    const real = MODULES.length - stubbed.size;
    console.log(`\n${real} of ${MODULES.length} real. ${stubbed.has("index.createOverlayViewer") ? "The composition root is a stub: the pages will run the harness's STAND-IN peer." : "The pages will run the package's own peer."} ${stubbed.has("coordinator.startNodeCoordinator") ? "The coordinator will be the harness's STAND-IN." : "The coordinator will be the package's."}`);
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "modules.json"), JSON.stringify(MODULES.map((m) => ({ ...m, stub: stubbed.has(m.name) })), null, 1));
    }
    return 0;
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
      // Survives the kill below, so the session's key and clock do (see shard.ts).
      storage: new Map<string, Map<string, string>>(),
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

  console.log("usage: swarm.mjs scenarios | modules | run <scenario> [--peers N --seed N --churn-s N --duration-s N --shard i/n --coordinator URL --secret S --start-at MS --ice host|stun|turn --stun URL --decode-every N --out DIR --require valid|pass] | coordinator [--scenario S --port N --for S] | report <dir> [--out DIR --require valid|pass] | sizes <dir>... [--out DIR]");
  return command ? 64 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
