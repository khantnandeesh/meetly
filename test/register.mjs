// Lets Node's own test runner load the app's TypeScript as written: source files import each
// other without an extension ("./emitter"), which Node does not resolve by itself, and route
// files import through the "@/" alias for src/ that tsconfig.json declares.
import { registerHooks } from "node:module";

const SRC = new URL("../src/", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const wanted = specifier.startsWith("@/") ? new URL(specifier.slice(2), SRC).href : specifier;
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
