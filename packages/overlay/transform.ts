/**
 * An optional hook on the media path, for whatever an application wants done to each frame's
 * payload at the two ends and nowhere between: end-to-end encryption (./media/sframe.ts) is the
 * one use. The engine stays agnostic: it hands each frame to `send` before packetizing it at the
 * source, and to `receive` after reassembling it at a viewer, before the jitter buffer. Relays
 * never call either: they forward the packets as they came (SPEC §15.2).
 *
 * Both are asynchronous (WebCrypto is). `inOrder` starts each frame's step at once and hands the
 * results on in the order the frames came, so the node and the player see frames in the order
 * they would have without the hook.
 */
import type { StreamConfig } from "./protocol";
import type { EncodedFrame, ReceivedFrame } from "./types";

export type FrameTransform = {
  /**
   * At the source: each encoded frame, before it is packetized. The frame it resolves to is what
   * is sent. If it rejects, the frame is not sent at all: never the frame as it was.
   */
  send?: (frame: EncodedFrame) => Promise<EncodedFrame>;
  /**
   * At a viewer: each frame once it is whole, before the player. Null drops it (it is not played).
   * A rejection drops it too.
   */
  receive?: (frame: ReceivedFrame) => Promise<ReceivedFrame | null>;
  /** `send` makes SFrame ciphertext: the source's `StreamConfig`s say `sframe: true`. */
  sframe?: boolean;
};

/** A stream's configuration as the source announces it under `transform`. */
export function markStreamConfig(config: StreamConfig, transform: FrameTransform | undefined): StreamConfig {
  return transform?.sframe && !config.sframe ? { ...config, sframe: true } : config;
}

/**
 * `step` on every item as it comes, all of them under way at once, and `deliver` on each result
 * in the order the items came. A null result, a rejection, or a step that throws is skipped
 * (`onError` hears of the last two). `alive` is asked before each delivery: false once the engine
 * has closed, so nothing is delivered after.
 *
 * `after(run)` runs `run` once every item given so far has been delivered (or skipped), still in
 * order with what follows: the source's stream configuration goes out this way, so it never
 * overtakes frames of the configuration before it that are still being transformed.
 */
export type Ordered<T> = ((item: T) => void) & { after: (run: () => void) => void };

export function inOrder<T, U>(step: (item: T) => Promise<U | null>, deliver: (result: U) => void, options: { onError?: (error: unknown) => void; alive?: () => boolean } = {}): Ordered<T> {
  let tail: Promise<void> = Promise.resolve();
  const settle = (item: T): Promise<U | null> => {
    try {
      return step(item).catch((error: unknown) => {
        options.onError?.(error);
        return null;
      });
    } catch (error) {
      options.onError?.(error);
      return Promise.resolve(null);
    }
  };
  const push = (item: T) => {
    const result = settle(item);
    tail = tail
      .then(() => result)
      .then((value) => {
        if (value !== null && (options.alive?.() ?? true)) deliver(value);
      })
      .catch((error: unknown) => options.onError?.(error));
  };
  return Object.assign(push, {
    after(run: () => void) {
      tail = tail
        .then(() => {
          if (options.alive?.() ?? true) run();
        })
        .catch((error: unknown) => options.onError?.(error));
    },
  });
}
