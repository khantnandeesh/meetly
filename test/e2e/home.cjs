// The home page: the hero's notification and the "Inside a meeting" feature grid.
const H = require("./lib.cjs");

const WIDE = { width: 1440, height: 900 };

// The approved copy, tile by tile, in reading order.
const TILES = [
  ["share", "Share your screen. On a computer, share a tab, a window or your whole screen."],
  ["noise", "Noise suppression Background noise, turned down. On by default. Turn it off when you play music."],
  ["polls", "Quick polls. The host asks, everyone gets one vote, and votes can be anonymous."],
  ["reactions", "React without unmuting. When many people send the same emoji, it shows as one count."],
  ["hands", "Hands, in order. Raised hands are listed in the order they went up, and the host can lower them all in one tap."],
];
// The poll's bars at rest: Tuesday 2, Wednesday 7, Thursday 3 of 12 votes.
const SHARES = [2 / 12, 7 / 12, 3 / 12];

const grid = (person) => person.page.locator("section[aria-labelledby='inside-a-meeting']");
const tileCopy = (person, feature) =>
  person.page.evaluate((name) => {
    const tile = document.querySelector(`.fg-tile[data-feature='${name}']`);
    // The copy only: the pictures are decorative and hidden from assistive technology.
    const copy = tile && Array.from(tile.querySelectorAll(":scope > p, :scope h3, :scope .fg-statement > p")).map((node) => node.textContent);
    return copy ? copy.join(" ").replace(/\s+/g, " ").trim() : null;
  }, feature);
const barScales = (person) =>
  person.page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-feature='polls'] [data-poll-bar]")).map((bar) => {
      const matrix = getComputedStyle(bar).transform;
      return { scale: matrix === "none" ? 1 : Number(matrix.slice(7).split(",")[0]), animating: bar.getAnimations().length > 0 };
    }),
  );
const atRest = (bars) => bars.length === 3 && bars.every((bar, index) => Math.abs(bar.scale - SHARES[index]) < 0.01 && !bar.animating);

