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
    // Cloudflare build output:
    ".open-next/**",
    ".wrangler/**",
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
  {
    // The overlay engine (packages/overlay, docs/overlay/SPEC.md) is not part of the app yet. It
    // joins the bundle at its integration step, through one adapter; until then nothing under
    // src/ may import it, so `next build` cannot pick it up by accident.
    files: ["src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@meetly/overlay", "@meetly/overlay/*", "**/packages/overlay", "**/packages/overlay/**"],
              message: "The overlay package is not wired into the app yet. See docs/overlay/PLAN.md, \"Integration\".",
            },
          ],
        },
      ],
    },
  },
  {
    // The one exception: Live (beta), /live and /live/<id>, with the route that signs its tickets.
    // It is the overlay's first use in the app, shipped ahead of the integration step and its
    // tests on purpose. Only these files may import the package, so no other page bundles it.
    files: ["src/app/live/**", "src/app/api/live/**", "src/components/live/**", "src/lib/live/**"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // The overlay engine is framework-agnostic: no React, no Next.js, nothing of the app's, and
    // neither media provider's SDK. An unused parameter may be kept, for its name, behind "_".
    files: ["packages/overlay/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["react", "react-dom", "next", "livekit-client", "livekit-server-sdk", "@cloudflare/realtimekit"],
          patterns: [
            { group: ["react/*", "react-dom/*", "next/*", "@/*"], message: "packages/overlay does not depend on the app or its framework." },
          ],
        },
      ],
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
]);

export default eslintConfig;
