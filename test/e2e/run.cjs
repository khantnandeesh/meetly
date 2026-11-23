// Runs the browser tests: `node test/e2e/run.cjs` for all, or name some (home host reactions host-tools access effects schedule chat fixes polls quality mini rating notices layout perf webinar people cost-guard timer).
const H = require("./lib.cjs");

const SUITES = {
  home: "./home.cjs",
  host: "./host.cjs",
  reactions: "./reactions.cjs",
  "host-tools": "./host-tools.cjs",
  access: "./access.cjs",
  effects: "./effects.cjs",
  schedule: "./schedule.cjs",
  chat: "./chat.cjs",
  fixes: "./fixes.cjs",
  polls: "./polls.cjs",
  quality: "./quality.cjs",
  mini: "./mini.cjs",
  rating: "./rating.cjs",
  notices: "./notices.cjs",
  layout: "./layout.cjs",
  perf: "./perf.cjs",
  webinar: "./webinar.cjs",
  people: "./people.cjs",
  "cost-guard": "./cost-guard.cjs",
  timer: "./timer.cjs",
};

// A suite with a failing check is run once more. If the second run passes, the suite counts as
// passed but is reported as flaky: a "flaky: passed on retry" line in the log, a warning on the
// run, and a table in the job summary ($GITHUB_STEP_SUMMARY) naming the checks that failed first.
// If the second run fails too, the suite fails as before. MEETLY_E2E_RETRIES=0 turns retries off.
const RETRIES = process.env.MEETLY_E2E_RETRIES === "0" ? 0 : 1;

/** Runs one suite and returns the checks it failed (an empty list when it passed). */
async function runSuite(name, browser, attempt) {
  const start = H.resultCount();
  try {
    await require(SUITES[name])(browser);
  } catch (error) {
    const where = String((error && error.stack) || "").split("\n").find((line) => line.includes(SUITES[name].slice(2))) || "";
    await H.failureShots(attempt > 1 ? `${name}-retry` : name);
    H.ok(`${name}: ran to the end`, false, `${String(error && error.message).split("\n")[0]} ${where.trim()}`);
  }
  return { start, failed: H.resultsSince(start).filter((result) => !result.pass) };
}

const oneLine = (text, max = 300) => String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
const cell = (text) => oneLine(text).replace(/\|/g, "\\|");
const describe = (failed) => failed.map((result) => `${result.name}${result.detail ? ` — ${oneLine(result.detail, 160)}` : ""}`);

function writeSummary(flaky, failing) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file || (!flaky.length && !failing.length)) return;
  const lines = ["## Browser tests", ""];
  if (flaky.length) {
    lines.push(`**${flaky.length} flaky suite${flaky.length === 1 ? "" : "s"}**: failed, then passed when run again. The run passes; the flake is still a bug.`, "");
    lines.push("| Suite | Result | Failed on the first run |", "| --- | --- | --- |");
    for (const { name, first } of flaky) lines.push(`| \`${name}\` | flaky: passed on retry | ${describe(first).map(cell).join("<br>")} |`);
    lines.push("");
  }
  if (failing.length) {
    lines.push(`**${failing.length} failing suite${failing.length === 1 ? "" : "s"}**: failed twice.`, "");
    lines.push("| Suite | Failed on the first run | Failed on the retry |", "| --- | --- | --- |");
    for (const { name, first, second } of failing) lines.push(`| \`${name}\` | ${describe(first).map(cell).join("<br>")} | ${describe(second).map(cell).join("<br>") || "(not retried)"} |`);
    lines.push("");
  }
  try {
    require("node:fs").appendFileSync(file, lines.join("\n") + "\n");
  } catch (error) {
    console.log(`Could not write the job summary: ${error.message}`);
  }
}

(async () => {
  const wanted = process.argv.slice(2);
  const names = wanted.length ? wanted : Object.keys(SUITES);
  const unknown = names.filter((name) => !SUITES[name]);
  if (unknown.length) {
    console.error(`Unknown suite: ${unknown.join(", ")}. Known: ${Object.keys(SUITES).join(", ")}.`);
    process.exit(2);
  }
  console.log(`Meetly at ${H.BASE}`);
  let browser = await H.launch();
  const flaky = [];
  const failing = [];
  for (const name of names) {
    if (!browser.isConnected()) browser = await H.launch();
    const first = await runSuite(name, browser, 1);
    if (!first.failed.length) continue;
    if (!RETRIES) {
      failing.push({ name, first: first.failed, second: [] });
      continue;
    }
    // The first run's results come out; the retry's alone decide the suite. The first run's
    // PASS/FAIL lines stay in the log above.
    H.dropResultsSince(first.start);
    console.log(`\nRETRY  ${name}: ${first.failed.length} check(s) failed; running the suite once more`);
    await H.closeEveryone();
    if (!browser.isConnected()) browser = await H.launch();
    const second = await runSuite(name, browser, 2);
    if (second.failed.length) {
      console.log(`FAILED ${name}: failed again on retry`);
      failing.push({ name, first: first.failed, second: second.failed });
    } else {
      console.log(`FLAKY  ${name}: flaky: passed on retry. First run failed: ${describe(first.failed).join("; ")}`);
      if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Flaky browser test (${name})::flaky: passed on retry. First run failed: ${oneLine(describe(first.failed).join("; "), 900)}`);
      flaky.push({ name, first: first.failed });
    }
  }
  await browser.close().catch(() => {});
  if (flaky.length) console.log(`\nFlaky (passed on retry): ${flaky.map((f) => f.name).join(", ")}`);
  writeSummary(flaky, failing);
  process.exit(H.finish());
})();
