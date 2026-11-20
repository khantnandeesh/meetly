// Feature 9: polls. Host and co-hosts start and end them, everyone votes once, and neither a
// second request nor anything a browser can write changes the count.
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
const card = (person, question) => panel(person).locator("[data-poll]").filter({ hasText: question });
/** The polls as the person's own client holds them (the app's debug handle). */
const polls = (person) => person.page.evaluate(() => window.__meetly.call.polls());
const pollNamed = async (person, question) => (await polls(person)).find((poll) => poll.question === question);
const counts = async (person, question) => ((await pollNamed(person, question)) || { options: [] }).options.map((option) => option.votes);
function pollApi(person, body) {
  return person.page.evaluate(async (payload) => {
    const response = await fetch("/api/poll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, body);
}
const unreadLabel = (person) => person.page.locator("#toggle-chat").getAttribute("aria-label");

async function startPoll(person, question, options, { named = false } = {}) {
  await openChat(person);
  await panel(person).getByRole("button", { name: "Start a poll" }).click();
  const dialog = person.page.getByRole("dialog", { name: "Start a poll" });
  await dialog.waitFor();
  await dialog.getByLabel("Question").fill(question);
  for (let index = 0; index < options.length; index++) {
    if (index >= 2) await dialog.getByRole("button", { name: "Add an option" }).click();
    await dialog.getByLabel(`Option ${index + 1}`, { exact: true }).fill(options[index]);
  }
  if (named) await dialog.getByText("Anonymous votes", { exact: true }).click();
  return dialog;
}

module.exports = async function pollsSuite(browser) {
  console.log("\n— polls: who may start one, one vote each, late joiners, ending —");
  const host = await H.client(browser, { scale: 2 });
  const guest = await H.client(browser);
  const url = await H.createMeeting(host);
  await H.join(host, url, "Maya Host");
  await H.join(guest, url, "Gus Guest");

  /* ------------------------------------------------------------ who may start one */
  await openChat(guest);
  H.ok("a guest is not offered \"Start a poll\"", (await panel(guest).getByRole("button", { name: "Start a poll" }).count()) === 0);
  H.ok("with no polls, a guest's chat has no polls section at all", (await panel(guest).locator("[data-polls]").count()) === 0);
  await closeChat(guest);
  const forged = await pollApi(guest, { token: guest.token, action: "create", question: "Forged?", options: ["Yes", "No"], role: "host", isHost: true });
  H.ok("a guest asking the server to start a poll is refused (403), whatever role the request claims", forged.status === 403, JSON.stringify(forged));
  const noToken = await pollApi(guest, { token: "not-a-token", action: "create", question: "Forged?", options: ["Yes", "No"] });
  H.ok("a request with no valid token is refused (403)", noToken.status === 403, String(noToken.status));
  H.ok("nothing was created by either", (await polls(host)).length === 0);

  await openChat(host);
  H.ok("the host is offered \"Start a poll\"", (await panel(host).getByRole("button", { name: "Start a poll" }).count()) === 1);
  const empty = await startPoll(host, "Lunch?", ["Pizza"]);
  await H.shot(host, "poll-create-desktop");
  await empty.getByRole("button", { name: "Start poll" }).click();
  H.ok("a poll with one option is refused in the form, with the reason", /at least 2 options/.test(await empty.getByRole("alert").innerText()));
  const oneOption = await pollApi(host, { token: host.token, action: "create", question: "Lunch?", options: ["Pizza"] });
  H.ok("and by the server (400)", oneOption.status === 400, JSON.stringify(oneOption));
  await empty.getByLabel("Option 2", { exact: true }).fill("Sushi");
  await empty.getByRole("button", { name: "Add an option" }).click();
  await empty.getByLabel("Option 3", { exact: true }).fill("Salad");
  await empty.getByRole("button", { name: "Start poll" }).click();
  await empty.waitFor({ state: "detached" });
  await card(host, "Lunch?").waitFor({ timeout: 8000 });
  H.ok("the host's poll appears at the top of their chat", (await card(host, "Lunch?").getAttribute("data-poll-open")) === "true");

  /* --------------------------------------------------------- how others hear of it */
  const toast = guest.page.locator("[data-toast]").filter({ hasText: "started a poll" });
  await toast.waitFor({ timeout: 8000 });
  H.ok("the guest gets one notification, naming who started it and the question", /Maya Host started a poll/.test(await toast.innerText()) && /Lunch\?/.test(await toast.innerText()), (await toast.innerText()).replace(/\n/g, " | "));
  H.ok("there is exactly one such notification", (await guest.page.locator("[data-toast]").count()) === 1);
  H.ok("the chat button counts the waiting poll as one", /1 unread/.test((await unreadLabel(guest)) || ""), await unreadLabel(guest));
  await H.shot(guest, "poll-toast-desktop");
  await toast.getByRole("button", { name: "Vote" }).click();
  await card(guest, "Lunch?").waitFor();
  H.ok("\"Vote\" opens chat on the poll", (await card(guest, "Lunch?").count()) === 1);

  /* -------------------------------------------------------------- results visibility */
  H.ok("before voting a guest sees the options and no counts", (await card(guest, "Lunch?").locator("[data-poll-count]").count()) === 0 && /Results show once you vote/.test(await card(guest, "Lunch?").innerText()));
  H.ok("the host, who can end it, sees the counts", (await card(host, "Lunch?").locator("[data-poll-count]").count()) === 3);
  H.ok("a guest cannot end it: no button", (await card(guest, "Lunch?").locator("[data-poll-end]").count()) === 0);
  await H.shot(guest, "poll-vote-desktop");

  /* ------------------------------------------------------------------ one vote each */
  await card(guest, "Lunch?").locator('[data-poll-option="1"]').click();
  H.ok("the guest's vote is counted", await H.until(async () => (await counts(host, "Lunch?")).join() === "0,1,0", 8000), (await counts(host, "Lunch?")).join());
  H.ok("after voting the guest sees counts and percentages, and which was theirs", await H.until(async () => (await card(guest, "Lunch?").locator("[data-poll-count]").count()) === 3, 5000) && /you voted/.test(await card(guest, "Lunch?").innerText()) && (await card(guest, "Lunch?").locator('[data-poll-option="1"]').getByLabel("Your vote").count()) === 1);
  H.ok("and can no longer press an option", (await card(guest, "Lunch?").locator("button[data-poll-option]").count()) === 0);
  await H.shot(guest, "poll-results-desktop");
  const pollId = (await pollNamed(guest, "Lunch?")).id;
  const again = await pollApi(guest, { token: guest.token, action: "vote", pollId, option: 1 });
  const other = await pollApi(guest, { token: guest.token, action: "vote", pollId, option: 0 });
  const many = await Promise.all([0, 2, 0, 2, 0].map((option) => pollApi(guest, { token: guest.token, action: "vote", pollId, option })));
  await H.sleep(800);
  H.ok("voting again for the same option is accepted and counts nothing", again.status === 200 && (await counts(host, "Lunch?")).join() === "0,1,0", `${again.status} ${(await counts(host, "Lunch?")).join()}`);
  H.ok("voting for a different option is refused (409)", other.status === 409, JSON.stringify(other));
  H.ok("five more votes at once are all refused; the count is still one", many.every((r) => r.status === 409) && (await counts(host, "Lunch?")).join() === "0,1,0", `${many.map((r) => r.status).join()} → ${(await counts(host, "Lunch?")).join()}`);
  const outOfRange = await pollApi(guest, { token: guest.token, action: "vote", pollId, option: 7 });
  const noPoll = await pollApi(guest, { token: guest.token, action: "vote", pollId: "nope", option: 0 });
  H.ok("an option that does not exist is refused (400), a poll that does not exist too (404)", outOfRange.status === 400 && noPoll.status === 404, `${outOfRange.status} ${noPoll.status}`);

  // Things a modified client could try without the server: none of them is where counts come from.
  await guest.page.evaluate(async (id) => {
    const room = window.__meetly.room;
    const forgedPoll = { id, q: "Lunch?", o: ["Pizza", "Sushi", "Salad"], by: "Maya Host", at: 1, c: [99, 0, 0] };
    const bytes = new TextEncoder().encode(JSON.stringify({ polls: [forgedPoll], type: "polls" }));
    for (const topic of ["meetly-polls", "meetly-chat", "polls"]) await room.localParticipant.publishData(bytes, { reliable: true, topic }).catch(() => {});
    await room.localParticipant.setAttributes({ polls: JSON.stringify([forgedPoll]), [`poll:${id}`]: "0" }).catch(() => {});
    await room.localParticipant.setMetadata(JSON.stringify({ polls: [forgedPoll] })).catch(() => {});
  }, pollId);
  await H.sleep(1000);
  H.ok("a tally forged over data messages, attributes and the guest's own metadata changes nothing for anyone", (await counts(host, "Lunch?")).join() === "0,1,0" && (await counts(guest, "Lunch?")).join() === "0,1,0", `${(await counts(host, "Lunch?")).join()} / ${(await counts(guest, "Lunch?")).join()}`);

  // The same browser after a reload is a new participant with the same signed cookie.
  await guest.page.reload();
  await H.join(guest, url, "Gus Guest");
  H.ok("after a reload the guest is still shown as having voted", await H.until(async () => ((await pollNamed(guest, "Lunch?")) || {}).voted === true, 8000), JSON.stringify(await pollNamed(guest, "Lunch?")));
  const reloaded = await pollApi(guest, { token: guest.token, action: "vote", pollId, option: 2 });
  H.ok("and a vote under the new identity is refused (409): one vote per browser, not per connection", reloaded.status === 409 && (await counts(host, "Lunch?")).join() === "0,1,0", `${reloaded.status} ${(await counts(host, "Lunch?")).join()}`);
  H.ok("the waiting-poll badge does not come back for a poll already voted in", !/unread/.test((await unreadLabel(guest)) || ""), await unreadLabel(guest));

  /* ------------------------------------------------------------------- late joiner */
  const cy = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  await H.join(cy, url, "Cy Late");
  H.ok("someone who joins late is given the open poll, with its count", await H.until(async () => (await counts(cy, "Lunch?")).join() === "0,1,0", 8000), (await counts(cy, "Lunch?")).join());
  await H.sleep(2500);
  H.ok("without a notification (it is not news), but with the chat button showing one waiting", (await cy.page.locator("[data-toast]").filter({ hasText: "poll" }).count()) === 0 && /1 unread/.test((await unreadLabel(cy)) || ""), await unreadLabel(cy));
  await openChat(cy);
  await card(cy, "Lunch?").waitFor();
  H.ok("on a 390 px phone the poll fits, options are at least 44 px tall", (await H.noOverflow(cy)) && (await card(cy, "Lunch?").locator("button[data-poll-option]").first().boundingBox()).height >= 44);
  await H.shot(cy, "poll-vote-phone");
  // Two people voting at the same moment are both counted.
  const [a, b] = await Promise.all([
    card(cy, "Lunch?").locator('[data-poll-option="0"]').click().then(() => ({ status: 200 })),
    pollApi(host, { token: host.token, action: "vote", pollId, option: 0 }),
  ]);
  H.ok("two votes arriving together are both counted", a.status === 200 && b.status === 200 && (await H.until(async () => (await counts(guest, "Lunch?")).join() === "2,1,0", 8000)), `${a.status} ${b.status} ${(await counts(guest, "Lunch?")).join()}`);
  await H.until(async () => (await card(cy, "Lunch?").locator("[data-poll-count]").count()) === 3, 5000);
  await H.shot(cy, "poll-results-phone");
  H.ok("an anonymous poll never shows names", (await card(host, "Lunch?").locator("[data-poll-voters]").count()) === 0 && (await pollNamed(host, "Lunch?")).options.every((option) => option.voters.length === 0));
  const raw = await host.page.evaluate(() => window.__meetly.room.metadata);
  const ids = await Promise.all([host, guest, cy].map((person) => H.identity(person)));
  const stored = JSON.stringify(JSON.parse(raw).polls);
  H.ok("nor does the meeting's record: no voter's identity is in it", ids.every((id) => !stored.includes(id)), stored.slice(0, 200));

  /* ------------------------------------------------------------------ a named poll */
  await openChat(host);
  const namedForm = await startPoll(host, "Who takes notes?", ["Maya", "Gus"], { named: true });
  await namedForm.getByRole("button", { name: "Start poll" }).click();
  await namedForm.waitFor({ state: "detached" });
  await card(host, "Who takes notes?").waitFor({ timeout: 8000 });
  await openChat(guest);
  await card(guest, "Who takes notes?").locator('[data-poll-option="0"]').click();
  H.ok("in a named poll the host sees who chose what", await H.until(async () => /Gus Guest/.test((await card(host, "Who takes notes?").locator("[data-poll-voters]").allInnerTexts()).join()), 8000), (await card(host, "Who takes notes?").innerText()).replace(/\n/g, " | "));
  await H.shot(host, "poll-named-host-desktop");

  /* ------------------------------------------------------------------------ ending */
  const guestEnd = await H.hostApi(guest, { token: guest.token, action: "closePoll", pollId });
  H.ok("a guest asking the server to end a poll is refused (403)", guestEnd === 403, String(guestEnd));
  await card(host, "Lunch?").locator("[data-poll-end]").click();
  H.ok("the host ends it, and it is ended for everyone with its final count", (await H.until(async () => { const poll = await pollNamed(guest, "Lunch?"); return poll && !poll.open && poll.options.map((o) => o.votes).join() === "2,1,0"; }, 8000)) && (await H.until(async () => (await card(cy, "Lunch?").getAttribute("data-poll-open")) === "false", 5000)));
  const afterEnd = await pollApi(cy, { token: cy.token, action: "vote", pollId, option: 1 });
  H.ok("a vote sent after it ended is refused (409)", afterEnd.status === 409 && (await counts(host, "Lunch?")).join() === "2,1,0", `${afterEnd.status}`);
  await card(guest, "Lunch?").getByRole("button").click();
  H.ok("an ended poll folds to a line that opens to the result", (await card(guest, "Lunch?").locator("[data-poll-count]").count()) === 3 && /Ended · 3 votes/.test(await card(guest, "Lunch?").innerText()));
  await H.shot(guest, "poll-ended-desktop");

  /* ------------------------------------------------------------------------ limits */
  const more = [];
  for (let n = 0; n < 5; n++) more.push(await pollApi(host, { token: host.token, action: "create", question: `Extra ${n}`, options: ["A", "B"] }));
  H.ok("no more than five polls are open at once (409 for the sixth)", more.slice(0, 4).every((r) => r.status === 200) && more[4].status === 409, more.map((r) => r.status).join());
  const long = await pollApi(host, { token: host.token, action: "create", question: "x".repeat(141), options: ["A", "B"] });
  const seven = await pollApi(host, { token: host.token, action: "create", question: "Seven?", options: ["1", "2", "3", "4", "5", "6", "7"] });
  H.ok("a question over 140 characters and a seventh option are refused (400)", long.status === 400 && seven.status === 400, `${long.status} ${seven.status}`);
  H.ok("with five open, \"Start a poll\" says why it will not", (await panel(host).getByRole("button", { name: "Start a poll" }).getAttribute("aria-disabled")) === "true");
  H.ok("a chat panel full of polls still leaves room for the conversation and does not overflow", await host.page.evaluate(() => {
    const aside = document.querySelector('aside[aria-label="Chat"]');
    const log = aside.querySelector('[role="log"]');
    return log.getBoundingClientRect().height >= 120 && document.documentElement.scrollWidth <= window.innerWidth;
  }));
  await H.shot(host, "poll-many-desktop");

  /* --------------------------------------------------------------------- co-hosts */
  const guestId = await H.identity(guest);
  H.ok("the host makes the guest a co-host", (await H.hostApi(host, { token: host.token, action: "coHost", identity: guestId, on: true })) === 200);
  const extraId = (await pollNamed(host, "Extra 0")).id;
  H.ok("a co-host may end a poll", await H.until(async () => (await H.hostApi(guest, { token: guest.token, action: "closePoll", pollId: extraId })) === 200, 5000));
  const byCoHost = await pollApi(guest, { token: guest.token, action: "create", question: "From a co-host", options: ["A", "B"] });
  H.ok("and start one", byCoHost.status === 200, JSON.stringify(byCoHost));
  H.ok("the co-host is now offered \"Start a poll\"", await H.until(async () => (await panel(guest).getByRole("button", { name: "Start a poll" }).count()) === 1, 5000));

  for (const person of [host, guest, cy]) await person.ctx.close();
};
