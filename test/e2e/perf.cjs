// Performance budgets under load. One real host in a real call, a synthetic crowd (sim.cjs)
// pushed through the call's own events at a steady rate, and the page watched from inside:
//
// - no main-thread task over 250 ms (the "longtask" entries Chromium reports);
// - layout shift (CLS, summed over the flood) under 0.05 on desktop;
// - never more than 2 notifications on screen.
//
// Each flood starts in a fresh call, and the counts start after the crowd that sets the scene
// has arrived, so the cost of joining is left out. The budgets are the approved ones and are
// not loosened for slow machines. A shared CI runner is noisy (another process, a GC pause), so
// a flood that misses a budget is run once more in a fresh call and only fails if it misses
// again: a real regression misses twice, a stray pause does not. Both runs are printed.
//
// Like notices.cjs, this measures the interface, not a server: nothing here says how LiveKit or
// RealtimeKit copes with 5,000 people.
const H = require("./lib.cjs");
const { install, watch } = require("./sim.cjs");

const BUDGET = { longestTask: 250, cls: 0.05, notices: 2 };
const TICK = 100;

/** Calls `__sim[fn](n)` `total` times spread evenly over `seconds`, one batch every 100 ms. */
async function rate(page, fn, total, seconds) {
  const ticks = Math.round((seconds * 1000) / TICK);
  const start = Date.now();
  let done = 0;
  for (let i = 1; i <= ticks; i++) {
    const target = Math.round((total * i) / ticks);
    if (target > done) await page.evaluate(([f, n]) => window.__sim[f](n), [fn, target - done]);
    done = target;
    const wait = start + i * TICK - Date.now();
    if (wait > 0) await H.sleep(wait);
  }
}

async function host(browser, viewport) {
  const person = await H.client(browser, { viewport, touch: viewport === H.PHONE });
  const url = await H.createMeeting(person);
  await H.join(person, url, "Hana Host");
  // Sounds and arrivals settle for a moment after joining (see useSounds.ts).
  await H.sleep(2800);
  await person.page.evaluate(install);
  await person.page.evaluate(watch);
  return person;
}

/**
 * One flood: `setup` sets the scene, then the counts start, then `flood` runs. Returns what the
 * watcher saw, plus a screenshot name.
 */
async function measure(browser, { viewport = H.DESKTOP, setup, flood, shot }) {
  const a = await host(browser, viewport);
  try {
    if (setup) await setup(a.page);
    await a.page.evaluate(() => window.__watch.reset());
    await flood(a.page);
    // Whatever the last batch started has a moment to finish (and to shift things).
    await H.sleep(1000);
    const seen = await a.page.evaluate(() => window.__watch.read());
    if (shot) await H.shot(a, shot);
    return seen;
  } finally {
    await a.ctx.close();
  }
}

const misses = (seen, { cls }) => {
  const out = [];
  if (seen.longest > BUDGET.longestTask) out.push("task");
  if (cls && seen.cls >= BUDGET.cls) out.push("cls");
  if (seen.maxShown > BUDGET.notices) out.push("notices");
  return out;
};

const summary = (seen) =>
  `longest task ${seen.longest} ms (${seen.longCount} over 50 ms, ${seen.longTotal} ms in all), CLS ${seen.cls}, ` +
  `frames p95 ${seen.frameP95} ms max ${seen.frameMax} ms, at most ${seen.maxShown} notices` +
  (seen.shifts.length ? `, biggest shifts ${JSON.stringify(seen.shifts.slice(0, 2))}` : "");

/** Runs a flood, again if it misses a budget, and records one result per budget. */
async function flood(browser, name, options) {
  const cls = options.cls !== false;
  let seen = await measure(browser, options);
  let note = "";
  const first = misses(seen, { cls });
  if (first.length) {
    note = ` [first run missed ${first.join(", ")}: ${summary(seen)}; run again]`;
    seen = await measure(browser, options);
  }
  console.log(`      ${name}: ${summary(seen)}${note}`);
  H.ok(`${name}: no main-thread task over ${BUDGET.longestTask} ms`, seen.longest <= BUDGET.longestTask, `longest ${seen.longest} ms${note}`);
  if (cls) H.ok(`${name}: layout shift under ${BUDGET.cls}`, seen.cls < BUDGET.cls, `CLS ${seen.cls}${note}`);
  H.ok(`${name}: never more than ${BUDGET.notices} notifications`, seen.maxShown <= BUDGET.notices, `max ${seen.maxShown} ${JSON.stringify(seen.titles.slice(0, 6))}${note}`);
  return seen;
}

