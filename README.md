# Meetly

Link-based video meetings built on [LiveKit](https://livekit.io) and Next.js.

- Start a meeting, share the link (`/abc-defg-hij`), no accounts
- Pre-join screen with camera preview and device selection
- Adaptive video grid, screen sharing with a focus layout
- In-call chat with unread badge, participant list, raise hand
- Layouts for large calls: Auto, Tiled (paginated gallery), Spotlight and Sidebar, with a debounced
  active speaker on the main tile; only on-screen cameras are streamed
- People list with search (windowed, fine at 100+), host can mute or remove (first person in is host)
- Simulcast, dynacast and adaptive stream enabled for larger calls

## Run locally

```bash
cp .env.example .env.local   # fill in LiveKit URL, key and secret
npm install
npm run dev
```

Get credentials from [LiveKit Cloud](https://cloud.livekit.io) (Settings → Keys), or run a local
server with `livekit-server --dev` and use `ws://localhost:7880` / `devkey` / `secret`.

## How it fits together

| Piece | Where |
| --- | --- |
| Token minting (server only, holds the API secret) | `src/app/api/token/route.ts` |
| Pre-join → in-call → left flow | `src/components/Meeting.tsx` |
| Pre-join screen (preview, device pickers) | `src/components/PreJoin.tsx`, `src/lib/usePreviewMedia.ts` |
| Stage, panels, toasts, shortcuts | `src/components/Conference.tsx` |
| Tiles, grid and control bar | `src/components/Tile.tsx`, `TileGrid.tsx`, `ControlBar.tsx` |
| Chat / people side panels | `src/components/ChatPanel.tsx`, `PeoplePanel.tsx` |
| Layout modes, paging, self-view settings | `src/lib/useCallSettings.ts`, `src/components/LayoutMenu.tsx`, `FocusStage.tsx` |
| Active-speaker debounce and stable tile order | `src/lib/useSpeakers.ts` |
| Pausing off-screen video | `src/lib/videoDemand.ts` |
| Host rule and moderation (server-verified) | `src/lib/host.server.ts`, `src/app/api/host/route.ts`, `src/components/HostTools.tsx` |
| Design tokens, motion, shared UI primitives | `src/app/globals.css`, `src/components/ui/` |
| Meeting code format | `src/lib/code.ts` |

Media never touches this app: browsers connect straight to LiveKit with the short-lived token.

## Deploy

Any Node host works (Vercel is the simplest). Set `LIVEKIT_URL`, `LIVEKIT_API_KEY` and
`LIVEKIT_API_SECRET` as environment variables on the host. The site must be served over HTTPS
for browsers to allow camera and microphone access.
