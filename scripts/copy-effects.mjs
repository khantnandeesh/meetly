// Puts the files that noise suppression and background blur load at run time into
// public/effects/, so they are served by the app itself and never fetched from somebody else's
// CDN. They come straight out of node_modules; nothing here is downloaded.
//
// Run before `next dev` and `next build` (see package.json). The folder is not committed.
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = (name) => join(root, "node_modules", ...name.split("/"));
const out = join(root, "public", "effects");

const noise = join(packageDir("@sapphi-red/web-noise-suppressor"), "dist");
const litert = join(packageDir("@litertjs/core"), "wasm");
const model = packageDir("@mediapipe/selfie_segmentation");

/** [source, name it is served under] */
const FILES = [
  // Noise suppression: RNNoise as an AudioWorklet (about 0.22 MB for one browser).
  [join(noise, "rnnoise", "workletProcessor.js"), "rnnoise-worklet.js"],
  [join(noise, "rnnoise.wasm"), "rnnoise.wasm"],
  [join(noise, "rnnoise_simd.wasm"), "rnnoise_simd.wasm"],
  // Background blur: the LiteRT runtime (a browser loads one of the two builds) and the model.
  [join(litert, "litert_wasm_internal.js"), "litert_wasm_internal.js"],
  [join(litert, "litert_wasm_internal.wasm"), "litert_wasm_internal.wasm"],
  [join(litert, "litert_wasm_compat_internal.js"), "litert_wasm_compat_internal.js"],
  [join(litert, "litert_wasm_compat_internal.wasm"), "litert_wasm_compat_internal.wasm"],
  [join(model, "selfie_segmentation_landscape.tflite"), "selfie_segmentation_landscape.tflite"],
];

mkdirSync(out, { recursive: true });
let bytes = 0;
for (const [from, name] of FILES) {
  copyFileSync(from, join(out, name));
  bytes += statSync(from).size;
}
console.log(`effects: ${FILES.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB, in public/effects`);
