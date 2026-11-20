// Checks that a deployed Meetly answers: the home page, a meeting page, one of the page's
// scripts, and /api/meeting. Run after every production deploy (.github/workflows/deploy.yml),
// or by hand:
//
//   node scripts/smoke-test.mjs https://meet.nandeesh.dev
//
// With EXPECT_BUILD_ID set (the .next/BUILD_ID of the build just deployed), it also waits until
// the home page is served by that build, so it never passes against the previous version.
//
// It never joins a call and never asks for a token. The only request that reaches the media
// provider is "peek" for a random meeting code, which on RealtimeKit is one meeting search (a
// GET); no meeting and no participant is created, so nothing is billed.
const base = (process.argv[2] || process.env.SMOKE_URL || "").replace(/\/+$/, "");
if (!/^https?:\/\/[^/]+$/.test(base)) {
  console.error("Usage: node scripts/smoke-test.mjs <https://host>");
  process.exit(2);
}
const expectBuildId = (process.env.EXPECT_BUILD_ID || "").trim();
const ATTEMPTS = Number(process.env.SMOKE_ATTEMPTS || 12);
const WAIT_MS = Number(process.env.SMOKE_WAIT_MS || 10_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const letters = "abcdefghijklmnopqrstuvwxyz";
const run = (n) => Array.from({ length: n }, () => letters[Math.floor(Math.random() * 26)]).join("");
// Meeting codes look like abc-defg-hij; a random one is almost certainly not a real meeting.
const code = `${run(3)}-${run(4)}-${run(3)}`;

async function get(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    redirect: "manual",
    ...init,
    headers: { "user-agent": "meetly-smoke-test", ...(init.headers || {}) },
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, type: response.headers.get("content-type") || "", body: await response.text() };
}

const postMeeting = (body) =>
  get("/api/meeting", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Each check returns null when it passes, or what was wrong. */
const checks = [
  [
    "home page: 200 with the New meeting button" + (expectBuildId ? ` from build ${expectBuildId}` : ""),
    async (state) => {
      const home = await get("/");
      if (home.status !== 200) return `status ${home.status}`;
      if (!home.body.includes("New meeting") || !home.body.includes("Meetly")) return "expected text missing";
      if (expectBuildId && !home.body.includes(`\\"b\\":\\"${expectBuildId}\\"`) && !home.body.includes(`"b":"${expectBuildId}"`)) {
        const served = home.body.match(/\\?"b\\?":\\?"([A-Za-z0-9_-]+)\\?"/);
        return `still serving build ${served ? served[1] : "(unknown)"}`;
      }
      state.script = (home.body.match(/\/_next\/static\/[^"'\\\s]+\.js/) || [])[0];
      return null;
    },
  ],
  [
    "a script the home page loads: 200 from static assets",
    async (state) => {
      if (!state.script) return "the home page links no /_next/static script";
      const script = await get(state.script);
      if (script.status !== 200) return `${state.script}: status ${script.status}`;
      return /javascript/.test(script.type) ? null : `${state.script}: content-type ${script.type}`;
    },
  ],
  [
    `meeting page /${code}: 200, rendered for that code`,
    async () => {
      const page = await get(`/${code}`);
      if (page.status !== 200) return `status ${page.status}`;
      return page.body.includes(`<title>${code} · Meetly</title>`) ? null : "title for the code missing";
    },
  ],
  [
    "POST /api/meeting peek, random code: 200 with an access mode",
    async () => {
      const peek = await postMeeting({ action: "peek", code });
      if (peek.status !== 200) return `status ${peek.status}: ${peek.body.slice(0, 200)}`;
      const json = JSON.parse(peek.body);
      return typeof json.access === "string" && json.host === false ? null : `unexpected body ${peek.body.slice(0, 200)}`;
    },
  ],
  [
    "POST /api/meeting peek, malformed code: 400",
    async () => {
      const bad = await postMeeting({ action: "peek", code: "not-a-code" });
      return bad.status === 400 ? null : `status ${bad.status}`;
    },
  ],
];

console.log(`Smoke test of ${base}`);
const state = {};
let failed = 0;
for (const [name, check] of checks) {
  let problem = "not run";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    problem = await check(state).catch((error) => {
      const cause = error?.cause?.code || error?.cause?.message;
      return `${error?.message || error}${cause ? ` (${cause})` : ""}`;
    });
    if (!problem) break;
    if (attempt < ATTEMPTS) {
      console.log(`  …  ${name}: ${problem} (attempt ${attempt}/${ATTEMPTS}, retrying)`);
      await sleep(WAIT_MS);
    }
  }
  console.log(`${problem ? "FAIL" : "PASS"}  ${name}${problem ? `  — ${problem}` : ""}`);
  if (problem) failed++;
}
console.log(failed ? `\n${failed} of ${checks.length} checks failed` : `\nAll ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
