/**
 * Meetly's interaction sounds: a small family of soft, plucked tones, synthesised with the Web
 * Audio API. There are no audio files.
 *
 * The family shares one voice (a sine with two quiet upper partials and a fast, bell-like decay)
 * and one key (D major pentatonic), so every sound is recognisably "Meetly" and none can clash
 * with another. Meaning is carried by contour and register:
 *
 *   rising  = something arriving or switching on      falling = leaving or switching off
 *   low     = people coming and going                 high    = something asking for attention
 *   3 notes = about the call itself (connected, ended, connection trouble)
 *
 * This module has two halves. `SOUNDS` and `scheduleSound` are pure descriptions that work on any
 * BaseAudioContext, which is what lets a test render each sound offline and measure it. The
 * `sounds` engine underneath plays them: one shared AudioContext, unlocked by a user gesture, a
 * quiet master gain, the user's level and volume, and rate limits so a burst of events can never
 * pile sounds on top of each other.
 *
 * Nothing here touches the microphone or any published track: the graph ends at the
 * AudioContext's own destination (the speakers) and is never connected to a MediaStream.
 */

/* ------------------------------------------------------------------ the set */

/** D major pentatonic, in Hz. */
const D4 = 293.66;
const A4 = 440.0;
const B4 = 493.88;
const D5 = 587.33;
const E5 = 659.25;
const FS5 = 739.99;
const A5 = 880.0;
const B5 = 987.77;
const D6 = 1174.66;

type Note = {
  /** Fundamental, Hz. */
  f: number;
  /** Start, seconds from the beginning of the sound. */
  at: number;
  /** Peak gain of this note (before the master gain). */
  gain: number;
  /** Decay time constant, seconds. The note is about five of these long. */
  decay: number;
};

export type SoundName =
  | "connected"
  | "ended"
  | "joined"
  | "left"
  | "hand"
  | "message"
  | "micOn"
  | "micOff"
  | "shareStart"
  | "shareStop"
  | "mutedByHost"
  | "connectionLost";

export type SoundSpec = {
  notes: Note[];
  /** Total length in seconds, including the tail. */
  length: number;
  /** Important sounds still play at the "important only" level. */
  important: boolean;
  /** Least time between two plays of this sound, ms. Anything sooner is dropped, not queued. */
  minGapMs: number;
  /** What the sound means, for settings UI and documentation. */
  meaning: string;
};

const note = (f: number, at: number, gain: number, decay: number): Note => ({ f, at, gain, decay });

export const SOUNDS: Record<SoundName, SoundSpec> = {
  // The call itself: three notes.
  connected: {
    notes: [note(D5, 0, 0.42, 0.045), note(FS5, 0.075, 0.42, 0.045), note(A5, 0.15, 0.46, 0.06)],
    length: 0.34,
    important: true,
    minGapMs: 1500,
    meaning: "You are connected (also played when a lost connection comes back)",
  },
  ended: {
    notes: [note(A4, 0, 0.42, 0.05), note(FS5 / 2, 0.085, 0.4, 0.05), note(D4, 0.17, 0.42, 0.065)],
    length: 0.35,
    important: true,
    minGapMs: 1500,
    meaning: "The call ended for you: you left, or the host removed you",
  },
  connectionLost: {
    notes: [note(D4, 0, 0.44, 0.04), note(D4, 0.13, 0.4, 0.05)],
    length: 0.33,
    important: true,
    minGapMs: 5000,
    meaning: "The connection dropped and Meetly is reconnecting",
  },
  mutedByHost: {
    notes: [note(B4, 0, 0.44, 0.05), note(E5 / 2, 0.11, 0.42, 0.06)],
    length: 0.33,
    important: true,
    minGapMs: 1500,
    meaning: "The host muted your microphone",
  },

  // People: low, two notes, a fourth apart.
  joined: {
    notes: [note(A4, 0, 0.38, 0.04), note(D5, 0.085, 0.4, 0.05)],
    length: 0.27,
    important: false,
    minGapMs: 3000,
    meaning: "Someone joined",
  },
  left: {
    notes: [note(D5, 0, 0.32, 0.04), note(A4, 0.085, 0.3, 0.045)],
    length: 0.25,
    important: false,
    minGapMs: 3000,
    meaning: "Someone left",
  },

  // Attention: high and short.
  hand: {
    notes: [note(E5, 0, 0.3, 0.03), note(B5, 0.06, 0.36, 0.045)],
    length: 0.22,
    important: false,
    minGapMs: 4000,
    meaning: "Someone raised a hand",
  },
  message: {
    notes: [note(FS5, 0, 0.3, 0.035)],
    length: 0.14,
    important: false,
    minGapMs: 4000,
    meaning: "A chat message arrived while chat is closed",
  },

  // Your own microphone: the smallest sounds in the set, one grace note and one note.
  micOn: {
    notes: [note(A5, 0, 0.14, 0.012), note(D6, 0.03, 0.24, 0.022)],
    length: 0.1,
    important: false,
    minGapMs: 120,
    meaning: "Your microphone is on",
  },
  micOff: {
    notes: [note(A5, 0, 0.14, 0.012), note(D5, 0.03, 0.24, 0.024)],
    length: 0.1,
    important: false,
    minGapMs: 120,
    meaning: "Your microphone is off",
  },

  // Screen sharing: a wide, open fifth.
  shareStart: {
    notes: [note(D5, 0, 0.36, 0.04), note(A5, 0.09, 0.4, 0.055)],
    length: 0.29,
    important: false,
    minGapMs: 1500,
    meaning: "A screen share started",
  },
  shareStop: {
    notes: [note(A5, 0, 0.32, 0.04), note(D5, 0.09, 0.32, 0.05)],
    length: 0.28,
    important: false,
    minGapMs: 1500,
    meaning: "A screen share stopped",
  },
};

