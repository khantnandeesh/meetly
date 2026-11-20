// Feature 6: a meeting for later, with Google Calendar, Outlook and .ics links.
const fs = require("node:fs");
const H = require("./lib.cjs");

const dialog = (person) => person.page.locator("[data-schedule-dialog]");
const CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

async function openMenu(person) {
  await person.page.goto(`${H.BASE}/`);
  await person.page.getByRole("button", { name: "More ways to start a meeting" }).click();
  await person.page.getByRole("menuitem", { name: "Schedule…" }).waitFor();
}

/** Fills the form and returns what each calendar would be given. */
async function plan(person, { title, date, time, minutes }) {
  const form = dialog(person);
  if (title !== undefined) await form.getByLabel("Title").fill(title);
  await form.getByLabel("Date").fill(date);
  await form.getByLabel("Starts").fill(time);
  await form.getByLabel("Length").selectOption(String(minutes));
  const href = (name) => form.getByRole("link", { name, exact: true }).getAttribute("href");
  return {
    link: await form.locator("[data-meeting-link]").getAttribute("data-meeting-link"),
    google: await href("Google Calendar"),
    outlook: await href("Outlook.com"),
    work: await href("Microsoft 365"),
  };
}

async function downloadIcs(person) {
  const [download] = await Promise.all([
    person.page.waitForEvent("download"),
    dialog(person).getByRole("button", { name: /^Download \.ics/ }).click(),
  ]);
  return { name: download.suggestedFilename(), text: fs.readFileSync(await download.path(), "utf8") };
}

/** Unfolds an .ics file (RFC 5545, 3.1) and returns its lines as [name, value]. */
function parseIcs(text) {
  return text
    .replace(/\r\n[ \t]/g, "")
    .split("\r\n")
    .filter(Boolean)
    .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1)]);
}
const unescapeIcs = (value) => value.replace(/\\n/g, "\n").replace(/\\([,;\\])/g, "$1");

