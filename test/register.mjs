// Lets Node's own test runner load the app's TypeScript as written: source files import each
// other without an extension ("./emitter"), which Node does not resolve by itself, and route
// files import through the "@/" alias for src/ that tsconfig.json declares. The overlay package
// (packages/overlay) is reached the same way, through its "@meetly/overlay" alias.
import { registerHooks } from "node:module";

const SRC = new URL("../src/", import.meta.url);
const OVERLAY = new URL("../packages/overlay/", import.meta.url);

function aliased(specifier) {
  if (specifier.startsWith("@/")) return new URL(specifier.slice(2), SRC).href;
  if (specifier === "@meetly/overlay") return new URL("index.ts", OVERLAY).href;
  if (specifier.startsWith("@meetly/overlay/")) return new URL(specifier.slice("@meetly/overlay/".length), OVERLAY).href;
  return specifier;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const wanted = aliased(specifier);
    try {
      return nextResolve(wanted, context);
    } catch (error) {
      if ((wanted.startsWith(".") || wanted.startsWith("file:")) && !/\.[cm]?[jt]sx?$/.test(wanted)) {
        return nextResolve(`${wanted}.ts`, context);
      }
      throw error;
    }
  },
});
