// Layout and phone (E3): the bottom sheet under a top safe-area inset, the reaction lane under a
// flood, badges and counts at scale, the ended screen, More, and joining a busy meeting muted.
//
// Crowds are synthetic, as in notices.cjs: people, knocks, messages and reactions are pushed
// through the call's own events (the provider-neutral RtcCall on window.__meetly), so the
// interface sees what an adapter would send it. Nothing here proves how a server copes.
const H = require("./lib.cjs");

/** Installs window.__crowd on a page that is in a call. */
const CROWD = () => {
  const call = window.__meetly.call;
  const real = {
    participants: call.participants.bind(call),
    remoteIds: call.remoteIds.bind(call),
    participant: call.participant.bind(call),
    tiles: call.tiles.bind(call),
    waiting: call.waiting.bind(call),
    chat: call.chatMessages.bind(call),
  };
  const fake = new Map();
  let waiters = [];
  let chat = [];
  let roster = null;
  let tiles = null;
  let chatCache = null;
  let chatBase = null;
  let seq = 0;
  const person = () => {
    const n = seq++;
    const listeners = new Set();
    return {
      identity: `crowd-${n}`,
      isLocal: false,
      name: `Person${n} Crowd`,
      role: "speaker",
      micOn: false,
      camOn: false,
      handRaised: false,
      speaking: false,
      weakConnection: false,
      subscribe(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
  };
  call.participants = () => (roster ??= [...real.participants(), ...fake.values()]);
  call.remoteIds = () => [...real.remoteIds(), ...fake.keys()];
  call.participant = (id) => fake.get(id) || real.participant(id);
  call.tiles = () => (tiles ??= [...real.tiles(), ...[...fake.values()].map((p) => ({ participant: p, source: "camera" }))]);
  call.waiting = () => (waiters.length ? waiters : real.waiting());
  call.chatMessages = () => {
    const base = real.chat();
    if (!chat.length) return base;
    if (chatCache && chatBase === base) return chatCache;
    chatBase = base;
    return (chatCache = [...base, ...chat]);
  };
  window.__crowd = {
    /** `n` more people, announced as one roster change. */
    join(n) {
      for (let i = 0; i < n; i++) {
        const p = person();
        fake.set(p.identity, p);
      }
      roster = null;
      tiles = null;
      call.emit("roster");
      call.emit("tiles");
    },
    knock(n) {
      const now = Date.now();
      for (let i = 0; i < n; i++) {
        const p = person();
        waiters = [...waiters, { id: p.identity, name: p.name, since: now }];
      }
      call.emit("waiting");
    },
    chat(n) {
      for (let i = 0; i < n; i++) {
        chatCache = null;
        chat = [...chat, { id: `crowd-chat-${seq++}`, timestamp: Date.now(), message: `Message ${seq}`, from: { identity: "crowd-x", name: "Sam Sender", isLocal: false } }];
        call.emit("chat");
      }
    },
    /** A reaction from the crowd's `index`th person (counted from the end, so off the first page). */
    react(index, emoji) {
      const people = [...fake.values()];
      call.emit("reaction", people[people.length - 1 - (index % people.length)], emoji);
    },
  };
};

/** The top safe-area inset of an iPhone home-screen app, emulated through the DevTools protocol. */
async function insetTop(person, top) {
  const cdp = await person.ctx.newCDPSession(person.page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top, topMax: top, left: 0, leftMax: 0, right: 0, rightMax: 0, bottom: 0, bottomMax: 0 } });
  return person.page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.paddingTop = "env(safe-area-inset-top)";
    document.body.append(probe);
    const value = parseFloat(getComputedStyle(probe).paddingTop);
    probe.remove();
    return value;
  });
}

const rect = (locator) => locator.evaluate((element) => element.getBoundingClientRect().toJSON());
const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

async function inCrowd(browser, { viewport = H.DESKTOP, scale = 1, name = "Hana Host" } = {}) {
  const person = await H.client(browser, { viewport, scale, touch: viewport.width < 768 });
  const url = await H.createMeeting(person);
  await H.join(person, url, name);
  // Sounds and arrivals settle for a moment after joining (see useSounds.ts).
  await H.sleep(2500);
  await person.page.evaluate(CROWD);
  person.url = url;
  return person;
}

/* ------------------------------------------------------------------- C2 */

