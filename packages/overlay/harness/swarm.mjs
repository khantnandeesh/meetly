#!/usr/bin/env node
// Runs ./cli.ts with the flags Node needs to load the package's TypeScript as written (the same
// ones `npm run overlay:smoke` uses), so a scenario is one command:
//
//   node packages/overlay/harness/swarm.mjs run proof-tree
//
// Owner: E-harness.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const result = spawnSync(
  process.execPath,
  [
    "--experimental-transform-types",
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--disable-warning=ExperimentalWarning",
    "--import",
    here("../../../test/register.mjs"),
    here("./cli.ts"),
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
