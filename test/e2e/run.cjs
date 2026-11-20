// Runs the browser tests: `node test/e2e/run.cjs` for all, or name some (host reactions host-tools access effects schedule chat fixes polls quality mini rating).
const H = require("./lib.cjs");

const SUITES = {
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
};

(async () => {
  const wanted = process.argv.slice(2);
  const names = wanted.length ? wanted : Object.keys(SUITES);
  const unknown = names.filter((name) => !SUITES[name]);
  if (unknown.length) {
    console.error(`Unknown suite: ${unknown.join(", ")}. Known: ${Object.keys(SUITES).join(", ")}.`);
    process.exit(2);
  }
  console.log(`Meetly at ${H.BASE}`);
  const browser = await H.launch();
  for (const name of names) {
    try {
      await require(SUITES[name])(browser);
    } catch (error) {
      const where = String((error && error.stack) || "").split("\n").find((line) => line.includes(SUITES[name].slice(2))) || "";
      await H.failureShots(name);
      H.ok(`${name}: ran to the end`, false, `${String(error && error.message).split("\n")[0]} ${where.trim()}`);
    }
  }
  await browser.close();
  process.exit(H.finish());
})();
