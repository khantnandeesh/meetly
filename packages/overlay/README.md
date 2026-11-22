# @meetly/overlay

A self-healing peer-relay overlay: it carries a webinar's program feed from the host's browser to
a large audience, viewer to viewer, with no media server.

- **What it is and how it works:** [docs/overlay/SPEC.md](../../docs/overlay/SPEC.md)
- **Who builds what, and the rules for working here:** [docs/overlay/PLAN.md](../../docs/overlay/PLAN.md)

Plain TypeScript. No React, no Next.js, nothing from `src/`, and `src/` does not import it yet
(ESLint enforces both). It is not an npm workspace: it uses the repository's `node_modules`.

## Layout

| Path | Owner | What |
| --- | --- | --- |
| `protocol.ts` | architect (shared) | every wire type, with encoders, decoders and tests. **Built.** |
| `runtime.ts`, `types.ts`, `index.ts` | architect (shared) | clocks and logging; cross-module types; the two factories an application calls |
| [`transport/`](./transport/README.md) | E-transport+topology | links, channels, framing |
| [`topology/`](./topology/README.md) | E-transport+topology | parents, backups, heartbeats, repair, the GOP cache, scoring |
| [`media/`](./media/README.md) | E-media | capture, encode, jitter buffer, decode, audio, sync |
| [`congestion/`](./congestion/README.md) | E-congestion | link estimates, layer drop, the source's bitrate |
| [`coordinator/`](./coordinator/README.md) | E-coordinator | the core, a Durable Object, a Node server, the browser's client |
| [`harness/`](./harness/README.md) | E-harness | the swarm runner, impairment, churn, the report |

Everything except `protocol.ts` is a skeleton: typed interfaces in each `types.ts`, and factories
in each `index.ts` that throw `NotImplementedError` naming their owner. `skeleton.test.ts` lists
what is still a stub.

## Commands (from the repository root)

```
npm run test:overlay     # this package's unit tests
npm run overlay:check    # type check with this package's own tsconfig
npx eslint packages/overlay
npm run overlay:smoke    # the swarm smoke test (a placeholder until the harness exists)
```

`npm test`, `npx tsc --noEmit` and `npm run lint` at the root cover this package too.

Tests run in Node with types stripped, not compiled: mark type-only imports with `import type`,
and do not use syntax that needs compiling away beyond what `--experimental-transform-types`
handles. Import without file extensions, as the rest of the repository does.
