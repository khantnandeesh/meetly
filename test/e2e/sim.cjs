// The synthetic crowd shared by the browser tests that need more people than a test machine can
// run (notices.cjs, perf.cjs). One real host sits in a real call; the crowd is pushed through
// the call's own events (the provider-neutral RtcCall on window.__meetly, which needs
// localStorage meetly:debug=1), so the interface sees exactly what an adapter would send it.
// The call's list methods are shadowed on the instance so the UI reads the crowd from them.
// Nothing here touches a server, and nothing here proves how a real server copes with that many
// people.
//
// Both functions run inside the page: pass them to `page.evaluate` (or `addInitScript` for
// `watch`), never call them in Node.

/** Installs window.__sim on a page that is in a call. */
const install = () => {
  const call = window.__meetly.call;
  const real = {
    participants: call.participants.bind(call),
    remoteIds: call.remoteIds.bind(call),
    participant: call.participant.bind(call),
    tiles: call.tiles.bind(call),
    waiting: call.waiting.bind(call),
    chat: call.chatMessages.bind(call),
  };
  const fake = new Map();
  let waiters = [];
  let chat = [];
  let roster = null;
  let tiles = null;
  let chatCache = null;
  let chatBase = null;
  let seq = 0;
  // The people a real crowd would bring: same shape as an RtcParticipant from an adapter.
  const person = () => {
    const n = seq++;
    const listeners = new Set();
    return {
      identity: `sim-${n}`,
      isLocal: false,
      name: `Person ${n}`,
      role: "speaker",
      micOn: false,
      camOn: false,
      handRaised: false,
      speaking: false,
      weakConnection: false,
      subscribe(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      notify() {
        listeners.forEach((l) => l());
      },
    };
  };
  call.participants = () => (roster ??= [...real.participants(), ...fake.values()]);
  call.remoteIds = () => [...real.remoteIds(), ...fake.keys()];
  call.participant = (id) => fake.get(id) || real.participant(id);
  call.tiles = () => (tiles ??= [...real.tiles(), ...[...fake.values()].map((p) => ({ participant: p, source: "camera" }))]);
  call.waiting = () => (waiters.length ? waiters : real.waiting());
  call.chatMessages = () => {
    const base = real.chat();
    if (!chat.length) return base;
    if (chatCache && chatBase === base) return chatCache;
    chatBase = base;
    return (chatCache = [...base, ...chat]);
  };
  const changed = () => {
    roster = null;
    tiles = null;
    call.emit("roster");
    call.emit("tiles");
  };
  const reactions = ["👍", "❤️", "😂", "😮", "👏", "🎉"];
  window.__sim = {
    /** How many synthetic people are in the call. */
    count: () => fake.size,
    join(n) {
      for (let i = 0; i < n; i++) {
        const p = person();
        fake.set(p.identity, p);
        changed();
        call.emit("participantJoined", p);
      }
    },
    /** The earliest arrivals leave first. */
    leave(n) {
      for (const id of [...fake.keys()].slice(0, n)) {
        const p = fake.get(id);
        fake.delete(id);
        changed();
        call.emit("participantLeft", p);
      }
    },
    hands(n) {
      for (const p of [...fake.values()].filter((x) => !x.handRaised).slice(0, n)) {
        p.handRaised = true;
        p.notify();
        roster = null;
        call.emit("roster");
        call.emit("handRaised", p);
      }
    },
    lowerHands() {
      for (const p of fake.values()) {
        if (!p.handRaised) continue;
        p.handRaised = false;
        p.notify();
      }
      changed();
    },
    knock(n) {
      for (let i = 0; i < n; i++) {
        const p = person();
        waiters = [...waiters, { id: p.identity, name: p.name, since: Date.now() }];
        call.emit("waiting");
      }
    },
    clearKnocks() {
      waiters = [];
      call.emit("waiting");
    },
    chat(n, text) {
      for (let i = 0; i < n; i++) {
        chatCache = null;
        chat = [...chat, { id: `sim-chat-${seq++}`, timestamp: Date.now(), message: text || `Message ${seq}`, from: { identity: "sim-x", name: "Sam Sender", isLocal: false } }];
        call.emit("chat");
      }
    },
    /** Reactions from the crowd, round-robin over people and emoji. Needs someone in the call. */
    react(n) {
      const people = [...fake.values()];
      for (let i = 0; i < n && people.length; i++) {
        call.emit("reaction", people[(seq + i) % people.length], reactions[(seq + i) % reactions.length]);
      }
      seq += n;
    },
    mutedByHost() {
      call.emit("localMic", false);
    },
    /** Your connection reads as poor from now on (the weak-connection banner follows after its hold). */
    poorConnection() {
      const quality = { ...call.quality(), connection: "poor" };
      call.quality = () => quality;
      call.emit("quality");
    },
  };
};

/**
 * Watches the notifications and the main thread from inside the page: how many notifications
 * are up and whether they cover the controls (sampled every 100 ms), long tasks, frame gaps,
 * and layout shift. `reset()` starts the counts again, so the cost of joining is left out.
 */
const watch = () => {
  const st = { samples: [], long: [], frames: [], cls: 0, shifts: [] };
  try {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => st.long.push(e.duration))).observe({ type: "longtask" });
  } catch {}
  // Layout shift as Chromium scores it for CLS: shifts right after your own input do not count.
  try {
    new PerformanceObserver((l) =>
      l.getEntries().forEach((e) => {
        if (e.hadRecentInput) return;
        st.cls += e.value;
        st.shifts.push({
          value: +e.value.toFixed(4),
          at: Math.round(e.startTime),
          nodes: (e.sources || []).map((s) => {
            const n = s.node;
            if (!n || n.nodeType !== 1) return n?.nodeName || "?";
            return `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}${n.getAttribute("aria-label") ? `[${n.getAttribute("aria-label")}]` : ""}${typeof n.className === "string" && n.className ? `.${n.className.split(/\s+/).slice(0, 3).join(".")}` : ""}`;
          }),
        });
      }),
    ).observe({ type: "layout-shift" });
  } catch {}
  let last = performance.now();
  const tick = (t) => {
    st.frames.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const leave = () => [...document.querySelectorAll("button")].find((b) => /^Leave (call|meeting)$/.test(b.getAttribute("aria-label") || ""));
  const timer = setInterval(() => {
    const toasts = [...document.querySelectorAll("[data-toast]")].filter((t) => t.dataset.leaving !== "true");
    const bar = leave()?.getBoundingClientRect().top ?? Infinity;
    const low = Math.max(0, ...toasts.map((t) => t.getBoundingClientRect().bottom));
    st.samples.push({
      n: toasts.length,
      covers: low > bar - 2,
      gap: Math.round(bar - low),
      detail: low > bar - 2 ? JSON.stringify({ bar: Math.round(bar), toasts: toasts.map((t) => [t.querySelector(".toast-title")?.textContent, Math.round(t.getBoundingClientRect().top), Math.round(t.getBoundingClientRect().bottom), getComputedStyle(t).transform, t.getAnimations().map((a) => a.animationName || "js")]), region: getComputedStyle(document.querySelector(".toast-region")).translate }) : "",
      titles: toasts.map((t) => t.querySelector(".toast-title")?.textContent || ""),
    });
  }, 100);
  window.__watch = {
    read: () => {
      const frames = st.frames.slice().sort((a, b) => a - b);
      const q = (p) => (frames.length ? Math.round(frames[Math.min(frames.length - 1, Math.floor(p * frames.length))]) : 0);
      return {
        maxShown: Math.max(0, ...st.samples.map((s) => s.n)),
        coveredControls: st.samples.some((s) => s.covers),
        detail: st.samples.find((s) => s.detail)?.detail || "",
        closest: Math.min(...st.samples.filter((s) => s.n > 0).map((s) => s.gap)),
        titles: [...new Set(st.samples.flatMap((s) => s.titles))],
        longest: Math.round(Math.max(0, ...st.long)),
        longTotal: Math.round(st.long.reduce((a, b) => a + b, 0)),
        longCount: st.long.length,
        cls: +st.cls.toFixed(4),
        // The biggest shifts first, so a failure names what moved.
        shifts: st.shifts
          .slice()
          .sort((a, b) => b.value - a.value)
          .slice(0, 5),
        frames: frames.length,
        frameP95: q(0.95),
        frameMax: q(1),
      };
    },
    reset: () => {
      st.samples = [];
      st.long = [];
      st.frames = [];
      st.cls = 0;
      st.shifts = [];
    },
    stop: () => clearInterval(timer),
  };
};

module.exports = { install, watch };
