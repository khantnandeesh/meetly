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

/*
 * More of the crowd, for the placement spec's C-items (team decisions, "E1 Notifications"):
 * a waiting queue people can also leave, the states behind the status lane, and co-host changes
 * answered at once. Installed after SIM, on the same provider-neutral call.
 */
const SIM_MORE = () => {
  const call = window.__meetly.call;
  const sim = window.__sim;
  // The waiting room, as a queue that people can also leave.
  let queue = null;
  let n = 0;
  const realWaiting = call.waiting;
  call.waiting = () => queue ?? realWaiting();
  sim.queue = {
    arrive(count) {
      const fresh = Array.from({ length: count }, () => ({ id: `queued-${n}`, name: `Queued ${n++}`, since: Date.now() }));
      queue = [...(queue ?? []), ...fresh];
      call.emit("waiting");
    },
    leave(count) {
      queue = (queue ?? []).slice(count);
      call.emit("waiting");
    },
  };
  // What the status lane reads: the connection, blocked sound, and connection quality.
  const pin = (key, value, event) => {
    if (value === null) delete call[key];
    else Object.defineProperty(call, key, { get: () => value, configurable: true });
    call.emit(event);
  };
  sim.status = (value) => pin("status", value, "status");
  sim.soundBlocked = (value) => pin("audioBlocked", value || null, "audio");
  const realQuality = call.quality.bind(call);
  let poor = null;
  call.quality = () => {
    const q = realQuality();
    if (!poor) return q;
    if (poor.base !== q) poor = { base: q, value: { ...q, connection: "poor" } };
    return poor.value;
  };
  sim.poor = (on) => {
    poor = on ? { base: null, value: null } : null;
    call.emit("quality");
  };
  // Host actions succeed at once; co-host changes are reflected as the server would reflect them.
  let coHosts = [];
  call.coHosts = () => coHosts;
  call.moderate = async (action) => {
    if (action.action === "coHost") {
      coHosts = action.on ? [...coHosts, action.identity] : coHosts.filter((id) => id !== action.identity);
      call.emit("host");
    }
  };
};

/** Samples every visible notification and status banner, ten times a second. */
const SAMPLE = () => {
  let samples = [];
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };
  const timer = setInterval(() => {
    const toasts = [...document.querySelectorAll("[data-toast]")].filter((t) => t.dataset.leaving !== "true");
    const banners = [...document.querySelectorAll("[data-status-lane] > *")];
    samples.push({
      toasts: toasts.map((t) => ({ id: t.dataset.toast, title: t.querySelector(".toast-title")?.textContent || "", ...box(t) })),
      banners: banners.map((b) => ({ kind: b.dataset.statusBanner || (b.hasAttribute("data-weak-connection") ? "weak" : "?"), leaving: b.dataset.leaving === "true", ...box(b) })),
    });
  }, 100);
  window.__samples = {
    take: () => samples,
    reset: () => {
      samples = [];
    },
    stop: () => clearInterval(timer),
  };
};

const intersects = (a, b) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5 && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5;
/** Pairs of boxes that overlap in one sample: two notifications, or a notification and a banner. */
function overlaps(sample) {
  const found = [];
  const { toasts, banners } = sample;
  for (let i = 0; i < toasts.length; i++) {
    for (let j = i + 1; j < toasts.length; j++) if (intersects(toasts[i], toasts[j])) found.push([toasts[i].title, toasts[j].title]);
    for (const b of banners) if (intersects(toasts[i], b)) found.push([toasts[i].title, b.kind]);
  }
  return found;
}

/** A host in a fresh meeting, with the simulated crowd and the samplers. `init` runs in the page before the app does. */
async function hostWith(browser, { viewport = H.DESKTOP, scale = 1, touch = viewport.width < 768, init, initArg } = {}) {
  const person = await H.client(browser, { viewport, scale, touch });
  if (init) await person.ctx.addInitScript(init, initArg);
  const url = await H.createMeeting(person);
  await H.join(person, url, "Hana Host");
  await H.sleep(2800);
  await person.page.evaluate(SIM);
  await person.page.evaluate(WATCH);
  await person.page.evaluate(SIM_MORE);
  await person.page.evaluate(SAMPLE);
  return person;
}

