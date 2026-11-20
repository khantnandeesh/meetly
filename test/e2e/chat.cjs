// Feature 7: chat history for late joiners, a pinned message, deleting your own, saving the chat.
const fs = require("node:fs");
const H = require("./lib.cjs");

const panel = (person) => person.page.locator('aside[aria-label="Chat"]');
async function openChat(person) {
  if ((await panel(person).count()) === 0) await person.page.locator("#toggle-chat").click();
  await panel(person).waitFor();
}
async function closeChat(person) {
  if ((await panel(person).count()) > 0) await panel(person).locator('button[aria-label="Close chat"]').click();
  await panel(person).waitFor({ state: "detached" });
}
async function say(person, text) {
  await openChat(person);
  await panel(person).getByLabel("Message", { exact: true }).fill(text);
  await person.page.keyboard.press("Enter");
  await bubble(person, text).waitFor({ timeout: 8000 });
}
const bubble = (person, text) => panel(person).locator("[data-chat-message]").filter({ hasText: text });
const texts = (person) => panel(person).locator("[data-chat-message]").allInnerTexts();
const pinnedBar = (person) => panel(person).locator("[data-pinned-message]");
/** Opens the menu of the message that reads `text` and returns the names of what it offers. */
async function menuOf(person, text) {
  const row = bubble(person, text).locator("xpath=..");
  await row.hover();
  await row.getByRole("button", { name: "Message options" }).click();
  await person.page.getByRole("menu").waitFor();
  return (await person.page.getByRole("menuitem").allInnerTexts()).map((item) => item.trim());
}
const choose = (person, name) => person.page.getByRole("menuitem", { name }).click();
const escape = async (person) => {
  await person.page.keyboard.press("Escape");
  await person.page.getByRole("menu").waitFor({ state: "detached" }).catch(() => {});
};
/** The messages a client holds as our server signed them (the app's own debug handle). */
const signed = (person) =>
  person.page.evaluate(() => Array.from(window.__meetly.call.chat.values(), (entry) => entry.signed).filter(Boolean));
