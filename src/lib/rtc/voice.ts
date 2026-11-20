/**
 * Works out who is talking by listening to the audio tracks themselves.
 *
 * For a provider that only names one "active speaker", and only when that changes: it never
 * says that someone stopped, and never names you. Nothing here is played or sent anywhere; each
 * track feeds an analyser that is connected to nothing.
 */

/** How often levels are read. */
const TICK_MS = 80;
/** Root-mean-square level (0 to 1) above which a track counts as voice, about -36 dBFS. */
const LOUD = 0.016;
/** Consecutive loud readings needed before someone counts as talking: rules out a single click. */
const ONSET_TICKS = 2;
/** How long someone stays "talking" after their last loud reading: the gaps between words. */
const HOLD_MS = 450;

type Entry = {
  track: MediaStreamTrack;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  level: number;
  loudTicks: number;
  lastLoud: number;
  speaking: boolean;
};

export class VoiceMeter {
  private context: AudioContext | null = null;
  private readonly entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onChange: (key: string) => void;

  constructor(onChange: (key: string) => void) {
    this.onChange = onChange;
  }

  static available(): boolean {
    return typeof window !== "undefined" && typeof window.AudioContext === "function";
  }

  /** Starts, replaces or (with no track) stops listening under this key. */
  set(key: string, track: MediaStreamTrack | undefined): void {
    const current = this.entries.get(key);
    if (current && track && current.track.id === track.id) return;
    if (current) this.drop(key, current);
    if (!track || track.readyState === "ended") return;
    try {
      const context = (this.context ??= new AudioContext());
      // Created after the Join click, so this is allowed; a browser that still holds it back
      // lets it go on the next interaction.
      if (context.state === "suspended") void context.resume().catch(() => {});
      const source = context.createMediaStreamSource(new MediaStream([track]));
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      this.entries.set(key, {
        track,
        source,
        analyser,
        samples: new Float32Array(analyser.fftSize),
        level: 0,
        loudTicks: 0,
        lastLoud: 0,
        speaking: false,
      });
      this.timer ??= setInterval(this.tick, TICK_MS);
    } catch {
      // Without a meter this person simply never shows as talking.
    }
  }

  speaking(key: string): boolean {
    return this.entries.get(key)?.speaking ?? false;
  }

  /** Everyone talking now, loudest first. */
  loudest(): string[] {
    return Array.from(this.entries.entries())
      .filter(([, entry]) => entry.speaking)
      .sort((a, b) => b[1].level - a[1].level)
      .map(([key]) => key);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const [key, entry] of Array.from(this.entries)) this.drop(key, entry, false);
    void this.context?.close().catch(() => {});
    this.context = null;
  }

  private drop(key: string, entry: Entry, tell = true): void {
    try {
      entry.source.disconnect();
    } catch {
      // Already gone with its context.
    }
    this.entries.delete(key);
    if (entry.speaking && tell) this.onChange(key);
    if (this.entries.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private readonly tick = (): void => {
    if (this.context?.state === "suspended") void this.context.resume().catch(() => {});
    const now = Date.now();
    const changed: string[] = [];
    for (const [key, entry] of this.entries) {
      entry.analyser.getFloatTimeDomainData(entry.samples);
      let sum = 0;
      for (const sample of entry.samples) sum += sample * sample;
      const level = Math.sqrt(sum / entry.samples.length);
      // Smoothed a little, so that "loudest" does not flip between two people word by word.
      entry.level = entry.level * 0.6 + level * 0.4;
      if (level >= LOUD && !entry.track.muted && entry.track.enabled) {
        entry.loudTicks++;
        if (entry.loudTicks >= ONSET_TICKS) entry.lastLoud = now;
      } else {
        entry.loudTicks = 0;
      }
      const speaking = entry.lastLoud > 0 && now - entry.lastLoud < HOLD_MS;
      if (speaking !== entry.speaking) {
        entry.speaking = speaking;
        changed.push(key);
      }
    }
    for (const key of changed) this.onChange(key);
  };
}
