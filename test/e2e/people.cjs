// The People list holds still while it is read (src/lib/listHold.ts), but never against the host:
// someone the host lets in shows at once, while someone else's hand still waits behind the pill.
const H = require("./lib.cjs");

module.exports = async function people(browser) {
  console.log("\n— people: a held list and your own changes —");
  const ada = await H.client(browser, { viewport: { width: 1440, height: 900 } });
  const ben = await H.client(browser);
  const cy = await H.client(browser);
  const url = await H.createMeeting(ada);
  await H.join(ada, url, "Ada Admin");
  await H.join(ben, url, "Ben Okri");
  H.ok("the host turns on asking to join", (await H.hostApi(ada, { token: ada.token, action: "access", access: "ask" })) === 200);
  await H.press(cy, url, "Cy Twombly", "Ask to join");

  await H.openPeople(ada);
  const panel = H.people(ada);
  const admit = panel.getByRole("button", { name: "Admit Cy Twombly" });
  await admit.waitFor({ timeout: 10000 });
  // Rest the pointer on the list: it holds still from here on.
  await admit.hover();
  await H.sleep(300);
  await ben.page.keyboard.press("h");
  const pill = panel.locator("[data-new-pill]");
  H.ok("held: someone else's hand waits behind the pill", await H.until(async () => (await pill.count()) === 1, 6000));
  H.ok("…and is not listed yet", (await panel.getByRole("region", { name: "Raised hands" }).count()) === 0);

  await admit.click();
  const list = panel.getByRole("list", { name: "Participants" });
  H.ok("admitting someone yourself shows them at once, with the list still held", await H.until(async () => (await list.getByText("Cy Twombly").count()) === 1, 10000));
  const counted = await list.evaluate((el) => ({ header: Number(el.querySelector("h3 span")?.textContent), rows: el.querySelectorAll('[role="listitem"]').length }));
  H.ok("…the count matches the rows", counted.header === 3 && counted.rows === 3, JSON.stringify(counted));
  H.ok("…and the pill still holds only the other person's hand", (await pill.count()) === 1 && /^1 new$/.test((await pill.innerText()).trim()), await pill.innerText().catch(() => ""));
  H.ok("the pointer never left the list", await panel.locator(".scroll-quiet").first().evaluate((el) => el.matches(":hover")));

  await Promise.all([ada, ben, cy].map((person) => person.ctx.close()));
};