function chatApi(person, body) {
  return person.page.evaluate(async (payload) => {
    const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, body);
}
const unreadLabel = (person) => person.page.locator("#toggle-chat").getAttribute("aria-label");
async function saveFrom(person, button) {
  const [download] = await Promise.all([person.page.waitForEvent("download"), button.click()]);
  return { name: download.suggestedFilename(), text: fs.readFileSync(await download.path(), "utf8") };
}

module.exports = async function chat(browser) {
  console.log("\n— chat: history, pin, delete, save —");
  const ada = await H.client(browser, { scale: 2 });
  const ben = await H.client(browser);
  const url = await H.createMeeting(ada);
  const code = url.split("/").pop();
  await H.join(ada, url, "Ada Lovelace");
  await H.join(ben, url, "Ben Okri");
  await say(ada, "Agenda: budget, then hiring");
  await say(ben, "I can only stay 20 minutes");
  await say(ada, "Notes are at https://example.com/notes");
  H.ok("messages reach the other person", await H.until(async () => (await texts(ben)).length === 3, 5000), (await texts(ben)).join(" | "));
  H.ok("there is no line marking earlier messages for people who were there", (await panel(ben).locator("[data-earlier-divider]").count()) === 0);

  /* ------------------------------------------------- history for a late joiner */
  const cy = await H.client(browser, { scale: 2 });
  await H.join(cy, url, "Cy Twombly");
  H.ok(
    "someone who joins late is given what was said before",
    await H.until(async () => (await cy.page.evaluate(() => window.__meetly.call.chatMessages().length)) === 3, 10000),
    `${await cy.page.evaluate(() => window.__meetly.call.chatMessages().length)} messages`,
  );
  H.ok(
    "…marked as earlier, in order, with who said it",
    JSON.stringify(await cy.page.evaluate(() => window.__meetly.call.chatMessages().map((m) => [m.from.name, m.message, !!m.earlier, m.from.isLocal]))) ===
      JSON.stringify([
        ["Ada Lovelace", "Agenda: budget, then hiring", true, false],
        ["Ben Okri", "I can only stay 20 minutes", true, false],
        ["Ada Lovelace", "Notes are at https://example.com/notes", true, false],
      ]),
  );
  await H.sleep(800);
  H.ok("history is not news: no unread badge", (await unreadLabel(cy)) === "Chat", await unreadLabel(cy));
  H.ok("…and no notification", (await cy.page.locator("[data-toast]").filter({ hasText: /Agenda|minutes|Notes/ }).count()) === 0);
  await openChat(cy);
  H.ok("the panel shows the earlier messages", (await texts(cy)).length === 3);
  H.ok("…with a line where the newcomer came in", (await panel(cy).locator("[data-earlier-divider]").count()) === 1);
  await closeChat(cy);
  await say(ben, "Welcome Cy");
  H.ok("a message after joining does count as unread", await H.until(async () => (await unreadLabel(cy)) === "Chat, 1 unread", 5000), await unreadLabel(cy));
  await openChat(cy);
  await H.shot(cy, "chat-history-desktop");
  H.ok(
    "the line sits between what was said before and after",
    await cy.page.evaluate(() => {
      const list = document.querySelector('aside[aria-label="Chat"] [role="log"]');
      const order = Array.from(list.querySelectorAll("[data-chat-message], [data-earlier-divider]"), (el) =>
        el.hasAttribute("data-earlier-divider") ? "|" : "m",
      ).join("");
      return order === "mmm|m";
    }),
  );

  // History comes from another participant, so it is checked: a participant who alters what
  // they hold, or makes a message up, gets nothing past the server.
  const eve = await H.client(browser);
  const fay = await H.client(browser);
  const other = await H.createMeeting(eve);
  await H.join(eve, other, "Eve Forger");
  await say(eve, "The real first message");
  await say(eve, "The real second message");
  await eve.page.evaluate(() => {
    const entries = Array.from(window.__meetly.call.chat.values());
    // One message reworded, keeping its signature; one invented outright, attributed to someone else.
    entries[0].signed = { ...entries[0].signed, text: "Send me your password" };
    const invented = { ...entries[1].signed, id: "invented-1", identity: "someone-else", name: "The Host", text: "Meeting is cancelled", mac: entries[1].signed.mac };
    window.__meetly.call.chat.set("invented-1", { signed: invented, message: { id: "invented-1", timestamp: invented.ts, message: invented.text } });
  });
  await H.join(fay, other, "Fay Late");
  await H.sleep(3500);
  const got = await fay.page.evaluate(() => window.__meetly.call.chatMessages().map((m) => m.message));
  H.ok(
    "a forged or altered message in someone's history never reaches the newcomer; the genuine one does",
    JSON.stringify(got) === JSON.stringify(["The real second message"]),
    JSON.stringify(got),
  );
  // And a participant cannot inject chat directly: only what the server sent counts.
  await eve.page.evaluate(async () => {
    const me = window.__meetly.room.localParticipant;
    const message = { id: "direct-1", room: window.__meetly.room.name, identity: me.identity, name: "Eve", ts: Date.now(), text: "straight to the room", mac: "x" };
    await me.publishData(new TextEncoder().encode(JSON.stringify({ type: "message", message })), { reliable: true, topic: "meetly-chat" });
    await me.publishData(new TextEncoder().encode(JSON.stringify({ type: "delete", id: "whatever" })), { reliable: true, topic: "meetly-chat" });
  });
  await H.sleep(1000);
  H.ok(
    "chat a participant publishes straight to the room is ignored",
    !(await fay.page.evaluate(() => window.__meetly.call.chatMessages().some((m) => m.message === "straight to the room"))),
  );
  for (const person of [eve, fay]) await person.ctx.close();

  /* ------------------------------------------------------------------- pin */
  await openChat(ada);
  await openChat(ben);
  const guestMenu = await menuOf(ben, "Agenda: budget");
  H.ok("a guest's message menu has no pin", !guestMenu.some((item) => /pin/i.test(item)), guestMenu.join(", "));
  await escape(ben);
  const all = await signed(ben);
  const agenda = all.find((message) => message.text.startsWith("Agenda"));
  H.ok(
    "a guest asking the server to pin is refused",
    (await H.hostApi(ben, { token: ben.token, action: "pin", messageId: agenda.id, message: agenda })) === 403,
  );
  H.ok("…and nothing is pinned", (await pinnedBar(ada).count()) === 0 && (await pinnedBar(ben).count()) === 0);

  await closeChat(cy);
  const hostMenu = await menuOf(ada, "Agenda: budget");
  H.ok("the host's menu has Pin for everyone", hostMenu.includes("Pin for everyone"), hostMenu.join(", "));
  await H.shot(ada, "chat-message-menu-desktop");
  await choose(ada, "Pin for everyone");
  await pinnedBar(ada).waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("pinning shows the message at the top for the host", (await pinnedBar(ada).innerText().catch(() => "")).includes("Agenda: budget, then hiring"));
  H.ok(
    "…and for a guest, who cannot take it down",
    (await H.until(async () => (await pinnedBar(ben).count()) === 1, 5000)) &&
      (await pinnedBar(ben).innerText()).includes("Ada Lovelace") &&
      (await pinnedBar(ben).getByRole("button", { name: "Unpin message" }).count()) === 0,
  );
  const pinToast = cy.page.locator("[data-toast]").filter({ hasText: "A message was pinned in chat" });
  H.ok("someone with chat closed is told once", await H.until(async () => (await pinToast.count()) === 1, 5000));
  H.ok("…and someone with chat open gets no notification as well", (await ben.page.locator("[data-toast]").filter({ hasText: "pinned" }).count()) === 0);
  await H.shot(cy, "chat-pin-toast-desktop");
  await pinToast.getByRole("button", { name: "View" }).click();
  await panel(cy).waitFor();
  H.ok("View opens chat with the pinned message", (await pinnedBar(cy).count()) === 1);
  await H.shot(ada, "chat-pinned-desktop");

  const dee = await H.client(browser, { scale: 2 });
  await H.join(dee, url, "Dee Later");
  await openChat(dee);
  H.ok(
    "someone who joins after the pin sees it",
    (await H.until(async () => (await pinnedBar(dee).count()) === 1, 8000)) && (await pinnedBar(dee).innerText()).includes("Agenda: budget, then hiring"),
  );
  H.ok("…without a notification about it", (await dee.page.locator("[data-toast]").filter({ hasText: "pinned" }).count()) === 0);

  // The host cannot pin words nobody said.
  const hostToken = ada.token;
  H.ok(
    "a pin for a message the server never signed is refused, even from the host",
    (await H.hostApi(ada, { token: hostToken, action: "pin", messageId: agenda.id, message: { ...agenda, text: "Everyone gets a raise" } })) === 400,
  );
  H.ok("…and the pinned message is unchanged", (await pinnedBar(ben).innerText()).includes("Agenda: budget, then hiring"));

  // A co-host may pin; when they stop being one, they may not.
  const benId = await H.identity(ben);
  H.ok("the host makes Ben a co-host", (await H.hostApi(ada, { token: hostToken, action: "coHost", identity: benId, on: true })) === 200);
  await H.until(async () => (await pinnedBar(ben).getByRole("button", { name: "Unpin message" }).count()) === 1, 5000);
  const coHostMenu = await menuOf(ben, "Notes are at");
  H.ok("a co-host's menu has Pin for everyone", coHostMenu.includes("Pin for everyone"), coHostMenu.join(", "));
  await choose(ben, "Pin for everyone");
  H.ok(
    "a co-host's pin replaces the pinned message for everyone",
    await H.until(async () => (await pinnedBar(ada).innerText().catch(() => "")).includes("Notes are at"), 6000),
  );
  H.ok("only one message is pinned at a time", (await pinnedBar(ada).count()) === 1);
  await pinnedBar(ada).getByRole("button", { name: "Unpin message" }).click();
  H.ok(
    "unpinning takes it down for everyone",
    await H.until(async () => (await pinnedBar(ada).count()) + (await pinnedBar(ben).count()) + (await pinnedBar(dee).count()) === 0, 6000),
  );
  await H.hostApi(ada, { token: hostToken, action: "coHost", identity: benId, on: false });
  H.ok(
    "a former co-host is refused again",
    (await H.until(async () => (await H.hostApi(ben, { token: ben.token, action: "pin", messageId: agenda.id, message: agenda })) === 403, 4000)),
  );

  /* ---------------------------------------------------------------- delete */
  const benOwn = await menuOf(ben, "I can only stay 20 minutes");
  H.ok("your own message's menu has Delete for everyone", benOwn.includes("Delete for everyone"), benOwn.join(", "));
  await escape(ben);
  const benOthers = await menuOf(ben, "Agenda: budget");
  H.ok("someone else's message's menu has no delete", !benOthers.some((item) => /delete/i.test(item)), benOthers.join(", "));
  await escape(ben);
  const hostOthers = await menuOf(ada, "I can only stay 20 minutes");
  H.ok("…not for the host either", !hostOthers.some((item) => /delete/i.test(item)), hostOthers.join(", "));
  await escape(ada);

  // Asking the server directly to delete somebody else's message.
  const stay = all.find((message) => message.text.startsWith("I can only stay"));
  const refused = await chatApi(cy, { token: cy.token, action: "delete", message: stay });
  H.ok("the server refuses to delete another person's message", refused.status === 403, `${refused.status} ${refused.body && refused.body.error}`);
  const asHost = await chatApi(ada, { token: hostToken, action: "delete", message: stay });
  H.ok("…from the host as well", asHost.status === 403, String(asHost.status));
  const cyId = await H.identity(cy);
  const relabelled = await chatApi(cy, { token: cy.token, action: "delete", message: { ...stay, identity: cyId } });
  H.ok("…and relabelling the message as your own breaks its signature", relabelled.status === 400, String(relabelled.status));
  const noToken = await chatApi(cy, { token: "nonsense", action: "delete", message: stay });
  H.ok("…and without a valid token nothing is allowed", noToken.status === 403, String(noToken.status));
  await H.sleep(500);
  H.ok("the message is still there for everyone", (await bubble(ada, "I can only stay 20 minutes").count()) === 1 && (await bubble(dee, "I can only stay 20 minutes").count()) === 1);

  await menuOf(ben, "I can only stay 20 minutes");
  await choose(ben, "Delete for everyone");
  const deleted = (person) => panel(person).locator("[data-chat-message][data-deleted]");
  H.ok("deleting your own message removes it for you", await H.until(async () => (await deleted(ben).count()) === 1 && (await bubble(ben, "I can only stay").count()) === 0, 6000));
  H.ok(
    "…and for everyone else, leaving \"Message deleted\" in its place",
    (await H.until(async () => (await deleted(ada).count()) === 1 && (await deleted(cy).count()) === 1, 6000)) &&
      (await bubble(ada, "I can only stay").count()) === 0 &&
      (await deleted(ada).innerText()) === "Message deleted",
  );
  H.ok("…and its text is gone from memory, not just hidden", !(await ada.page.evaluate(() => JSON.stringify(window.__meetly.call.chatMessages()).includes("20 minutes"))));
  await H.shot(ada, "chat-deleted-desktop");

  // A deleted message does not stay pinned.
  await say(ben, "Pin me then delete me");
  await menuOf(ada, "Pin me then delete me");
  await choose(ada, "Pin for everyone");
  await H.until(async () => (await pinnedBar(ben).count()) === 1, 6000);
  await menuOf(ben, "Pin me then delete me");
  await choose(ben, "Delete for everyone");
  H.ok("deleting the pinned message takes the pin down too", await H.until(async () => (await pinnedBar(ada).count()) + (await pinnedBar(ben).count()) === 0, 6000));

  // Someone who joins now is not shown the deleted messages.
  const gus = await H.client(browser);
  await H.join(gus, url, "Gus Latest");
  await H.sleep(3000);
  const gusSees = await gus.page.evaluate(() => window.__meetly.call.chatMessages().map((m) => m.message));
  H.ok(
    "someone who joins after a deletion is not given the deleted message",
    gusSees.length === 3 && !gusSees.some((text) => /20 minutes|Pin me/.test(text)),
    JSON.stringify(gusSees),
  );

  // After a reload you are a new participant, but your own messages are still yours to delete.
  await ben.page.reload();
  await H.join(ben, url, "Ben Okri");
  await openChat(ben);
  await H.until(async () => (await bubble(ben, "Welcome Cy").count()) === 1, 8000);
  const afterReload = await menuOf(ben, "Welcome Cy");
  H.ok("after a reload your earlier messages are still yours", afterReload.includes("Delete for everyone"), afterReload.join(", "));
  await choose(ben, "Delete for everyone");
  H.ok("…and deleting one works", await H.until(async () => (await bubble(ada, "Welcome Cy").count()) === 0, 6000));

  // Someone the host removed keeps their token, but not their voice.
  const gusToken = gus.token;
  const gusId = await H.identity(gus);
  await H.hostApi(ada, { token: hostToken, action: "remove", identity: gusId });
  await H.sleep(1500);
  const afterRemoval = await chatApi(ada, { token: gusToken, action: "send", text: "still here?" });
  H.ok("a removed person's token can no longer send chat", afterRemoval.status === 403, String(afterRemoval.status));
  const tooLong = await chatApi(ada, { token: hostToken, action: "send", text: "x".repeat(2001) });
  H.ok("an over-long message is refused by the server", tooLong.status === 400, String(tooLong.status));

  /* ------------------------------------------------------------------ save */
  await say(ada, "Two lines\nin one message");
  const saved = await saveFrom(ada, panel(ada).getByRole("button", { name: "Save chat" }));
  H.ok("Save chat downloads a text file named after the meeting", new RegExp(`^meetly-chat-${code}-\\d{8}-\\d{4}\\.txt$`).test(saved.name), saved.name);
  const lines = saved.text.replace(/^\uFEFF/, "").split("\r\n");
  H.ok(
    "the file starts with the meeting and how many messages it holds",
    lines[0] === "Meetly chat" && lines[1] === `Meeting: ${code}` && /^Saved: \d{4}-\d\d-\d\d \d\d:\d\d \(.+\)$/.test(lines[2]) && lines[3] === "Messages: 3",
    lines.slice(0, 4).join(" / "),
  );
  const body = lines.slice(5).filter(Boolean);
  const stamp = "\\[\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d\\] ";
  const expected = [
    `^${stamp}Ada Lovelace: Agenda: budget, then hiring$`,
    `^${stamp}Ben Okri: \\(message deleted\\)$`,
    `^${stamp}Ada Lovelace: Notes are at https://example\\.com/notes$`,
    `^${stamp}Ben Okri: \\(message deleted\\)$`,
    `^${stamp}Ben Okri: \\(message deleted\\)$`,
    `^${stamp}Ada Lovelace: Two lines$`,
    "^    in one message$",
  ];
  H.ok(
    "then every message in order with time and name, deleted ones marked, and nothing of their text",
    body.length === expected.length && expected.every((pattern, index) => new RegExp(pattern).test(body[index])) && !/20 minutes|Welcome Cy|Pin me/.test(saved.text),
    body.join(" / "),
  );

  /* ------------------------------------------------------------------ phone */
  const mo = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  await H.join(mo, url, "Mo Phone");
  await say(cy, "Pinned for the phone");
  await menuOf(ada, "Pinned for the phone");
  await choose(ada, "Pin for everyone");
  await mo.page.locator("#toggle-chat").click();
  await panel(mo).waitFor();
  await H.until(async () => (await bubble(mo, "Pinned for the phone").count()) === 1, 8000);
  H.ok("phone: the pinned message is at the top of the sheet", await H.until(async () => (await pinnedBar(mo).count()) === 1, 6000));
  await say(mo, "Hello from my phone");
  H.ok("phone: history, the line and new messages fit the sheet", (await H.noOverflow(mo)) && (await panel(mo).locator("[data-earlier-divider]").count()) === 1);
  // A long press on a message opens its menu.
  const mine = bubble(mo, "Hello from my phone");
  const box = await mine.boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const touch = (type) =>
    mine.dispatchEvent(type, { pointerType: "touch", pointerId: 7, isPrimary: true, bubbles: true, clientX: point.x, clientY: point.y });
  await touch("pointerdown");
  await H.sleep(700);
  await touch("pointerup");
  await mo.page.getByRole("menu").waitFor({ timeout: 3000 }).catch(() => {});
  const phoneMenu = (await mo.page.getByRole("menuitem").allInnerTexts()).map((item) => item.trim());
  H.ok("phone: a long press on your message opens its menu", phoneMenu.includes("Copy text") && phoneMenu.includes("Delete for everyone"), phoneMenu.join(", "));
  await H.shot(mo, "chat-message-menu-phone");
  H.ok("phone: the menu fits the screen", await H.noOverflow(mo));
  await escape(mo);
  // A short tap does not.
  await touch("pointerdown");
  await H.sleep(120);
  await touch("pointerup");
  await H.sleep(600);
  H.ok("phone: a tap does not", (await mo.page.getByRole("menu").count()) === 0);
  const saveBox = await panel(mo).getByRole("button", { name: "Save chat" }).boundingBox();
  H.ok("phone: Save chat is in the sheet's header, on screen", !!saveBox && saveBox.x >= 0 && saveBox.x + saveBox.width <= H.PHONE.width && saveBox.width >= 40);
  await H.shot(mo, "chat-history-phone");

  await ada.page.getByRole("button", { name: "Leave call" }).click();
  const leaveSave = ada.page.getByRole("button", { name: "Save chat" });
  await leaveSave.waitFor({ timeout: 8000 });
  await H.shot(ada, "chat-save-on-leaving-desktop");
  const again = await saveFrom(ada, leaveSave);
  H.ok("after leaving, the goodbye screen can still save the chat", again.text.includes("Ada Lovelace: Agenda: budget, then hiring") && again.text.includes("Mo Phone: Hello from my phone") && again.text.includes("Pinned: Cy Twombly: Pinned for the phone"));
  const hal = await H.client(browser);
  const quiet = await H.createMeeting(hal);
  await H.join(hal, quiet, "Hal Quiet");
  await openChat(hal);
  H.ok("with nothing said, Save chat is not offered as something to press", (await panel(hal).getByRole("button", { name: "Save chat" }).getAttribute("aria-disabled")) === "true");
  await hal.page.getByRole("button", { name: "Close chat" }).click();
  await hal.page.getByRole("button", { name: "Leave call" }).click();
  await hal.page.getByRole("button", { name: "Rejoin" }).waitFor();
  H.ok("…and the goodbye screen has no Save chat", (await hal.page.getByRole("button", { name: "Save chat" }).count()) === 0);
  await hal.ctx.close();

  for (const person of [ben, cy, dee, gus, mo, ada]) await person.ctx.close();
};