const knocksPlayed = (person) =>
  person.page.evaluate(() => (window.__meetlySounds?.log || []).filter((s) => s.name === "knock" && s.outcome === "played").length);
const micButton = (person) => person.page.locator("footer").getByRole("button", { name: /microphone$/ }).first();
const camButton = (person) => person.page.locator("footer").getByRole("button", { name: /camera$/ }).first();
const laneKinds = (person) =>
  person.page.evaluate(() => [...document.querySelectorAll("[data-status-lane] > *")].map((b) => b.dataset.statusBanner || (b.hasAttribute("data-weak-connection") ? "weak" : "?")));

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

  await placement(browser);
};

/** The placement spec's notification items (C1, C3, C4, C8, C9, C10, C16, C17). C14 is a unit test. */
async function placement(browser) {
  console.log("\n— notifications: stacking, the status lane, tags, knocks, your own state —");

  /* ------------------------------------------------- C1: under dialogs and menus */
  {
    const a = await hostWith(browser);
    await a.page.evaluate(() => window.__sim.queue.arrive(1));
    await H.sleep(600);
    const z = await a.page.evaluate(() => getComputedStyle(document.querySelector(".toast-region")).zIndex);
    H.ok("C1: the notification column is at z-index 45", z === "45", z);
    await a.page.getByRole("button", { name: "More ways to leave" }).click();
    await a.page.getByRole("menuitem", { name: "End meeting for everyone" }).click();
    await a.page.getByRole("dialog").waitFor();
    await H.sleep(500);
    const hit = await a.page.evaluate(() => {
      const card = [...document.querySelectorAll("[data-toast]")].find((t) => /wants to join/.test(t.textContent));
      if (!card) return { card: false };
      const admit = [...card.querySelectorAll("button")].find((b) => b.textContent.trim() === "Admit");
      const r = admit.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { card: true, onCard: card.contains(top), what: String(top?.className || "").slice(0, 60) };
    });
    H.ok("C1: with 'End the meeting for everyone?' open, the request to join is still there", hit.card);
    H.ok("C1: ...under the dialog's overlay, so it can't be clicked", hit.card && !hit.onCard, JSON.stringify(hit));
    await H.shot(a, "c1-end-dialog-over-notice");
    await a.page.keyboard.press("Escape");
    await a.page.getByRole("dialog").waitFor({ state: "detached" });
    await a.page.getByRole("button", { name: "More options" }).click();
    await a.page.getByRole("menu").waitFor();
    const menuZ = await a.page.evaluate(() => Number(getComputedStyle(document.querySelector("[role='menu']")).zIndex));
    H.ok("C1: an open menu draws over notifications", menuZ > 45, `menu z ${menuZ}`);
    await a.page.keyboard.press("Escape");
    await a.ctx.close();
  }
  {
    // Phone, a sheet open: the one-line strip stays above the scrim, and offers one answer.
    const a = await hostWith(browser, { viewport: H.PHONE });
    await a.page.getByRole("button", { name: /^Chat/ }).click();
    await a.page.locator('aside[aria-label="Chat"]').waitFor();
    await H.sleep(500);
    await a.page.evaluate(() => window.__sim.queue.arrive(1));
    await H.sleep(700);
    const strip = await a.page.evaluate(() => {
      const card = document.querySelector("[data-toast]");
      if (!card) return null;
      const r = card.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + 20, r.top + r.height / 2);
      return { visible: card.contains(top), buttons: [...card.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean) };
    });
    H.ok("C1: on a phone with a sheet open, the strip is above the scrim", !!strip?.visible, JSON.stringify(strip));
    H.ok("C10: the strip has one answer, View (not Deny and Admit)", JSON.stringify(strip?.buttons) === '["View"]', JSON.stringify(strip?.buttons));
    await H.shot(a, "c10-phone-strip-view");
    await a.ctx.close();
  }

  /* ---------------------------------------------- C3 + C4: one status banner */
  {
    const a = await hostWith(browser, { viewport: H.PHONE });
    await a.page.evaluate(() => window.__sim.poor(true));
    // A connection has to be poor for 10 s before it is mentioned (src/lib/callHealth.ts).
    const weak = await H.until(async () => (await a.page.locator("[data-weak-connection]:not([data-leaving='true'])").count()) === 1, 15000);
    H.ok("C3: a weak connection shows its banner", weak);
    await a.page.evaluate(() => window.__samples.reset());
    await a.page.evaluate(() => window.__sim.queue.arrive(1));
    await H.sleep(1200);
    await a.page.evaluate(() => window.__sim.chat(1));
    await H.sleep(2000);
    const samples = await a.page.evaluate(() => window.__samples.take());
    const last = samples[samples.length - 1];
    const bad = samples.map(overlaps).filter((pairs) => pairs.length > 0);
    H.ok(
      "C3: phone: the banner, then the request to join below it",
      last.banners.some((b) => b.kind === "weak") && last.toasts.length === 1 && /wants to join/.test(last.toasts[0].title) && last.toasts[0].top >= Math.max(...last.banners.map((b) => b.bottom)),
      JSON.stringify(last),
    );
    H.ok("C3: phone: the banner counts toward the two, so no chat card", samples.every((s) => !s.toasts.some((t) => t.title === "Sam Sender")));
    H.ok("C3: phone: no two boxes overlap, in 30 samples or more", samples.length >= 30 && bad.length === 0, `${samples.length} samples; ${JSON.stringify(bad[0] || [])}`);
    await H.shot(a, "c3-phone-banner-and-knock");
    // C4: one banner at a time, the most urgent.
    await a.page.evaluate(() => window.__sim.soundBlocked(true));
    await H.sleep(900);
    H.ok("C4: weak connection and blocked sound: only Turn on sound", JSON.stringify(await laneKinds(a)) === '["sound"]', JSON.stringify(await laneKinds(a)));
    await a.page.evaluate(() => window.__sim.status("reconnecting"));
    await H.sleep(900);
    H.ok(
      "C4: reconnecting as well: only 'Connection lost. Reconnecting…' is in the DOM",
      JSON.stringify(await laneKinds(a)) === '["reconnecting"]' && (await a.page.getByText("Connection lost. Reconnecting…").count()) === 1,
      JSON.stringify(await laneKinds(a)),
    );
    // With a sheet open, Reconnecting takes the one line over the top bar.
    await a.page.getByRole("button", { name: /^Chat/ }).click();
    await a.page.locator('aside[aria-label="Chat"]').waitFor();
    await H.sleep(700);
    const strip = await a.page.evaluate(() => {
      const lane = document.querySelector("[data-status-lane]");
      const banner = lane?.querySelector("[data-status-banner='reconnecting']");
      if (!banner) return null;
      const r = banner.getBoundingClientRect();
      // The banner lets touches through (pointer-events: none), which hit-testing would skip; ask what paints on top.
      banner.style.pointerEvents = "auto";
      return {
        mode: lane.dataset.statusLane,
        visible: banner.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)),
        toasts: document.querySelectorAll("[data-toast]:not([data-leaving='true'])").length,
      };
    });
    H.ok("C3: phone sheet: Reconnecting takes the strip, over the scrim, alone", strip?.mode === "strip" && strip.visible && strip.toasts === 0, JSON.stringify(strip));
    await H.shot(a, "c3-phone-sheet-reconnecting");
    await a.page.evaluate(() => window.__sim.status(null));
    await a.page.evaluate(() => window.__sim.soundBlocked(false));
    await H.sleep(900);
    H.ok("C3: phone sheet: back online, the request to join takes the strip again", (await shown(a)).some((t) => /wants? to join/.test(t.title)), JSON.stringify((await shown(a)).map((t) => t.title)));
    await a.ctx.close();
  }

  /* ------------------------------------------ C9: tags for repeats and contradictions */
  {
    const a = await hostWith(browser);
    await a.page.evaluate(() => window.__sim.join(2));
    await H.openPeople(a);
    await a.page.evaluate(() => window.__samples.reset());
    const started = Date.now();
    await H.people(a).getByRole("button", { name: "Host controls for Person 0" }).click();
    await a.page.getByRole("menuitem", { name: "Make co-host" }).click();
    await H.sleep(1500);
    await H.people(a).getByRole("button", { name: "Host controls for Person 0" }).click();
    await a.page.getByRole("menuitem", { name: "Remove as co-host" }).click();
    const within = Date.now() - started;
    await H.sleep(1600);
    const samples = await a.page.evaluate(() => window.__samples.take());
    const most = Math.max(...samples.map((s) => s.toasts.filter((t) => /co-host$/.test(t.title)).length));
    const titles = (await shown(a)).filter((t) => /co-host$/.test(t.title)).map((t) => t.title);
    H.ok("C9: co-host on, then off within 5 s: one notification", within < 5000 && most === 1, `${within} ms, at most ${most} at once`);
    H.ok("C9: ...reading the latest state, 'Person 0 is no longer a co-host'", JSON.stringify(titles) === '["Person 0 is no longer a co-host"]', JSON.stringify(titles));
    await a.ctx.close();
  }
  {
    const a = await hostWith(browser);
    await a.page.evaluate(() => {
      const call = window.__meetly.call;
      const real = call.setEnabled.bind(call);
      call.setEnabled = (source, on) => (source === "microphone" ? Promise.reject(new Error("Permission denied")) : real(source, on));
    });
    await a.page.evaluate(() => window.__samples.reset());
    for (let i = 0; i < 5; i++) {
      await micButton(a).click();
      await H.sleep(250);
    }
    await H.sleep(1200);
    const samples = await a.page.evaluate(() => window.__samples.take());
    const failing = (t) => t.title === "Couldn't start your microphone";
    const most = Math.max(...samples.map((s) => s.toasts.filter(failing).length));
    const ids = new Set(samples.flatMap((s) => s.toasts.filter(failing).map((t) => t.id)));
    H.ok("C9: 5 failed microphone taps: one notification", most === 1 && ids.size === 1, `at most ${most} at once, ${ids.size} in all`);
    await a.ctx.close();
  }

  /* ------------------------------------------------------------- C10: the knock */
  {
    const a = await hostWith(browser);
    await a.page.evaluate(() => window.__sim.queue.arrive(3));
    await H.sleep(800);
    const card = a.page.locator("[data-toast]", { hasText: "3 people want to join" });
    H.ok("C10: three waiting: one card", (await card.count()) === 1);
    await card.getByRole("button", { name: "Dismiss notification" }).click();
    await H.sleep(600);
    await a.page.evaluate(() => window.__sim.queue.leave(1));
    await H.sleep(1500);
    H.ok("C10: closed with 3 waiting, one leaves: no card", !(await shown(a)).some((t) => /want to join/.test(t.title)), JSON.stringify((await shown(a)).map((t) => t.title)));
    await H.openPeople(a);
    await H.closePeople(a);
    await H.sleep(800);
    H.ok("C10: opening and closing People does not bring it back", !(await shown(a)).some((t) => /want to join/.test(t.title)));
    await a.page.evaluate(() => window.__sim.queue.arrive(1));
    await H.sleep(800);
    H.ok("C10: somebody new arrives: the card returns, '3 people want to join'", (await shown(a)).some((t) => t.title === "3 people want to join"), JSON.stringify((await shown(a)).map((t) => t.title)));
    await a.ctx.close();
  }
  {
    // 50 knocks over 60 s. Meanwhile (C17) the microphone and camera go off without a toggle of
    // this person's own, which is what a host's mute looks like from the receiving end.
    const a = await hostWith(browser);
    await a.page.evaluate(async () => {
      const call = window.__meetly.call;
      if (!call.localMedia().microphone) await call.setEnabled("microphone", true);
      if (!call.localMedia().camera) await call.setEnabled("camera", true);
    });
    await H.sleep(2000);
    const before = await knocksPlayed(a);
    await a.page.evaluate(() => window.__meetly.call.setEnabled("microphone", false));
    await a.page.evaluate(() => window.__meetly.call.setEnabled("camera", false));
    const start = Date.now();
    let checked = false;
    for (let i = 0; i < 50; i++) {
      await a.page.evaluate(() => window.__sim.queue.arrive(1));
      if (!checked && Date.now() - start > 30_000) {
        checked = true;
        const mic = await micButton(a).getAttribute("aria-label");
        const cam = await camButton(a).getAttribute("aria-label");
        H.ok("C17: 30 s after the host muted you, the microphone says why", mic === "Muted by the host. Unmute microphone", mic);
        H.ok("C17: ...and a camera the host turned off says so too", cam === "Turned off by the host. Turn on camera", cam);
      }
      await H.sleep(Math.max(0, start + ((i + 1) * 60_000) / 50 - Date.now()));
    }
    const knocks = (await knocksPlayed(a)) - before;
    H.ok("C10: 50 knocks over 60 s: at most 3 knock sounds", knocks >= 1 && knocks <= 3, `${knocks} played`);
    await micButton(a).click();
    await H.until(async () => (await micButton(a).getAttribute("aria-label")) === "Mute microphone", 5000);
    await micButton(a).click();
    const after = await H.until(async () => (await micButton(a).getAttribute("aria-label")) === "Unmute microphone", 5000);
    H.ok("C17: once the person turns it on and off again, the usual label", after, await micButton(a).getAttribute("aria-label"));
    await a.ctx.close();
  }

  /* ------------------------------------------- C16: your own state is never dropped */
  {
    const a = await hostWith(browser);
    await a.page.evaluate(() => {
      const t = window.__meetlyToast;
      t.push({ priority: "you", title: "First ten-second notice", duration: 10_000 });
      t.push({ priority: "you", title: "Second ten-second notice", duration: 10_000 });
    });
    await H.sleep(300);
    await a.page.evaluate(() => window.__sim.mutedByHost());
    await H.sleep(1000);
    H.ok("C16: with two 10 s notices up, 'the host muted your microphone' waits", !(await shown(a)).some((t) => t.title === "The host muted your microphone"));
    // Longer than an error may wait (6 s): a change to your own state keeps waiting.
    const appeared = await H.until(async () => (await shown(a)).some((t) => t.title === "The host muted your microphone"), 12000, 200);
    H.ok("C16: ...and shows once a slot frees, 10 s later", appeared, JSON.stringify((await shown(a)).map((t) => t.title)));
    await a.ctx.close();
  }

  /* --------------------------------------------- C8: chat previews by meeting size */
  {
    const a = await hostWith(browser);
    await a.page.evaluate(() => window.__sim.join(50));
    await H.sleep(1500);
    await a.page.evaluate(() => window.__samples.reset());
    const start = Date.now();
    for (let i = 0; i < 30; i++) {
      await a.page.evaluate(() => window.__sim.chat(10));
      await H.sleep(Math.max(0, start + ((i + 1) * 10_000) / 30 - Date.now()));
    }
    await H.sleep(500);
    const samples = await a.page.evaluate(() => window.__samples.take());
    const previews = new Set(samples.flatMap((s) => s.toasts.filter((t) => t.title === "Sam Sender").map((t) => t.id)));
    H.ok("C8: 300 messages in 10 s with 51 people: at most 1 preview", previews.size <= 1, `${previews.size} previews`);
    const label = await a.page.locator("#toggle-chat").getAttribute("aria-label");
    H.ok("C8: the chat button counts all 300, in full for screen readers", label === "Chat, 300 unread", label);
    const badge = (await a.page.locator("#toggle-chat > span").last().innerText()).trim();
    H.ok("C8: the badge reads 99+", badge === "99+", badge);
    await a.ctx.close();
  }
  {
    const a = await hostWith(browser, { init: () => localStorage.setItem("meetly:call-settings", JSON.stringify({ chatPreviews: false })) });
    await a.page.evaluate(() => window.__sim.chat(1));
    await H.sleep(5000);
    await a.page.evaluate(() => window.__sim.chat(1));
    await H.sleep(1200);
    const samples = await a.page.evaluate(() => window.__samples.take());
    H.ok("C8: Chat previews switched off: no preview", samples.every((s) => !s.toasts.some((t) => t.title === "Sam Sender")));
    const label = await a.page.locator("#toggle-chat").getAttribute("aria-label");
    H.ok("C8: ...the chat button still counts them", label === "Chat, 2 unread", label);
    await a.ctx.close();
  }

  await shortScreens(browser);
}

