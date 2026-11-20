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
  ]),
  {
    // The browser tests are plain CommonJS scripts, so Playwright can come from wherever Node
    // finds it (a global install via NODE_PATH works) without being a dependency of the app.
    files: ["test/e2e/**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);

export default eslintConfig;
