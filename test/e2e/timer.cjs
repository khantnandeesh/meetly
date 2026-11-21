// How long the meeting has been running: the timer in the control bar (desktop), beside the code
// in the top bar (phone), and where "● Live · N watching" sits for a webinar's audience.
//
// The start comes from our server once, with the token (`started`, see src/app/api/token). Here it
// is LiveKit's: the moment the first person was let into the empty room. Where a test needs a
// meeting that has run for an hour or more, or a start the server could not give, it rewrites that
// one field of the token's answer on its way to the page; nothing else is faked.
const H = require("./lib.cjs");
const { CROWD } = require("./layout.cjs");

const inCall = (person) => person.page.locator("[data-in-call]:not([inert])");
const timer = (person) => inCall(person).locator("[data-meeting-timer]:visible").first();
const asSeconds = (text) => text.trim().split(":").map(Number).reduce((total, part) => total * 60 + part, 0);
const seconds = async (person) => asSeconds(await timer(person).innerText());

/** Rewrites `started` in this person's token answer: a number of milliseconds, or undefined for "not known". */
async function startedAgo(person, started) {
  await person.page.route("**/api/token", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    delete json.started;
    return route.fulfill({ response, json: started === undefined ? json : { ...json, started } });
  });
}

/** A webinar link made the way "New webinar" makes it; this person's browser holds its host key. */
async function createWebinar(person) {
  await person.page.goto(`${H.BASE}/`);
  const code = await person.page.evaluate(async () => {
    const response = await fetch("/api/meeting", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", mode: "webinar" }) });
    return (await response.json()).code;
  });
  return `${H.BASE}/${code}`;
}

/** Both timers read at the same moment, in seconds. */
const together = (a, b) => Promise.all([seconds(a), seconds(b)]);

/* ----------------------------------------------- shows, ticks, agrees */

async function basics(browser) {
  const host = await H.client(browser, { viewport: { width: 1440, height: 900 }, scale: 2 });
  const guest = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  const url = await H.createMeeting(host);
  await H.join(host, url, "Hana Host");
  H.ok("the first person in is told the meeting begins now", host.tokenBody && host.tokenBody.started === 0, JSON.stringify(host.tokenBody && host.tokenBody.started));

  const desktop = inCall(host).locator("footer [data-meeting-timer]");
  H.ok("desktop: the timer is in the control bar's left cluster, beside the clock", (await desktop.isVisible()) && (await inCall(host).locator("footer time").isVisible()));
  const first = await seconds(host);
  await H.sleep(3100);
  const later = await seconds(host);
  H.ok("desktop: it advances over 3 s", later - first >= 2 && later - first <= 4, `${first} → ${later}`);
  H.ok("desktop: mm:ss under an hour, in tabular figures", /^\d{1,2}:\d\d$/.test(await desktop.innerText()) && (await desktop.evaluate((el) => getComputedStyle(el).fontVariantNumeric)).includes("tabular-nums"));
  H.ok(
    "it is a timer that is not announced, named as the meeting's time in minutes",
    (await desktop.getAttribute("role")) === "timer" && (await desktop.getAttribute("aria-live")) === "off" && /^Meeting time, (under a minute|\d+ minutes?)$/.test(await desktop.getAttribute("aria-label")),
    await desktop.getAttribute("aria-label"),
  );

  // Ticking touches the timer's own text and nothing else in the bar.
  const changed = await host.page.evaluate(
    () =>
      new Promise((resolve) => {
        const outside = new Set();
        const bar = document.querySelector("[data-in-call] footer");
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            const node = record.target.nodeType === 1 ? record.target : record.target.parentElement;
            if (!node.closest("[data-meeting-timer]")) outside.add(node.tagName + (node.getAttribute("aria-label") ? `[${node.getAttribute("aria-label")}]` : ""));
          }
        });
        observer.observe(bar, { subtree: true, childList: true, characterData: true, attributes: true });
        setTimeout(() => {
          observer.disconnect();
          resolve([...outside]);
        }, 2500);
      }),
  );
  H.ok("each second changes the timer's text and nothing else in the control bar", changed.length === 0, changed.join(", "));

  // A second person, some seconds later, sees the same meeting time, not their own.
  await H.sleep(2500);
  await H.join(guest, url, "Gus Guest");
  H.ok("the second person is told how long ago the meeting began", typeof guest.tokenBody.started === "number" && guest.tokenBody.started >= 5000, String(guest.tokenBody.started));
  const header = inCall(guest).locator("header [data-meeting-timer]");
  H.ok("phone: the timer is in the top bar, beside the code", await header.isVisible());
  const [h, g] = await together(host, guest);
  H.ok("two people who joined 8 s apart show the same elapsed time (within 2 s)", Math.abs(h - g) <= 2 && h >= 7, `host ${h}, guest ${g}`);
  const phoneFirst = await seconds(guest);
  await H.sleep(3100);
  H.ok("phone: it advances over 3 s", (await seconds(guest)) - phoneFirst >= 2);
  H.ok("phone: small and muted", await header.evaluate((el) => parseFloat(getComputedStyle(el).fontSize) <= 12.5 && getComputedStyle(el).color !== getComputedStyle(document.body).color));
  await H.shot(host, "timer-desktop");
  await H.shot(guest, "timer-phone");

  // A start the server could not give: counted from joining, and named so.
  const late = await H.client(browser, { viewport: { width: 1440, height: 900 } });
  await startedAgo(late, undefined);
  await H.join(late, url, "Lou Late");
  const own = inCall(late).locator("footer [data-meeting-timer]");
  const [hostNow, lateNow] = await together(host, late);
  H.ok("start not known: counts from when you joined", lateNow <= 3 && hostNow >= 12, `host ${hostNow}, late ${lateNow}`);
  H.ok("…and says so", /^Time since you joined, /.test(await own.getAttribute("aria-label")), await own.getAttribute("aria-label"));
  await own.hover();
  H.ok("…on hover too", await H.until(async () => (await late.page.getByRole("tooltip").filter({ hasText: "Time since you joined" }).count()) > 0, 3000));

  for (const person of [host, guest, late]) await person.ctx.close();
}

