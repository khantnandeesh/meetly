// Feature 3: mute all, stop a camera, lower hands, co-host, end the call for everyone.
const H = require("./lib.cjs");

const micOff = (person) => person.page.getByRole("button", { name: "Unmute microphone" });
const camOff = (person) => person.page.getByRole("button", { name: "Turn on camera" });
const menuFor = async (person, name) => {
  await H.openPeople(person);
  await person.page.getByRole("list", { name: "Participants" }).getByRole("button", { name: `Host controls for ${name}` }).click();
};

module.exports = async function hostTools(browser) {
  console.log("\n— host tools —");
  const ada = await H.client(browser, { scale: 2 });
  const ben = await H.client(browser, { scale: 2 });
  const cy = await H.client(browser, { scale: 2 });
  const url = await H.createMeeting(ada);
  await H.join(ada, url, "Ada Lovelace");
  await H.join(ben, url, "Ben Okri");
  await H.join(cy, url, "Cy Twombly");
  await ada.page.waitForFunction(() => document.querySelectorAll("[data-tile]").length === 3, null, { timeout: 20000 });
  await H.sleep(2800);
  const [adaId, benId, cyId] = [await H.identity(ada), await H.identity(ben), await H.identity(cy)];

  /* mute all */
  await H.openPeople(ada);
  await H.shot(ada, "host-people-panel-desktop");
  await ada.page.getByRole("button", { name: "Mute everyone" }).click();
  await micOff(ben).waitFor({ timeout: 8000 }).catch(() => {});
  await micOff(cy).waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("mute all reaches every guest", (await micOff(ben).count()) === 1 && (await micOff(cy).count()) === 1);
  H.ok("mute all leaves the host's own microphone on", (await ada.page.getByRole("button", { name: "Mute microphone" }).count()) === 1);
  H.ok("each muted guest is told once, the way a single mute tells them", (await ben.page.getByText("The host muted your microphone").count()) === 1);
  H.ok("the host gets one confirmation", (await ada.page.getByText("You muted everyone").count()) === 1);
  await ben.page.getByRole("button", { name: "Unmute microphone" }).click();
  H.ok("a muted guest can unmute again (nobody is forced silent)", await H.until(async () => (await micOff(ben).count()) === 0, 5000));

  /* stop one camera */
  await menuFor(ada, "Ben Okri");
  await H.shot(ada, "host-menu-desktop");
  await ada.page.getByRole("menuitem", { name: "Turn off camera" }).click();
  await camOff(ben).waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("stopping a camera reaches that person", (await camOff(ben).count()) === 1);
  H.ok("…and they are told why", await H.until(async () => (await ben.page.getByText("The host turned off your camera").count()) === 1, 4000));
  H.ok("…and nobody else's camera is touched", (await camOff(cy).count()) === 0);
  await ben.page.getByRole("button", { name: "Turn on camera" }).click();
  H.ok("they can turn it back on themselves", await H.until(async () => (await camOff(ben).count()) === 0, 8000));
  await ada.page.getByRole("button", { name: "Dismiss notification" }).first().click().catch(() => {});

  /* lower hands */
  await ben.page.keyboard.press("h");
  await cy.page.keyboard.press("h");
  const hands = (person) => person.page.evaluate(() => window.__meetly.call.participants().filter((p) => p.handRaised).length);
  await H.until(async () => (await hands(ada)) === 2, 6000);
  await menuFor(ada, "Ben Okri");
  await ada.page.getByRole("menuitem", { name: "Lower hand" }).click();
  H.ok("lowering one hand lowers that hand only", await H.until(async () => (await hands(ada)) === 1 && (await hands(ben)) === 1, 6000));
  await ben.page.keyboard.press("h");
  await H.until(async () => (await hands(ada)) === 2, 6000);
  await ada.page.getByRole("button", { name: "More actions for everyone" }).click();
  await H.shot(ada, "host-more-actions-desktop");
  await ada.page.getByRole("menuitem", { name: "Lower all hands" }).click();
  H.ok(
    "lower all hands reaches every client",
    await H.until(async () => (await hands(ada)) === 0 && (await hands(ben)) === 0 && (await hands(cy)) === 0, 6000),
  );
  H.ok("…and each person's own hand button is back to Raise hand", (await ben.page.getByRole("button", { name: "Raise hand" }).count()) === 1);

  /* co-host */
  H.ok("a guest cannot make themselves co-host", (await H.hostApi(ben, { token: ben.token, action: "coHost", identity: benId, on: true })) === 403);
  await menuFor(ada, "Ben Okri");
  await ada.page.getByRole("menuitem", { name: "Make co-host" }).click();
  H.ok("the new co-host is told", await H.until(async () => (await ben.page.getByText("You're now a co-host").count()) === 1, 6000));
  await H.openPeople(ben);
  await H.openPeople(cy);
  H.ok("the co-host gets the moderation controls", await H.until(() => H.hostControlsShown(ben), 4000));
  H.ok("everyone is shown who the co-host is", await H.until(async () => (await H.people(cy).getByText("Co-host").count()) === 1, 4000));
  H.ok("the co-host has no controls for the host", (await ben.page.getByRole("button", { name: "Host controls for Ada Lovelace" }).count()) === 0);
  await H.shot(ben, "cohost-people-panel-desktop");
  const asBen = { token: ben.token };
  const refused = {
    end: await H.hostApi(ben, { ...asBen, action: "end" }),
    coHostOther: await H.hostApi(ben, { ...asBen, action: "coHost", identity: cyId, on: true }),
    muteHost: await H.hostApi(ben, { ...asBen, action: "mute", identity: adaId }),
    removeHost: await H.hostApi(ben, { ...asBen, action: "remove", identity: adaId }),
  };
  H.ok("a co-host cannot end the call, make co-hosts, or act on the host", Object.values(refused).every((status) => status === 403), JSON.stringify(refused));
  H.ok("a third person is still just a guest", (await H.hostApi(cy, { token: cy.token, action: "muteAll" })) === 403 && !(await H.hostControlsShown(cy)));

  // The co-host removes someone; that person cannot walk back in.
  await menuFor(ben, "Cy Twombly");
  await ben.page.getByRole("menuitem", { name: "Remove from meeting" }).click();
  await H.shot(ben, "remove-dialog-desktop");
  await ben.page.getByRole("button", { name: "Remove from meeting", exact: true }).click();
  await cy.page.getByText("The host removed you").waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("a co-host can remove someone", (await cy.page.getByText("The host removed you").count()) === 1);
  await H.shot(cy, "removed-screen-desktop");
  H.ok("the removed person is not offered a way back", (await cy.page.getByRole("button", { name: "Rejoin" }).count()) === 0);
  await cy.page.goto(url);
  await H.press(cy, url, "Cy Twombly");
  await cy.page.getByRole("alert").filter({ hasText: "The host removed you from this meeting." }).waitFor({ timeout: 8000 }).catch(() => {});
  H.ok(
    "the removed person cannot rejoin: the server refuses them",
    cy.tokenStatus === 403 && (await cy.page.getByText("The host removed you from this meeting.").count()) === 1 && !(await H.isInCall(cy)),
    `token route answered ${cy.tokenStatus}`,
  );
  await H.shot(cy, "removed-refused-desktop");
  H.ok("…and their old token no longer moderates or counts as in the room", (await H.hostApi(cy, { token: cy.token, action: "muteAll" })) === 403);
  H.ok("the call carries on without them", await H.until(() => ada.page.evaluate(() => window.__meetly.call.participants().length === 2), 5000));

  // Taking co-host away again.
  await menuFor(ada, "Ben Okri");
  await ada.page.getByRole("menuitem", { name: "Remove as co-host" }).click();
  H.ok("a co-host who is demoted loses the controls and the server's say-so", await H.until(async () => !(await H.hostControlsShown(ben)) && (await H.hostApi(ben, asBen.token ? { ...asBen, action: "muteAll" } : {})) === 403, 6000));

  /* end the call for everyone */
  const dee = await H.client(browser);
  await H.join(dee, url, "Dee Late");
  await H.closePeople(ada);
  await ada.page.getByRole("button", { name: "More ways to leave" }).click();
  await H.shot(ada, "leave-menu-desktop");
  await ada.page.getByRole("menuitem", { name: "End meeting for everyone" }).click();
  await ada.page.getByRole("dialog").getByText("End the meeting for everyone?").waitFor();
  await H.shot(ada, "end-dialog-desktop");
  await ada.page.getByRole("button", { name: "End meeting", exact: true }).click();
  await ben.page.getByText("The host ended the meeting").waitFor({ timeout: 8000 }).catch(() => {});
  await dee.page.getByText("The host ended the meeting").waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("ending the call reaches every client", (await ben.page.getByText("The host ended the meeting").count()) === 1 && (await dee.page.getByText("The host ended the meeting").count()) === 1);
  H.ok("the host is told it was their doing", await H.until(async () => (await ada.page.getByText("You ended the meeting").count()) === 1, 6000));
  await H.shot(ben, "ended-screen-desktop");
  // The meeting can be started again by the same host, and by nobody else.
  await ben.page.getByRole("button", { name: "Rejoin" }).click();
  await H.join(ben, url, "Ben Okri");
  await ada.page.getByRole("button", { name: "Start again" }).click();
  await H.join(ada, url, "Ada Lovelace");
  await H.openPeople(ada);
  await H.openPeople(ben);
  await ada.page.getByRole("button", { name: "Host controls for Ben Okri" }).waitFor({ timeout: 8000 }).catch(() => {});
  H.ok("after ending, the same host is host of the next call, and the first person back is not", (await H.hostControlsShown(ada)) && !(await H.hostControlsShown(ben)));

  /* phone: everything reachable */
  const mo = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  const phoneUrl = await H.createMeeting(mo);
  await H.join(mo, phoneUrl, "Mo Phone");
  const pat = await H.client(browser);
  await H.join(pat, phoneUrl, "Pat Guest");
  await H.sleep(1500);
  await H.openPeople(mo);
  await H.shot(mo, "host-people-panel-phone");
  H.ok("phone: the people sheet holds the host's tools without overflowing", (await mo.page.getByRole("button", { name: "Mute everyone" }).count()) === 1 && (await H.noOverflow(mo)));
  await mo.page.getByRole("list", { name: "Participants" }).getByRole("button", { name: "Host controls for Pat Guest" }).click();
  await H.shot(mo, "host-menu-phone");
  await mo.page.getByRole("menuitem", { name: "Mute microphone" }).click();
  H.ok("phone: muting from the sheet's menu works", await H.until(async () => (await micOff(pat).count()) === 1, 6000));
  await H.closePeople(mo);
  await mo.page.getByRole("button", { name: "More options" }).click();
  const endItem = mo.page.getByRole("menuitem", { name: "End meeting for everyone" });
  await endItem.scrollIntoViewIfNeeded();
  await H.shot(mo, "more-menu-end-phone");
  H.ok("phone: End meeting for everyone is in the More menu", (await endItem.count()) === 1);
  await endItem.click();
  await H.shot(mo, "end-dialog-phone");
  await mo.page.getByRole("button", { name: "End meeting", exact: true }).click();
  H.ok("phone: ending from the More menu ends it for the guest", await H.until(async () => (await pat.page.getByText("The host ended the meeting").count()) === 1, 8000));
  await H.shot(mo, "ended-screen-host-phone");

  for (const person of [ada, ben, cy, dee, mo, pat]) await person.ctx.close();
};