module.exports = async function perf(browser) {
  console.log("\n— performance budgets: long tasks, layout shift, notifications, under floods —");

  // The joins start in a meeting of 20, so the gallery page is already full. Going from a few
  // tiles to a full page re-grids every tile (about 0.05 of layout shift in one go, as in any
  // gallery); that is the meeting filling up, not the flood, and is left out.
  const twenty = async (page) => {
    await page.evaluate(() => window.__sim.join(20));
    await H.sleep(1500);
  };

  // 1,000 people arrive in 20 s, 50 a second.
  await flood(browser, "1,000 joins", { setup: twenty, flood: (page) => rate(page, "join", 1000, 20), shot: "perf-1000-joins" });

  // 5,000 people arrive in 50 s, 100 a second.
  await flood(browser, "5,000 joins", { setup: twenty, flood: (page) => rate(page, "join", 5000, 50), shot: "perf-5000-joins" });

  // A busy chat: 300 messages in 10 s in a 51-person meeting.
  await flood(browser, "300-message chat", {
    setup: async (page) => {
      await page.evaluate(() => window.__sim.join(50));
      await H.sleep(1500);
    },
    flood: (page) => rate(page, "chat", 300, 10),
    shot: "perf-chat-300",
  });

  // 100 people ask to join in 10 s.
  await flood(browser, "100 knocks", { flood: (page) => rate(page, "knock", 100, 10), shot: "perf-knock-100" });

  // 200 reactions in 2 s from a 200-person meeting.
  await flood(browser, "200 reactions", {
    setup: async (page) => {
      await page.evaluate(() => window.__sim.join(200));
      await H.sleep(1500);
    },
    flood: (page) => rate(page, "react", 200, 2),
    shot: "perf-reactions-200",
  });

  // The People list through a flood of hands in a 231-person meeting. A list being read holds
  // still (src/lib/listHold.ts): scrolled, touched or (with a mouse) hovered, nobody is added or
  // moved, and an "N new" pill counts what arrived. Left alone at the top it is live, so the
  // first hands push it down; rows that move glide (by transform), or snap with reduced motion.
  // The live case is measured and printed, not budgeted.
  await peopleSheet(browser, "at the top, untouched");
  await peopleSheet(browser, "at the top, untouched, reduced motion", { reducedMotion: "reduce" });
  await peopleSheet(browser, "scrolled");
  await peopleSheet(browser, "touched");
  await peopleSheet(browser, "hovered", { viewport: H.DESKTOP });
};

/**
 * Where the pill is against the rows: its box must not meet any button in the list, nor the
 * row icons and buttons of the first two rows under it, and its left edge lines up with the names.
 */
const pillPlace = (page) =>
  page.evaluate(() => {
    const pill = document.querySelector("[data-new-pill]");
    if (!pill) return { ok: false, why: "no pill" };
    const box = (el) => el.getBoundingClientRect();
    const p = box(pill);
    const scroller = pill.closest(".scroll-quiet");
    const s = box(scroller);
    const meets = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const rows = [...scroller.querySelectorAll('[role="listitem"], section[aria-label="Raised hands"] li')]
      .map((row) => ({ row, r: box(row) }))
      .filter(({ r }) => r.bottom > s.top + 1 && r.top < s.bottom)
      .sort((a, b) => a.r.top - b.r.top)
      .slice(0, 2);
    const controls = [
      ...[...scroller.querySelectorAll("button")].filter((b) => b !== pill),
      ...rows.flatMap(({ row }) => [...row.querySelectorAll("span.shrink-0.items-center > *")]),
    ];
    const hits = controls.filter((el) => meets(p, box(el))).map((el) => el.getAttribute("aria-label") || el.textContent.trim().slice(0, 20) || el.tagName);
    const name = rows[0]?.row.querySelector("span.min-w-0 > span");
    const nameLeft = name ? Math.round(box(name).left) : null;
    return {
      ok: hits.length === 0 && nameLeft !== null && Math.abs(p.left - nameLeft) <= 1 && Math.round(p.top - s.top) === 8,
      hits,
      pill: { left: Math.round(p.left), right: Math.round(p.right), top: Math.round(p.top - s.top) },
      nameLeft,
    };
  });