/* ------------------------------------------------ the phone's top bar */

async function topBar(person, label) {
  return person.page.evaluate(() => {
    const header = document.querySelector("[data-in-call] header");
    const people = header.querySelector("#toggle-people");
    const code = header.querySelector("button span.truncate");
    const timer = header.querySelector("[data-meeting-timer]");
    const shown = timer && getComputedStyle(timer).display !== "none";
    const r = (el) => el.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      peopleText: people.querySelector("[data-headcount]").textContent,
      peopleWhole: people.scrollWidth <= people.clientWidth + 0.5 && r(people).right <= innerWidth - 11.5 && r(people).left >= 0,
      codeWhole: code.scrollWidth <= code.clientWidth + 0.5,
      timerShown: shown,
      timerText: shown ? timer.textContent : null,
      timerClear: !shown || (r(timer).left >= r(code).right && r(timer).right <= r(header.lastElementChild).left),
    };
  }).then((state) => ({ ...state, label }));
}

async function phones(browser) {
  const host = await H.client(browser);
  const url = await H.createMeeting(host);
  await H.join(host, url, "Hana Host");
  for (const width of [360, 390]) {
    const mo = await H.client(browser, { viewport: { width, height: 800 }, scale: 2, touch: true, reducedMotion: "reduce" });
    // An hour in: "1:02:03" is the widest the top bar has to hold in practice.
    await startedAgo(mo, 3_723_000);
    await H.join(mo, url, "Mo Phone");
    await mo.page.evaluate(CROWD);
    await mo.page.evaluate(() => window.__crowd.join(1202));
    await H.sleep(1200);
    let bar = await topBar(mo, `${width}`);
    H.ok(
      `${width} px with 1,204 people and over an hour: nothing overflows, the code and "1.2k" are whole, the timer shows`,
      !bar.overflow && bar.peopleText === "1.2k" && bar.peopleWhole && bar.codeWhole && bar.timerShown && /^1:02:\d\d$/.test(bar.timerText) && bar.timerClear,
      JSON.stringify(bar),
    );
    H.ok(`${width} px: under reduced motion the timer is still text, nothing animates`, await timer(mo).evaluate((el) => getComputedStyle(el).animationName === "none" && getComputedStyle(el).transitionDuration === "0s"));
    await H.shot(mo, `timer-phone-${width}-crowd`);
    // The fullest top bar: a raised hand adds its chip. Where there is no longer room for the timer
    // beside the whole code, it steps aside whole rather than squeeze anything. (At 360 px the hands
    // chip alone cuts the code short, as it did before the timer; with the timer out of the layout,
    // that is the same bar as without it.)
    await mo.page.evaluate(() => window.__meetly.call.setHandRaised(true));
    await H.sleep(1200);
    bar = await topBar(mo, `${width} hand`);
    H.ok(
      `${width} px with a raised hand too: nothing overflows, "1.2k" is whole, and the timer is whole beside the code or out of the way${width >= 390 ? "; the code is whole" : ""}`,
      !bar.overflow && bar.peopleWhole && bar.timerClear && (width >= 390 ? bar.codeWhole : !bar.timerShown),
      JSON.stringify(bar),
    );
    await H.shot(mo, `timer-phone-${width}-hand`);
    // Leave properly: a closed page lingers in the room for a while, raised hand and all.
    await mo.page.evaluate(() => window.__meetly.call.disconnect());
    await mo.ctx.close();
  }
  await host.ctx.close();
}

/* ------------------------------------------ large screens, 768–1440 px */