export const SOUND_NAMES = Object.keys(SOUNDS) as SoundName[];

/** Attack time of every note. Long enough not to click, short enough to feel immediate. */
const ATTACK = 0.006;
/** Every sound is forced to true silence over its last few milliseconds, so it cannot end on a click. */
const RELEASE = 0.012;
/** The voice: fundamental plus two quieter partials that die away faster, like a struck bar. */
const PARTIALS = [
  { ratio: 1, level: 1, decay: 1 },
  { ratio: 2, level: 0.2, decay: 0.6 },
  { ratio: 4, level: 0.06, decay: 0.35 },
] as const;

/**
 * Schedules one sound on `context`, starting at `when`, into `destination`.
 * Works on an AudioContext (to play) and an OfflineAudioContext (to render and measure).
 */
export function scheduleSound(
  context: BaseAudioContext,
  destination: AudioNode,
  name: SoundName,
  when: number = context.currentTime,
): void {
  const spec = SOUNDS[name];
  const end = when + spec.length;
  // One gain for the whole sound: it guarantees the clean fade to zero at the end.
  const out = context.createGain();
  out.gain.setValueAtTime(1, when);
  out.gain.setValueAtTime(1, end - RELEASE);
  out.gain.linearRampToValueAtTime(0, end);
  out.connect(destination);

  for (const n of spec.notes) {
    const start = when + n.at;
    for (const partial of PARTIALS) {
      const frequency = n.f * partial.ratio;
      if (frequency > 9000) continue;
      const osc = context.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(frequency, start);
      const env = context.createGain();
      env.gain.setValueAtTime(0, start);
      env.gain.linearRampToValueAtTime(n.gain * partial.level, start + ATTACK);
      env.gain.setTargetAtTime(0, start + ATTACK, n.decay * partial.decay);
      osc.connect(env).connect(out);
      osc.start(start);
      osc.stop(end + 0.005);
    }
  }
  // On a live context, drop the graph once the sound is over. (An offline render just ends.)
  if (!("startRendering" in context)) {
    setTimeout(() => out.disconnect(), (end - context.currentTime) * 1000 + 100);
  }
}

/* ----------------------------------------------------------------- settings */

/** "all": every sound. "important": only the ones you must not miss. "off": silence. */
export type SoundLevel = "all" | "important" | "off";
export type SoundSettings = { level: SoundLevel; volume: number };

export const SOUND_DEFAULTS: SoundSettings = { level: "all", volume: 0.6 };
const SETTINGS_KEY = "meetly:sounds";
/** Ceiling of the master gain: with `volume` at 1 the loudest sound peaks near -9 dBFS. */
const MASTER = 0.7;

