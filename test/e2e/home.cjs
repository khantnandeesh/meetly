// The home page: the hero's notification and the "Inside a meeting" feature grid.
const H = require("./lib.cjs");

const WIDE = { width: 1440, height: 900 };

// The approved copy: a short title on every tile, and nothing else.
const TILES = [
  ["share", "Share your screen"],
  ["noise", "Noise suppression"],
  ["polls", "Quick polls"],
  ["reactions", "Group reactions"],
  ["hands", "Hands, in order"],
];

const grid = (person) => person.page.locator("section[aria-labelledby='inside-a-meeting']");

/** What each tile's picture shows right now, read from the visible picture (the poster or the stage). */
const payoff = (person) =>
  person.page.evaluate(() => {
    // The words a person sees: nothing under data-show="false", and a rolling number read as itself.
    const read = (el) => {
      if (el.nodeType === 3) return el.textContent;
      if (el.nodeType !== 1 || el.getAttribute("data-show") === "false" || getComputedStyle(el).display === "none") return "";
      if (el.classList.contains("ss-count") || el.classList.contains("gm-tick")) return el.getAttribute("aria-label") || "";
      return Array.from(el.childNodes).map(read).join("");
    };
    const pick = (tile, selector) => Array.from(document.querySelectorAll(`.gm-slot[data-scene='${tile}'] ${selector}`)).filter((el) => el.getClientRects().length > 0);
    const banner = pick("share", ".gm-share-banner")[0];
    const sw = pick("noise", ".switch")[0];
    // Your vote: its tick, and its row's count (the card runs off the tile's foot).
    const mine = pick("polls", ".gm-option[data-mine]")[0];
    const tick = mine?.querySelector(".gm-mark-done");
    // The lane, from the bottom (the oldest) up.
    const rows = pick("reactions", ".gm-lane-row[data-show='true']").sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    const hands = pick("hands", ".gm-hand").filter((row) => row.getAttribute("data-show") === "true");
    return {
      share: !!banner && read(banner).includes("Stop sharing"),
      noise: sw ? sw.getAttribute("data-on") : null,
      polls: mine ? `${tick && tick.getAttribute("data-show") === "true" ? "✓ " : ""}${read(mine).replace(/\s+/g, "")}` : null,
      reactions: rows.map((row) => read(row).replace(/\s+/g, "")).join(" | "),
      hands: hands.map((row) => read(row.querySelector(".gm-place"))).join(" "),
    };
  });
const LANE = "👏×12 | 🎉×5 | ❤️Lena | 😂×3";
const POSTER = { share: true, noise: "true", polls: "✓ Wednesday7·58%", reactions: LANE, hands: "1st 2nd 3rd" };
const atPoster = (p) => Object.entries(POSTER).every(([tile, value]) => p[tile] === value);
// What a tile must show whenever it is at rest, whatever its story has reached: nothing is ever
// played back to an empty or unvoted state.
const whole = (p) => ({
  share: p.share === true,
  noise: p.noise === "true",
  polls: /^✓ /.test(p.polls ?? "") && /\d+%$/.test(p.polls),
  reactions: p.reactions.split(" | ").filter(Boolean).length === 4,
  hands: ["", "1st", "1st 2nd", "1st 2nd 3rd"].includes(p.hands),
});
// What each picture is about, which its tile's crop must never cut: the banner, the switch, your
// vote, the lane, the speaker's label and the queue. The rest may run off the tile's edge.
const WHOLE = [".gm-share-banner", ".gm-menu-item:has(.switch)", ".gm-option[data-mine]", ".gm-lane-row", ".gm-name", ".gm-hands-head", ".gm-hand"];

