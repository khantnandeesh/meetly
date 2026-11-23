# Staging and error alerts

## Staging

https://staging.meet.nandeesh.dev is the `meetly-staging` Cloudflare Worker. It runs `main`:
every push to `main` (a merged pull request) runs `.github/workflows/staging.yml`, which runs CI,
then `opennextjs-cloudflare build` and `deploy --env staging`, then the smoke test. Production
(`meetly`, https://meet.nandeesh.dev) is untouched; it is released from `cloudflare-deploy`
(docs/RELEASING.md).

It is `env.staging` in `wrangler.jsonc`: the same build as production, with

| | Staging | Production |
| --- | --- | --- |
| Worker | `meetly-staging` | `meetly` |
| Live (beta) Durable Objects | its own namespace (`OverlayRoom` in `meetly-staging`) | its own |
| Secrets | `OVERLAY_ADMISSION_SECRET`, `OVERLAY_SERVER_SECRET`, `MEETLY_SESSION_SECRET`, each its own random value | its own |
| Live (beta) TURN, for viewers behind strict NATs (SPEC §6.7, §8.1 [D82]) | secrets `TURN_KEY_ID`, `TURN_KEY_API_TOKEN` (a Cloudflare Realtime TURN key) | not yet: set at release; without them those viewers can't connect |
| Cron Trigger (cost guard) | **none** | every minute |
| Webinars | off (`MEETLY_WEBINARS_ENABLED=0`) | on |
| Meetings (RealtimeKit) | off: no `CLOUDFLARE_API_TOKEN` secret | on |
| Search engines | `X-Robots-Tag: noindex`, `/robots.txt` disallows all | indexed |
| Label | a "Staging" tab on every page | none |

The label and `noindex` come from the `MEETLY_ENVIRONMENT_LABEL` variable, which only staging
has (`src/lib/environmentLabel.ts`, applied in `custom-worker.ts`).

**Staging must not have a Cron Trigger** while it uses production's RealtimeKit app: the cost
guard works on every live session of the app, and with webinars off it would end production's
webinars within a minute. `staging.yml` refuses to deploy if `env.staging` has one.

### Turning meetings on in staging

Staging reads production's RealtimeKit app id and presets, but has no token, so meetings say
"Meetly can't start meetings right now". To test meetings there, set a RealtimeKit API token
on the staging Worker:

```sh
npx wrangler secret put CLOUDFLARE_API_TOKEN --env staging
```

Meetings held on staging are then billed with production's. A separate RealtimeKit app for
staging (its own `REALTIMEKIT_APP_ID` and presets in `env.staging.vars`) keeps them apart.
Remove `SMOKE_RTK_OFF` from `staging.yml` at the same time.

### Smoke test

```sh
# production, read-only
node scripts/smoke-test.mjs https://meet.nandeesh.dev
# staging, as staging.yml runs it (SMOKE_LIVE needs Playwright through NODE_PATH)
SMOKE_STAGING=1 SMOKE_RTK_OFF=1 SMOKE_LIVE=1 node scripts/smoke-test.mjs https://staging.meet.nandeesh.dev
```

## Error alerts

**Workers errors** (both Workers): `observability.issues` is on in `wrangler.jsonc`, so
Cloudflare groups uncaught exceptions, failed invocations, `5xx` responses and logged errors
into Issues (Workers & Pages → the Worker → Issues). It is enabled for a Worker by its next
deploy. Cloudflare emails the account's address:

- Notification policy "Meetly Workers issues (meetly, meetly-staging)"
  (`aaaf745732554706b50553b2bf2561a9`, alert type Real-Time Issue, email only).
- Issues automations, one pair per Worker (Workers & Pages → the Worker → Issues → Automations):
  - "new issue": the first occurrence of a new issue;
  - "issue back after a day": an issue that comes back after 24 hours without occurrences.

  | Worker | new issue | issue back after a day |
  | --- | --- | --- |
  | `meetly` | `922a7bd9-cd96-43c2-a04d-887db4674cf5` | `76ca0fc3-de5e-427a-a0e9-ad0f1d6c6725` |
  | `meetly-staging` | `b366a4c5-8a76-4442-9792-d124c0e41577` | `80c62652-7ed1-4d7b-94be-4edefcd96560` |

Other Workers on the account have no automation, so their issues are not emailed. To test the
alert on staging (staging has no RealtimeKit token, so this logs an error and answers 500
without reaching RealtimeKit):

```sh
curl -sS -X POST https://staging.meet.nandeesh.dev/api/token -H 'content-type: application/json' -d '{}'
```

**Failed deploys**: `.github/workflows/deploy-alerts.yml` opens a GitHub issue when Deploy,
Staging or Rollback fails (one open issue per workflow and branch; later failures comment on
it). GitHub emails new issues to people watching the repository.
