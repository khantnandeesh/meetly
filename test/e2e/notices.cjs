// The notification policy (src/lib/notices.ts) under load: aggregation, the cap, priority,
// placement, and a flood without jank. One real host in a real call; the crowd is synthetic:
// people, hands, knocks and messages are pushed through the call's own events (the
// provider-neutral RtcCall on window.__meetly), so the interface sees exactly what an adapter
// would send it. Nothing here proves how a real server copes with that many people.
const H = require("./lib.cjs");

// The crowd and the watcher are shared with perf.cjs.
const { install: SIM, watch: WATCH } = require("./sim.cjs");

const shown = (person) =>
  person.page.evaluate(() =>
    [...document.querySelectorAll("[data-toast]")]
      .filter((t) => t.dataset.leaving !== "true")
      .map((t) => {
        const r = t.getBoundingClientRect();
        return {
          title: t.querySelector(".toast-title")?.textContent || "",
          priority: t.dataset.priority,
          buttons: [...t.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean),
          top: r.top,
          bottom: r.bottom,
          bodyShown: !!t.querySelector(".toast-body") && getComputedStyle(t.querySelector(".toast-body")).display !== "none",
        };
      }),
  );

async function host(browser, viewport = H.DESKTOP) {
  const person = await H.client(browser, { viewport, touch: viewport === H.PHONE });
  const url = await H.createMeeting(person);
  await H.join(person, url, "Hana Host");
  // Sounds and arrivals settle for a moment after joining (see useSounds.ts).
  await H.sleep(2800);
  await person.page.evaluate(SIM);
  await person.page.evaluate(WATCH);
  return person;
}