/** "20270314T060000Z" for a Date: worked out here, independently of the app. */
const basic = (date) => date.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
/** What the wall clock in `timeZone` reads at `date`, as "YYYY-MM-DD HH:MM". */
function wallClock(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}
const fromBasic = (value) => new Date(value.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z"));

/** Opens Schedule… in a browser set to `timeZone` and checks every output for one start time. */
async function checkZone(browser, { timeZone, date, time, minutes, startUtc, endUtc, note }) {
  const ctx = await browser.newContext({ viewport: H.DESKTOP, timezoneId: timeZone, acceptDownloads: true });
  const person = { ctx, page: await ctx.newPage() };
  await openMenu(person);
  await person.page.getByRole("menuitem", { name: "Schedule…" }).click();
  await dialog(person).waitFor();
  const out = await plan(person, { title: "Zone check", date, time, minutes });
  const google = new URL(out.google);
  const outlook = new URL(out.outlook);
  const ics = Object.fromEntries(parseIcs((await downloadIcs(person)).text).filter(([name]) => name.startsWith("DT")));
  const label = `${timeZone} ${date} ${time} +${minutes} min${note ? ` (${note})` : ""}`;
  H.ok(
    `${label}: Google gets ${startUtc}/${endUtc}`,
    google.searchParams.get("dates") === `${startUtc}/${endUtc}`,
    google.searchParams.get("dates"),
  );
  H.ok(
    `${label}: Outlook gets the same instants`,
    basic(new Date(outlook.searchParams.get("startdt"))) === startUtc && basic(new Date(outlook.searchParams.get("enddt"))) === endUtc,
    `${outlook.searchParams.get("startdt")} to ${outlook.searchParams.get("enddt")}`,
  );
  H.ok(`${label}: the .ics has the same instants, in UTC`, ics.DTSTART === startUtc && ics.DTEND === endUtc, `${ics.DTSTART} to ${ics.DTEND}`);
  // The other way round: that instant, read on a clock in that zone, is the time that was typed.
  H.ok(
    `${label}: that start is ${date} ${time} on a clock there`,
    wallClock(fromBasic(startUtc), timeZone) === `${date} ${time}`,
    wallClock(fromBasic(startUtc), timeZone),
  );
  H.ok(`${label}: the end is ${minutes} minutes after the start`, fromBasic(endUtc) - fromBasic(startUtc) === minutes * 60000);
  await ctx.close();
}

module.exports = async function schedule(browser) {
  console.log("\n— schedule for later —");
  const ada = await H.client(browser, { scale: 2 });
  await ada.ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});

  /* --------------------------------------------------------- the home page */
  await openMenu(ada);
  H.ok(
    "New meeting's arrow offers Get a link for later and Schedule… (the button itself starts now)",
    (await ada.page.getByRole("menuitem").allInnerTexts()).map((text) => text.trim()).join("|") === "Get a link for later|Schedule…",
    (await ada.page.getByRole("menuitem").allInnerTexts()).join("|"),
  );
  await H.shot(ada, "schedule-menu-desktop");

  await ada.page.getByRole("menuitem", { name: "Get a link for later" }).click();
  await dialog(ada).waitFor();
  const later = await dialog(ada).locator("[data-meeting-link]").getAttribute("data-meeting-link");
  const laterCode = later.split("/").pop();
  H.ok("Get a link for later shows a meeting link", later.startsWith(`${H.BASE}/`) && CODE.test(laterCode), later);
  H.ok("…without taking you into the meeting", ada.page.url() === `${H.BASE}/`);
  await H.shot(ada, "schedule-link-desktop");
  await dialog(ada).locator("[data-meeting-link]").click();
  H.ok("…and Copy link confirms in place", await H.until(async () => (await dialog(ada).locator("[data-meeting-link]").innerText()).includes("Copied"), 3000));
  H.ok(
    "the calendar form is one step away",
    (await dialog(ada).getByLabel("Date").count()) === 0 && (await dialog(ada).getByRole("button", { name: "Add to calendar…" }).count()) === 1,
  );
  await ada.page.keyboard.press("Escape");
  await dialog(ada).waitFor({ state: "detached" });

  // Whoever made the link is its host when they come back to it, as with "New meeting".
  await ada.page.goto(later);
  await ada.page.getByLabel("Your name").waitFor();
  H.ok(
    "the browser that made the link is the meeting's host",
    await H.until(async () => (await ada.page.getByText("You're the host when you join from this browser").count()) === 1, 8000),
  );

  /* ------------------------------------------------------------- Schedule… */
  await openMenu(ada);
  await ada.page.getByRole("menuitem", { name: "Schedule…" }).click();
  await dialog(ada).waitFor();
  H.ok("Schedule… opens on the form", (await dialog(ada).getByLabel("Date").count()) === 1);
  const defaults = {
    date: await dialog(ada).getByLabel("Date").inputValue(),
    time: await dialog(ada).getByLabel("Starts").inputValue(),
    minutes: await dialog(ada).getByLabel("Length").inputValue(),
  };
  const offered = new Date(`${defaults.date}T${defaults.time}:00`);
  H.ok(
    "it offers the next half hour, for 30 minutes",
    defaults.minutes === "30" && offered.getMinutes() % 30 === 0 && offered - Date.now() > 0 && offered - Date.now() <= 36 * 60000,
    JSON.stringify(defaults),
  );
  await H.shot(ada, "schedule-form-desktop");

  // An awkward title: commas, a semicolon, a quote, an ampersand, a plus, an accent, a backslash.
  const title = 'Design review, Q4; "plans" & R+D \\ café';
  const out = await plan(ada, { title, date: "2027-06-15", time: "14:30", minutes: 45 });
  const code = out.link.split("/").pop();
  const start = new Date("2027-06-15T14:30:00"); // the test browser runs in this process's time zone
  const end = new Date(start.getTime() + 45 * 60000);
  H.ok("the form is for a fresh meeting link", out.link.startsWith(`${H.BASE}/`) && CODE.test(code) && code !== laterCode, out.link);

  const google = new URL(out.google);
  H.ok(
    "Google: the event template on calendar.google.com",
    google.origin === "https://calendar.google.com" && google.pathname === "/calendar/render" && google.searchParams.get("action") === "TEMPLATE",
    `${google.origin}${google.pathname}`,
  );
  H.ok("Google: the title, exactly", google.searchParams.get("text") === title, google.searchParams.get("text"));
  H.ok("Google: start and end in UTC", google.searchParams.get("dates") === `${basic(start)}/${basic(end)}`, google.searchParams.get("dates"));
  H.ok(
    "Google: the meeting link as the location and in the description",
    google.searchParams.get("location") === out.link && google.searchParams.get("details").includes(out.link),
  );
  H.ok("no link encodes a space as a plus sign", !/\+/.test(out.google.replace(/%2B/g, "")) && !/\+/.test(out.outlook.replace(/%2B/g, "")));

  for (const [name, href, host] of [
    ["Outlook.com", out.outlook, "outlook.live.com"],
    ["Microsoft 365", out.work, "outlook.office.com"],
  ]) {
    const url = new URL(href);
    H.ok(
      `${name}: the compose link on ${host}`,
      url.hostname === host &&
        url.pathname === "/calendar/0/deeplink/compose" &&
        url.searchParams.get("rru") === "addevent" &&
        url.searchParams.get("path") === "/calendar/action/compose",
      `${url.hostname}${url.pathname}`,
    );
    H.ok(
      `${name}: title, start and end in UTC, and the link`,
      url.searchParams.get("subject") === title &&
        url.searchParams.get("startdt") === start.toISOString().slice(0, 19) + "Z" &&
        url.searchParams.get("enddt") === end.toISOString().slice(0, 19) + "Z" &&
        url.searchParams.get("location") === out.link &&
        url.searchParams.get("body").includes(out.link),
      `${url.searchParams.get("startdt")} to ${url.searchParams.get("enddt")}`,
    );
  }
  H.ok(
    "the calendar links open in a new tab, as plain links",
    (await dialog(ada).getByRole("link", { name: "Google Calendar" }).getAttribute("target")) === "_blank" &&
      ((await dialog(ada).getByRole("link", { name: "Google Calendar" }).getAttribute("rel")) || "").includes("noopener"),
  );

  const file = await downloadIcs(ada);
  const lines = parseIcs(file.text);
  const names = lines.map(([name, value]) => (name === "BEGIN" || name === "END" ? `${name}:${value}` : name));
  const value = (name) => (lines.find(([key]) => key === name) || [])[1];
  H.ok("ics: saved as a .ics file named after the title", /^design-review-q4-plans-r-d-caf\.ics$/.test(file.name), file.name);
  H.ok(
    "ics: every line ends CRLF and none is longer than 75 bytes",
    !/[^\r]\n/.test(file.text) && file.text.endsWith("\r\n") && file.text.split("\r\n").every((line) => Buffer.byteLength(line) <= 75),
    `longest ${Math.max(...file.text.split("\r\n").map((line) => Buffer.byteLength(line)))} bytes`,
  );
  H.ok(
    "ics: one calendar holding one event holding one alarm, properly nested",
    names.join(" ") ===
      "BEGIN:VCALENDAR VERSION PRODID CALSCALE METHOD BEGIN:VEVENT UID DTSTAMP DTSTART DTEND SUMMARY DESCRIPTION LOCATION URL BEGIN:VALARM ACTION DESCRIPTION TRIGGER END:VALARM END:VEVENT END:VCALENDAR",
    names.join(" "),
  );
  H.ok("ics: version 2.0 with a product id", value("VERSION") === "2.0" && value("PRODID").length > 0);
  H.ok("ics: start and end in UTC", value("DTSTART") === basic(start) && value("DTEND") === basic(end), `${value("DTSTART")} to ${value("DTEND")}`);
  H.ok("ics: a UTC time stamp and an id of its own", /^\d{8}T\d{6}Z$/.test(value("DTSTAMP")) && value("UID").includes(code) && value("UID").includes("@"), value("UID"));
  H.ok("ics: the title survives escaping", unescapeIcs(value("SUMMARY")) === title && value("SUMMARY").includes("\\,") && value("SUMMARY").includes("\\;"), value("SUMMARY"));
  H.ok(
    "ics: the meeting link is the location, the URL, and in the description",
    unescapeIcs(value("LOCATION")) === out.link && value("URL") === out.link && unescapeIcs(value("DESCRIPTION")).includes(out.link),
  );
  H.ok("ics: a reminder ten minutes before", value("TRIGGER") === "-PT10M" && value("ACTION") === "DISPLAY");

  // A title left empty still makes an entry.
  const untitled = await plan(ada, { title: "", date: "2027-06-15", time: "14:30", minutes: 30 });
  H.ok("an empty title becomes \"Meetly meeting\"", new URL(untitled.google).searchParams.get("text") === "Meetly meeting");

  // A time that has passed is refused, there and then.
  await dialog(ada).getByLabel("Date").fill("2020-01-01");
  const alert = dialog(ada).getByRole("alert");
  await alert.waitFor({ timeout: 3000 }).catch(() => {});
  H.ok("a past date is refused inline", (await alert.innerText().catch(() => "")).includes("has passed"));
  H.ok(
    "…and nothing can be added to a calendar until it is fixed",
    (await dialog(ada).locator('a[aria-disabled="true"]').count()) === 3 &&
      (await dialog(ada).locator("a[href]").count()) === 0 &&
      (await dialog(ada).getByRole("button", { name: /^Download \.ics/ }).isDisabled()),
  );
  await H.shot(ada, "schedule-past-desktop");
  await ada.page.keyboard.press("Escape");

  /* ------------------------------------------------ time zones and the clocks changing */
  await checkZone(browser, { timeZone: "Asia/Kolkata", date: "2027-06-15", time: "09:00", minutes: 60, startUtc: "20270615T033000Z", endUtc: "20270615T043000Z", note: "UTC+5:30" });
  await checkZone(browser, { timeZone: "America/Los_Angeles", date: "2027-01-20", time: "17:15", minutes: 30, startUtc: "20270121T011500Z", endUtc: "20270121T014500Z", note: "the UTC date is the next day" });
  // New York, the night the clocks go forward (02:00 becomes 03:00 on 14 March 2027): a meeting
  // from 01:00 for 90 minutes ends at 03:30 by the clock, and is still 90 minutes long.
  await checkZone(browser, { timeZone: "America/New_York", date: "2027-03-14", time: "01:00", minutes: 90, startUtc: "20270314T060000Z", endUtc: "20270314T073000Z", note: "clocks go forward during it" });
  await checkZone(browser, { timeZone: "America/New_York", date: "2027-03-14", time: "09:00", minutes: 30, startUtc: "20270314T130000Z", endUtc: "20270314T133000Z", note: "first morning of summer time" });
  // London, the night they go back (02:00 becomes 01:00 on 31 October 2027).
  await checkZone(browser, { timeZone: "Europe/London", date: "2027-10-31", time: "00:30", minutes: 120, startUtc: "20271030T233000Z", endUtc: "20271031T013000Z", note: "clocks go back during it" });
  await checkZone(browser, { timeZone: "Europe/London", date: "2027-10-31", time: "09:00", minutes: 60, startUtc: "20271031T090000Z", endUtc: "20271031T100000Z", note: "first morning of winter time" });

  /* ------------------------------------------------- in the call, and after it */
  // While the meeting runs, the people a calendar entry would be sent to are in it: More has no
  // calendar item. The host is offered a follow-up on the screen after leaving, on the same link.
  const url = await H.createMeeting(ada);
  await H.join(ada, url, "Ada Lovelace");
  await ada.page.getByRole("button", { name: "More options" }).click();
  await ada.page.getByRole("menu").waitFor();
  H.ok("in a call, More has no calendar item and no second copy of the link", (await ada.page.getByRole("menuitem", { name: /calendar|Copy meeting link/i }).count()) === 0);
  await ada.page.keyboard.press("Escape");
  await H.leaveButton(ada).click();
  await ada.page.getByText("You left the meeting").waitFor();
  // It is a row of the "Keep from this meeting" card, not one of the two buttons for leaving.
  const keep = ada.page.getByRole("region", { name: "Keep from this meeting" });
  H.ok("the follow-up is offered in the card of things to keep, as Schedule", (await keep.getByRole("button", { name: "Schedule a follow-up" }).innerText()).trim() === "Schedule");
  await keep.getByRole("button", { name: "Schedule a follow-up" }).click();
  await dialog(ada).waitFor();
  H.ok(
    "after the meeting, the host can schedule a follow-up on the same link",
    (await dialog(ada).getByRole("heading", { name: "Schedule a follow-up" }).count()) === 1 &&
      (await dialog(ada).locator("[data-meeting-link]").getAttribute("data-meeting-link")) === url &&
      (await dialog(ada).getByLabel("Date").count()) === 1,
  );
  const weekOn = await ada.page.evaluate(() => {
    const d = new Date(Date.now() + 5 * 60_000);
    d.setMinutes(Math.ceil(d.getMinutes() / 30) * 30, 0, 0);
    d.setDate(d.getDate() + 7);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  H.ok("a follow-up starts a week on", (await dialog(ada).getByLabel("Date").inputValue()) === weekOn, `${await dialog(ada).getByLabel("Date").inputValue()} vs ${weekOn}`);
  await H.shot(ada, "schedule-follow-up-desktop");
  await ada.page.keyboard.press("Escape");
  await ada.ctx.close();
  // A guest is not offered it: the link, and the role of sending it, are the host's.
  {
    const host = await H.client(browser);
    const guest = await H.client(browser);
    const meeting = await H.createMeeting(host);
    await H.join(host, meeting, "Hal Host");
    await H.join(guest, meeting, "Gus Guest");
    await H.leaveButton(guest).click();
    await guest.page.getByText("You left the meeting").waitFor();
    H.ok("a guest's leave screen does not offer a follow-up", (await guest.page.getByRole("button", { name: "Schedule a follow-up" }).count()) === 0);
    await host.ctx.close();
    await guest.ctx.close();
  }

  /* ------------------------------------------------------------------ phone */
  const mo = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  await openMenu(mo);
  await H.shot(mo, "schedule-menu-phone");
  H.ok("phone: the menu fits", await H.noOverflow(mo));
  await mo.page.getByRole("menuitem", { name: "Schedule…" }).click();
  await dialog(mo).waitFor();
  await H.shot(mo, "schedule-form-phone");
  H.ok("phone: the form fits the screen", await H.noOverflow(mo));
  const box = await dialog(mo).boundingBox();
  H.ok("phone: the dialog is inside the screen", box.x >= 0 && box.x + box.width <= H.PHONE.width && box.y >= 0 && box.y + box.height <= H.PHONE.height, JSON.stringify(box));
  const ics = dialog(mo).getByRole("button", { name: /^Download \.ics/ });
  await ics.scrollIntoViewIfNeeded();
  const icsBox = await ics.boundingBox();
  H.ok("phone: the last control can be reached by scrolling", icsBox.y >= 0 && icsBox.y + icsBox.height <= H.PHONE.height && icsBox.x + icsBox.width <= H.PHONE.width);
  await H.shot(mo, "schedule-form-end-phone");
  await mo.page.keyboard.press("Escape");
  const phoneUrl = await H.createMeeting(mo);
  await H.join(mo, phoneUrl, "Mo Phone");
  await H.leaveButton(mo).click();
  await mo.page.getByRole("button", { name: "Schedule a follow-up" }).click();
  await dialog(mo).waitFor();
  H.ok("phone: the follow-up dialog fits", (await H.noOverflow(mo)) && (await dialog(mo).getByLabel("Date").count()) === 1);
  await H.shot(mo, "schedule-follow-up-phone");
  await mo.ctx.close();
};
