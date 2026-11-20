// Lets Node's own test runner load the app's TypeScript as written: source files import each
// other without an extension ("./emitter"), which Node does not resolve by itself, and route
// handlers import through the "@/" alias of tsconfig.json, which Node does not know either.
import { registerHooks } from "node:module";

const SRC = new URL("../src/", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) specifier = new URL(specifier.slice(2), SRC).href;
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if ((specifier.startsWith(".") || specifier.startsWith("file:")) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
