# coordinator

**Owner: E-coordinator.** Spec: SPEC §6, §8.1–§8.2, §4.1. Milestones: PLAN §5, K1–K6.

Who is in a session, what each may do, where each sits in the trees, and a relay for WebRTC
signalling. It never sees media, and a session keeps playing and repairing without it.

| File | What |
| --- | --- |
| `types.ts` | `CoordinatorCore` and its `Effect`s; `CoordinatorClient`; the Node entry point's options |
| `index.ts` | `createCoordinatorCore`, `createCoordinatorClient`, the routes and close codes |
| `node.ts` | `startNodeCoordinator`: the core behind `http` and `ws`, for tests and the harness |
| `durableObject.ts` | `OverlayRoom` and the Worker: the core behind hibernatable WebSockets, for production |

The core does no I/O. It is told what happened and returns what to do. Both entry points are a
few dozen lines around it, and one contract test suite, written against a URL, must pass against
both. If a behaviour can only be had by putting logic in an entry point, the core's interface is
missing something.

Rules of this module:

- The tree map is soft state, rebuilt from peers' `status`. Store only what cannot be rebuilt:
  the signing key, used ticket nonces, whether the session has ended.
- Never be on the repair path. A peer tells you about a repair after it has happened.
- `node.ts` and `durableObject.ts` are imported by path, never re-exported from `index.ts`: a
  browser bundle must not pull in Node's `http` or a Worker's globals.
- The Worker is its own (`meetly-overlay`), with its own `wrangler.jsonc` in this directory. The
  app's Worker and the `cloudflare-deploy` branch are not touched.
- Placement ranks with topology's `judgeRelay` and `parentCost`. That is the only code this
  module imports from another module; everything else is `types.ts`.
