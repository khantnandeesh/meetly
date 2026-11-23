/**
 * What this browser can decode, for `Capabilities.decode` (SPEC §6.3): the coordinator must not
 * place a viewer in a session whose codecs it cannot play.
 */

/** The WebCodecs codec strings asked about: what a program feed may be encoded with, now or later. */
export const CANDIDATE_VIDEO_CODECS = ["vp8", "vp09.00.10.08", "avc1.42E01E", "av01.0.04M.08"] as const;
export const CANDIDATE_AUDIO_CODECS = ["opus"] as const;

/** The codec strings this browser can decode. Empty where there is no WebCodecs at all. */
export async function probeDecoders(): Promise<string[]> {
  const supported: string[] = [];
  if (typeof VideoDecoder === "function") {
    for (const codec of CANDIDATE_VIDEO_CODECS) {
      try {
        if ((await VideoDecoder.isConfigSupported({ codec })).supported) supported.push(codec);
      } catch {
        // Not a codec string this browser knows.
      }
    }
  }
  if (typeof AudioDecoder === "function") {
    for (const codec of CANDIDATE_AUDIO_CODECS) {
      try {
        if ((await AudioDecoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 1 })).supported) supported.push(codec);
      } catch {
        // As above.
      }
    }
  }
  return supported;
}
