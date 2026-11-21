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
    // Agent skills installed with `npx skills add` (third-party guidance and example code).
    ".agents/**",
    // Third-party runtime files copied out of node_modules (see scripts/copy-effects.mjs).
    "public/effects/**",
  ]),
  {
    // The home illustration's stage engine, ported from the stageshow skill's kit (MIT, see its
    // LICENSE). It keeps its playback state in refs read during render and settles its first frame
    // with setState in layout effects, on purpose; these rules are kept for the app's own code.
    files: ["src/components/hero/kit/**"],
    rules: {
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
  {
    // The browser tests are plain CommonJS scripts, so Playwright can come from wherever Node
    // finds it (a global install via NODE_PATH works) without being a dependency of the app.
    // scripts/join-bots.cjs is the same kind of script.
    files: ["test/e2e/**/*.cjs", "scripts/join-bots.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);

export default eslintConfig;
