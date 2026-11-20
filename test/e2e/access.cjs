// Feature 4: ask to join, and lock the meeting.
const H = require("./lib.cjs");

async function setAccess(person, label) {
  await H.openPeople(person);
  await person.page.getByRole("button", { name: /^Who can join/ }).click();
  await person.page.getByRole("menuitemradio", { name: new RegExp(`^${label}`) }).click();
  await person.page.getByRole("button", { name: `Who can join: ${label}` }).waitFor({ timeout: 8000 });
}
const headcount = (person) => person.page.evaluate(() => window.__meetly.call.participants().length);
const knocks = (person) =>
  person.page.evaluate(() => window.__meetlySounds.log.filter((entry) => entry.name === "knock" && entry.outcome === "played").length);

module.exports = async function access(browser) {
  console.log("\n— ask to join, and lock —");
  const ada = await H.client(browser, { scale: 2 });
  const ben = await H.client(browser);
  const url = await H.createMeeting(ada);
  await H.join(ada, url, "Ada Lovelace");
  await H.join(ben, url, "Ben Okri");
  await H.sleep(2500);

  // Open by default.
  H.ok("a new meeting is open: the guest walked straight in", (await headcount(ada)) === 2);
  await H.openPeople(ada);
  H.ok("the host's control says so", (await ada.page.getByRole("button", { name: "Who can join: Anyone with the link" }).count()) === 1);
  await ada.page.getByRole("button", { name: /^Who can join/ }).click();
  await ada.page.getByRole("menuitemradio", { name: /^Locked/ }).waitFor();
  await H.sleep(400);
  await H.shot(ada, "access-menu-desktop");
  await ada.page.keyboard.press("Escape");
  await H.sleep(400);

  /* ask to join */
  await setAccess(ada, "People ask to join");
  // Chat that someone outside must never see.
  await ben.page.getByRole("button", { name: /^Chat/ }).click();
  await ben.page.getByLabel("Message").fill("private to the people inside");
  await ben.page.keyboard.press("Enter");
  await ben.page.keyboard.press("Escape");

  const dee = await H.client(browser, { scale: 2 });
  await dee.page.goto(url);
  await dee.page.getByRole("button", { name: "Ask to join" }).waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("the newcomer's button reads Ask to join", (await dee.page.getByRole("button", { name: "Ask to join" }).count()) === 1);
  await H.shot(dee, "ask-prejoin-desktop");
  const knocksBefore = await knocks(ada);
  await H.press(dee, url, "Dee Knocker");
  await dee.page.getByText("Asking to join…").waitFor({ timeout: 10000 }).catch(() => {});
  H.ok("after asking they wait, and are told so", (await dee.page.getByText("Someone in the call will let you in").count()) === 1);
  await H.shot(dee, "waiting-screen-desktop");
  await ada.page.getByText("Dee Knocker wants to join").waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("the host is asked, with the answer on the notification", (await ada.page.locator("[data-toast]").filter({ hasText: "Dee Knocker wants to join" }).getByRole("button", { name: "Admit" }).count()) === 1);
  H.ok("one knock sounds for the host", await H.until(async () => (await knocks(ada)) === knocksBefore + 1, 3000));
  H.ok("the people button counts who is waiting", (await ada.page.locator("[data-waiting-count]").first().innerText()).startsWith("1"));
  H.ok("the waiting list is at the top of the people panel", (await H.people(ada).getByRole("region", { name: "Waiting to join" }).getByText("Dee Knocker").count()) === 1);
  await H.shot(ada, "knock-desktop");
  H.ok("the person waiting is not in the call", (await headcount(ada)) === 2 && (await headcount(ben)) === 2);
  const outside = await dee.page.evaluate(() => ({
    room: window.__meetly.room.state,
    people: window.__meetly.room.remoteParticipants.size,
    chat: window.__meetly.call.chatMessages().length,
    tiles: document.querySelectorAll("[data-tile] video").length,
    status: window.__meetly.call.status,
  }));
  H.ok(
    "…and nothing of the call reaches them: no people, no chat, no pictures",
    outside.room === "disconnected" && outside.people === 0 && outside.chat === 0 && outside.status === "waiting",
    JSON.stringify(outside),
  );
  H.ok("guests in the call are not told anyone is waiting", (await ben.page.locator("[data-toast]").filter({ hasText: "wants to join" }).count()) === 0 && (await ben.page.evaluate(() => window.__meetly.call.waiting().length)) === 0);
  const deeId = await ada.page.evaluate(() => window.__meetly.call.waiting()[0].id);
  H.ok("a guest cannot let them in (403)", (await H.hostApi(ben, { token: ben.token, action: "admit", identity: deeId })) === 403);
  H.ok("the person waiting cannot let themselves in (403)", (await H.hostApi(dee, { token: dee.token, action: "admit", identity: deeId })) === 403);
  await H.sleep(5200);
  H.ok("the notification stays until it is answered", (await ada.page.getByText("Dee Knocker wants to join").count()) === 1);

  // Deny.
  await ada.page.locator("[data-toast]").filter({ hasText: "Dee Knocker wants to join" }).getByRole("button", { name: "Deny" }).click();
  await dee.page.getByText("The host didn't let you in").waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("deny: the person is told, and is not in the call", (await dee.page.getByText("The host didn't let you in").count()) === 1 && (await headcount(ada)) === 2);
  await H.shot(dee, "denied-screen-desktop");
  H.ok("deny: the host's notification and count clear", await H.until(async () => (await ada.page.getByText("wants to join").count()) === 0 && (await ada.page.locator("[data-waiting-count]").count()) === 0, 5000));

  // Ask again, and a second person: one notification for both, then admit from the list.
  await dee.page.getByRole("button", { name: "Ask again" }).click();
  await H.press(dee, url, "Dee Knocker");
  await dee.page.getByText("Asking to join…").waitFor({ timeout: 10000 });
  const eli = await H.client(browser);
  await H.press(eli, url, "Eli Second");
  await eli.page.getByText("Asking to join…").waitFor({ timeout: 10000 });
  await ada.page.getByText("2 people want to join").waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("two people waiting share one notification", (await ada.page.locator("[data-toast]").filter({ hasText: "want" }).count()) === 1 && (await ada.page.getByText("2 people want to join").count()) === 1);
  await H.shot(ada, "knock-two-desktop");
  // Nothing of the conversation reaches someone who is only asking.
  const whileWaiting = await dee.page.evaluate(() => window.__meetly.call.chatMessages().length);
  await H.people(ada).getByRole("button", { name: "Admit Dee Knocker" }).click();
  await H.inCall(dee).catch(() => {});
  H.ok("admit: the person is in the call", (await H.isInCall(dee)) && (await H.until(async () => (await headcount(ada)) === 3, 8000)));
  H.ok("admit: they see and hear the others", await H.until(() => dee.page.evaluate(() => Array.from(document.querySelectorAll("[data-tile] video")).filter((v) => v.videoWidth > 0 && !v.paused).length >= 3 && document.querySelectorAll("audio").length >= 2), 15000));
  // Since chat history for late joiners: once let in they are given the conversation so far, as history.
  await H.sleep(2500);
  H.ok(
    "admit: no chat reached them while they waited; once in, what came before is history",
    whileWaiting === 0 && (await dee.page.evaluate(() => window.__meetly.call.chatMessages().every((message) => message.earlier === true))),
    JSON.stringify(await dee.page.evaluate(() => window.__meetly.call.chatMessages().map((message) => [message.message, !!message.earlier]))),
  );
  H.ok("the other person is still waiting", await H.until(async () => (await eli.page.getByText("Asking to join…").count()) === 1 && (await ada.page.getByText("Eli Second wants to join").count()) === 1, 6000));
  // Cancelling takes them off the host's list.
  await eli.page.getByRole("button", { name: "Cancel" }).click();
  H.ok("cancel: the host's list and notification clear", await H.until(async () => (await ada.page.getByText("wants to join").count()) === 0 && (await ada.page.evaluate(() => window.__meetly.call.waiting().length)) === 0, 6000));

  // The host reloads while someone waits: the list is still there.
  await H.press(eli, url, "Eli Second");
  await eli.page.getByText("Asking to join…").waitFor({ timeout: 10000 });
  await ada.page.reload();
  await H.join(ada, url, "Ada Lovelace");
  H.ok("the host walks back in without asking, and still sees who is waiting", await H.until(async () => (await ada.page.getByText("Eli Second wants to join").count()) === 1, 10000));
  await ada.page.locator("[data-toast]").filter({ hasText: "Eli Second wants to join" }).getByRole("button", { name: "Admit" }).click();
  await H.inCall(eli).catch(() => {});
  H.ok("admit from the notification works too", (await H.isInCall(eli)));

  /* lock */
  await setAccess(ada, "Locked");
  const fay = await H.client(browser, { scale: 2 });
  await fay.page.goto(url);
  await fay.page.getByText("This meeting is locked").waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("locked: the pre-join screen says so", (await fay.page.getByText("This meeting is locked").count()) >= 1);
  await H.shot(fay, "locked-prejoin-desktop");
  await H.press(fay, url, "Fay Late");
  await fay.page.getByRole("alert").filter({ hasText: "locked" }).waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("locked: a new joiner is refused by the server", fay.tokenStatus === 403 && !(await H.isInCall(fay)) && (await headcount(ada)) === 4, `token route answered ${fay.tokenStatus}`);
  await H.shot(fay, "locked-refused-desktop");
  await ada.page.reload();
  await H.join(ada, url, "Ada Lovelace");
  H.ok("locked: the host can still come back", (await H.isInCall(ada)));
  await setAccess(ada, "Anyone with the link");
  await fay.page.reload();
  await H.join(fay, url, "Fay Late");
  H.ok("unlocked: the same person now joins", (await H.isInCall(fay)));

  /* removing someone, and making people ask from then on */
  await H.openPeople(ada);
  await ada.page.getByRole("list", { name: "Participants" }).getByRole("button", { name: "Host controls for Ben Okri" }).click();
  await ada.page.getByRole("menuitem", { name: "Remove from call" }).click();
  await ada.page.getByText("Make new people ask to join").click();
  await H.shot(ada, "remove-dialog-ask-desktop");
  await ada.page.getByRole("button", { name: "Remove", exact: true }).click();
  await ben.page.getByText("The host removed you").waitFor({ timeout: 8000 });
  H.ok("remove with 'make people ask': the meeting now asks", await H.until(async () => (await ada.page.getByRole("button", { name: "Who can join: People ask to join" }).count()) === 1, 8000));
  await ben.page.goto(url);
  await H.press(ben, url, "Ben Okri");
  await ben.page.getByRole("alert").filter({ hasText: "removed you" }).waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("the removed person's browser is refused outright", ben.tokenStatus === 403);
  const ben2 = await H.client(browser);
  await H.press(ben2, url, "Ben Again");
  await ben2.page.getByText("Asking to join…").waitFor({ timeout: 10000 }).catch(() => {});
  const asking = { waiting: await ben2.page.getByText("Asking to join…").count(), inCall: await H.isInCall(ben2), status: ben2.tokenStatus, lobby: !!(ben2.tokenBody && ben2.tokenBody.lobby) };
  H.ok("…and from a fresh browser they can only ask, which the host can deny", asking.waiting === 1 && !asking.inCall && asking.lobby, JSON.stringify(asking));
  await ada.page.getByText("Ben Again wants to join").waitFor({ timeout: 8000 });
  await H.people(ada).getByRole("button", { name: "Deny Ben Again" }).click();
  await ben2.page.getByText("The host didn't let you in").waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("…denied", (await ben2.page.getByText("The host didn't let you in").count()) === 1);

  /* phone */
  const mo = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  const phoneUrl = await H.createMeeting(mo);
  await H.join(mo, phoneUrl, "Mo Phone");
  await setAccess(mo, "People ask to join");
  await H.closePeople(mo);
  const pat = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  await H.press(pat, phoneUrl, "Pat Pocket");
  await pat.page.getByText("Asking to join…").waitFor({ timeout: 10000 });
  await H.shot(pat, "waiting-screen-phone");
  H.ok("phone: the waiting screen fits", await H.noOverflow(pat));
  await mo.page.getByText("Pat Pocket wants to join").waitFor({ timeout: 8000 });
  await H.shot(mo, "knock-phone");
  H.ok("phone: the knock notification fits, with both answers", (await H.noOverflow(mo)) && (await mo.page.locator("[data-toast]").getByRole("button", { name: "Deny" }).count()) === 1);
  await H.openPeople(mo);
  await H.shot(mo, "waiting-list-phone");
  H.ok("phone: the people sheet lists who is waiting", (await H.people(mo).getByRole("button", { name: "Admit Pat Pocket" }).count()) === 1 && (await H.noOverflow(mo)));
  await H.people(mo).getByRole("button", { name: "Admit Pat Pocket" }).click();
  await H.inCall(pat).catch(() => {});
  H.ok("phone: admit lets them in", (await H.isInCall(pat)));

  for (const person of [ada, ben, dee, eli, fay, ben2, mo, pat]) await person.ctx.close();
};
