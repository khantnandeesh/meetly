# Meetly

Link-based video meetings built on Next.js, running on [LiveKit](https://livekit.io) or
[Cloudflare RealtimeKit](https://developers.cloudflare.com/realtime/realtimekit/).

- Start a meeting, share the link (`/abc-defg-hij`), no accounts
- Pre-join screen with camera preview and device selection
- Adaptive video grid, screen sharing with a focus layout
- In-call chat with unread badge, participant list, raise hand, emoji reactions
- Chat that late joiners can read back, one message pinned by the host, deleting your own
  message, and saving the conversation as a text file
- Noise suppression (on by default) and background blur, both done in the browser
- A meeting for later: a link now, and a Google Calendar, Outlook or .ics entry to go with it
- Layouts for large calls: Auto, Tiled (paginated gallery), Spotlight and Sidebar, with a debounced
  active speaker on the main tile; only on-screen cameras are streamed
- People list with search (windowed, fine at 100+)
- Whoever starts the meeting is its host, from that browser, across reloads. The host can mute one
  or all, stop a camera, lower hands, remove people, name co-hosts, end the call for everyone,
  and choose who can join: anyone with the link, people who ask, or nobody new
- Simulcast enabled for larger calls (plus dynacast and adaptive stream on LiveKit)
- A mini window that keeps the call on top while you use other tabs or present (desktop Chrome
  and Edge)
- Polls: the host and co-hosts ask, everyone gets one vote
- A notice when your own connection is the weak one, a "call quality" view and a "use less data"
  switch

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
some (`host`, `reactions`, `host-tools`, `access`, `effects`, `schedule`, `chat`, `fixes`, `polls`,
`quality`, `mini`, `rating`); set
`MEETLY_SHOTS=<dir>` to keep screenshots.
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
- Chat is RealtimeKit's own, kept by Cloudflare, so history needs nothing from us. Which message
  is pinned is one more `meetly-…` record, written through `/api/host` like any host action;
  RealtimeKit's own "pin" is not used, because nothing limits who may call it. Deleting is
  RealtimeKit's: this app only ever asks it to delete the caller's own message, and whether
  Cloudflare would refuse anyone else's is its rule, not ours.

## Noise suppression and background blur

Both run in the browser. Nothing is sent anywhere to be processed and no service is paid for.
The files they need are copied out of `node_modules` into `public/effects/` by
`scripts/copy-effects.mjs` (it runs before `npm run dev` and `npm run build`; the folder is not
committed), so they are served by this app and never fetched from someone else's CDN. Each is
downloaded the first time its feature is switched on, not before.

| | Library (licence) | What a browser downloads |
| --- | --- | --- |
| Noise suppression | RNNoise, through `@sapphi-red/web-noise-suppressor` (MIT; wraps `shiguredo/rnnoise-wasm`, Apache-2.0, and `xiph/rnnoise`, BSD-3-Clause) | 64 kB worklet + 157 kB wasm (about 0.13 MB compressed) |
| Background blur | LiteRT.js, `@litertjs/core` (Apache-2.0), running MediaPipe's selfie segmentation model from `@mediapipe/selfie_segmentation` (Apache-2.0) | 0.28 MB loader + 11.1 MB wasm (3.1 MB gzipped) + 0.25 MB model |

- **Noise suppression** is on unless switched off (microphone menu; More on a phone). On is two
  layers: the browser's own `noiseSuppression`, and RNNoise on top of it. Off turns both off,
  which is what music needs. If the filter cannot run, the browser's layer carries on alone.
- **Blur** (None, Slight blur, Blur) is in the camera menu and on the pre-join preview, which
  runs the same code as the call. A camera first published with blur chosen is published
  already blurred; if blur cannot start, that camera stays off rather than going out as it is.
  The control is absent (pre-join) or disabled with the reason (in the call) where the browser
  cannot do it. The picture is drawn at most 30 times a second; if drawing cannot keep up the
  picture is first made smaller, and after ten seconds under 12 frames a second blur is switched
  off with a notification that offers to put it back.

The code is in `src/lib/effects/` and knows nothing of either provider: LiveKit takes it as track
processors, RealtimeKit as audio and video middlewares. Cloudflare's own
`@cloudflare/realtimekit-noise-cancellation` and `-virtual-background` packages are not used:
both fetch their runtime and models from `rtk-assets.realtime.cloudflare.com` when they start.

## Chat on LiveKit

LiveKit carries data and keeps none, and this app has no storage. So chat goes through
`/api/chat` (`src/lib/chat.server.ts`): the server works out who is sending from their token and
the room's current participants, signs the message, and hands it to the room. Clients ignore
chat that a participant publishes directly.

- **History**: a newcomer asks the participant who has been in the call longest for the messages
  they hold, then asks the server which of those it really signed. A participant can therefore
  leave messages out, or pass on one its author has since deleted; it cannot invent, alter or
  re-attribute one. Up to the last 200 messages are passed on. Once everybody has left, the
  conversation is gone.
- **Pin**: a host action through `/api/host`. The pinned message is kept whole in the room's
  metadata, and only a message carrying the server's signature can be put there.
- **Delete**: your own messages only, checked by the server against the identity in the signed
  message (or one your browser held before a reload, from its signed cookie).

The smallest thing that would improve this is a per-meeting store (a Durable Object or a KV
entry) holding the log: history would then survive everyone leaving, and deletions would be
remembered by the server instead of by the clients that saw them.

## Mini window

"Open mini window" (More, the main tile's actions, or Shift+P) moves the call into a small
window that stays on top of everything: whoever the stage would show (the person talking, a pin,
somebody's shared screen; never your own shared screen), with microphone, camera, back and leave.
Closing it by any route brings the call back to the tab; the call itself is not touched. While
it is open the tab shows a placeholder instead of drawing the same pictures twice, and offers an
opt-in to open the mini window whenever you start presenting.

It is the browser's Document Picture-in-Picture, which today exists in desktop Chromium browsers
only. In Firefox, in Safari and at phone width nothing offers it: no menu item, no tile button,
no shortcut. There is no video-only fallback, because a floating picture without a mute button
would look like this feature without being it. Where the browser asks a page for its
picture-in-picture on switching tabs (Chrome, for sites allowed to open one automatically), the
mini window answers; opening when you start presenting depends on the browser still counting the
click that started the share, and is silently skipped when it does not.

## Polls

Polls sit at the top of the chat panel. The host and co-hosts start one (a question of up to 140
characters, two to six options, anonymous or by name) and end it; everyone votes once. Until you
have voted you see the options and not the counts; the host and co-hosts see the counts from the
start. Someone who joins late finds the open polls waiting, with a count on the chat button. At
most five are open at a time.

**On LiveKit** there are no polls and this app has no storage, so a poll is part of the
meeting's record: the room's metadata, which only the API secret can write and which LiveKit
gives to everyone, late joiners included. Starting one and voting are requests to `/api/poll`
(`src/lib/polls.server.ts`, rules in `src/lib/pollStore.ts`); ending one is a host action through
`/api/host`. The server takes who is asking from their signed token and what they may do from the
record, and counts one vote per identity it minted and per browser (the signed cookie lists the
identities a browser has held in the meeting, so a reload is not a second vote). An anonymous
poll's record holds a keyed hash per voter in place of their identity. Nothing a browser can
write (data messages, its own attributes or metadata) is read as a vote.

What it cannot stop, without accounts: a second browser, or a private window, is a second
participant and has a second vote. A poll takes at most 150 votes, because the record is sent to
everyone on every change. And the record is read, changed and written back, so two votes that
reach two server instances in the same instant can lose one: each client checks that its
confirmed vote is in the record and sends it again if not (the server takes the same vote twice
without counting it twice).

**On RealtimeKit** polls are RealtimeKit's own (`meeting.polls`): Cloudflare keeps them, counts
the votes and hands them to late joiners. Who may see polls, vote and start one is each preset's
`polls` permission (`can_view`, `can_vote`, `can_create`), enforced by Cloudflare; until the
presets grant them there are no polls in a RealtimeKit call. Give the host preset all three and
the guest preset `can_view` and `can_vote`. Co-hosts join with the guest preset, so on
RealtimeKit only the host starts polls; co-hosts can still end them. Three things there are only
as good as the client: Meetly's limits on a new poll, "results once you have voted", and ending.
RealtimeKit has no way to end a poll, so that a poll has ended is one more `meetly-…` record
written through `/api/host`; honest clients stop offering it, but a modified client can still
send a vote and Cloudflare will count it. Whether Cloudflare refuses a second vote from the same
participant is its rule and is not documented.

## Call quality and using less data

When your own connection has been poor for ten seconds in a row, one chip appears at the top of
the stage: "Your connection is weak", with "Use less data" and a way to dismiss it. It goes a few
seconds after things improve, is not repeated for two minutes after that, and not for ten after
being dismissed (`src/lib/callHealth.ts`). No toast, no sound. "Poor" is the provider's judgement:
LiveKit's connection quality for you, or RealtimeKit's media scores for what you send.

More → "Call quality…" shows the same judgement in a word, what is being sent and received, the
switch, and "Copy diagnostics". Everything in it is about this browser and stays there.

"Use less data" is never switched on for you. While it is on your camera is captured at 640 × 360
and 15 frames a second (so the largest version anyone receives is 320 × 180) and, on LiveKit,
each version is capped at 150 kbit/s; and only the main picture and shared screens are shown,
everyone else is their avatar, which is what stops their video being sent to you. Sound is not
touched. A leaf in the bar (the top bar on a phone) shows it is on.

## Usage counts and the rating

The screen you see after leaving asks "How was the call?" with two buttons, and a few features
report that they were used. All of it goes to `sendUsageEvent` in `src/lib/usage.ts`, which today
does nothing: Meetly has no storage and no analytics service, so no request is made and nothing
is kept. The event's shape is fixed there (a feature name or a rating, and coarse buckets for
call size, length and phone or desktop; no code, names or text). Making it real needs somewhere
to keep one counter per day and event, for example a Workers Analytics Engine dataset.

## Meetings for later

"New meeting" has an arrow with "Get a link for later" and "Schedule…"; in a call, More has "Add
to calendar…". The link is made the way an instant meeting's is, so whoever makes it is its
host, and it never expires. Title and time go only into the calendar entry
(`src/lib/calendar.ts`): a Google Calendar or Outlook link, or an .ics file with a ten-minute
reminder, all in UTC. Meetly stores none of it and sends no email.

On LiveKit the host's record lasts a day in an unused room, so for a meeting further off the
person who scheduled it is host only if they are the first to arrive. On RealtimeKit it lasts
thirty days.

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
| Chat / people side panels | `src/components/ChatPanel.tsx`, `ChatStore.tsx`, `PeoplePanel.tsx` |
| Chat on LiveKit (signing, history, delete), saving the chat | `src/lib/chat.server.ts`, `chatSignature.server.ts`, `src/app/api/chat/route.ts`, `src/lib/chatExport.ts` |
| Noise suppression, background blur and their saved settings | `src/lib/effects/`, `scripts/copy-effects.mjs` |
| Calendar links and the schedule dialog | `src/lib/calendar.ts`, `src/components/ScheduleDialog.tsx` |
| Layout modes, paging, self-view settings | `src/lib/useCallSettings.ts`, `src/components/LayoutMenu.tsx`, `FocusStage.tsx` |
| Active-speaker debounce and stable tile order | `src/lib/useSpeakers.ts` |
| Not streaming off-screen video | `src/lib/videoDemand.ts` |
| Host rule, the meeting's record and moderation (server-verified) | `src/lib/host.server.ts` (LiveKit), `src/lib/rtc/server/` (RealtimeKit), `src/lib/pass.server.ts`, `src/app/api/host/route.ts`, `src/app/api/meeting/route.ts` |
| Host tools, waiting list, what moderation looks like to the person it happens to | `src/components/HostTools.tsx`, `PeoplePanel.tsx`, `ModerationNotices.tsx` |
| Reactions | `src/lib/reactions.ts`, `src/components/Reactions.tsx` |
| Mini window | `src/lib/usePip.ts`, `src/lib/miniTile.ts`, `src/components/MiniWindow.tsx` |
| Polls | `src/components/Polls.tsx`, `src/lib/pollStore.ts`, `src/lib/polls.server.ts`, `src/app/api/poll/route.ts` |
| Call quality, the weak-connection notice, using less data | `src/lib/callHealth.ts`, `src/lib/useCallHealth.ts`, `src/components/CallQuality.tsx` |
| Usage events and the leave-screen rating (sent nowhere) | `src/lib/usage.ts` |
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