/** Every visible notification's box, and the screen's size. */
const boxes = (person) =>
  person.page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    toasts: [...document.querySelectorAll("[data-toast]:not([data-leaving='true'])")].map((t) => {
      const r = t.getBoundingClientRect();
      return { title: t.querySelector(".toast-title")?.textContent || "", top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    }),
  }));
const onScreen = ({ width, height, toasts }) => toasts.every((t) => t.left >= 0 && t.right <= width && t.top >= 0 && t.bottom <= height);

/** A phone held sideways (844 x 390), and side panels on narrow large screens (E4's C15 measurement). */
async function shortScreens(browser) {
  const LANDSCAPE = { width: 844, height: 390 };
  // A long notice: a title that would wrap and a body, the kind that ran off the top.
  const long = () =>
    window.__meetlyToast.push({
      priority: "you",
      title: "Background blur was turned off because it was slowing down your camera",
      body: "It was slowing down your camera. Turn it back on from the video settings when your device is less busy.",
      duration: 6000,
    });

  // At 844 x 390, a mixed flood with the weak-connection banner up and the self-view floating.
  {
    const a = await hostWith(browser, { viewport: LANDSCAPE, touch: true, init: () => localStorage.setItem("meetly:call-settings", JSON.stringify({ selfView: "float" })) });
    await a.page.evaluate(() => window.__sim.join(3));
    await a.page.evaluate(() => window.__sim.poor(true));
    H.ok("short screen: the weak-connection banner is up", await H.until(async () => (await a.page.locator("[data-weak-connection]:not([data-leaving='true'])").count()) === 1, 15000));
    await a.page.evaluate(() => window.__samples.reset());
    const start = Date.now();
    let step = 0;
    while (Date.now() - start < 5000) {
      await a.page.evaluate((i) => {
        const s = window.__sim;
        s.queue.arrive(1);
        s.chat(1);
        s.join(2);
        if (i % 4 === 1) s.mutedByHost();
      }, step);
      if (step % 5 === 2) await a.page.evaluate(long);
      step++;
      await H.sleep(200);
    }
    await H.sleep(600);
    const samples = await a.page.evaluate(() => window.__samples.take());
    const offTop = samples.filter((s) => s.toasts.some((t) => t.top < 0));
    const overBanner = samples.filter((s) => s.toasts.some((t) => s.banners.some((b) => intersects(t, b))));
    const most = Math.max(...samples.map((s) => s.toasts.length));
    H.ok("short screen: one notification at a time", most === 1, `at most ${most}`);
    H.ok("short screen: no notification crosses the top of the screen, in 30 samples or more", samples.length >= 30 && offTop.length === 0, `${samples.length} samples; ${JSON.stringify(offTop[0] || "")}`);
    H.ok("short screen: no notification covers the status banner", overBanner.length === 0, JSON.stringify(overBanner[0] || ""));
    H.ok("short screen: no chat preview interrupts", samples.every((s) => !s.toasts.some((t) => t.title === "Sam Sender")));
    await H.shot(a, "short-screen-flood");
    await a.ctx.close();
  }

  // With People or Chat open, every notice stays on screen: sideways phone, tablet, desktop.
  for (const viewport of [LANDSCAPE, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    const size = `${viewport.width}x${viewport.height}`;
    for (const layout of ["sidebar", "auto"]) {
      const a = await hostWith(browser, { viewport, init: (l) => localStorage.setItem("meetly:call-settings", JSON.stringify({ layout: l, selfView: "float" })), initArg: layout });
      await a.page.evaluate(() => window.__sim.join(4));
      await H.sleep(500);
      const results = [];
      for (const panel of ["People", "Chat"]) {
        if (panel === "People") await H.openPeople(a);
        else await a.page.locator("#toggle-chat").click();
        await a.page.locator(`aside[aria-label="${panel}"]`).waitFor();
        await H.sleep(600);
        await a.page.evaluate(long);
        await a.page.evaluate(() => window.__sim.mutedByHost());
        await H.sleep(900);
        results.push({ panel, ...(await boxes(a)) });
      }
      H.ok(
        `${size} ${layout}: with People or Chat open, every notification is on screen`,
        results.every((r) => r.toasts.length > 0 && onScreen(r)),
        JSON.stringify(results.map((r) => [r.panel, r.toasts.map((t) => [Math.round(t.left), Math.round(t.top), Math.round(t.right), Math.round(t.bottom)])])),
      );
      await H.shot(a, `panel-open-${size}-${layout}`);
      await a.ctx.close();
    }
  }
}
module.exports.placement = placement;
module.exports.hostWith = hostWith;
module.exports.shortScreens = shortScreens;