function loadSettings(): SoundSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<SoundSettings>;
    const level = (["all", "important", "off"] as const).includes(saved.level as SoundLevel)
      ? (saved.level as SoundLevel)
      : SOUND_DEFAULTS.level;
    const volume =
      typeof saved.volume === "number" && saved.volume >= 0 && saved.volume <= 1 ? saved.volume : SOUND_DEFAULTS.volume;
    return { level, volume };
  } catch {
    return SOUND_DEFAULTS;
  }
}

/* ------------------------------------------------------------------- engine */

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

/** No two sounds of any kind start closer together than this, so they never smear into noise. */
const GLOBAL_GAP_MS = 350;

function createEngine() {
  let context: SinkContext | null = null;
  let master: GainNode | null = null;
  let settings: SoundSettings = SOUND_DEFAULTS;
  let loaded = false;
  let sinkId = "";
  let lastAny = 0;
  const lastPlayed = new Map<SoundName, number>();
  const listeners = new Set<() => void>();

  const available = () => typeof window !== "undefined" && typeof window.AudioContext !== "undefined";
  const ensureSettings = () => {
    if (loaded || typeof window === "undefined") return;
    settings = loadSettings();
    loaded = true;
  };
  const applyVolume = () => {
    if (!context || !master) return;
    // A short ramp: changing the volume while a sound rings must not click.
    master.gain.setTargetAtTime(MASTER * settings.volume, context.currentTime, 0.015);
  };
  const applySink = () => {
    if (!context?.setSinkId) return;
    // "" and "default" both mean the system default output.
    context.setSinkId(sinkId === "default" ? "" : sinkId).catch(() => {});
  };

  return {
    /**
     * Creates (or resumes) the audio context. Browsers only allow this from a user gesture, so
     * call it from a click or key handler: joining the call is the natural place.
     */
    unlock(): void {
      if (!available()) return;
      ensureSettings();
      try {
        if (!context) {
          context = new window.AudioContext({ latencyHint: "interactive" }) as SinkContext;
          master = context.createGain();
          master.gain.value = MASTER * settings.volume;
          master.connect(context.destination);
          applySink();
        }
        if (context.state === "suspended") context.resume().catch(() => {});
      } catch {
        context = null;
        master = null;
      }
    },

    /**
     * Plays a sound, unless the user's level, the rate limits or the browser say no.
     * Returns whether it actually played. Never throws and never queues: a sound that cannot
     * play now is dropped, because a late chime is worse than none.
     */
    play(name: SoundName, { preview = false }: { preview?: boolean } = {}): boolean {
      ensureSettings();
      const spec = SOUNDS[name];
      if (!preview) {
        if (settings.level === "off") return false;
        if (settings.level === "important" && !spec.important) return false;
      }
      if (!context || !master) return false;
      if (context.state !== "running") {
        // Suspended by the browser (for example after the device slept): try for next time.
        context.resume().catch(() => {});
        return false;
      }
      const now = performance.now();
      if (!preview) {
        if (now - (lastPlayed.get(name) ?? -Infinity) < spec.minGapMs) return false;
        // Important sounds and your own microphone ticks are never held back by other sounds.
        if (!spec.important && !isOwnTick(name) && now - lastAny < GLOBAL_GAP_MS) return false;
      }
      lastPlayed.set(name, now);
      if (!isOwnTick(name)) lastAny = now;
      try {
        scheduleSound(context, master, name, context.currentTime + 0.005);
        return true;
      } catch {
        return false;
      }
    },

    /** Follows the speaker the user picked for the call. No-op where the browser cannot. */
    setOutputDevice(deviceId: string): void {
      sinkId = deviceId;
      applySink();
    },

    getSettings(): SoundSettings {
      ensureSettings();
      return settings;
    },
    setSettings(patch: Partial<SoundSettings>): void {
      ensureSettings();
      settings = { ...settings, ...patch };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch {}
      applyVolume();
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Releases the audio device when the call is over. `unlock` brings it back. */
    suspend(afterMs = 600): void {
      const target = context;
      if (!target) return;
      setTimeout(() => {
        if (target.state === "running") target.suspend().catch(() => {});
      }, afterMs);
    },

    /** For tests and debugging. */
    state(): { context: AudioContextState | "none"; sinkId: string } {
      return { context: context?.state ?? "none", sinkId };
    },
  };
}

function isOwnTick(name: SoundName): boolean {
  return name === "micOn" || name === "micOff";
}

/** The one sound engine for the page. Safe to import anywhere: it does nothing until `unlock`. */
export const sounds = createEngine();