async function widths(browser) {
  const host = await H.client(browser, { viewport: { width: 1440, height: 900 } });
  // Ten hours in, the widest the timer gets: the cluster has to give way in time for it too.
  await startedAgo(host, 36_001_000);
  const url = await H.createMeeting(host);
  await H.join(host, url, "Hana Host");
  await host.page.evaluate(CROWD);
  await host.page.evaluate(() => window.__crowd.join(3));
  H.ok("1440 px: the clock, the timer and the code all show", (await inCall(host).locator("footer time").isVisible()) && /^10:00:\d\d$/.test(await timer(host).innerText()));
  const problems = [];
  for (const width of [768, 800, 850, 899, 960, 1024, 1100, 1180, 1280, 1366, 1440]) {
    await host.page.setViewportSize({ width, height: 800 });
    await H.sleep(300);
    const covered = await H.coveredButtons(host);
    const spill = await host.page.evaluate(() => {
      const cluster = document.querySelector("[data-in-call] footer > div:first-child");
      const controls = document.querySelector("[data-in-call] footer > [role=toolbar]");
      const edge = cluster.getBoundingClientRect().right;
      const out = [...cluster.children]
        .filter((el) => getComputedStyle(el).display !== "none")
        .filter((el) => el.getBoundingClientRect().right > edge + 0.5)
        .map((el) => el.textContent.trim() || el.tagName);
      if (edge > controls.getBoundingClientRect().left) out.push("cluster over the controls");
      return out;
    });
    if (covered.length || spill.length) problems.push(`${width}: ${[...covered, ...spill].join(", ")}`);
  }
  H.ok("768–1440 px, ten hours in: the leave controls and every other button stay uncovered, and the left cluster stays in its place", problems.length === 0, problems.join("; "));
  await host.ctx.close();
}

/* --------------------------------------------- a webinar's audience */

async function webinar(browser) {
  const host = await H.client(browser, { viewport: { width: 1440, height: 900 } });
  const url = await createWebinar(host);
  await H.press(host, url, "Hana Host", /^Join now$/);
  await inCall(host).getByRole("button", { name: "Leave webinar" }).first().waitFor({ timeout: 20000 });
  H.ok("webinar host: the timer is named as the webinar's", /^Webinar time, /.test(await timer(host).getAttribute("aria-label")));
  await H.sleep(3000);
  const viewers = [];
  for (const [viewport, name] of [
    [{ width: 1440, height: 900 }, "Vic Viewer"],
    [H.PHONE, "Wes Watcher"],
  ]) {
    const viewer = await H.client(browser, { viewport, scale: 2, touch: viewport.width < 768 });
    await viewer.page.goto(url);
    await viewer.page.getByLabel("Your name").fill(name);
    await viewer.page.getByRole("button", { name: "Watch" }).click();
    await inCall(viewer).locator("[data-viewer-bar]").waitFor({ timeout: 20000 });
    viewers.push(viewer);
  }
  const [vic, wes] = viewers;
  const live = inCall(vic).locator("[data-viewer-bar] [data-live]");
  H.ok(
    'viewer, desktop: the timer sits in "● Live · 0:05 · N watching"',
    (await live.locator("[data-meeting-timer]").isVisible()) && /^Live · \d+:\d\d · \d+ watching$/.test((await live.innerText()).replace(/\s+/g, " ").trim()),
    (await live.innerText()).replace(/\s+/g, " "),
  );
  H.ok("viewer, phone: the timer is in the top bar", await inCall(wes).locator("header [data-meeting-timer]").isVisible());
  const [h, v] = await together(host, vic);
  const [, w] = await together(host, wes);
  H.ok("the host and both viewers show the same webinar time (within 2 s)", Math.abs(h - v) <= 2 && Math.abs(h - w) <= 2 && h >= 3, `host ${h}, desktop viewer ${v}, phone viewer ${w}`);
  H.ok("viewer, phone: the top bar fits", await H.noOverflow(wes));
  const clashes = [];
  for (const width of [768, 900, 1024, 1440]) {
    await vic.page.setViewportSize({ width, height: 800 });
    await H.sleep(300);
    const clash = await vic.page.evaluate(() => {
      const cluster = document.querySelector("[data-viewer-bar] > div:first-child");
      const controls = document.querySelector("[data-viewer-bar] > [role=toolbar]");
      const live = cluster.querySelector("[data-live]").getBoundingClientRect();
      return live.right > controls.getBoundingClientRect().left || document.documentElement.scrollWidth > innerWidth;
    });
    const covered = await H.coveredButtons(vic);
    if (clash || covered.length) clashes.push(`${width}: ${clash ? "Live runs into the controls " : ""}${covered.join(", ")}`);
  }
  H.ok("viewer, 768–1440 px: \"● Live · time · N watching\" never runs into the controls, and Leave is uncovered", clashes.length === 0, clashes.join("; "));
  await H.shot(vic, "timer-viewer-desktop");
  await H.shot(wes, "timer-viewer-phone");
  for (const person of [host, vic, wes]) await person.ctx.close();
}

module.exports = async function timerSuite(browser) {
  console.log("\n— how long the meeting has been running —");
  await basics(browser);
  await phones(browser);
  await widths(browser);
  await webinar(browser);
};
