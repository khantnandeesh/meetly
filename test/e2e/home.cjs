// The home page: the hero's notification and the "Inside a meeting" feature grid.
const H = require("./lib.cjs");

const WIDE = { width: 1440, height: 900 };

// The approved copy, tile by tile: a short title and at most one short line.
const TILES = [
  ["share", "Share your screen", "From a computer"],
  ["noise", "Noise suppression", "On by default"],
  ["polls", "Quick polls", null],
  ["reactions", "Group reactions", null],
  ["hands", "Hands, in order", null],
];
// Each tile's animation, and the last beat of its loop: after it, the tile holds its payoff.
const LAST_BEAT = { share: "live", noise: "on", polls: "counted", reactions: "burst", hands: "raised" };

const grid = (person) => person.page.locator("section[aria-labelledby='inside-a-meeting']");

/** What each tile's picture shows right now, read from the visible picture (the poster or the stage). */
const payoff = (person) =>
  person.page.evaluate(() => {
    // The words a person sees: nothing under data-show="false", and a rolling number read as itself.
    const read = (el) => {
      if (el.nodeType === 3) return el.textContent;
      if (el.nodeType !== 1 || el.getAttribute("data-show") === "false" || getComputedStyle(el).display === "none") return "";
      if (el.classList.contains("ss-count")) return el.getAttribute("aria-label") || "";
      return Array.from(el.childNodes).map(read).join("");
    };
    const pick = (tile, selector) => Array.from(document.querySelectorAll(`.gm-slot[data-scene='${tile}'] ${selector}`)).filter((el) => el.getClientRects().length > 0);
    const banner = pick("share", ".gm-share-banner")[0];
    const sw = pick("noise", ".switch")[0];
    const foot = pick("polls", ".gm-foot")[0];
    const rows = pick("reactions", ".gm-lane-row").filter((row) => row.getAttribute("data-show") === "true" && getComputedStyle(row).display !== "none");
    const hands = pick("hands", ".gm-hand").filter((row) => row.getAttribute("data-show") === "true");
    return {
      share: !!banner && banner.getAttribute("data-show") === "true",
      noise: sw ? sw.getAttribute("data-on") : null,
      polls: foot ? read(foot).replace(/\s+/g, " ").trim() : null,
      reactions: rows.map((row) => read(row).replace(/\s+/g, "")).join(" | "),
      hands: hands.map((row) => read(row.querySelector(".gm-place"))).join(" "),
    };
  });
const PAYOFF = (laneRows) => ({ share: true, noise: "true", polls: "12 votes · you voted", reactions: laneRows, hands: "1st 2nd 3rd" });
const atPayoff = (p, laneRows) => Object.entries(PAYOFF(laneRows)).every(([tile, value]) => p[tile] === value);
const DESKTOP_LANE = "👏×12 | 🎉×5 | ❤️Lena | 😂×3";
const PHONE_LANE = "👏×12 | 🎉×5 | ❤️Lena";

