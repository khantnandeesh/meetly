// Feature 1: the host survives a reload, and nobody else can take the role.
const H = require("./lib.cjs");

module.exports = async function hostSurvives(browser) {
  console.log("\n— host that survives a reload —");
  const ada = await H.client(browser, { scale: 2 });
  const ben = await H.client(browser);
  const url = await H.createMeeting(ada);
  const code = url.split("/").pop();

  // Before anyone has joined, the creating browser is already known as the host.
  await ada.page.getByText("You're the host when you join from this browser").waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("the creator's pre-join screen says they are the host", (await ada.page.getByText("You're the host when you join from this browser").count()) === 1);
  await H.shot(ada, "host-prejoin-desktop");

  // A guest who gets there first does not become host.
  await H.join(ben, url, "Ben Guest");
  await H.openPeople(ben);
  H.ok("a guest who arrives before the creator is not host", !(await H.hostControlsShown(ben)) && (await H.people(ben).getByText("Host", { exact: true }).count()) === 0);
  await H.join(ada, url, "Ada Host");
  await H.openPeople(ada);
  await ada.page.getByRole("button", { name: "Host controls for Ben Guest" }).waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("the creator is host when they join, even second", await H.hostControlsShown(ada));
  H.ok("the guest is shown who the host is", await H.until(async () => (await H.people(ben).getByText("Host", { exact: true }).count()) === 1));
  const adaFirstId = await H.identity(ada);

  // Guest endpoints: every moderation action answers 403 for a guest's own, valid token.
  const benId = await H.identity(ben);
  const asGuest = { token: ben.token };
  const statuses = {};
  for (const body of [
    { action: "mute", identity: adaFirstId },
    { action: "remove", identity: adaFirstId },
    { action: "stopCamera", identity: adaFirstId },
    { action: "lowerHand", identity: adaFirstId },
    { action: "admit", identity: "someone" },
    { action: "deny", identity: "someone" },
    { action: "muteAll" },
    { action: "lowerAllHands" },
    { action: "end" },
    { action: "access", access: "locked" },
    { action: "coHost", identity: benId, on: true },
    { action: "lobby" },
  ]) {
    statuses[body.action] = await H.hostApi(ben, { ...asGuest, ...body });
  }
  H.ok("a guest calling any host endpoint gets 403", Object.values(statuses).every((status) => status === 403), JSON.stringify(statuses));
  H.ok("no token at all is a bad request", (await H.hostApi(ben, { action: "end" })) === 400);
  const tampered = `${ada.token.slice(0, -4)}abcd`;
  H.ok("a tampered host token is refused", (await H.hostApi(ben, { token: tampered, action: "muteAll" })) === 403);
  // Things a browser can write about itself must not help.
  await ben.page.evaluate(async () => {
    const me = window.__meetly.room.localParticipant;
    await me.setMetadata(JSON.stringify({ host: me.identity, cohosts: [me.identity] })).catch(() => {});
    await me.setAttributes({ host: me.identity, cohost: "1" }).catch(() => {});
  });
  await H.sleep(600);
  H.ok(
    "a guest writing 'host' into their own metadata and attributes gains nothing",
    (await H.hostApi(ben, { ...asGuest, action: "muteAll" })) === 403 && !(await H.hostControlsShown(ben)),
  );
  // A made-up pass cookie is not a host key.
  const eve = await H.client(browser);
  await eve.ctx.addCookies([{ name: `meetly.${code}`, value: "eyJjIjoiZm9yZ2VkIn0.Zm9yZ2Vk", url: H.BASE }]);
  await H.join(eve, url, "Eve Forger");
  await H.openPeople(eve);
  H.ok("a forged host cookie does not make a host", !(await H.hostControlsShown(eve)) && (await H.hostApi(eve, { token: eve.token, action: "muteAll" })) === 403);
  await eve.ctx.close();

  // The guest reloads: still a guest.
  await ben.page.reload();
  await H.join(ben, url, "Ben Guest");
  await H.openPeople(ben);
  await H.sleep(800);
  H.ok("a guest who reloads does not become host", !(await H.hostControlsShown(ben)) && (await H.hostApi(ben, { token: ben.token, action: "muteAll" })) === 403);

  // The host reloads: host again, as a new connection.
  await ada.page.reload();
  await H.join(ada, url, "Ada Host");
  await H.openPeople(ada);
  await ada.page.getByRole("button", { name: "Host controls for Ben Guest" }).waitFor({ timeout: 8000 }).catch(() => {});
  const adaSecondId = await H.identity(ada);
  H.ok("the host is host again after a reload", (await H.hostControlsShown(ada)) && adaSecondId !== adaFirstId);
  H.ok("the server agrees: the reloaded host's token is accepted", (await H.hostApi(ada, { token: ada.token, action: "lowerAllHands" })) === 200);
  H.ok(
    "the guest sees the crown move to the host's new connection",
    await H.until(() => ben.page.evaluate((id) => window.__meetly.call.hostIdentity === id, adaSecondId)),
  );
  await H.shot(ada, "host-after-reload-desktop");

  // The host leaves entirely; whoever is left, and whoever rejoins, is still not host.
  await ada.page.getByRole("button", { name: "Leave meeting" }).click();
  await ada.page.getByText("You left the meeting").waitFor();
  await ben.page.reload();
  await H.join(ben, url, "Ben Guest");
  await H.openPeople(ben);
  await H.sleep(800);
  H.ok("with the host away, a guest rejoining still does not become host", !(await H.hostControlsShown(ben)) && (await H.hostApi(ben, { token: ben.token, action: "muteAll" })) === 403);
  // …and the host walks back in as host.
  await ada.page.getByRole("button", { name: "Rejoin" }).click();
  await H.join(ada, url, "Ada Host");
  await H.openPeople(ada);
  await ada.page.getByRole("button", { name: "Host controls for Ben Guest" }).waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("the host who left and came back is host again", await H.hostControlsShown(ada));

  // A code typed by hand has no record: first in is host, and stays host across a reload.
  const cy = await H.client(browser);
  const dee = await H.client(browser);
  const typed = `${H.BASE}/${H.randomCode()}`;
  await H.join(cy, typed, "Cy First");
  await H.join(dee, typed, "Dee Second");
  await H.openPeople(cy);
  await H.sleep(500);
  H.ok("a hand-typed code: the first person in is host", await H.hostControlsShown(cy));
  await cy.page.reload();
  await H.join(cy, typed, "Cy First");
  await H.openPeople(cy);
  await cy.page.getByRole("button", { name: "Host controls for Dee Second" }).waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("a hand-typed code: that host also survives a reload", await H.hostControlsShown(cy));
  await H.openPeople(dee);
  H.ok("a hand-typed code: the second person is a guest", !(await H.hostControlsShown(dee)));

  for (const person of [ada, ben, cy, dee]) await person.ctx.close();
};
