// Feature 5: noise suppression and background blur.
//
// Runs in a browser of its own, whose fake microphone plays steady noise and whose fake camera
// shows a finely patterned picture, both from files made here. With those, "is the noise being
// removed" and "is the picture being blurred" can be measured on what another client receives,
// not read off a switch.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const H = require("./lib.cjs");

/** Ten seconds of white noise, 48 kHz mono 16-bit: about as loud as a fan close to a microphone. */
function noiseFile() {
  const rate = 48000;
  const samples = rate * 10;
  const data = Buffer.alloc(samples * 2);
  let seed = 12345;
  for (let i = 0; i < samples; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data.writeInt16LE(Math.round(((seed / 0x7fffffff) * 2 - 1) * 0.12 * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "meetly-noise-")), "noise.wav");
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

/**
 * A camera picture full of detail at two scales (16-pixel blocks, each with a 4-pixel
 * checkerboard), 1280x720 like a real webcam, as a raw video file Chromium can play as its
 * camera. There is nobody in it, so with blur on all of it is background.
 */
function patternFile(dir) {
  const width = 1280;
  const height = 720;
  let seed = 4242;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const columns = width / 16;
  const rows = height / 16;
  const blocks = Array.from({ length: columns * rows }, () => ({ y: 50 + Math.floor(random() * 150), u: 100 + Math.floor(random() * 56), v: 100 + Math.floor(random() * 56) }));
  const luma = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const block = blocks[Math.floor(y / 16) * columns + Math.floor(x / 16)];
      luma[y * width + x] = block.y + (((x >> 2) + (y >> 2)) % 2 ? 28 : -28);
    }
  }
  const chroma = (key) => {
    const plane = Buffer.alloc((width / 2) * (height / 2));
    for (let y = 0; y < height / 2; y++) {
      for (let x = 0; x < width / 2; x++) plane[y * (width / 2) + x] = blocks[Math.floor(y / 8) * columns + Math.floor(x / 8)][key];
    }
    return plane;
  };
  const frame = Buffer.concat([Buffer.from("FRAME\n"), luma, chroma("u"), chroma("v")]);
  const file = path.join(dir, "pattern.y4m");
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F20:1 Ip A1:1 C420jpeg\n`), frame, frame, frame]));
  return file;
}

const effects = (person) => person.page.evaluate(() => window.__meetly.call.localEffects());

/** What is really on the wire for the microphone: the processor, the track being sent, and how it was opened. */
const microphone = (person) =>
  person.page.evaluate(() => {
    const publication = window.__meetly.room.localParticipant.getTrackPublication("microphone");
    const track = publication && publication.track;
    if (!track) return null;
    const processor = track.getProcessor();
    const raw = (processor && processor.input) || track.mediaStreamTrack;
    return {
      processor: processor ? processor.name : null,
      // The track handed to the peer connection is the filter's output, not the microphone.
      sendsFiltered: !!processor && !!track.sender && track.sender.track === processor.processedTrack,
      sendsRaw: !!track.sender && track.sender.track === raw,
      browserSuppression: raw.getSettings().noiseSuppression,
    };
  });

const camera = (person) =>
  person.page.evaluate(() => {
    const publication = window.__meetly.room.localParticipant.getTrackPublication("camera");
    const track = publication && publication.track;
    if (!track) return null;
    const processor = track.getProcessor();
    return {
      processor: processor ? processor.name : null,
      sendsBlurred: !!processor && !!track.sender && track.sender.track === processor.processedTrack,
      muted: track.isMuted,
      // How the blur itself is doing: picture size, and the time it takes to draw a frame.
      stats: processor && processor.pipeline ? processor.pipeline.stats : null,
    };
  });

/** Energy of `name`'s microphone as this client received it over `ms`, per second (RTCRtpReceiver stats). */
async function receivedLoudness(person, name, ms = 2500) {
  const read = () =>
    person.page.evaluate(async (who) => {
      const room = window.__meetly.room;
      const from = Array.from(room.remoteParticipants.values()).find((p) => p.name === who);
      const track = from && from.getTrackPublication("microphone") && from.getTrackPublication("microphone").track;
      if (!track || !track.receiver) return null;
      let found = null;
      (await track.receiver.getStats()).forEach((report) => {
        if (report.type === "inbound-rtp") found = { energy: report.totalAudioEnergy, seconds: report.totalSamplesDuration };
      });
      return found;
    }, name);
  const before = await read();
  await H.sleep(ms);
  const after = await read();
  if (!before || !after) return NaN;
  return (after.energy - before.energy) / Math.max(0.001, after.seconds - before.seconds);
}
const decibels = (ratio) => `${(10 * Math.log10(ratio)).toFixed(1)} dB`;

/**
 * How much fine detail there is in `name`'s picture as this client sees it: the mean difference
 * between neighbouring pixels, on a fixed-size copy of the frame. Blur lowers it.
 */
async function detail(person, name) {
  const one = () =>
    person.page.evaluate((who) => {
      const tile = Array.from(document.querySelectorAll('[data-tile][data-source="camera"]')).find((el) =>
        (el.getAttribute("aria-label") || "").startsWith(who),
      );
      const video = tile && tile.querySelector("video");
      if (!video || video.videoWidth === 0) return null;
      const w = 640;
      const h = 360;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(video, 0, 0, w, h);
      const px = context.getImageData(0, 0, w, h).data;
      let sum = 0;
      for (let y = 0; y < h - 1; y++) {
        for (let x = 0; x < w - 1; x++) {
          const i = (y * w + x) * 4;
          const luma = px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11;
          const right = px[i + 4] * 0.3 + px[i + 5] * 0.59 + px[i + 6] * 0.11;
          const below = px[i + w * 4] * 0.3 + px[i + w * 4 + 1] * 0.59 + px[i + w * 4 + 2] * 0.11;
          sum += Math.abs(luma - right) + Math.abs(luma - below);
        }
      }
      return { detail: sum / (w * h), width: video.videoWidth, height: video.videoHeight };
    }, name);
  // The fake camera's picture moves; a few frames give a steadier number than one.
  const samples = [];
  let size = "";
  for (let i = 0; i < 5; i++) {
    const sample = await one();
    if (sample) {
      samples.push(sample.detail);
      size = `${sample.width}x${sample.height}`;
    }
    await H.sleep(200);
  }
  samples.sort((a, b) => a - b);
  return { detail: samples.length ? samples[Math.floor(samples.length / 2)] : NaN, size };
}

/** Frames a second of `name`'s camera as this client decodes it, and as the sender encodes its top layer. */
async function receivedFps(person, name, ms = 4000) {
  const read = () =>
    person.page.evaluate(async (who) => {
      const from = Array.from(window.__meetly.room.remoteParticipants.values()).find((p) => p.name === who);
      const track = from && from.getTrackPublication("camera") && from.getTrackPublication("camera").track;
      if (!track || !track.receiver) return null;
      let frames = null;
      (await track.receiver.getStats()).forEach((report) => {
        if (report.type === "inbound-rtp") frames = report.framesDecoded;
      });
      return { frames, at: performance.now() };
    }, name);
  const before = await read();
  await H.sleep(ms);
  const after = await read();
  if (!before || !after) return NaN;
  return ((after.frames - before.frames) * 1000) / (after.at - before.at);
}
async function sentFps(person, ms = 4000) {
  const read = () =>
    person.page.evaluate(async () => {
      const track = window.__meetly.room.localParticipant.getTrackPublication("camera").track;
      let frames = 0;
      (await track.sender.getStats()).forEach((report) => {
        if (report.type === "outbound-rtp") frames = Math.max(frames, report.framesEncoded || 0);
      });
      return { frames, at: performance.now() };
    });
  const before = await read();
  await H.sleep(ms);
  const after = await read();
  return ((after.frames - before.frames) * 1000) / (after.at - before.at);
}

const audioMenu = async (person) => {
  await person.page.getByRole("button", { name: "Audio settings" }).click();
  return person.page.getByRole("menuitemcheckbox", { name: /^Noise suppression/ });
};
const videoMenu = async (person) => {
  await person.page.getByRole("button", { name: "Video settings" }).click();
  await person.page.getByRole("menuitemradio", { name: "Blur", exact: true }).waitFor();
};
const closeMenu = async (person) => {
  await person.page.keyboard.press("Escape");
  await person.page.getByRole("menu").waitFor({ state: "detached" }).catch(() => {});
};

module.exports = async function effectsSuite() {
  console.log("\n— noise suppression and background blur —");
  const noise = noiseFile();
  const browser = await H.launch([`--use-file-for-fake-audio-capture=${noise}`, `--use-file-for-fake-video-capture=${patternFile(path.dirname(noise))}`]);
  try {
    await run(browser);
  } finally {
    await browser.close();
  }
};

async function run(browser) {
  const ada = await H.client(browser, { scale: 2 });
  const ben = await H.client(browser);
  const url = await H.createMeeting(ada);
  await H.join(ada, url, "Ada Lovelace");
  await H.join(ben, url, "Ben Okri");
  await ada.page.waitForFunction(() => document.querySelectorAll("[data-tile]").length === 2, null, { timeout: 20000 });

  /* ------------------------------------------------------ noise suppression */
  H.ok("noise suppression is on by default", (await effects(ada)).noiseSuppression === true);
  H.ok(
    "…and our filter is really running on the microphone",
    await H.until(async () => (await effects(ada)).noiseState === "enhanced", 15000),
    JSON.stringify(await effects(ada)),
  );
  let mic = await microphone(ada);
  H.ok(
    "the track being sent is the filter's output, with the browser's own suppression on underneath",
    mic && mic.processor === "meetly-noise" && mic.sendsFiltered && mic.browserSuppression === true,
    JSON.stringify(mic),
  );
  await H.sleep(4000); // the filter takes a few seconds to learn what the noise is
  const loudOn = await receivedLoudness(ben, "Ada Lovelace");

  const noiseSwitch = await audioMenu(ada);
  H.ok("the microphone menu has a Noise suppression switch, shown on", (await noiseSwitch.getAttribute("aria-checked")) === "true");
  await H.shot(ada, "effects-noise-menu-desktop");
  await noiseSwitch.click();
  H.ok("switching it off shows it off, in the same menu", (await noiseSwitch.getAttribute("aria-checked")) === "false");
  await H.shot(ada, "effects-noise-off-desktop");
  await closeMenu(ada);
  H.ok("off: nothing is filtering", await H.until(async () => (await effects(ada)).noiseState === "off", 8000));
  mic = await microphone(ada);
  H.ok(
    "off: the track being sent is the microphone itself, opened without the browser's suppression",
    mic && mic.processor === null && mic.sendsRaw && mic.browserSuppression === false,
    JSON.stringify(mic),
  );
  await H.sleep(2500);
  const loudOff = await receivedLoudness(ben, "Ada Lovelace");
  H.ok(
    "what the other person receives is far quieter with suppression on than off (steady noise)",
    loudOff > 0 && loudOn < loudOff / 10,
    `noise is ${decibels(loudOn / loudOff)} with suppression on (energy/s ${loudOn.toExponential(2)} on, ${loudOff.toExponential(2)} off)`,
  );

  // The choice is kept: reload, come back, and it is still off, on the wire too.
  await ada.page.reload();
  await H.join(ada, url, "Ada Lovelace");
  await H.sleep(3000);
  H.ok("after a reload the switch is still off", (await effects(ada)).noiseSuppression === false);
  mic = await microphone(ada);
  H.ok(
    "…and the microphone is published unfiltered from the start",
    mic && mic.processor === null && mic.browserSuppression === false,
    JSON.stringify(mic),
  );
  const again = await audioMenu(ada);
  H.ok("…and the menu shows it off", (await again.getAttribute("aria-checked")) === "false");
  await again.click();
  await closeMenu(ada);
  H.ok("switching it back on brings the filter back", await H.until(async () => (await effects(ada)).noiseState === "enhanced", 15000));
  mic = await microphone(ada);
  H.ok(
    "…with the filtered track on the wire again",
    mic && mic.processor === "meetly-noise" && mic.sendsFiltered && mic.browserSuppression === true,
    JSON.stringify(mic),
  );

  // Muting and unmuting keeps it.
  await ada.page.getByRole("button", { name: "Mute microphone" }).click();
  await ada.page.getByRole("button", { name: "Unmute microphone" }).click();
  await H.sleep(1500);
  mic = await microphone(ada);
  H.ok("the filter survives muting and unmuting", mic && mic.processor === "meetly-noise" && mic.sendsFiltered, JSON.stringify(mic));

  /* ------------------------------------------------------- background blur */
  await ben.page.waitForFunction(() => document.querySelectorAll("[data-tile] video").length >= 1, null, { timeout: 20000 });
  await H.sleep(3000);
  const sharp = await detail(ben, "Ada Lovelace");
  const fpsBefore = { sent: await sentFps(ada), received: await receivedFps(ben, "Ada Lovelace") };
  H.ok("no blur by default", (await effects(ada)).background === "none" && (await camera(ada)).processor === null);

  await videoMenu(ada);
  H.ok(
    "the camera menu offers None, Slight blur and Blur",
    (await ada.page.getByRole("menuitemradio", { name: "None", exact: true }).count()) === 1 &&
      (await ada.page.getByRole("menuitemradio", { name: "Slight blur", exact: true }).count()) === 1,
  );
  await ada.page.getByRole("menuitemradio", { name: "Blur", exact: true }).click();
  H.ok("choosing Blur turns it on", await H.until(async () => (await effects(ada)).backgroundState === "on", 30000), JSON.stringify(await effects(ada)));
  await H.shot(ada, "effects-blur-menu-desktop");
  await closeMenu(ada);
  let cam = await camera(ada);
  H.ok("the track being sent is the blurred one", cam && cam.processor === "meetly-blur" && cam.sendsBlurred, JSON.stringify(cam));
  H.ok("your own tile is marked as blurred", (await ada.page.locator("[data-blur-badge]").count()) === 1);
  await H.sleep(3500);
  const blurred = await detail(ben, "Ada Lovelace");
  H.ok(
    "the other person's picture of you loses its detail",
    blurred.detail < sharp.detail * 0.4,
    `detail ${sharp.detail.toFixed(2)} (${sharp.size}) → ${blurred.detail.toFixed(2)} (${blurred.size}) with blur`,
  );
  await H.shot(ben, "effects-blur-seen-by-other-desktop");
  const fpsBlur = { sent: await sentFps(ada), received: await receivedFps(ben, "Ada Lovelace") };
  const stats = (await camera(ada)).stats;
  H.ok(
    "the frame rate holds with blur on",
    fpsBlur.sent >= 12 && fpsBlur.sent >= fpsBefore.sent * 0.8 && fpsBlur.received >= fpsBefore.received * 0.8,
    `sent ${fpsBefore.sent.toFixed(1)} → ${fpsBlur.sent.toFixed(1)} fps, received ${fpsBefore.received.toFixed(1)} → ${fpsBlur.received.toFixed(1)} fps; ` +
      `drawing a ${stats.width}x${stats.height} frame takes ${stats.drawMs.toFixed(1)} ms of the ${stats.frameMs.toFixed(0)} ms there is`,
  );

  // Slight blur is in between.
  await videoMenu(ada);
  await ada.page.getByRole("menuitemradio", { name: "Slight blur", exact: true }).click();
  await closeMenu(ada);
  await H.sleep(3000);
  const slight = await detail(ben, "Ada Lovelace");
  H.ok(
    "Slight blur blurs less than Blur",
    slight.detail > blurred.detail * 1.2 && slight.detail < sharp.detail * 0.8,
    `detail ${slight.detail.toFixed(2)} (none ${sharp.detail.toFixed(2)}, blur ${blurred.detail.toFixed(2)})`,
  );

  // Camera off and on again: still blurred, and never a sharp frame in between.
  await ada.page.getByRole("button", { name: "Turn off camera" }).click();
  await ada.page.getByRole("button", { name: "Turn on camera" }).click();
  await H.sleep(3000);
  cam = await camera(ada);
  H.ok("blur survives turning the camera off and on", cam && cam.processor === "meetly-blur" && cam.sendsBlurred && !cam.muted, JSON.stringify(cam));
  const afterToggle = await detail(ben, "Ada Lovelace");
  H.ok("…and the picture is still blurred for the other person", afterToggle.detail < sharp.detail * 0.8, `detail ${afterToggle.detail.toFixed(2)}`);

  await videoMenu(ada);
  await ada.page.getByRole("menuitemradio", { name: "None", exact: true }).click();
  await closeMenu(ada);
  H.ok("None turns it off", await H.until(async () => (await effects(ada)).backgroundState === "off", 8000));
  cam = await camera(ada);
  H.ok("the camera itself is being sent again", cam && cam.processor === null, JSON.stringify(cam));
  await H.sleep(3500);
  const restored = await detail(ben, "Ada Lovelace");
  H.ok(
    "the other person's picture gets its detail back",
    restored.detail > sharp.detail * 0.8,
    `detail ${restored.detail.toFixed(2)} (was ${sharp.detail.toFixed(2)} before blur)`,
  );
  H.ok("the mark on your tile goes", (await ada.page.locator("[data-blur-badge]").count()) === 0);

  /* ------------------------------------------- chosen before joining, kept */
  const cy = await H.client(browser, { scale: 2 });
  await cy.page.goto(url);
  await cy.page.getByLabel("Your name").fill("Cy Twombly");
  await cy.page.getByRole("button", { name: /^(Mute|Unmute) microphone$/ }).waitFor();
  const blurToggle = cy.page.getByRole("button", { name: "Blur background" });
  H.ok("pre-join: there is a Blur background button, off", (await blurToggle.getAttribute("aria-pressed")) === "false");
  await blurToggle.click();
  H.ok("pre-join: pressing it turns it on", (await blurToggle.getAttribute("aria-pressed")) === "true");
  H.ok(
    "pre-join: the preview becomes the blurred picture",
    await H.until(async () => (await cy.page.locator("[data-blur-status]").count()) === 0, 30000),
  );
  await H.shot(cy, "effects-prejoin-blur-desktop");
  await cy.page.getByRole("button", { name: "Join now" }).click();
  await H.inCall(cy);
  // The first time the camera is seen published at all, it must already be the blurred track.
  await H.until(async () => (await camera(cy)) !== null, 20000, 50);
  cam = await camera(cy);
  H.ok(
    "joining with blur chosen publishes the camera already blurred",
    cam && cam.processor === "meetly-blur" && cam.sendsBlurred && (await H.until(async () => (await effects(cy)).backgroundState === "on", 5000)),
    JSON.stringify(cam),
  );
  await H.sleep(3500);
  const cySeen = await detail(ben, "Cy Twombly");
  H.ok("…which is what the others see", cySeen.detail < sharp.detail * 0.4, `detail ${cySeen.detail.toFixed(2)}`);
  await cy.page.reload();
  await cy.page.getByRole("button", { name: /^(Mute|Unmute) microphone$/ }).waitFor();
  H.ok(
    "the choice is remembered on the pre-join screen next time",
    (await cy.page.getByRole("button", { name: "Blur background" }).getAttribute("aria-pressed")) === "true",
  );
  await cy.ctx.close();

  /* ------------------------------------------------- when it cannot be done */
  // A browser that cannot capture a canvas cannot blur: the control is absent before joining
  // and says why in the call.
  const old = await H.client(browser);
  await old.ctx.addInitScript(() => {
    delete HTMLCanvasElement.prototype.captureStream;
  });
  await old.page.goto(url);
  await old.page.getByLabel("Your name").fill("Old Browser");
  await old.page.getByRole("button", { name: /^(Mute|Unmute) microphone$/ }).waitFor();
  H.ok("unsupported browser: no Blur button before joining", (await old.page.getByRole("button", { name: "Blur background" }).count()) === 0);
  await old.page.getByRole("button", { name: "Join now" }).click();
  await H.inCall(old);
  await old.page.getByRole("button", { name: "Video settings" }).click();
  await old.page.getByRole("menu").waitFor();
  H.ok(
    "unsupported browser: the camera menu says blur is not available, and offers no choices",
    (await old.page.getByRole("menuitem", { name: /can't blur the background/ }).count()) === 1 &&
      (await old.page.getByRole("menuitemradio", { name: "Blur", exact: true }).count()) === 0,
  );
  await H.shot(old, "effects-blur-unsupported-desktop");
  await closeMenu(old);
  await old.ctx.close();

  // The model cannot be fetched: an error, and the camera carries on unblurred.
  const dee = await H.client(browser);
  await dee.ctx.route("**/effects/*.tflite", (route) => route.abort());
  await H.join(dee, url, "Dee Offline");
  await videoMenu(dee);
  await dee.page.getByRole("menuitemradio", { name: "Blur", exact: true }).click();
  const failure = dee.page.locator("[data-toast]").filter({ hasText: "Couldn't start background blur" });
  await failure.waitFor({ timeout: 20000 }).catch(() => {});
  H.ok("when blur cannot start, it says so", (await failure.count()) === 1);
  await closeMenu(dee);
  await H.shot(dee, "effects-blur-failed-desktop");
  cam = await camera(dee);
  const fx = await effects(dee);
  H.ok(
    "…and the camera stays on, unblurred, with the setting back at None",
    cam && cam.processor === null && !cam.muted && fx.background === "none" && fx.backgroundState === "off",
    JSON.stringify({ cam, fx }),
  );
  await dee.ctx.close();

  /* ------------------------------------------------------------------ phone */
  const mo = await H.client(browser, { viewport: H.PHONE, scale: 2, touch: true });
  await mo.page.goto(url);
  await mo.page.getByLabel("Your name").fill("Mo Phone");
  await mo.page.getByRole("button", { name: /^(Mute|Unmute) microphone$/ }).waitFor();
  H.ok("phone: the Blur button is on the pre-join preview", (await mo.page.getByRole("button", { name: "Blur background" }).count()) === 1);
  await H.shot(mo, "effects-prejoin-phone");
  H.ok("phone: the pre-join screen fits", await H.noOverflow(mo));
  await mo.page.getByRole("button", { name: "Join now" }).click();
  await H.inCall(mo);
  await mo.page.getByRole("button", { name: "More options" }).click();
  // On a phone the device settings are one level down in More, and first in it.
  await mo.page.getByRole("menu").waitFor();
  H.ok("phone: Audio and video is the first item in More", /^Audio and video/.test((await mo.page.locator("[role=menu] [role^=menuitem]").first().innerText()).trim()));
  await mo.page.getByRole("menuitem", { name: "Audio and video" }).click();
  const phoneSwitch = mo.page.getByRole("menuitemcheckbox", { name: /^Noise suppression/ });
  await phoneSwitch.scrollIntoViewIfNeeded();
  H.ok("phone: More, Audio and video has the Noise suppression switch", (await phoneSwitch.count()) === 1 && (await phoneSwitch.getAttribute("aria-checked")) === "true");
  await H.shot(mo, "effects-noise-menu-phone");
  const phoneBlur = mo.page.getByRole("menuitemradio", { name: "Blur", exact: true });
  await phoneBlur.scrollIntoViewIfNeeded();
  H.ok("phone: More has the Background choices", (await phoneBlur.count()) === 1);
  await phoneBlur.click();
  H.ok("phone: Blur can be turned on from there", await H.until(async () => (await effects(mo)).backgroundState === "on", 30000));
  await H.shot(mo, "effects-blur-menu-phone");
  H.ok("phone: nothing overflows with the menu open", await H.noOverflow(mo));
  await closeMenu(mo);
  await H.shot(mo, "effects-blur-on-phone");

  for (const person of [ada, ben, mo]) await person.ctx.close();
}