module.exports = async function home(browser) {
  console.log("\n— home —");

  /* a computer */
  const desk = await H.client(browser, { viewport: WIDE, scale: 2 });
  await desk.page.goto(`${H.BASE}/`);
  await desk.page.getByRole("heading", { level: 2, name: "Inside a meeting" }).waitFor();
  H.ok("the feature grid is headed Inside a meeting", (await desk.page.getByRole("heading", { level: 2, name: "Inside a meeting" }).count()) === 1);
  H.ok("it has five tiles", (await grid(desk).locator(":scope > ul > li").count()) === 5);
  for (const [feature, title] of TILES) {
    const copy = await desk.page.evaluate((name) => {
      const tile = document.querySelector(`.fg-tile[data-feature='${name}']`);
      return { title: tile.querySelector("h3")?.textContent, words: tile.querySelectorAll(":scope > h3, :scope > p").length };
    }, feature);
    H.ok(`the ${feature} tile reads "${title}", and nothing more`, copy.title === title && copy.words === 1, JSON.stringify(copy));
  }
  // The home page stays mounted (hidden) after a visit, so its pictures must not look like a call's
  // video tiles to the call page, which finds those by [data-tile] across the document.
  H.ok("the grid adds nothing the call page would count as a video tile", (await desk.page.locator("[data-tile]").count()) === 0);
  H.ok("the poster, before any animation, shows each tile's payoff", atPoster(await payoff(desk)), JSON.stringify(await payoff(desk)));

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

  // The animations load once the grid is near; then the tiles take turns, one at a time, each story
  // going forward, and every tile at rest still shows its payoff.
  await grid(desk).scrollIntoViewIfNeeded();
  H.ok("the animations load when the grid comes into view", await H.until(async () => (await desk.page.locator(".gm-stage .ss-stage").count()) === 5, 8000));
  const beating = () => desk.page.evaluate(() => Array.from(document.querySelectorAll(".gm-stage .gm-scene[data-beat='true']")).map((scene) => scene.closest(".gm-slot").dataset.scene));
  const seen = new Set();
  let most = 0;
  let together = "";
  const broken = [];
  // A full round, five turns, each a beat and a pause.
  const until = Date.now() + 21000;
  while (Date.now() < until) {
    const now = await beating();
    now.forEach((tile) => seen.add(tile));
    if (now.length > most) {
      most = now.length;
      together = now.join(", ");
    }
    if (now.length === 0) {
      const p = await payoff(desk);
      for (const [tile, ok] of Object.entries(whole(p))) if (!ok) broken.push(`${tile}: ${JSON.stringify(p[tile])}`);
    }
    await H.sleep(100);
  }
  H.ok("one tile moves at a time", most <= 1, together);
  H.ok("every tile takes its turn", seen.size === 5, [...seen].join(", "));
  H.ok("at rest, no tile has gone back on its story (banner, switch, your vote, the lane, the queue)", broken.length === 0, broken.slice(0, 4).join("; "));
  await H.shot(desk, "home-grid-desktop");
  await desk.ctx.close();

  /* a phone */
  const phone = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  await phone.page.goto(`${H.BASE}/`);
  await grid(phone).waitFor();
  const fit = async () =>
    phone.page.evaluate((keep) => {
      const width = document.documentElement.clientWidth;
      const out = [];
      if (document.documentElement.scrollWidth > width) out.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${width}`);
      for (const tile of document.querySelectorAll(".fg-tile")) {
        const t = tile.getBoundingClientRect();
        if (t.left < 0 || t.right > width) out.push(`${tile.dataset.feature} tile runs off the screen`);
        // The title, the controls and the payoff show whole inside the tile; the rest may run off.
        for (const node of tile.querySelectorAll(`h3, p, ${keep.join(", ")}`)) {
          const r = node.getBoundingClientRect();
          if (r.width === 0 || getComputedStyle(node).display === "none" || node.closest("[data-show='false']")) continue;
          if (r.left < t.left - 0.5 || r.right > t.right + 0.5 || r.top < t.top - 0.5 || r.bottom > t.bottom + 0.5) out.push(`${tile.dataset.feature}: "${node.textContent.trim().slice(0, 30)}" is cut by its tile`);
        }
        // Nothing a person reads is drawn under 10px.
        for (const node of tile.querySelectorAll(".gm-slot span, .gm-slot div")) {
          if (!Array.from(node.childNodes).some((child) => child.nodeType === 3 && child.textContent.trim())) continue;
          const r = node.getBoundingClientRect();
          if (!r.width || r.bottom < t.top || r.top > t.bottom || r.left > t.right) continue;
          const size = parseFloat(getComputedStyle(node).fontSize) * (r.width / node.offsetWidth || 1);
          if (size < 9.95) out.push(`${tile.dataset.feature}: "${node.textContent.trim().slice(0, 20)}" is drawn at ${size.toFixed(1)}px`);
        }
      }
      return out;
    }, WHOLE);
  const before = await fit();
  H.ok("phone: nothing in the grid runs off the screen, out of its tile or under 10px", before.length === 0, before.slice(0, 5).join("; "));
  await grid(phone).scrollIntoViewIfNeeded();
  await H.until(async () => (await phone.page.locator(".gm-stage .ss-stage").count()) === 5, 8000);
  await H.sleep(1500);
  const during = await fit();
  H.ok("phone: …nor once the animations run", during.length === 0, during.slice(0, 5).join("; "));
  const banner = await phone.page.evaluate(() => {
    const tile = document.querySelector(".fg-tile[data-feature='share']").getBoundingClientRect();
    const stop = Array.from(document.querySelectorAll(".fg-tile[data-feature='share'] .gm-stop")).filter((el) => el.getClientRects().length > 0)[0].getBoundingClientRect();
    return stop.left >= tile.left && stop.right <= tile.right && stop.width > 0;
  });
  H.ok("phone: the screen-share banner's Stop sharing shows whole", banner);
  H.ok("phone: the reaction lane holds four rows", (await payoff(phone)).reactions.split(" | ").length === 4, (await payoff(phone)).reactions);
  await H.shot(phone, "home-grid-phone");
  await phone.ctx.close();

  /* reduced motion: every tile is its poster, and nothing loads to animate it */
  const still = await H.client(browser, { viewport: H.PHONE, scale: 2, reducedMotion: "reduce" });
  await still.page.goto(`${H.BASE}/`);
  await grid(still).scrollIntoViewIfNeeded();
  await H.sleep(2500);
  H.ok("reduced motion: no animation is loaded", (await still.page.locator(".gm-stage").count()) === 0);
  H.ok("reduced motion: each tile shows its payoff", atPoster(await payoff(still)), JSON.stringify(await payoff(still)));
  await still.ctx.close();
};
