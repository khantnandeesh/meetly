// Shared harness for the browser tests: real Chromium clients with fake cameras and microphones,
// talking to a running Meetly (MEETLY_URL, default http://localhost:3000) on a LiveKit build.
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.MEETLY_URL || "http://localhost:3000";
/** Where screenshots go, if anywhere. */
const SHOTS = process.env.MEETLY_SHOTS || "";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function finish() {
  const failed = results.filter((result) => !result.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  return failed.length ? 1 : 0;
}

function launch() {
  return chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
}

/** Everyone with a browser open, so a failure can be photographed (see `failureShots`). */
const everyone = new Set();
async function failureShots(label) {
  const dir = SHOTS || process.env.MEETLY_FAILURE_SHOTS;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const person of everyone) {
    await person.page.screenshot({ path: path.join(dir, `_failed-${label}-${++n}.png`) }).catch(() => {});
  }
}

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

/** One person: their own browser context (so their own cookies), one page, and the tokens they were given. */
async function client(browser, { viewport = DESKTOP, scale = 1, touch = false, reducedMotion = "no-preference" } = {}) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: scale,
    hasTouch: touch,
    reducedMotion,
    permissions: ["camera", "microphone"],
  });
  // The app's own opt-in debug handle: window.__meetly = { call, room }, and the sound log.
  await ctx.addInitScript(() => localStorage.setItem("meetly:debug", "1"));
  const page = await ctx.newPage();
  const person = { ctx, page, token: null, tokenStatus: null, tokenBody: null };
  everyone.add(person);
  ctx.on("close", () => everyone.delete(person));
  page.on("pageerror", (error) => console.log("[pageerror]", error.message));
  page.on("response", async (response) => {
    if (!response.url().endsWith("/api/token")) return;
    person.tokenStatus = response.status();
    person.tokenBody = await response.json().catch(() => null);
    if (person.tokenBody && person.tokenBody.token) person.token = person.tokenBody.token;
  });
  return person;
}

/** Presses "New meeting" on the home page and returns the meeting's URL. */
async function createMeeting(person) {
  await person.page.goto(`${BASE}/`);
  await person.page.getByRole("button", { name: "New meeting" }).click();
  await person.page.waitForURL(/\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  return person.page.url();
}

const randomCode = () => {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const run = (n) => Array.from({ length: n }, () => letters[Math.floor(Math.random() * 26)]).join("");
  return `${run(3)}-${run(4)}-${run(3)}`;
};

/** Fills in the pre-join screen and presses its button, whatever it currently reads. */
async function press(person, url, name, button = /^(Join now|Ask to join)$/) {
  const { page } = person;
  if (page.url() !== url) await page.goto(url);
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: /^(Mute|Unmute) microphone$/ }).waitFor();
  await page.getByRole("button", { name: button }).click();
}

// The call is drawn underneath the pre-join screen while joining or asking; "in the call" means uncovered.
const leaveButton = (person) => person.page.locator("[data-in-call]:not([inert])").getByRole("button", { name: "Leave call" });
const inCall = (person, timeout = 20000) => leaveButton(person).waitFor({ timeout });
const isInCall = async (person) => (await leaveButton(person).count()) === 1;

async function join(person, url, name) {
  await press(person, url, name);
  await inCall(person);
}

const identity = (person) => person.page.evaluate(() => window.__meetly.room.localParticipant.identity);

/** POSTs to /api/host from the person's own page (so with their cookies) and returns the status. */
function hostApi(person, body) {
  return person.page.evaluate(async (payload) => {
    const response = await fetch("/api/host", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return response.status;
  }, body);
}

// By element, not by role: while a menu is open (or still closing) everything else is hidden from
// the accessibility tree, and a role lookup would say the panel is not there.
const people = (person) => person.page.locator('aside[aria-label="People"]');
async function openPeople(person) {
  if ((await people(person).count()) === 0) await person.page.locator("#toggle-people").click();
  await people(person).waitFor();
}
async function closePeople(person) {
  if ((await people(person).count()) > 0) await people(person).locator('button[aria-label="Close people"]').click();
  await people(person).waitFor({ state: "detached" });
}

const hostControlsShown = async (person) => (await person.page.getByRole("button", { name: /^Host controls for/ }).count()) > 0;

/** Waits until `check` (run in Node) is true, or gives up. Returns whether it became true. */
async function until(check, timeout = 10000, every = 150) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return true;
    await sleep(every);
  }
  return false;
}

async function shot(person, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  // Let whatever just opened finish arriving.
  await sleep(450);
  await person.page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

const noOverflow = (person) => person.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

module.exports = {
  BASE,
  DESKTOP,
  PHONE,
  sleep,
  ok,
  finish,
  launch,
  client,
  createMeeting,
  randomCode,
  press,
  inCall,
  isInCall,
  join,
  identity,
  hostApi,
  people,
  openPeople,
  closePeople,
  hostControlsShown,
  until,
  shot,
  noOverflow,
  failureShots,
};
