/**
 * Temporal layers, as the header describes them (SPEC §4.2, §9.2). The source uses this to fill
 * `refDelta` and the DISCARDABLE flag; the jitter buffer uses the pattern only to tell a frame
 * that was never sent (a layer above this viewer's cap) from one that was lost, for its
 * statistics. Nothing here decides what can be decoded: that is `refDelta` alone.
 */

/** How many temporal layers a WebCodecs scalability mode has. "L1T3" is 3; anything unknown is 1. */
export function temporalLayerCount(scalability: string | undefined): number {
  const match = /^L\d+T(\d+)/.exec(scalability ?? "");
  const count = match ? Number(match[1]) : 1;
  return count >= 1 && count <= 8 ? count : 1;
}

/**
 * The temporal layer of the frame `keyDelta` frames after its keyframe, for the dyadic patterns
 * WebCodecs produces: T2 is 0 1 0 1, T3 is 0 2 1 2. Null when the pattern is not known.
 */
export function expectedTemporalLayer(scalability: string | undefined, keyDelta: number): number | null {
  const layers = temporalLayerCount(scalability);
  if (layers === 1) return 0;
  if (layers > 3 || keyDelta < 0) return null;
  const period = 1 << (layers - 1);
  const position = keyDelta % period;
  if (position === 0) return 0;
  let layer = layers - 1;
  for (let step = position; step % 2 === 0; step >>= 1) layer--;
  return layer;
}

/**
 * Tracks, as the source's encoder emits frames, which earlier frame each one needs (SPEC §9.2):
 * layer 0 needs the layer-0 frame before it, and a higher layer needs the nearest earlier frame
 * of a lower layer. A keyframe needs none and starts a GOP.
 */
export class DependencyTracker {
  private lastKey = -1;
  /** The newest frame id of each temporal layer in this GOP. */
  private readonly newest: (number | undefined)[] = [];

  constructor(private readonly layers: number) {}

  /** The header fields that follow from a frame's place in the stream. Call once per frame, in order. */
  next(frameId: number, key: boolean, temporal: number): { temporal: number; refDelta: number; keyDelta: number; discardable: boolean } {
    const layer = Math.max(0, Math.min(this.layers - 1, temporal));
    if (key || this.lastKey < 0) {
      this.lastKey = frameId;
      this.newest.length = 0;
      this.newest[0] = frameId;
      return { temporal: 0, refDelta: 0, keyDelta: 0, discardable: false };
    }
    let ref = -1;
    if (layer === 0) ref = this.newest[0] ?? this.lastKey;
    else for (let lower = 0; lower < layer; lower++) ref = Math.max(ref, this.newest[lower] ?? -1);
    if (ref < 0) ref = this.lastKey;
    this.newest[layer] = frameId;
    // A higher layer that came before this frame can no longer be needed by anything after it.
    for (let higher = layer + 1; higher < this.layers; higher++) this.newest[higher] = undefined;
    return { temporal: layer, refDelta: frameId - ref, keyDelta: frameId - this.lastKey, discardable: this.layers > 1 && layer === this.layers - 1 };
  }
}