module.exports = async function home(browser) {
  console.log("\n— home —");

  /* a computer */
  const desk = await H.client(browser, { viewport: WIDE, scale: 2 });
  await desk.page.goto(`${H.BASE}/`);
  await desk.page.getByRole("heading", { level: 2, name: "Inside a meeting" }).waitFor();
  H.ok("the feature grid is headed Inside a meeting", (await desk.page.getByRole("heading", { level: 2, name: "Inside a meeting" }).count()) === 1);
  H.ok("it has five tiles", (await grid(desk).locator(":scope > ul > li").count()) === 5);
  for (const [feature, copy] of TILES) {
    const text = await tileCopy(desk, feature);
    H.ok(`the ${feature} tile says what was approved`, text === copy, text);
  }
  H.ok("the poll shows no host controls", (await grid(desk).getByText("End poll").count()) === 0);

  // The hero's notification: Deny and Admit on a line of their own under "Pat wants to join".
  const knock = desk.page.locator("[data-hero-toast]").filter({ visible: true }).first();
  await knock.getByText("Pat wants to join").waitFor();
  const lines = await knock.evaluate((el) => {
    const box = (text) => Array.from(el.querySelectorAll("span")).find((span) => span.textContent.trim() === text).getBoundingClientRect();
    const title = box("Pat wants to join");
    const deny = box("Deny");
    const admit = box("Admit");
    // The answers' row is pulled up a little (-mt-1.5, as in Toaster.tsx), so compare by line: each
    // button's middle is below the title's text.
    const middle = (r) => r.top + r.height / 2;
    return { below: middle(deny) > title.bottom && middle(admit) > title.bottom, level: Math.abs(deny.top - admit.top) < 1, order: deny.right <= admit.left };
  });
  H.ok("hero: Deny and Admit sit on their own line under the title, Deny first", lines.below && lines.level && lines.order, JSON.stringify(lines));

  // The poll's bars render full (what a screenshot or a page with no script shows), fill once as
  // the card comes into view, and end at their counts.
  H.ok("the poll's bars are full before the card is in view", atRest(await barScales(desk)), JSON.stringify(await barScales(desk)));
  await grid(desk).locator("[data-feature='polls']").scrollIntoViewIfNeeded();
  const filling = await H.until(async () => (await barScales(desk)).some((bar) => bar.animating), 1500, 20);
  H.ok("once in view, the bars fill", filling);
  H.ok("…to their counts, and stop", await H.until(async () => atRest(await barScales(desk)), 3000), JSON.stringify(await barScales(desk)));
  await desk.page.evaluate(() => {
    window.__pollAgain = 0;
    document.querySelectorAll("[data-feature='polls'] [data-poll-bar]").forEach((bar) => {
      const animate = bar.animate.bind(bar);
      bar.animate = (...args) => {
        window.__pollAgain += 1;
        return animate(...args);
      };
    });
    window.scrollTo(0, 0);
  });
  await H.sleep(300);
  await grid(desk).locator("[data-feature='polls']").scrollIntoViewIfNeeded();
  await H.sleep(600);
  H.ok("…and only once", (await desk.page.evaluate(() => window.__pollAgain)) === 0 && atRest(await barScales(desk)));
  await H.shot(desk, "home-grid-desktop");
  await desk.ctx.close();

  /* a phone */
  const phone = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  await phone.page.goto(`${H.BASE}/`);
  await grid(phone).waitFor();
  const fit = await phone.page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const out = [];
    if (document.documentElement.scrollWidth > width) out.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${width}`);
    for (const tile of document.querySelectorAll(".fg-tile")) {
      const t = tile.getBoundingClientRect();
      if (t.left < 0 || t.right > width) out.push(`${tile.dataset.feature} tile runs off the screen`);
      // Every word and control in a tile shows whole inside it (the shared page may be cropped).
      for (const node of tile.querySelectorAll("p, h3, span, strong")) {
        if (node.closest(".fg-share-page") || !node.textContent.trim()) continue;
        const r = node.getBoundingClientRect();
        if (r.width === 0 || getComputedStyle(node).display === "none") continue;
        if (r.left < t.left - 0.5 || r.right > t.right + 0.5 || r.top < t.top - 0.5 || r.bottom > t.bottom + 0.5) out.push(`${tile.dataset.feature}: "${node.textContent.trim().slice(0, 30)}" is cut by its tile`);
      }
    }
    return out;
  });
  H.ok("phone: nothing in the grid runs off the screen or out of its tile", fit.length === 0, fit.slice(0, 5).join("; "));
  const banner = await phone.page.evaluate(() => {
    const tile = document.querySelector(".fg-tile[data-feature='share']").getBoundingClientRect();
    const stop = Array.from(document.querySelectorAll(".fg-share-banner span")).find((span) => span.textContent.trim() === "Stop sharing").getBoundingClientRect();
    return stop.left >= tile.left && stop.right <= tile.right && stop.width > 0;
  });
  H.ok("phone: the screen-share banner and Stop sharing show whole", banner);
  const lane = await phone.page.evaluate(() => Array.from(document.querySelectorAll(".fg-reactions .chip")).filter((chip) => chip.getBoundingClientRect().height > 0).map((chip) => chip.textContent.trim()));
  H.ok("phone: the reaction lane has three rows, newest on top", lane.join(" | ") === "❤️Lena | 🎉×5 | 👏×12", lane.join(" | "));
  await H.shot(phone, "home-grid-phone");
  await phone.ctx.close();

  /* reduced motion: the poll is simply full */
  const still = await H.client(browser, { viewport: H.PHONE, scale: 2, reducedMotion: "reduce" });
  await still.page.goto(`${H.BASE}/`);
  await grid(still).waitFor();
  H.ok("reduced motion: the poll's bars are full before it is in view", atRest(await barScales(still)), JSON.stringify(await barScales(still)));
  await grid(still).locator("[data-feature='polls']").scrollIntoViewIfNeeded();
  await H.sleep(600);
  H.ok("reduced motion: …and after, with nothing animated", atRest(await barScales(still)), JSON.stringify(await barScales(still)));
  await still.ctx.close();
};
