// Two phone-layout repairs to "ask to join": the waiting card's second line wraps instead of
// being cut off, and the notification that someone is asking is not stacked with the invite card:
// the card steps aside for it (somebody asking is the answer to "share the link").
const H = require("./lib.cjs");

module.exports = async function fixes(browser) {
  console.log("\n— phone repairs to ask-to-join —");
  const host = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  const guest = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  const url = await H.createMeeting(host);
  await H.join(host, url, "Hana Host");
  H.ok("the host switches the meeting to ask-to-join", (await H.hostApi(host, { token: host.token, action: "access", access: "ask" })) === 200);
  const card = host.page.locator("[data-invite-card]");
  await card.waitFor({ timeout: 8000 });

  await H.press(guest, url, "Bartholomew Featherstonehaugh", "Ask to join");
  const line = guest.page.getByText(/^You'll join as Bartholomew/);
  await line.waitFor({ timeout: 15000 });
  const text = await line.evaluate((el) => ({
    clipped: el.scrollWidth > el.clientWidth + 1,
    overflow: getComputedStyle(el).textOverflow,
    lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
    inside: el.getBoundingClientRect().right <= window.innerWidth,
  }));
  H.ok("the waiting card's second line wraps onto more lines, nothing cut off", !text.clipped && text.overflow !== "ellipsis" && text.lines >= 2 && text.inside, JSON.stringify(text));
  H.ok("the waiting screen still fits a 390 px phone", await H.noOverflow(guest));
  await H.shot(guest, "fix-asking-card-phone");

  const knock = host.page.locator("[data-toast]").filter({ hasText: "wants to join" });
  await knock.waitFor({ timeout: 15000 });
  await H.sleep(500);
  await card.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  const box = await knock.boundingBox();
  H.ok("the invite card steps aside for the request to join, so the two never stack", (await card.count()) === 0);
  H.ok("the request sits at the top, with Admit within reach", box.y < 140 && box.y + box.height <= H.PHONE.height && (await knock.getByRole("button", { name: "Admit" }).count()) === 1 && (await H.noOverflow(host)), `notification at ${Math.round(box.y)}`);
  await H.shot(host, "fix-knock-and-invite-phone");
  // Answered, and the host is alone again: the card comes back.
  await knock.getByRole("button", { name: "Deny" }).click();
  H.ok("once nobody is waiting, the invite card returns", await H.until(async () => (await card.count()) === 1, 5000));
  for (const person of [host, guest]) await person.ctx.close();
};
