import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Other agents' checkouts (each with its own build output) are not this project's source.
    ".claude/**",
    // Third-party runtime files copied out of node_modules (see scripts/copy-effects.mjs).
    "public/effects/**",
  ]),
  {
    // The browser tests are plain CommonJS scripts, so Playwright can come from wherever Node
    // finds it (a global install via NODE_PATH works) without being a dependency of the app.
    // scripts/join-bots.cjs is the same kind of script.
    files: ["test/e2e/**/*.cjs", "scripts/join-bots.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);

export default eslintConfig;