/** The People list through a flood of hands, read in one of five ways. */
async function peopleSheet(browser, how, { viewport = H.PHONE, reducedMotion = "no-preference" } = {}) {
  const phone = viewport === H.PHONE;
  const person = await H.client(browser, { viewport, touch: phone, reducedMotion });
  try {
    const { page } = person;
    const url = await H.createMeeting(person);
    await H.join(person, url, "Hana Host");
    await H.sleep(2800);
    await page.evaluate(install);
    await page.evaluate(watch);
    await page.evaluate(() => window.__sim.join(230));
    await H.sleep(1500);
    await page.locator("#toggle-people").click();
    // The people list's own scroller: the parent of the list of everyone.
    const list = page.locator('aside[aria-label="People"] [role="list"][aria-label="Participants"]').locator("..");
    await list.waitFor();
    await H.sleep(800);
    // Counts the glides: animations started on an element that is measured for one.
    await page.evaluate(() => {
      window.__flips = 0;
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        if (this.hasAttribute("data-flip")) window.__flips++;
        return animate.apply(this, args);
      };
    });
    if (how === "scrolled") await list.evaluate((el) => el.scrollBy({ top: 120 }));
    if (how === "touched") await list.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true, bubbles: true });
    if (how === "hovered") {
      const r = await list.boundingBox();
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    }
    await H.sleep(300);
    await page.evaluate(() => window.__watch.reset());
    // A finger or a pointer rests on the list for 4 s, not 10.
    const total = how === "hovered" ? 40 : 200;
    await rate(page, "hands", total, how === "touched" || how === "hovered" ? 4 : 10);
    await H.sleep(1000);
    const seen = await page.evaluate(() => window.__watch.read());
    const name = `${total} hands, People ${phone ? "sheet open on a phone" : "panel open on desktop"}, ${how}`;
    console.log(`      ${name}: ${summary(seen)}`);
    H.ok(`${name}: no main-thread task over ${BUDGET.longestTask} ms`, seen.longest <= BUDGET.longestTask, `longest ${seen.longest} ms`);
    const pill = page.locator("[data-new-pill]");
    const raised = page.locator('aside[aria-label="People"] section[aria-label="Raised hands"] li');
    const flips = () => page.evaluate(() => window.__flips);
    await H.shot(person, `perf-hands-people-${phone ? "phone" : "desktop"}-${how.replace(/\W+/g, "-")}`);
    if (how.startsWith("at the top, untouched")) {
      H.ok(`${name}: live, so no pill, and the first five hands are listed`, (await pill.count()) === 0 && (await raised.count()) === 5);
      if (reducedMotion === "reduce") H.ok(`${name}: rows snap, nothing glides`, (await flips()) === 0, `${await flips()} glides`);
      else H.ok(`${name}: the rows that move glide`, (await flips()) > 0, `${await flips()} glides`);
      return;
    }
    H.ok(`${name}: layout shift under ${BUDGET.cls}`, seen.cls < BUDGET.cls, `CLS ${seen.cls} ${JSON.stringify(seen.shifts.slice(0, 2))}`);
    const said = ((await pill.textContent().catch(() => "")) || "").trim();
    const hands = await page.evaluate(() => window.__meetly.call.participants().filter((p) => p.handRaised).length);
    const label = `${hands > 99 ? "99+" : hands} new`;
    H.ok(`${name}: the pill counts the hands that went up meanwhile ("99+" above 99), and none moved in`, said === label && (await raised.count()) === 0, `"${said}" with ${hands} hands up`);
    const place = await pillPlace(page);
    H.ok(`${name}: the pill lines up with the names, 8px down, clear of every row button`, place.ok, JSON.stringify(place));
    if (how === "scrolled") {
      await pill.tap();
      const shown = await H.until(async () => (await pill.count()) === 0 && (await raised.count()) === 5 && (await list.evaluate((el) => el.scrollTop)) === 0, 3000);
      H.ok(`${name}: one tap on the pill goes to the top and shows them`, shown);
      await H.shot(person, "perf-hands-people-phone-after-pill");
    } else if (how === "touched") {
      await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch", isPrimary: true })));
      const caught = await H.until(async () => (await pill.count()) === 0 && (await raised.count()) === 5, 4000);
      H.ok(`${name}: lifting the finger lets the list catch up`, caught);
    } else {
      // Off the list, onto the stage.
      await page.mouse.move(40, 40);
      const caught = await H.until(async () => (await pill.count()) === 0 && (await raised.count()) === 5, 4000);
      H.ok(`${name}: moving the pointer off the list lets it catch up`, caught);
    }
  } finally {
    await person.ctx.close();
  }
}
