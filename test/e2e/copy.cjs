// Word budgets (docs/UI-WRITING.md): each key screen's visible words, counted in a real browser,
// stay at or under its budget, at 1440 px and at 390 px. What counts is what a sighted person reads
// on the screen as it first appears: text and placeholders that are drawn. Not counted: anything
// hidden from assistive technology (aria-hidden, which marks the home page's illustrations),
// screen-reader-only text (.sr-only), and tooltips, which are not open.
//
// A screen over budget fails with its count and its words, so the fix is to cut words, or, if the
// words are needed, to raise the budget here in the same pull request, saying why.
const H = require("./lib.cjs");

/** Words per screen. Each is the count after the "less text" pass plus a little headroom. */
const BUDGET = {
  home: 35, // was 47
  "webinar chooser": 26, // was 65
  "meeting pre-join": 15, // was 34
  "live host": 52, // was 175
  "live viewer": 33, // was 73
};

const WIDE = { width: 1440, height: 900 };

/** Counts the visible words inside `selector` (the whole page by default), and returns them too. */
function countWords(page, selector = "body") {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return { count: -1, words: [] };
    const hidden = (el) =>
      !!el.closest('[aria-hidden="true"], .sr-only, script, style, noscript, template, [role="tooltip"]') ||
      (typeof el.checkVisibility === "function" ? !el.checkVisibility({ checkOpacity: true, visibilityProperty: true }) : !el.offsetParent);
    const words = [];
    const add = (text) => {
      for (const word of text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(word)) words.push(word);
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || hidden(el) || !node.textContent.trim()) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      add(node.textContent);
    }
    for (const field of root.querySelectorAll("input[placeholder], textarea[placeholder]")) {
      if (!field.value && !hidden(field)) add(field.getAttribute("placeholder"));
    }
    return { count: words.length, words };
  }, selector);
}

async function check(screen, size, page, selector) {
  const { count, words } = await countWords(page, selector);
  H.ok(`${screen} (${size}): ${count} words, budget ${BUDGET[screen]}`, count >= 0 && count <= BUDGET[screen], count > BUDGET[screen] ? words.join(" ") : undefined);
}

/** A well-formed Live link fragment: a 32-byte key, a P-256 public point (0x04, x, y) and a 16-byte pass. */
function liveFragment() {
  const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
  const point = Buffer.alloc(65, 9);
  point[0] = 4;
  return `#k=${b64(Buffer.alloc(32, 7))}&s=${b64(point)}&a=${b64(Buffer.alloc(16, 3))}`;
}

module.exports = async function copy(browser) {
  console.log("\n— word budgets —");
  for (const [size, viewport] of [
    ["1440", WIDE],
    ["390", H.PHONE],
  ]) {
    const person = await H.client(browser, { viewport, reducedMotion: "reduce" });
    const { page } = person;

    /* home */
    await page.goto(`${H.BASE}/`);
    await page.getByRole("button", { name: "New meeting" }).waitFor();
    await check("home", size, page);

    /* the webinar chooser, with Standard on (the server's switch is its own test) */
    await page.route("**/api/meeting", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      if (body.action === "webinars") return route.fulfill({ json: { enabled: true } });
      return route.continue();
    });
    await page.getByRole("button", { name: "More ways to start a meeting" }).click();
    await page.getByRole("menuitem", { name: "New webinar…" }).click();
    await page.getByRole("dialog", { name: "Start a webinar" }).waitFor();
    await H.sleep(400);
    await check("webinar chooser", size, page, "[data-webinar-type-dialog]");
    await page.keyboard.press("Escape");
    await page.unroute("**/api/meeting");

    /* a meeting's pre-join, for the person who made it */
    await page.getByRole("button", { name: "New meeting" }).click();
    await page.waitForURL(/\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
    await page.getByRole("button", { name: /^(Mute|Unmute) microphone$/ }).waitFor();
    await H.sleep(800);
    // The form's column: the preview beside it shows the camera and device names, which are not copy.
    await check("meeting pre-join", size, page, "main > section:nth-of-type(2)");

    /* Live, the host before going live */
    await page.goto(`${H.BASE}/live`);
    await page.getByTestId("host-preview").waitFor({ timeout: 20000 });
    await H.sleep(400);
    await check("live host", size, page, "main");

    /* Live, a viewer before pressing Watch: the coordinator's answer is given here (it runs only in workerd) */
    await page.route("**/api/live/*/tree", (route) =>
      route.fulfill({ json: { started: true, ended: false, full: false, viewers: 3, cap: 50, nodes: [] } }),
    );
    await page.goto(`${H.BASE}/live/abc-defg-hij${liveFragment()}`);
    await page.getByTestId("live-notice").waitFor({ timeout: 15000 });
    await H.sleep(400);
    await check("live viewer", size, page, "main");

    await person.ctx.close();
  }
};
