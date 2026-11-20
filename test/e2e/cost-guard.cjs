// The webinar cost watchdog as people see it: the host's warning that the free time limit is
// near, and the leave screen when the watchdog ends a webinar.
//
// The watchdog itself only runs on RealtimeKit, against Cloudflare's REST API (unit-tested in
// test/costGuard*.test.ts); on this LiveKit build nothing ever reaches the limit. So the two
// moments are simulated on a real webinar call through the app's debug handle: the call is told
// it has a warning, and then that it was ended for the limit, exactly as the RealtimeKit adapter
// would report them. What is checked is everything from there on: the notification, and the
// screen the person is left on.
const H = require("./lib.cjs");

/** Starts a webinar the way "New webinar" does, from this person's page, and returns its URL. */
async function createWebinar(person) {
  await person.page.goto(`${H.BASE}/`);
  const code = await person.page.evaluate(async () => {
    const response = await fetch("/api/meeting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", mode: "webinar" }),
    });
    return (await response.json()).code;
  });
  return `${H.BASE}/${code}`;
}

/** What the RealtimeKit adapter does when our server says the limit is `minutes` away. */
const warn = (person, minutes) =>
  person.page.evaluate((ms) => {
    const call = window.__meetly.call;
    Object.defineProperty(call, "limitWarning", { configurable: true, get: () => ({ endsAt: Date.now() + ms }) });
    call.emit("limitWarning");
  }, minutes * 60_000);

/** What the RealtimeKit adapter does once it knows why it was removed. */
const endAs = (person, reason) => person.page.evaluate((why) => window.__meetly.call.emit("disconnected", why), reason);

const leaveScreen = (person) => person.page.locator("main").filter({ has: person.page.getByRole("heading", { level: 1 }) });

module.exports = async function costGuardSuite(browser) {
  console.log("\n— webinar cost guard: the warning and the ending —");
  const host = await H.client(browser, { viewport: { width: 1440, height: 900 }, scale: 2 });
  const phone = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });

  const offered = await host.page.evaluate(async () => (await (await fetch("/api/meeting", { method: "POST", body: JSON.stringify({ action: "webinars" }) })).json()).enabled);
  H.ok("with the switch unset, webinars are offered", offered === true);

  const url = await createWebinar(host);
  H.ok("a webinar can be started", /\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(url), url);
  await H.join(host, url, "Hana Host");

  // The warning: a "you" notification with the minutes left.
  await warn(host, 7);
  const notice = host.page.getByText("This webinar ends in about 7 minutes (free limit).");
  H.ok("at 80% the host sees how long is left", await notice.waitFor({ timeout: 5000 }).then(() => true, () => false));
  await H.shot(host, "cost-guard-warning-desktop");
  // The same warning again is one notification, updated in place, not a second one.
  await warn(host, 6);
  await H.sleep(300);
  H.ok("a newer estimate replaces the notification rather than stacking", (await host.page.getByText(/This webinar ends in about \d+ minutes/).count()) === 1);

  // The ending.
  await endAs(host, "limit");
  await host.page.getByRole("heading", { name: "This webinar reached its free time limit" }).waitFor({ timeout: 8000 });
  const text = await leaveScreen(host).innerText();
  H.ok("the leave screen says the free time limit ended it", /This webinar reached its free time limit/.test(text));
  H.ok("and does not say the host ended it or removed anyone", !/host ended|host removed/i.test(text), text.replace(/\s+/g, " "));
  H.ok("there is nothing to rejoin: no Rejoin button", (await host.page.getByRole("button", { name: /Rejoin|Start again/ }).count()) === 0);
  H.ok("Back to home is the way out", (await host.page.getByRole("link", { name: "Back to home" }).getAttribute("class")).includes("btn-primary"));
  await H.shot(host, "cost-guard-limit-desktop");

  // On a phone, both endings our server can cause.
  const phoneUrl = await createWebinar(phone);
  await H.join(phone, phoneUrl, "Pia Phone");
  await warn(phone, 1);
  H.ok("one minute left reads as one minute", await phone.page.getByText("This webinar ends in about 1 minute (free limit).").waitFor({ timeout: 5000 }).then(() => true, () => false));
  await H.shot(phone, "cost-guard-warning-phone");
  await endAs(phone, "limit");
  await phone.page.getByRole("heading", { name: "This webinar reached its free time limit" }).waitFor({ timeout: 8000 });
  H.ok("on a 390 px phone the limit screen fits", await H.noOverflow(phone));
  await H.shot(phone, "cost-guard-limit-phone");

  await phone.page.goto(phoneUrl);
  await H.join(phone, phoneUrl, "Pia Phone");
  await endAs(phone, "paused");
  await phone.page.getByRole("heading", { name: "Webinars are paused right now" }).waitFor({ timeout: 8000 });
  H.ok("switched off, the screen says webinars are paused, not that the host ended it", !/host/i.test(await leaveScreen(phone).innerText()));
  H.ok("and offers no Rejoin", (await phone.page.getByRole("button", { name: /Rejoin/ }).count()) === 0);
  await H.shot(phone, "cost-guard-paused-phone");

  for (const person of [host, phone]) await person.ctx.close();
};