module.exports = async function notices(browser) {
  console.log("\n— notifications: aggregation, cap, priority, placement, floods —");

  // Arrivals that are not on screen are counted in one notification, not listed or stacked.
  {
    const a = await host(browser);
    await a.page.evaluate(() => window.__sim.join(20));
    await H.sleep(1600);
    const now = await shown(a);
    const joined = now.filter((t) => / joined$/.test(t.title));
    H.ok("arrivals: one notification for a burst, counted", joined.length === 1 && /^\d+ people joined$/.test(joined[0].title), JSON.stringify(now.map((t) => t.title)));
    H.ok("arrivals: ranked as presence, the lowest kind", joined[0]?.priority === "presence");
    // With the people list open, the list is the news.
    await H.openPeople(a);
    await a.page.evaluate(() => window.__sim.join(2));
    await H.sleep(900);
    H.ok("arrivals: nothing while the people list is open", (await shown(a)).filter((t) => / joined$/.test(t.title)).length === 0);
    await a.ctx.close();
  }

  // People asking to join: one notification that counts, and the right buttons for the count.
  {
    const a = await host(browser);
    await a.page.evaluate(() => window.__sim.knock(1));
    await H.sleep(500);
    let knock = (await shown(a)).find((t) => /wants? to join/.test(t.title));
    H.ok("knock: one person gets Deny and Admit", !!knock && knock.buttons.includes("Deny") && knock.buttons.includes("Admit"), JSON.stringify(knock));
    await a.page.evaluate(() => window.__sim.knock(29));
    await H.sleep(1500);
    const all = await shown(a);
    knock = all.find((t) => /want to join/.test(t.title));
    H.ok("knock: thirty people are one notification that counts them", all.filter((t) => /join$/.test(t.title)).length === 1 && knock?.title === "30 people want to join", JSON.stringify(all.map((t) => t.title)));
    H.ok("knock: the count offers View, never a Deny meant for one person", !!knock && knock.buttons.includes("View") && !knock.buttons.includes("Deny"), JSON.stringify(knock?.buttons));
    await H.openPeople(a);
    await H.sleep(400);
    H.ok("knock: left out while the people list (with the same buttons) is open", !(await shown(a)).some((t) => /want to join/.test(t.title)));
    await H.closePeople(a);
    await H.sleep(500);
    H.ok("knock: back when the list closes and people are still waiting", (await shown(a)).some((t) => t.title === "30 people want to join"));
    // Thirty arrivals in the waiting room are not thirty knocks.
    const knocks = await a.page.evaluate(() => (window.__meetlySounds?.log || []).filter((s) => s.name === "knock" && s.outcome === "played").length);
    H.ok("knock: a burst is heard once, not per person", knocks <= 2, `${knocks} knocks played`);
    await a.ctx.close();
  }

  // Everything at once: the cap holds, controls stay clear, and what concerns you is not pushed aside.
  {
    const a = await host(browser);
    await a.page.evaluate(() => window.__sim.join(6));
    await H.sleep(800);
    const start = Date.now();
    let mutedAt = 0;
    while (Date.now() - start < 6000) {
      await a.page.evaluate(() => {
        const s = window.__sim;
        s.join(2);
        s.knock(1);
        s.chat(1);
        s.hands(1);
      });
      if (!mutedAt && Date.now() - start > 1500) {
        mutedAt = Date.now();
        await a.page.evaluate(() => window.__sim.mutedByHost());
        await H.sleep(150);
      }
      if (mutedAt && Date.now() - mutedAt > 1500 && Date.now() - mutedAt < 2200) {
        const now = await shown(a);
        H.ok("priority: 'the host muted you' is still up after 1.5 s of flood", now.some((t) => t.title === "The host muted your microphone"), JSON.stringify(now.map((t) => t.title)));
        const knock = now.find((t) => /join$/.test(t.title));
        const nearest = now.reduce((best, t) => (t.bottom > (best?.bottom ?? -1) ? t : best), null);
        H.ok("priority: the request to join sits nearest the controls", !!knock && nearest === knock, JSON.stringify(now.map((t) => [t.title, Math.round(t.bottom)])));
        mutedAt = -1;
      }
      await H.sleep(200);
    }
    const seen = await a.page.evaluate(() => window.__watch.read());
    H.ok("cap: never more than two notifications on screen", seen.maxShown <= 2, `max ${seen.maxShown}`);
    H.ok("cap: notifications never cover the control bar", !seen.coveredControls, `closest ${seen.closest}px above it ${seen.detail}`);
    await a.ctx.close();
  }

  // A dialog has your attention: news waits; what you must answer does not.
  {
    const a = await host(browser);
    await a.page.keyboard.press("?");
    await a.page.getByRole("dialog").waitFor();
    await a.page.evaluate(() => window.__sim.chat(1));
    await H.sleep(700);
    H.ok("dialog: a chat message does not pop up over an open dialog", (await shown(a)).length === 0);
    await a.page.evaluate(() => window.__sim.knock(1));
    await H.sleep(700);
    H.ok("dialog: a request to join still shows", (await shown(a)).some((t) => /wants to join/.test(t.title)));
    await a.ctx.close();
  }

  // Phone, with a sheet open: one line over the top bar, never over the sheet.
  {
    const a = await host(browser, H.PHONE);
    await a.page.getByRole("button", { name: /^Chat/ }).click();
    const sheet = a.page.locator('aside[aria-label="Chat"]');
    await sheet.waitFor();
    await H.sleep(500);
    await a.page.evaluate(() => window.__sim.join(30));
    await a.page.evaluate(() => window.__sim.knock(2));
    await H.sleep(1500);
    const now = await shown(a);
    const sheetTop = await sheet.evaluate((el) => el.getBoundingClientRect().top);
    H.ok("phone sheet: one notification at most", now.length === 1, JSON.stringify(now.map((t) => t.title)));
    H.ok("phone sheet: it is the request to join", /want to join/.test(now[0]?.title || ""));
    H.ok("phone sheet: it sits above the sheet, clear of its header", !!now[0] && now[0].bottom <= sheetTop + 1, `toast bottom ${Math.round(now[0]?.bottom)} sheet top ${Math.round(sheetTop)}`);
    H.ok("phone sheet: no 390 px overflow", await H.noOverflow(a));
    await H.shot(a, "notices-phone-sheet");
    await a.ctx.close();
  }

  // A busy chat: the first message is shown, the rest are counted on the chat button.
  {
    const a = await host(browser);
    for (let i = 0; i < 50; i++) {
      await a.page.evaluate(() => window.__sim.chat(2));
      await H.sleep(100);
    }
    await H.sleep(300);
    const seen = await a.page.evaluate(() => window.__watch.read());
    const chatTitles = seen.titles.filter((t) => t === "Sam Sender" || /message/.test(t));
    H.ok("chat flood: one preview, which does not keep changing", chatTitles.length <= 1, JSON.stringify(seen.titles));
    const badge = await a.page.locator("#toggle-chat").getAttribute("aria-label");
    H.ok("chat flood: the chat button counts what was not shown", /unread/.test(badge || ""), badge);
    await a.ctx.close();
  }

  // A thousand arrivals in ten seconds: calm screen, no jank.
  {
    const a = await host(browser);
    for (let i = 0; i < 100; i++) {
      await a.page.evaluate(() => window.__sim.join(10));
      await H.sleep(100);
    }
    await H.sleep(1000);
    const seen = await a.page.evaluate(() => window.__watch.read());
    H.ok("1,000 joins: never more than one notification about them", seen.maxShown <= 1, `max ${seen.maxShown}, ${JSON.stringify(seen.titles)}`);
    H.ok("1,000 joins: no main-thread task over 250 ms", seen.longest <= 250, `longest ${seen.longest} ms, total ${seen.longTotal} ms`);
    await H.shot(a, "notices-1000-joins");
    await a.ctx.close();
  }
};
