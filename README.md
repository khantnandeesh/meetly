# Meetly

Link-based video meetings built on Next.js, running on [LiveKit](https://livekit.io) or
[Cloudflare RealtimeKit](https://developers.cloudflare.com/realtime/realtimekit/).

- Start a meeting, share the link (`/abc-defg-hij`), no accounts
- Pre-join screen with camera preview and device selection
- Adaptive video grid, screen sharing with a focus layout
- In-call chat with unread badge, participant list, raise hand, emoji reactions
- Layouts for large calls: Auto, Tiled (paginated gallery), Spotlight and Sidebar, with a debounced
  active speaker on the main tile; only on-screen cameras are streamed
- People list with search (windowed, fine at 100+)
- Whoever starts the meeting is its host, from that browser, across reloads. The host can mute one
  or all, stop a camera, lower hands, remove people, name co-hosts, end the call for everyone,
  and choose who can join: anyone with the link, people who ask, or nobody new
- Simulcast enabled for larger calls (plus dynacast and adaptive stream on LiveKit)

## Run locally

```bash
cp .env.example .env.local   # fill in LiveKit URL, key and secret
npm install
npm run dev
```

Get credentials from [LiveKit Cloud](https://cloud.livekit.io) (Settings → Keys), or run a local
server with `livekit-server --dev` and use `ws://localhost:7880` / `devkey` / `secret`.

`npm test` runs the unit tests (Node's built-in runner, no extra dependencies).

`node test/e2e/run.cjs` runs the browser tests: real Chromium clients with fake cameras, against
a running LiveKit build (`MEETLY_URL`, default `http://localhost:3000`). Name suites to run only
some (`host`, `reactions`, `host-tools`, `access`); set `MEETLY_SHOTS=<dir>` to keep screenshots.
They need [Playwright](https://playwright.dev) where Node can find it (`npm i --no-save playwright`,
or a global install on `NODE_PATH`). `node test/e2e/realtimekit-rest.cjs` checks a RealtimeKit
build's server routes against Cloudflare's REST API without joining a call; it creates test
meetings in the configured app and prints their ids.

## Choosing the media provider

`NEXT_PUBLIC_RTC_PROVIDER` picks the provider: `livekit` (the default) or `realtimekit`. It is
read when the app is built, so the browser bundle and the server routes always agree; change it
and rebuild. Only the chosen provider's SDK is downloaded, and only once Join is pressed.

| Provider | Variables |
| --- | --- |
| `livekit` | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` |
| `realtimekit` | `CLOUDFLARE_ACCOUNT_ID`, `REALTIMEKIT_APP_ID`, `REALTIMEKIT_HOST_PRESET`, `REALTIMEKIT_GUEST_PRESET`, `CLOUDFLARE_API_TOKEN`, `MEETLY_SESSION_SECRET`, and optionally `REALTIMEKIT_KNOCK_PRESET` |

For RealtimeKit, create an app and two presets in it: a host preset that may mute and remove
participants, and a guest preset that may not. Both need to publish audio, video and screen
share and to send public chat. `CLOUDFLARE_API_TOKEN` needs the Realtime permission, and
`MEETLY_SESSION_SECRET` is any long random string (`openssl rand -hex 32`); it signs the session
that tells the server who is asking, and the cookie that holds the host key. Meeting codes become
RealtimeKit meetings with the code as their title.

Two host tools depend on the presets, and stay hidden until the presets allow them:

- **Turn off someone's camera** needs `disable_participant_video` on the host preset. Co-hosts
  join with the guest preset, so on RealtimeKit only the host can do this.
- **People ask to join** needs a third preset, named in `REALTIMEKIT_KNOCK_PRESET`: the guest
  preset with the waiting room switched on (`waiting_room_type`), plus `accept_waiting_requests`
  on the host preset. Again only the host can let people in.

What differs in a RealtimeKit call:

- RealtimeKit reports one active speaker, and only when it changes. The main tile follows it
  through the same debounce as on LiveKit, but the "speaking" ring stays on the last speaker
  until someone else talks or they mute, and never shows on your own tile.
- Video is received for at most 23 other people at a time (fewer when fewer are on screen).
  RealtimeKit picks who, recent speakers first; anyone else shows their avatar.
- Joining takes a second or two longer: the server makes three or four calls to Cloudflare.
- The meeting's record (co-hosts, lock, who was removed) is kept as extra participant records in
  the RealtimeKit meeting, named `meetly-…`, that nobody joins with: RealtimeKit has no other
  per-meeting storage. They show up in the dashboard's participant list.
- Clients learn about co-hosts and the lock by asking our server when another client says they
  changed, since the server cannot push to them. Lowering hands and "the host ended the call"
  (as opposed to "removed you") are messages between clients, as raised hands are.
- "Mute all" uses Cloudflare's mute-all call, which makes no exception for the host or co-hosts.

## Hosts, co-hosts and who can join

There are no accounts, so the host is a browser. Starting a meeting gives that browser a signed,
HttpOnly cookie for that meeting (`src/lib/pass.server.ts`); joining with it makes you host, every
time. Nobody else becomes host, whoever arrives first or stays longest, and the key is never in
the link. Clearing cookies, or moving to another device, loses the role. For a code somebody
typed by hand, the first person in is the host and gets the cookie then.

The same cookie notes who the browser was in the call, which is how someone the host removed is
refused when they try to come back. A different browser or a private window is not recognised:
to keep a determined person out, switch the meeting to "People ask to join" (the remove dialog
offers it) or lock it.

Every host action is a request to `/api/host`, which works out from the caller's signed token
and the meeting's record what they may do. Co-hosts can do everything except end the call and
choose co-hosts, and cannot act on the host.

On LiveKit the record is the room's metadata, kept for a day after the last person leaves; after
that the code is new again. People who have to ask wait in a second room (`<code>.lobby`) with a
token that can do nothing, so nothing of the meeting reaches them; being let in sends them a
token for the meeting itself. On RealtimeKit the host's record lapses once the meeting is empty
and the host has not joined for thirty days.

## How it fits together

| Piece | Where |
| --- | --- |
| The call as the UI sees it, and the two provider adapters | `src/lib/rtc/types.ts`, `react.tsx`, `livekit.ts`, `realtimekit.ts` |
| Token minting (server only, holds the API secret) | `src/app/api/token/route.ts` |
| Pre-join → in-call → left flow | `src/components/Meeting.tsx` |
| Pre-join screen (preview, device pickers) | `src/components/PreJoin.tsx`, `src/lib/usePreviewMedia.ts` |
| Stage, panels, toasts, shortcuts | `src/components/Conference.tsx` |
| Tiles, grid and control bar | `src/components/Tile.tsx`, `TileGrid.tsx`, `ControlBar.tsx` |
| Chat / people side panels | `src/components/ChatPanel.tsx`, `PeoplePanel.tsx` |
| Layout modes, paging, self-view settings | `src/lib/useCallSettings.ts`, `src/components/LayoutMenu.tsx`, `FocusStage.tsx` |
| Active-speaker debounce and stable tile order | `src/lib/useSpeakers.ts` |
| Not streaming off-screen video | `src/lib/videoDemand.ts` |
| Host rule, the meeting's record and moderation (server-verified) | `src/lib/host.server.ts` (LiveKit), `src/lib/rtc/server/` (RealtimeKit), `src/lib/pass.server.ts`, `src/app/api/host/route.ts`, `src/app/api/meeting/route.ts` |
| Host tools, waiting list, what moderation looks like to the person it happens to | `src/components/HostTools.tsx`, `PeoplePanel.tsx`, `ModerationNotices.tsx` |
| Reactions | `src/lib/reactions.ts`, `src/components/Reactions.tsx` |
| Design tokens, motion, shared UI primitives | `src/app/globals.css`, `src/components/ui/` |
| Meeting code format | `src/lib/code.ts` |

Media never touches this app: browsers connect straight to the provider with a short-lived token.

## Deploy

Any Node host works (Vercel is the simplest). Set `NEXT_PUBLIC_RTC_PROVIDER` and that
provider's variables (see above) on the host, for the build as well as at run time. The site
must be served over HTTPS for browsers to allow camera and microphone access.

### Cloudflare Workers

The app also builds for Cloudflare Workers with [`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare)
(`wrangler.jsonc`, `open-next.config.ts`). `npm run dev` / `build` / `start` are unchanged.

```bash
npm run preview   # build .open-next/ and run it locally in workerd (http://localhost:8787)
npm run deploy    # build and deploy the `meetly` Worker (workers.dev + meet.nandeesh.dev)
```

`npm run deploy` needs `wrangler login` or `CLOUDFLARE_API_TOKEN` (the "Edit Cloudflare Workers"
template covers it). Secrets are set once per Worker with `npx wrangler secret put <NAME>` and are
read as `process.env.<NAME>`; non-secret values go under `vars` in `wrangler.jsonc`. This branch
builds with `NEXT_PUBLIC_RTC_PROVIDER=realtimekit` (`.env.production`) and needs two secrets:
`CLOUDFLARE_API_TOKEN` (Realtime permission) and `MEETLY_SESSION_SECRET` (any long random string).

In Workers Builds use build command `npx opennextjs-cloudflare build` and deploy command
`npx opennextjs-cloudflare deploy`. Plain `wrangler deploy` skips the page-cache step and every
page then returns 500. For local
preview, put them in `.dev.vars` (git-ignored).