async function sheetUnderInset(browser, top) {
  const mo = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  const applied = await insetTop(mo, top);
  const url = await H.createMeeting(mo);
  await H.join(mo, url, "Mo Phone");
  await H.sleep(2500);
  await mo.page.evaluate(CROWD);
  const header = mo.page.locator("[data-in-call] > header").first();
  await mo.page.locator("#toggle-chat").tap();
  const sheet = mo.page.locator('aside[aria-label="Chat"]');
  await sheet.waitFor();
  await H.sleep(600); // the sheet's slide-in
  const bar = await rect(header);
  const box = await rect(sheet);
  H.ok(`C2 inset ${top}px: the emulated inset is applied`, applied === top, `env() reads ${applied}px`);
  H.ok(`C2 inset ${top}px: the sheet's top edge is at or below the top bar's bottom`, box.top >= bar.bottom - 0.5, `sheet ${box.top}, bar ${bar.bottom}`);
  // A knock while the chat sheet is open: the one compact line over the top bar.
  await mo.page.evaluate(() => window.__crowd.knock(3));
  const toast = mo.page.locator("[data-toast]").first();
  await toast.waitFor({ timeout: 5000 });
  await H.sleep(500);
  const strip = await rect(toast);
  H.ok(`C2 inset ${top}px: the compact notification starts below the inset`, strip.top >= Math.max(4, top) - 0.5, `strip top ${strip.top}`);
  H.ok(`C2 inset ${top}px: the compact notification does not touch the sheet`, strip.bottom <= box.top && !intersects(strip, box), `strip ${strip.top}–${strip.bottom}, sheet ${box.top}`);
  const handle = await rect(sheet.locator("span[aria-hidden=true]").first());
  const title = await rect(sheet.getByRole("heading", { name: "Chat" }));
  const close = await rect(sheet.getByRole("button", { name: "Close chat" }));
  H.ok(`C2 inset ${top}px: the drag handle, title and close button are uncovered`, [handle, title, close].every((r) => !intersects(strip, r)));
  await H.shot(mo, `c2-sheet-inset-${top}-phone`);
  await mo.ctx.close();
}

/* ------------------------------------------------------------------- C7 */

/**
 * Watches the lane from inside the page: how many rows, and whether any touches the bottom-left
 * name label of the stage proper, or covers the self view or a filmstrip tile.
 */
const WATCH_LANE = () => {
  const st = { most: 0, hits: [], labels: [], covers: [], names: new Set() };
  const label = () => {
    const metas = [...document.querySelectorAll('main [data-tile]:is([data-slot="main"], [data-slot="grid"]) .tile-meta')].map((m) => m.getBoundingClientRect());
    if (!metas.length) return null;
    // The tile furthest down, and of those the furthest left.
    return metas.sort((a, b) => b.bottom - a.bottom || a.left - b.left)[0];
  };
  const meet = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const timer = setInterval(() => {
    const rows = [...document.querySelectorAll("[data-lane-row]")];
    st.most = Math.max(st.most, rows.length);
    const name = label();
    const others = [...document.querySelectorAll(".tile-meta")].map((m) => m.getBoundingClientRect());
    const kept = [...document.querySelectorAll('main [data-tile][data-slot="strip"], main .self-float')].map((el) => el.getBoundingClientRect());
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      st.names.add(row.lastElementChild.textContent);
      if (name && meet(r, name)) st.hits.push([Math.round(r.top), Math.round(r.bottom), Math.round(name.top)]);
      if (others.some((m) => meet(r, m))) st.labels.push([Math.round(r.top), Math.round(r.bottom)]);
      if (kept.some((k) => meet(r, k))) st.covers.push([Math.round(r.top), Math.round(r.bottom)]);
    }
  }, 50);
  window.__lane = { read: () => ({ most: st.most, hits: st.hits.slice(0, 3), labels: st.labels.slice(0, 3), covers: st.covers.slice(0, 3), names: [...st.names] }), stop: () => clearInterval(timer) };
};

