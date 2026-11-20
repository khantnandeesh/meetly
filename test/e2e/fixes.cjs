// Two phone-layout repairs to "ask to join": the waiting card's second line wraps instead of
// being cut off, and the notification that someone is asking does not cover the invite card.
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
  const a = await card.boundingBox();
  const b = await knock.boundingBox();
  const apart = b.y >= a.y + a.height || a.y >= b.y + b.height;
  H.ok("the asking notification does not cover the invite card", apart, `card ${Math.round(a.y)}–${Math.round(a.y + a.height)}, notification ${Math.round(b.y)}–${Math.round(b.y + b.height)}`);
  H.ok("both are on screen, with Admit within reach", b.y + b.height <= H.PHONE.height && (await knock.getByRole("button", { name: "Admit" }).count()) === 1 && (await H.noOverflow(host)));
  await H.shot(host, "fix-knock-and-invite-phone");
  await card.getByRole("button", { name: "Dismiss invite reminder" }).click();
  await card.waitFor({ state: "detached" });
  await H.sleep(300);
  const moved = await knock.boundingBox();
  H.ok("with the card gone the notification returns to the top", moved.y < b.y, `${Math.round(b.y)} → ${Math.round(moved.y)}`);
  for (const person of [host, guest]) await person.ctx.close();
};
