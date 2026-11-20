// "How was the call?" on the screen you see after leaving: one tap, and nothing sent anywhere.
const H = require("./lib.cjs");

const rating = (person) => person.page.locator("[data-call-rating]");

module.exports = async function ratingSuite(browser) {
  console.log("\n— leave screen: a one-tap rating that sends nothing —");
  const host = await H.client(browser, { scale: 2 });
  const guest = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  const gone = await H.client(browser);
  const url = await H.createMeeting(host);
  await H.join(host, url, "Hana Host");
  await H.join(guest, url, "Gus Guest");
  await H.join(gone, url, "Rex Removed");

  // Everything the two pages ask of the network from here on.
  const requests = [];
  for (const person of [host, guest]) person.page.on("request", (request) => requests.push(`${request.method()} ${new URL(request.url()).pathname}`));
  for (const person of [host, guest]) {
    await person.page.evaluate(() => {
      window.__beacons = 0;
      const send = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = (...args) => (window.__beacons++, send(...args));
    });
  }

  await guest.page.getByRole("button", { name: "Leave call" }).tap();
  await guest.page.getByText("You left the meeting").waitFor();
  await rating(guest).waitFor();
  H.ok("the leave screen asks how the call was, with two answers", /How was the call\?/.test(await rating(guest).innerText()) && (await rating(guest).getByRole("button").count()) === 2);
  const sizes = await rating(guest).getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
  H.ok("on a 390 px phone it fits and the answers are at least 44 px tall", (await H.noOverflow(guest)) && sizes.every((height) => height >= 44), sizes.join());
  await H.shot(guest, "rating-phone");
  const stored = () => guest.page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort()) + document.cookie);
  const before = await stored();
  requests.length = 0;
  await rating(guest).getByRole("button", { name: "Good", exact: true }).tap();
  H.ok("one tap answers it, and it does not ask again", (await H.until(async () => /Thanks/.test(await rating(guest).innerText()), 3000)) && (await rating(guest).getByRole("button").count()) === 0);
  await H.sleep(1500);
  H.ok("answering sends nothing: no request, no beacon", requests.length === 0 && (await guest.page.evaluate(() => window.__beacons)) === 0, requests.join(", "));
  H.ok("and keeps nothing in the browser", (await stored()) === before);

  await host.page.locator("[data-in-call]").getByRole("button", { name: "Leave call" }).first().click();
  await host.page.getByText("You left the meeting").waitFor();
  await H.shot(host, "rating-desktop");
  requests.length = 0;
  await rating(host).getByRole("button", { name: "Not good" }).click();
  await H.sleep(1000);
  H.ok("the other answer behaves the same", /Thanks/.test(await rating(host).innerText()) && requests.length === 0, requests.join(", "));

  // Someone who was turned away is not asked to rate the call.
  await host.page.getByRole("button", { name: "Rejoin" }).click();
  await H.join(host, url, "Hana Host");
  const target = await H.identity(gone);
  H.ok("the host removes someone", (await H.hostApi(host, { token: host.token, action: "remove", identity: target })) === 200);
  await gone.page.getByText("The host removed you").waitFor({ timeout: 8000 });
  H.ok("someone the host removed is not asked how the call was", (await rating(gone).count()) === 0);

  for (const person of [host, guest, gone]) await person.ctx.close();
};