async function laneFlood(browser, viewport, limit, label, layout) {
  const a = await inCrowd(browser, { viewport, scale: 2 });
  await a.page.evaluate(() => window.__crowd.join(230));
  if (layout) {
    await a.page.getByRole("button", { name: "Change layout" }).click();
    await a.page.getByRole("menuitemradio", { name: new RegExp(`^${layout}`) }).click();
    await a.page.mouse.move(viewport.width / 2, 200);
  }
  await H.sleep(1500);
  await a.page.evaluate(WATCH_LANE);
  // 200 reactions in 2 s, from people whose tiles are not on screen, over all six emoji.
  await a.page.evaluate(async () => {
    const emoji = ["👍", "❤️", "😂", "😮", "👏", "🎉"];
    for (let i = 0; i < 200; i++) {
      window.__crowd.react(i, emoji[(i * 7) % 6]);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
  await H.sleep(600);
  await H.shot(a, `c7-lane-flood-${label}`);
  const seen = await a.page.evaluate(() => window.__lane.read());
  H.ok(`C7 ${label}: 200 reactions in 2 s give at most ${limit} rows`, seen.most >= 1 && seen.most <= limit, `most ${seen.most}`);
  H.ok(`C7 ${label}: no row ever touches the bottom-left name label`, seen.hits.length === 0, JSON.stringify(seen.hits));
  H.ok(`C7 ${label}: …nor any other name label`, seen.labels.length === 0, JSON.stringify(seen.labels));
  H.ok(`C7 ${label}: no row covers the self view or the filmstrip`, seen.covers.length === 0, JSON.stringify(seen.covers));
  H.ok(`C7 ${label}: from 200 people, counts only and never names`, seen.names.every((text) => /^×\d+$/.test(text.trim())), seen.names.join(", "));
  await a.page.evaluate(() => window.__lane.stop());
  await a.ctx.close();
}

async function laneStill(browser) {
  // Twelve people: rows are grouped by emoji, each new emoji arriving on top.
  const a = await inCrowd(browser, { viewport: { width: 1440, height: 900 }, scale: 2 });
  await a.page.evaluate(() => window.__crowd.join(11));
  // Spotlight shows one person, so the crowd's reactions go to the lane.
  await a.page.getByRole("button", { name: "Change layout" }).click();
  await a.page.getByRole("menuitemradio", { name: /^Spotlight/ }).click();
  await a.page.mouse.move(700, 300);
  await H.sleep(1200);
  const row = (emoji) => a.page.locator(`[data-lane-row="${emoji}"]`);
  await a.page.evaluate(() => window.__crowd.react(0, "👏"));
  await row("👏").waitFor({ timeout: 4000 });
  await H.sleep(400);
  const first = await rect(row("👏"));
  await a.page.evaluate(() => window.__crowd.react(1, "🎉"));
  await row("🎉").waitFor({ timeout: 4000 });
  await H.sleep(400);
  const after = await rect(row("👏"));
  const second = await rect(row("🎉"));
  H.ok("C7: a new emoji row appears above, and the row already there does not move", Math.abs(after.top - first.top) < 0.5 && second.bottom <= first.top, `👏 ${first.top}→${after.top}, 🎉 bottom ${second.bottom}`);
  await a.page.evaluate(() => window.__crowd.react(2, "👏"));
  await H.sleep(400);
  const grown = await rect(row("👏"));
  H.ok("C7: a growing row stays in place and counts", Math.abs(grown.top - first.top) < 0.5 && (await row("👏").innerText()).includes("×2"), await row("👏").innerText());
  const label = await rect(a.page.locator("main [data-tile] .tile-meta").first());
  H.ok("C7: the lane sits above the name label", second.bottom <= label.top && first.bottom <= label.top, `lane bottom ${first.bottom}, label top ${label.top}`);
  await H.shot(a, "c7-lane-grouped-desktop");
  await a.ctx.close();
}

/* ------------------------------------------------------------------ C11 */

async function badges(browser) {
  const a = await inCrowd(browser, { viewport: { width: 1440, height: 900 }, scale: 2 });
  await a.page.evaluate(() => {
    window.__crowd.join(1203);
    window.__crowd.knock(128);
    window.__crowd.chat(150);
  });
  await H.sleep(1500);
  const waiting = a.page.locator("[data-waiting-count]").first();
  H.ok("C11 desktop: 128 waiting reads 99+", (await waiting.locator("[aria-hidden=true]").innerText()) === "99+");
  H.ok("C11 desktop: …and screen readers hear 128", /\b128 waiting to join/.test(await waiting.locator(".sr-only").innerText()));
  H.ok("C11 desktop: 1,204 people read 1,204", (await a.page.locator("#toggle-people").innerText()).includes("1,204"), await a.page.locator("#toggle-people").innerText());
  const unread = a.page.locator("[data-unread-count]");
  H.ok("C11 desktop: 150 unread messages read 99+", (await unread.innerText()) === "99+");
  H.ok("C11 desktop: …and the Chat button is named with 150", (await a.page.locator("#toggle-chat").getAttribute("aria-label")) === "Chat, 150 unread");
  await H.shot(a, "c11-badges-desktop");
  await a.ctx.close();

  const mo = await inCrowd(browser, { viewport: H.PHONE, scale: 2, name: "Mo Phone" });
  await mo.page.evaluate(() => {
    window.__crowd.join(1203);
    window.__crowd.knock(128);
    window.__crowd.chat(150);
  });
  await H.sleep(1500);
  const people = mo.page.locator("#toggle-people");
  H.ok("C11 phone: 1,204 people read 1.2k in the top bar", (await people.locator("[data-headcount]").innerText()) === "1.2k");
  H.ok("C11 phone: …and screen readers hear 1,204", (await people.locator(".sr-only").allInnerTexts()).join("").includes("1,204 in the meeting"));
  H.ok("C11 phone: 128 waiting reads 99+", (await people.locator("[data-waiting-count] [aria-hidden=true]").innerText()) === "99+");
  H.ok("C11 phone: 150 unread reads 99+", (await mo.page.locator("[data-unread-count]").innerText()) === "99+");
  H.ok("C11 phone: the top bar fits", await H.noOverflow(mo));
  await H.shot(mo, "c11-badges-phone");
  await mo.ctx.close();
}

/* ------------------------------------------------------------------ C13 */

const inView = (r, viewport) => r.top >= 0 && r.bottom <= viewport.height && r.left >= 0 && r.right <= viewport.width;

async function endedScreen(browser) {
  const big = { width: 1440, height: 900 };
  const host = await H.client(browser, { viewport: big, scale: 2 });
  const guest = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  const url = await H.createMeeting(host);
  await H.join(host, url, "Hana Host");
  await H.join(guest, url, "Gus Guest");
  await host.page.evaluate(() => window.__meetly.call.sendChat("Agenda: budget, then hiring"));
  await H.until(() => guest.page.evaluate(() => window.__meetly.call.chatMessages().length === 1), 5000);

  await H.leaveButton(host).click();
  await host.page.getByText("You left the meeting").waitFor();
  await H.sleep(600);
  const actions = host.page.locator("[data-leave-actions] > *");
  H.ok("C13 host: exactly two buttons in the row, Rejoin then Back to home", (await actions.allInnerTexts()).map((t) => t.trim()).join("|") === "Rejoin|Back to home", (await actions.allInnerTexts()).join("|"));
  const rows = host.page.locator("[data-keep] [data-keep-row]");
  H.ok(
    "C13 host: the keep card has two rows, the chat first",
    (await rows.count()) === 2 && /^Save the chat/.test(await rows.nth(0).innerText()) && /^Schedule a follow-up/.test(await rows.nth(1).innerText()),
    (await rows.allInnerTexts()).join(" / "),
  );
  H.ok("C13 host: the chat row says how much there is to lose", (await rows.nth(0).innerText()).includes("1 message. It's gone once you close this page."));
  const rating = await rect(host.page.locator("[data-call-rating]"));
  H.ok("C13 1440×900: everything through the rating is visible without scrolling", inView(rating, big) && (await host.page.evaluate(() => document.scrollingElement.scrollHeight <= innerHeight)), JSON.stringify(rating));
  await H.shot(host, "c13-ended-host-desktop");

  await H.leaveButton(guest).tap();
  await guest.page.getByText("You left the meeting").waitFor();
  await H.sleep(600);
  H.ok("C13 phone guest: two buttons, and a card with Save the chat only", (await guest.page.locator("[data-leave-actions] > *").count()) === 2 && (await guest.page.locator("[data-keep-row]").count()) === 1);
  const phoneRating = await rect(guest.page.locator("[data-call-rating]"));
  H.ok("C13 390×844: the rating is visible without scrolling", inView(phoneRating, H.PHONE), JSON.stringify(phoneRating));
  H.ok("C13 390×844: nothing overflows sideways", await H.noOverflow(guest));
  const sizes = await guest.page.locator("[data-leave-actions] > *, [data-keep-row] button").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  H.ok("C13 390×844: every button is at least 44 px tall", sizes.every((h) => h >= 44), sizes.join());
  await H.shot(guest, "c13-ended-guest-phone");

  // The host ends it for everyone: a guest goes home first, and is not offered a follow-up.
  await guest.page.getByRole("button", { name: "Rejoin" }).tap();
  await H.join(guest, url, "Gus Guest");
  await host.page.getByRole("button", { name: "Rejoin" }).click();
  await H.join(host, url, "Hana Host");
  await host.page.getByRole("button", { name: "More ways to leave" }).click();
  await host.page.getByRole("menuitem", { name: "End meeting for everyone" }).click();
  await host.page.getByRole("button", { name: "End meeting", exact: true }).click();
  await guest.page.getByText("The host ended the meeting").waitFor({ timeout: 8000 });
  await H.sleep(500);
  const first = guest.page.locator("[data-leave-actions] > *").first();
  H.ok("C13 guest after the host ended: Back to home is the primary button", (await first.innerText()).trim() === "Back to home" && /btn-primary/.test(await first.getAttribute("class")));
  H.ok("C13 guest after the host ended: no Schedule row", (await guest.page.getByRole("button", { name: "Schedule a follow-up" }).count()) === 0);
  await host.page.getByText("You ended the meeting").waitFor({ timeout: 8000 });
  H.ok("C13 the host who ended it: Start again, then Back to home", (await host.page.locator("[data-leave-actions] > *").allInnerTexts()).map((t) => t.trim()).join("|") === "Start again|Back to home");
  await H.shot(guest, "c13-ended-by-host-phone");
  await host.ctx.close();
  await guest.ctx.close();
}

/* ------------------------------------------------- mute late joiners (UI) */

/** Opens the pre-join screen with the peek's headcount replaced by `count`. */
async function prejoinWith(browser, url, count) {
  const person = await H.client(browser);
  await person.page.route("**/api/meeting", async (route) => {
    const body = route.request().postDataJSON();
    const response = await route.fetch();
    if (!body || body.action !== "peek") return route.fulfill({ response });
    const json = await response.json();
    return route.fulfill({ response, json: { ...json, count } });
  });
  await person.page.goto(url);
  await person.page.getByLabel("Your name").fill(`Late ${count}`);
  await person.page.getByRole("button", { name: /^(Mute|Unmute) microphone$/ }).waitFor();
  // The peek and the preview's microphone both settle.
  await H.sleep(1500);
  return person;
}

const micState = (person) => person.page.locator("main").getByRole("button", { name: /^(Mute|Unmute) microphone$/ }).getAttribute("aria-label");

async function lateJoiners(browser) {
  const host = await H.client(browser);
  const url = await H.createMeeting(host);
  await H.join(host, url, "Hana Host");

  const nine = await prejoinWith(browser, url, 9);
  H.ok("late joiners: 9 people here, the microphone starts off", (await micState(nine)) === "Unmute microphone");
  H.ok("late joiners: …with the line saying why", (await nine.page.getByText("You'll join muted. 9 people are here.").count()) === 1);
  await H.shot(nine, "mute-late-joiners-prejoin-desktop");
  await nine.page.getByRole("button", { name: "Unmute microphone" }).click();
  H.ok("late joiners: an explicit toggle on is kept", await H.until(async () => (await micState(nine)) === "Mute microphone", 4000));
  H.ok("late joiners: …and the line goes", (await nine.page.getByText("You'll join muted.").count()) === 0);
  await H.sleep(1500);
  H.ok("late joiners: …and it stays on", (await micState(nine)) === "Mute microphone");
  await nine.page.getByRole("button", { name: /^(Join now|Ask to join)$/ }).click();
  await H.inCall(nine);
  await H.sleep(1500);
  H.ok("late joiners: someone who chose their microphone joins with it on", await nine.page.evaluate(() => window.__meetly.call.localMedia().microphone));

  const unknown = await prejoinWith(browser, url, null);
  H.ok("late joiners: with no headcount (null), nothing changes", (await micState(unknown)) === "Mute microphone" && (await unknown.page.getByText("You'll join muted.").count()) === 0);
  const five = await prejoinWith(browser, url, 5);
  H.ok("late joiners: with 5 people, nothing changes", (await micState(five)) === "Mute microphone");

  const quiet = await prejoinWith(browser, url, 12);
  await quiet.page.getByRole("button", { name: /^(Join now|Ask to join)$/ }).click();
  await H.inCall(quiet);
  await H.sleep(1500);
  H.ok("late joiners: someone who left it joins muted", (await quiet.page.evaluate(() => window.__meetly.call.localMedia().microphone)) === false);
  for (const person of [host, nine, unknown, five, quiet]) await person.ctx.close();
}

module.exports = async function layout(browser) {
  console.log("\n— layout and phone: safe areas, the reaction lane, counts, the ended screen, joining muted —");
  await sheetUnderInset(browser, 47);
  await sheetUnderInset(browser, 0);
  await laneStill(browser);
  await laneFlood(browser, { width: 1440, height: 900 }, 4, "desktop");
  await laneFlood(browser, { width: 1440, height: 900 }, 4, "desktop-tiled", "Tiled");
  await laneFlood(browser, H.PHONE, 3, "phone");
  await badges(browser);
  await endedScreen(browser);
  await lateJoiners(browser);
};
