# Meetly

Link-based video meetings built on Next.js, running on [LiveKit](https://livekit.io) or
[Cloudflare RealtimeKit](https://developers.cloudflare.com/realtime/realtimekit/).

- Start a meeting, share the link (`/abc-defg-hij`), no accounts
- Pre-join screen with camera preview and device selection
- Adaptive video grid, screen sharing with a focus layout
- In-call chat with unread badge, participant list, raise hand
- Layouts for large calls: Auto, Tiled (paginated gallery), Spotlight and Sidebar, with a debounced
  active speaker on the main tile; only on-screen cameras are streamed
- People list with search (windowed, fine at 100+), host can mute or remove (first person in is host)
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

## Choosing the media provider

`NEXT_PUBLIC_RTC_PROVIDER` picks the provider: `livekit` (the default) or `realtimekit`. It is
read when the app is built, so the browser bundle and the server routes always agree; change it
and rebuild. Only the chosen provider's SDK is downloaded, and only once Join is pressed.

| Provider | Variables |
| --- | --- |
| `livekit` | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` |
| `realtimekit` | `CLOUDFLARE_ACCOUNT_ID`, `REALTIMEKIT_APP_ID`, `REALTIMEKIT_HOST_PRESET`, `REALTIMEKIT_GUEST_PRESET`, `CLOUDFLARE_API_TOKEN`, `MEETLY_SESSION_SECRET` |

For RealtimeKit, create an app and two presets in it: a host preset that may mute and remove
participants, and a guest preset that may not. Both need to publish audio, video and screen
share and to send public chat. `CLOUDFLARE_API_TOKEN` needs the Realtime permission, and
`MEETLY_SESSION_SECRET` is any long random string (`openssl rand -hex 32`); it signs the session
that tells the server who the host is. Meeting codes become RealtimeKit meetings with the code
as their title.

What differs in a RealtimeKit call:

- RealtimeKit reports one active speaker, and only when it changes. The main tile follows it
  through the same debounce as on LiveKit, but the "speaking" ring stays on the last speaker
  until someone else talks or they mute, and never shows on your own tile.
- Video is received for at most 23 other people at a time (fewer when fewer are on screen).
  RealtimeKit picks who, recent speakers first; anyone else shows their avatar.
- Joining takes a second or two longer: the server makes three or four calls to Cloudflare.

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
| Host rule and moderation (server-verified) | `src/lib/host.server.ts` (LiveKit), `src/lib/rtc/server/` (RealtimeKit), `src/app/api/host/route.ts`, `src/components/HostTools.tsx` |
| Design tokens, motion, shared UI primitives | `src/app/globals.css`, `src/components/ui/` |
| Meeting code format | `src/lib/code.ts` |

Media never touches this app: browsers connect straight to the provider with a short-lived token.

## Deploy

Any Node host works (Vercel is the simplest). Set `NEXT_PUBLIC_RTC_PROVIDER` and that
provider's variables (see above) on the host, for the build as well as at run time. The site
must be served over HTTPS for browsers to allow camera and microphone access.