module.exports = async function home(browser) {
  console.log("\n— home —");

  /* a computer */
  const desk = await H.client(browser, { viewport: WIDE, scale: 2 });
  await desk.page.goto(`${H.BASE}/`);
  await desk.page.getByRole("heading", { level: 2, name: "Inside a meeting" }).waitFor();
  H.ok("the feature grid is headed Inside a meeting", (await desk.page.getByRole("heading", { level: 2, name: "Inside a meeting" }).count()) === 1);
  H.ok("it has five tiles", (await grid(desk).locator(":scope > ul > li").count()) === 5);
  for (const [feature, title, line] of TILES) {
    const copy = await desk.page.evaluate((name) => {
      const tile = document.querySelector(`.fg-tile[data-feature='${name}']`);
      return { title: tile.querySelector("h3")?.textContent, line: tile.querySelector(".fg-line")?.textContent ?? null, words: tile.querySelectorAll(":scope > h3, :scope > p").length };
    }, feature);
    H.ok(`the ${feature} tile reads "${title}"${line ? ` / "${line}"` : ""}, and nothing more`, copy.title === title && copy.line === line && copy.words === (line ? 2 : 1), JSON.stringify(copy));
  }
  // The home page stays mounted (hidden) after a visit, so its pictures must not look like a call's
  // video tiles to the call page, which finds those by [data-tile] across the document.
  H.ok("the grid adds nothing the call page would count as a video tile", (await desk.page.locator("[data-tile]").count()) === 0);
  H.ok("the poster, before any animation, shows each tile's payoff", atPayoff(await payoff(desk), DESKTOP_LANE), JSON.stringify(await payoff(desk)));

  // The hero's notification: Deny and Admit on a line of their own under "Pat wants to join".
  const knock = desk.page.locator("[data-hero-toast]").filter({ visible: true }).first();
  await knock.getByText("Pat wants to join").waitFor();
  const lines = await knock.evaluate((el) => {
    const box = (text) => Array.from(el.querySelectorAll("span")).find((span) => span.textContent.trim() === text).getBoundingClientRect();
    const title = box("Pat wants to join");
    const deny = box("Deny");
    const admit = box("Admit");
    // The answers' row is pulled up a little (-mt-1.5, as in Toaster.tsx), so compare by line.
    const middle = (r) => r.top + r.height / 2;
    return { below: middle(deny) > title.bottom && middle(admit) > title.bottom, level: Math.abs(deny.top - admit.top) < 1, order: deny.right <= admit.left };
  });
  H.ok("hero: Deny and Admit sit on their own line under the title, Deny first", lines.below && lines.level && lines.order, JSON.stringify(lines));

  // The animations load once the grid is near, each tile plays its loop and comes back to its payoff.
  await grid(desk).scrollIntoViewIfNeeded();
  H.ok("the animations load when the grid comes into view", await H.until(async () => (await desk.page.locator(".gm-stage .ss-stage").count()) === 5, 8000));
  const marks = () => desk.page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll(".gm-slot")).map((slot) => [slot.dataset.scene, slot.querySelector(".ss-stage")?.getAttribute("data-mark") ?? null])));
  const played = await H.until(async () => {
    const now = await marks();
    return Object.entries(LAST_BEAT).every(([tile, beat]) => now[tile] === beat);
  }, 16000, 250);
  H.ok("every tile plays its story through to its last beat", played, JSON.stringify(await marks()));
  // The tiles take turns, so each is checked in its own hold: its last beat played, its payoff showing.
  const expected = PAYOFF(DESKTOP_LANE);
  for (const tile of Object.keys(LAST_BEAT)) {
    const holds = await H.until(async () => (await marks())[tile] === LAST_BEAT[tile] && (await payoff(desk))[tile] === expected[tile], 12000, 200);
    H.ok(`${tile}: after its story it holds its payoff`, holds, JSON.stringify((await payoff(desk))[tile]));
  }
  await H.shot(desk, "home-grid-desktop");
  await desk.ctx.close();

  /* a phone */
  const phone = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  await phone.page.goto(`${H.BASE}/`);
  await grid(phone).waitFor();
  const fit = async () =>
    phone.page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const out = [];
      if (document.documentElement.scrollWidth > width) out.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${width}`);
      for (const tile of document.querySelectorAll(".fg-tile")) {
        const t = tile.getBoundingClientRect();
        if (t.left < 0 || t.right > width) out.push(`${tile.dataset.feature} tile runs off the screen`);
        // Every word and control in a tile shows whole inside it (the shared page may be cropped).
        for (const node of tile.querySelectorAll("p, h3, span")) {
          if (node.closest(".gm-share-page, .gm-burst, .ss-cursor, .ss-count") || !node.textContent.trim()) continue;
          const r = node.getBoundingClientRect();
          if (r.width === 0 || getComputedStyle(node).display === "none") continue;
          if (r.left < t.left - 0.5 || r.right > t.right + 0.5 || r.top < t.top - 0.5 || r.bottom > t.bottom + 0.5) out.push(`${tile.dataset.feature}: "${node.textContent.trim().slice(0, 30)}" is cut by its tile`);
        }
      }
      return out;
    });
  const before = await fit();
  H.ok("phone: nothing in the grid runs off the screen or out of its tile", before.length === 0, before.slice(0, 5).join("; "));
  await grid(phone).scrollIntoViewIfNeeded();
  await H.until(async () => (await phone.page.locator(".gm-stage .ss-stage").count()) === 5, 8000);
  await H.sleep(1200);
  const during = await fit();
  H.ok("phone: …nor once the animations run", during.length === 0, during.slice(0, 5).join("; "));
  const banner = await phone.page.evaluate(() => {
    const tile = document.querySelector(".fg-tile[data-feature='share']").getBoundingClientRect();
    const stop = Array.from(document.querySelectorAll(".fg-tile[data-feature='share'] .gm-stop")).filter((el) => el.getClientRects().length > 0)[0].getBoundingClientRect();
    return stop.left >= tile.left && stop.right <= tile.right && stop.width > 0;
  });
  H.ok("phone: the screen-share banner's Stop sharing shows whole", banner);
  H.ok("phone: the reaction lane holds three rows", await H.until(async () => (await payoff(phone)).reactions === PHONE_LANE, 16000, 250), (await payoff(phone)).reactions);
  await H.shot(phone, "home-grid-phone");
  await phone.ctx.close();

  /* reduced motion: every tile is its poster, and nothing loads to animate it */
  const still = await H.client(browser, { viewport: H.PHONE, scale: 2, reducedMotion: "reduce" });
  await still.page.goto(`${H.BASE}/`);
  await grid(still).scrollIntoViewIfNeeded();
  await H.sleep(2500);
  H.ok("reduced motion: no animation is loaded", (await still.page.locator(".gm-stage").count()) === 0);
  H.ok("reduced motion: each tile shows its payoff", atPayoff(await payoff(still), PHONE_LANE), JSON.stringify(await payoff(still)));
  await still.ctx.close();
};
