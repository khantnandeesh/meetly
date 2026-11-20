#!/usr/bin/env node
/**
 * Fills a live meeting with test bots, for trying the app at size by hand.
 *
 *   node scripts/join-bots.cjs <meeting link> [bots=20] [minutes=15] [with camera=4]
 *
 * Each bot is a headless browser that joins through the real join screen, with its microphone off,
 * the first few showing a test pattern as their camera and the rest with the camera off. In a
 * meeting where people ask to join, the bots wait to be let in. They leave by themselves after the
 * given minutes (or press Ctrl+C).
 *
 * Every bot is a real participant: on RealtimeKit each one uses participant-minutes on the
 * account (20 bots for 15 minutes is 300). Run it from a computer with ordinary internet access;
 * a sandbox that only allows HTTPS through a proxy can't carry the meeting's media.
 *
 * Needs Playwright, which is not a dependency of the app. Once, without touching package.json:
 *   npm install --no-save playwright && npx playwright install chromium
 */
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("Playwright isn't installed. Run once:\n  npm install --no-save playwright && npx playwright install chromium");
  process.exit(1);
}

const [link, countArg, minutesArg, cameraArg] = process.argv.slice(2);
if (!link || !/^https?:\/\//.test(link)) {
  console.error("Usage: node scripts/join-bots.cjs <meeting link> [bots=20] [minutes=15] [with camera=4]");
  process.exit(1);
}
const COUNT = Math.max(1, Number(countArg ?? 20));
const MINUTES = Math.max(1, Number(minutesArg ?? 15));
const WITH_CAMERA = Math.max(0, Number(cameraArg ?? 4));
const stamp = () => new Date().toLocaleTimeString();

(async () => {
  const browser = await chromium.launch({
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const bots = [];
  let stopping = false;
  const leaveAll = async () => {
    if (stopping) return;
    stopping = true;
    console.log(`${stamp()} leaving…`);
    await Promise.all(bots.map(({ page }) => page.getByRole("button", { name: /^Leave (meeting|webinar)$/ }).click({ timeout: 3_000 }).catch(() => {})));
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await browser.close();
    console.log(`${stamp()} all bots left`);
    process.exit(0);
  };
  process.on("SIGINT", leaveAll);

  for (let i = 1; i <= COUNT && !stopping; i++) {
    const name = `Bot ${String(i).padStart(2, "0")}`;
    const context = await browser.newContext({ permissions: ["camera", "microphone"], viewport: { width: 640, height: 400 } });
    // The join screen reads its name and on/off choices from here, so the bots fill nothing in.
    await context.addInitScript(
      ([username, video]) => localStorage.setItem("lk-user-choices", JSON.stringify({ username, audioEnabled: false, videoEnabled: video })),
      [name, i <= WITH_CAMERA],
    );
    const page = await context.newPage();
    try {
      await page.goto(link, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const join = page.getByRole("button", { name: /^(Join now|Ask to join|Watch)$/ });
      await join.waitFor({ timeout: 60_000 });
      const label = (await join.innerText()).trim();
      await join.click();
      console.log(`${stamp()} ${name}: ${label === "Ask to join" ? "asked to join" : "joining"}`);
      bots.push({ name, page });
    } catch (error) {
      console.log(`${stamp()} ${name}: couldn't join (${String(error.message).split("\n")[0]})`);
    }
    await page.waitForTimeout(1_500);
  }

  console.log(`${stamp()} ${bots.length} bots sent. They leave in ${MINUTES} min (Ctrl+C to end now).`);
  setTimeout(leaveAll, MINUTES * 60_000);
})();
