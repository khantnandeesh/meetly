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
- People list with search (windowed, fine at 1,000+), as one scrolling list: who is waiting to
  join (the five who have waited longest, with how long, Admit all and Deny all), raised hands
  (the first five in the order they went up, with Lower all), everyone, and for the host who
  left since they joined. Waiting and hands each have a "See all" view with its own search
- Whoever starts the meeting is its host, from that browser, across reloads. The host can mute one
  or all, stop a camera, lower hands, remove people, name co-hosts, end the call for everyone,
  and choose who can join: anyone with the link, people who ask, or nobody new
- Simulcast enabled for larger calls (plus dynacast and adaptive stream on LiveKit)
- A mini window that keeps the call on top while you use other tabs or present (desktop Chrome
  and Edge)
- Polls: the host and co-hosts ask, everyone gets one vote
- A notice when your own connection is the weak one, a "connection quality" view and a "use less
  data" switch
- Notifications that stay calm from two people to thousands: at most two on screen, counted
  rather than listed, and the ones that need you first

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
`quality`, `mini`, `rating`, `notices`, `cost-guard`); set
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
| `realtimekit` | `CLOUDFLARE_ACCOUNT_ID`, `REALTIMEKIT_APP_ID`, `REALTIMEKIT_HOST_PRESET`, `REALTIMEKIT_GUEST_PRESET`, `CLOUDFLARE_API_TOKEN`, `MEETLY_SESSION_SECRET`, and optionally `REALTIMEKIT_KNOCK_PRESET`, `REALTIMEKIT_WEBINAR_HOST_PRESET`, `REALTIMEKIT_WEBINAR_VIEWER_PRESET` and `REALTIMEKIT_WEBINAR_COHOST_PRESET` (see [Webinars](#webinars)) |

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
- "Mute everyone" uses Cloudflare's mute-all call, which makes no exception for the host or co-hosts.
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

## Notifications

One policy for every notification in a call, in `src/lib/notices.ts` (tested in
`test/notices.test.ts` and, under floods, `test/e2e/notices.cjs`):

| Kind | What | Stays |
| --- | --- | --- |
| action | Somebody asks to join (host and co-hosts) | Until answered |
| you | The host muted you or turned your camera off; you became (or stopped being) a co-host; something you did failed; blur was switched off | A few seconds; waits up to 6 s for room |
| info | A chat message (the first after a quiet spell), a pinned message, a new poll | A few seconds; dropped if there is no room |
| presence | People joining or leaving who are not on screen, up to 24 people in the call | A few seconds; dropped if there is no room |

- At most two on screen (one on a phone while a sheet is open). A higher kind takes the place of
  the lowest one showing; news that finds no room is dropped (the chat badge and the people
  count still carry it); anything else waits its turn.
- Bursts are one notification that counts: "5 people joined", "30 people want to join". A count
  changes at most once a second. A busy chat shows its first message and counts the rest on the
  chat button.
- On large screens they rise from the bottom-right corner of the stage, clear of the controls, an
  open panel and the invite card; the most important one sits nearest the controls and does not
  move when another arrives. On a phone they hang from the top bar; with a sheet open, only what
  concerns you shows, as one line over the top bar, never over the sheet.
- While a dialog is open, news is not shown. With the people list open, joins and requests to join are
  not notified: the list shows them, with the same buttons.
- Sounds follow the same lines: one knock per burst of requests, presence sounds only up to eight
  people, and above 24 a raised hand is heard only by the host and co-hosts.

## How long the meeting has run

Beside the clock, bottom left ("12:44 PM · 23:15 | code"; in a webinar's audience "● Live · 23:15 ·
250 watching"), and beside the code in a phone's top bar: minutes and seconds, then hours past the
first one (`MeetingTimer.tsx`, `src/lib/meetingTime.ts`). On narrow large screens the clock gives way
first, then the timer; on a crowded phone top bar the timer steps aside whole rather than cut
anything short. A screen reader hears it as a timer named in whole minutes, never announced.

It counts from when the meeting began, which our server works out once, when /api/token lets
someone in, and sends as `started` (milliseconds ago, so the browser's clock does not matter).
Nothing asks again while the meeting runs.

- LiveKit: the room is made at "New meeting" and kept for a day after everyone leaves, so its own
  creation time is not when the meeting began. Instead whoever is let into the empty room begins
  it, and that moment is written into the room's record (`startedAt`, `meetingAge` in
  `src/lib/host.server.ts`).
- RealtimeKit: the active session's `started_at` (`GET /meetings/{id}/active-session`). A join
  reads that once and shares it with its other questions (who is host, how many are watching);
  no session means the meeting begins with this person.

When it can't be known (a meeting that began before the start was recorded, or Cloudflare would
not answer) the timer counts from when you joined and is named "Time since you joined".

## Connection quality and using less data

When your own connection has been poor for ten seconds in a row, one chip appears at the top of
the stage: "Your connection is weak", with "Use less data" and a way to dismiss it. It goes a few
seconds after things improve, is not repeated for two minutes after that, and not for ten after
being dismissed (`src/lib/callHealth.ts`). No toast, no sound. "Poor" is the provider's judgement:
LiveKit's connection quality for you, or RealtimeKit's media scores for what you send.

More → "Connection quality…" shows the same judgement in a word, what is being sent and received, the
switch, and "Copy connection details". Everything in it is about this browser and stays there.

"Use less data" is never switched on for you. While it is on your camera is captured at 640 × 360
and 15 frames a second (so the largest version anyone receives is 320 × 180) and, on LiveKit,
each version is capped at 150 kbit/s; and only the main picture and shared screens are shown,
everyone else is their avatar, which is what stops their video being sent to you. Sound is not
touched. A leaf in the bar (the top bar on a phone) shows it is on.

## Usage counts and the rating

The screen you see after leaving asks "How were the sound and video?" with two buttons, and a few features
report that they were used. All of it goes to `sendUsageEvent` in `src/lib/usage.ts`, which today
does nothing: Meetly has no storage and no analytics service, so no request is made and nothing
is kept. The event's shape is fixed there (a feature name or a rating, and coarse buckets for
call size, length and phone or desktop; no code, names or text). Making it real needs somewhere
to keep one counter per day and event, for example a Workers Analytics Engine dataset.

## Meetings for later

"New meeting" has an arrow with "Get a link for later" and "Schedule…". There is no calendar item
in the call: while a meeting runs, the people an invitation would go to are in it. When it ends,
the host's leave screen offers "Schedule a follow-up", on the same link (so they stay its host).
The link is made the way an instant meeting's is, so whoever makes it is its
host, and it never expires. Title and time go only into the calendar entry
(`src/lib/calendar.ts`): a Google Calendar, Outlook.com or Microsoft 365 link, or an .ics file with a ten-minute
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

Admit all and Deny all are one request however many people are waiting. If some of them could
not be answered, the host gets one notification with how many, and "Try again" answers just
those. On RealtimeKit our server only says yes, and the host's own browser then answers the
waiting room through the SDK (one message for Admit all, one per person for Deny all).

**Allow reactions** (People › ⋯, host and co-hosts) is kept in the meeting's record and is
enforced client-side only. Each browser disables its own react button and drops reactions that
arrive from anyone but the host and co-hosts while it is off, but reactions travel between
browsers without passing our server, so a modified client can still send one to anyone whose
browser does not drop it. On RealtimeKit a reaction names its sender itself, so one that claims
to come from the host is believed.

On LiveKit the record is the room's metadata, kept for a day after the last person leaves; after
that the code is new again. People who have to ask wait in a second room (`<code>.lobby`) with a
token that can do nothing, so nothing of the meeting reaches them; being let in sends them a
token for the meeting itself. On RealtimeKit the host's record lapses once the meeting is empty
and the host has not joined for thirty days.

## Webinars

**Words.** A **webinar** is a call where a few people present and everyone else watches. The
**speakers** are the people on stage (the host, and anyone the host brings up); the **audience**
is everyone watching. In a webinar the interface says "webinar" wherever a meeting would be named
("Leave webinar", "End webinar for everyone", "You left the webinar").

"New webinar…" (under the arrow next to New meeting on the home page) asks which kind
(`WebinarTypeDialog.tsx`): **Standard webinar**, described here, or **Serverless webinar (beta)**,
whose video goes browser to browser and never through a media server (`/live`, `src/components/live/`,
`packages/overlay`; up to 50 viewers, one person on camera). Standard can be chosen only while
webinars are on (`MEETLY_WEBINARS_ENABLED`); otherwise it is shown, disabled, with the reason.
"Standard webinar" makes a link whose record says it is a webinar. That is fixed for the life of the record: the link cannot become a meeting,
and a meeting's link cannot become a webinar. The browser that made it is the host. Everyone else
joins the audience: they watch and listen, raise a hand, react and vote in polls, and have no
microphone, camera, screen share or tile. Chat is read-only for them ("Only speakers and hosts can
send messages"). Their pre-join screen asks for a name only ("Watch"), so the browser never asks
them for a camera or microphone. Their bar holds "● Live · N watching" and the link on the left,
Raise hand, React and Leave in the middle, and Chat on the right, whose badge counts new messages
and polls waiting for a vote (`ViewerPreJoin.tsx`, `ViewerCall.tsx`, `ViewerControlBar.tsx`).

The host and co-hosts bring someone on stage from People › Audience, where raised hands come first
in the order they went up ("Invite to speak", one person at a time). The invitation is a dialog
that asks first, with the person's camera preview and microphone and camera switches in it from
the start: nothing of theirs is sent until they choose "Join stage" ("Not now", or Esc, turns it
down; `StageInvite.tsx`). On stage they get the meeting's screen, with "● Live · On stage" where the
clock is (in the top bar on a phone), which holds "Back to audience". The host can send them back
too, from their menu. Going back stops whatever they were sending.

A speaker can chat, the audience cannot, and nobody is ever one without the other: the stage and
the chat permission change together or not at all. People › Speakers lists who is on stage;
"Left the webinar" lists speakers and co-hosts who left, never the audience, whose comings and
goings show only in the Audience count, with no notification or sound. Audience reactions are
shown without a name.

**Co-hosts** moderate from the audience: People with the Audience, hands, the waiting list and
the host's controls (Invite to speak, Back to audience, mute), and the chat. They are on stage
only if invited, and cannot end the webinar or appoint co-hosts. Someone made co-host (or no
longer one) reconnects with a fresh token for the same person, which shows "Switching to co-host…"
for a second or two, the same on both providers.

How many may watch at once is `MEETLY_WEBINAR_VIEWER_CAP` (250 unless set). Past it, people are
told "This webinar is full" and can try again; the host always gets in. Every check made before
someone joins a webinar is in `src/lib/webinarGate.server.ts`.

The record is marked like this, for anything on the server that needs to know:

- **LiveKit:** `mode: "webinar"` in the room's metadata (`parseRoomMeta(...).mode` in
  `src/lib/host.server.ts`). The audience's tokens cannot publish, so LiveKit itself refuses
  their media. Inviting someone is `RoomService.updateParticipant`: our server gives them the
  right to publish together with a `stage: "invited"` attribute, and they count as audience until
  their own client clears it by saying yes. Sending them back takes the right away again. Chat
  goes through our server, which takes messages from whoever may publish, the host and co-hosts.
  `src/lib/webinar.server.ts` holds those rules; anyone may send themselves back.
- **RealtimeKit:** one more `meetly-…` record, `meetly-mode:webinar` (`readRecord(...).mode` in
  `src/lib/rtc/server/realtimekit.ts`). Three presets, all `view_type` WEBINAR:
  - `REALTIMEKIT_WEBINAR_HOST_PRESET` (`meetly-webinar-host`): the host, who goes straight on stage;
  - `REALTIMEKIT_WEBINAR_VIEWER_PRESET` (`meetly-webinar-viewer`): the audience, whose media is
    "can request" and who cannot send chat;
  - `REALTIMEKIT_WEBINAR_COHOST_PRESET` (`meetly-webinar-cohost`): co-hosts, also "can request",
    with the moderation the host's controls need. A new co-host's record is switched to it and
    given a fresh token (`realtimeKitWebinarRejoin`); this is the one place to change if
    RealtimeKit applies a preset change to someone already connected, which has not been tried.

  The stage is RealtimeKit's own (`meeting.stage`): inviting is `grantAccess`, which puts them in
  `ACCEPTED_TO_JOIN_STAGE`; saying yes is their `stage.join()`; sending back is `kick` (on stage)
  or `denyAccess` (invited, not answered). Our server checks the caller is the host or a co-host
  first. Their chat is turned on and off with the SDK's `participants.updatePermissions` (the REST
  API has no call for a live participant's permissions), which needs
  `can_change_participant_permissions` on the inviter's preset; whoever cannot do both is not
  offered "Invite to speak". Who is on stage is read from the participants the SDK already
  announced and their `stageStatusUpdate` events; `getAllJoinedPeers()` (10 calls a minute) is
  never called. The audience limit is counted from the active session's `live_participants`,
  which includes the people on stage. `test/e2e/realtimekit-webinar-rest.cjs` checks the presets
  and the co-host token against the real REST API (it is not part of the browser suite).

Viewer names are shown to the host and co-hosts only, by the interface: other people never see
the audience list, the names of audience hands, or who voted for what in a named poll (they see
the counts). On both providers the audience is in the same room as everyone else, so a modified
client could still read them.

## Webinar costs

Webinars are free and anyone can start one, but on RealtimeKit every viewer is a billed
participant-minute (10,000 a month are included, then about $0.002 a minute). Two settings keep
that in hand:

| Variable | Default | What it does |
| --- | --- | --- |
| `MEETLY_WEBINARS_ENABLED` | on | Set to `0`, `false`, `off` or `no` to switch webinars off at once: "Standard webinar" can no longer be chosen, the server refuses to start one or to let anyone into one ("Webinars are paused right now."), and the watchdog ends the ones running. Ordinary meetings are not affected. It is read on every request, so on the Worker a change to the variable takes effect with the next request, without a rebuild. |
| `MEETLY_WEBINAR_MINUTE_LIMIT` | 5000 | The most participant-minutes one webinar session may use. At 80% the host and co-hosts are told roughly how long is left; past it the session is ended for everyone ("This webinar reached its free time limit.") and its link stops letting anyone in. |

The watchdog (`src/lib/costGuard.server.ts`) runs once a minute on the Cloudflare Worker, as a
Cron Trigger. Each run lists the app's live sessions in one call. A session that cannot yet be
near the warning (its largest audience times its length is under 80% of the limit) costs nothing
more. For the others it reads the meeting's record (to make sure it is a webinar, and see what
was already done) and the session's participants, adds up each person's connected time, and
writes at most two records. A run makes at most 30 calls, well inside RealtimeKit's 3,500 per five
minutes; what does not fit, or fails, is done the next minute. It never joins a session. Before
removing anyone it writes a `meetly-limit:<session>` record, so every client that is removed asks
our server why and shows the right ending. Everyone removed asks at the same moment, so our server
shares one lookup of the record between them (and keeps a "limit" answer for a minute): 250
viewers cost about three REST calls per Worker instance, not one lookup each.

Limits and what is not covered:

- **Precision.** The count is each participant's own connected time, to the second, as
  RealtimeKit reports it (a reload is a new connection, counted from when it joined), or
  RealtimeKit's own `minutes_consumed` for the session where that is higher. A webinar is ended
  in the first run after it passes the limit, so up to a minute late (about 250 minutes at 250
  viewers), plus however Cloudflare rounds each participant's minutes when it bills.
- **A missed run** changes nothing but timing: the next one counts from the participants'
  timestamps, not from the last run, so nothing is lost; the warning or the ending simply comes
  later. Nothing ends a webinar while the Cron Trigger is not running.
- **The warning** reaches the host and co-hosts through their own clients, which ask our server
  once a minute during a webinar (our server cannot push to a RealtimeKit client).
- **LiveKit** is not billed per minute, so there is no watchdog there; the switch still applies.
- A webinar link that reached the limit stays closed. Starting a new webinar gives a new link,
  with a new limit.

## How it fits together

| Piece | Where |
| --- | --- |
| The call as the UI sees it, and the two provider adapters | `src/lib/rtc/types.ts`, `react.tsx`, `livekit.ts`, `realtimekit.ts` |
| Token minting (server only, holds the API secret) | `src/app/api/token/route.ts` |
| Pre-join → in-call → left flow | `src/components/Meeting.tsx` |
| Pre-join screen (preview, device pickers) | `src/components/PreJoin.tsx`, `src/lib/usePreviewMedia.ts` |
| Stage, panels, shortcuts | `src/components/Conference.tsx` |
| Notifications: the rules, and how they are shown | `src/lib/notices.ts`, `src/components/ui/Toaster.tsx` |
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
| Connection quality, the weak-connection notice, using less data | `src/lib/callHealth.ts`, `src/lib/useCallHealth.ts`, `src/components/CallQuality.tsx` |
| Usage events and the leave-screen rating (sent nowhere) | `src/lib/usage.ts` |
| Design tokens, motion, shared UI primitives | `src/app/globals.css`, `src/components/ui/` |
| Meeting code format | `src/lib/code.ts` |

Media never touches this app: browsers connect straight to the provider with a short-lived token.

## Filling a meeting with bots

To try a meeting at size by hand, `scripts/join-bots.cjs` sends headless test bots into a live meeting through the real join screen:

```bash
npm install --no-save playwright && npx playwright install chromium   # once
node scripts/join-bots.cjs https://meet.nandeesh.dev/abc-defg-hij 20  # bots, then minutes (15) and how many show a camera (4)
```

Bots join with the microphone off; in a meeting where people ask to join, they wait to be let in. They leave by themselves after the given minutes, or on Ctrl+C. Each bot is a real participant, so on RealtimeKit it uses participant-minutes (20 bots for 15 minutes is 300). Run it from a computer with ordinary internet access: a sandbox that only lets HTTPS out through a proxy can't carry the meeting's media.

## Deploying

Production is the Cloudflare Worker `meetly` at https://meet.nandeesh.dev, built with
[`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare) from the `cloudflare-deploy`
branch. Since 2026-11-23 `main` holds the same Workers files (`wrangler.jsonc`,
`open-next.config.ts`, `.env.production` with `NEXT_PUBLIC_RTC_PROVIDER=realtimekit`), and
`cloudflare-deploy` is `main` as of its last release. GitHub Actions does the rest.

**The release process is in [docs/RELEASING.md](docs/RELEASING.md).** In short: feature branch →
pull request to `main` (CI must pass) → staging deploys `main` (once set up) → a release pull
request from `main` to `cloudflare-deploy`, merged with **Create a merge commit** → Deploy runs
CI again and deploys to production. Both branches are protected: nobody, admins included, pushes
to them directly (`scripts/protect-branches.sh` sets this up). The same document covers the
emergency path (deploying with `skip_tests`), rolling back, flaky tests and re-running a job.

### What runs when

| When | Workflow | What it does |
| --- | --- | --- |
| A pull request, or a push to any branch except `cloudflare-deploy` | **CI** (`.github/workflows/ci.yml`) | `npm ci`; `next typegen` and `tsc --noEmit`; lint; `npm test`; `next build` once with `NEXT_PUBLIC_RTC_PROVIDER=livekit` and once with `realtimekit`; every browser-test suite (`node test/e2e/run.cjs`) in Chromium against a LiveKit build and the official `livekit-server` release run with `--dev`. A suite that fails is run once more; if it then passes, the job passes and the suite is reported as "flaky: passed on retry" in the log, as a warning and in the run's summary. If the browser tests fail, their screenshots and the server logs are attached to the run as an artifact. A newer push to the same branch or pull request cancels the run it replaces. |
| A push to `cloudflare-deploy` (a merged release pull request), or **Actions → Deploy → Run workflow** on `cloudflare-deploy` | **Deploy** (`deploy.yml`) | The same CI jobs (skipped only by the emergency `skip_tests` input, docs/RELEASING.md). Only if all of them pass: in the `production` environment, `npx opennextjs-cloudflare build`, `npx opennextjs-cloudflare deploy`, then a smoke test of https://meet.nandeesh.dev. The run's summary shows the URL and the new Worker version id. |
| **Actions → Rollback → Run workflow** | **Rollback** (`rollback.yml`) | Lists the Worker's recent deployments and versions, or puts an earlier version back (see below). |

- Deploys never overlap, and a rollback never overlaps a deploy. A deploy that arrives while
  another is running waits; if two are waiting, only the newer one runs, so an older commit is
  never deployed over a newer one.
- The deploy is `opennextjs-cloudflare deploy`, never plain `wrangler deploy`: the former fills
  the page cache first, and without it every page returns 500.
- The smoke test (`scripts/smoke-test.mjs`, which you can also run yourself with
  `node scripts/smoke-test.mjs https://meet.nandeesh.dev`) waits until the home page is served
  by the build just deployed, then checks that the home page, a meeting page and one of its
  scripts return 200 with the expected content, and that `/api/meeting` answers a "peek" for a
  random code (200) and refuses a malformed one (400). It never asks for a token or joins a
  call, so it never creates a RealtimeKit participant. If it fails, the new version is live:
  look at the log and roll back if the site is broken.
- The Worker's own secrets (`CLOUDFLARE_API_TOKEN` with the Realtime permission, and
  `MEETLY_SESSION_SECRET`) stay on the Worker and are kept by every deploy. The workflows never
  set, read or print them.
- Workflow changes reach `cloudflare-deploy` the same way as everything else: with the next
  release pull request from `main`.

### One-time setup

1. **Create a Cloudflare API token for deploying.** This is a different token from the Worker's
   own `CLOUDFLARE_API_TOKEN` secret (that one only needs Realtime). In the Cloudflare dashboard:
   **Manage account → Account API tokens → Create Token**; under **Permission policies** open
   the **Custom** dropdown and select **Edit Cloudflare Workers** ([Cloudflare: GitHub
   Actions][cf-gha]). That template grants ([Cloudflare: API token templates][cf-templates]):

   | Permission | Scope | Why Meetly needs it |
   | --- | --- | --- |
   | Workers Scripts: Edit (in the new roles, Workers **Editor**) | Account | Upload the Worker and its static assets, deploy versions, roll back ([Cloudflare: Workers roles][cf-roles]) |
   | Workers Routes: Edit | Zone `nandeesh.dev` | `wrangler.jsonc` attaches the custom domain `meet.nandeesh.dev`; adding or changing a Custom Domain needs this on the zone ([Cloudflare: Routes and Custom Domains][cf-routes]) |
   | Account Settings: Read | Account | Read-only; part of the template. Keep it |
   | User Details: Read, Memberships: Read | User | Read-only; part of the template. Keep them if the form offers them |
   | Workers Tail: Read | Account | Not needed to deploy; harmless (`wrangler tail`) |
   | Workers KV Storage: Edit, Workers R2 Storage: Edit | Account | Not needed: Meetly has no KV or R2 binding. You can delete these two rows |

   Then scope it: **Account Resources → Include → your account** only, and **Zone Resources →
   Include → Specific zone → nandeesh.dev**. Give the Workers permission for the whole account,
   not just the `meetly` Worker: Custom Domains do not support per-Worker roles yet
   ([Cloudflare: Workers roles, Limitations][cf-roles]).
2. **Add two secrets to GitHub:** the repository's **Settings → Secrets and variables → Actions
   → New repository secret**:
   - `CLOUDFLARE_API_TOKEN`: the token from step 1.
   - `CLOUDFLARE_ACCOUNT_ID`: the account id (the dashboard's account home page, or the
     `account_id` in `wrangler.jsonc` on `cloudflare-deploy`).

   Enter them only in GitHub's form; never paste them anywhere else. (Stricter, optional: add
   them under **Settings → Environments → production → Environment secrets** instead; only the
   deploy and rollback jobs, which run in that environment, can then read them.)
3. **Optional: require approval.** The `production` environment appears under **Settings →
   Environments** after the first deploy run (or create it there yourself). Turn on **Required
   reviewers** and add yourself: every deploy and rollback then waits for a click. Under
   **Deployment branches and tags** you can also allow only `cloudflare-deploy`.

### Approving a deploy

With required reviewers on, a deploy run stops at **Deploy to Cloudflare** once CI has passed,
showing "Waiting for review". Open the run (Actions → Deploy), press **Review deployments**,
tick `production` and **Approve and deploy** (or **Reject**). Nothing reaches Cloudflare before
that.

### Rolling back

Cloudflare keeps every uploaded version of the Worker (the latest 100, and anything newer than
30 days), and a rollback switches production back to one of them at once, without a rebuild
([Cloudflare: Rollbacks][cf-rollbacks]).

- **From GitHub:** Actions → **Rollback** → Run workflow. `list` shows the recent deployments
  and versions and changes nothing. `rollback` with the version left empty goes back to the
  version before the current one; with a version id (from `list`, a Deploy run's summary, or
  the dashboard) it goes back to that one. It then runs the smoke test.
- **From the dashboard:** Workers & Pages → `meetly` → **Deployments** → the version's **⋯** →
  **Rollback**.
- **From a terminal** (on `cloudflare-deploy`, after `npx wrangler login`):
  `npx wrangler deployments list`, `npx wrangler versions list`, then
  `npx wrangler rollback [<version-id>] --message "why"`
  ([Wrangler: rollback][wrangler-rollback]).

A rollback does not change the code: the next push to `cloudflare-deploy` deploys whatever is
there, so revert or fix the bad commit on `main` with a pull request and release again. If one of the Worker's
secrets was changed after the older version was deployed, Wrangler asks for confirmation (the
workflow confirms); the run's log says so. Pages opened before a rollback may still ask for the
newer version's scripts until they are reloaded ([Cloudflare: Version skew][cf-skew]).

### Preview deploys for pull requests

Not set up, on purpose. `npx opennextjs-cloudflare upload` (`wrangler versions upload`) would
upload a version without deploying it, but a version's URL "runs one uploaded version against
your production resources" ([Cloudflare: Version URLs][cf-version-urls]): with Meetly's Worker
secrets, anyone with a preview link could create billed RealtimeKit meetings and participants.
Preview URLs are also switched off for this Worker (`"preview_urls": false` in
`wrangler.jsonc`), the deploy job only runs for `cloudflare-deploy`, and pull requests from
forks get no secrets. Cloudflare's Previews, which have their own secrets and
bindings, would be the way to add them later.

[cf-gha]: https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
[cf-templates]: https://developers.cloudflare.com/fundamentals/api/reference/template/
[cf-roles]: https://developers.cloudflare.com/workers/authorization/workers/
[cf-routes]: https://developers.cloudflare.com/workers/authorization/workers/#routes-and-custom-domains
[cf-rollbacks]: https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/
[cf-skew]: https://developers.cloudflare.com/workers/versions-and-deployments/version-skew/
[cf-version-urls]: https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/
[wrangler-rollback]: https://developers.cloudflare.com/workers/wrangler/commands/workers/#rollback

## Other hosts

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

The Worker's entry is `custom-worker.ts`, not OpenNext's `.open-next/worker.js` directly: it
passes every request to OpenNext's handler and adds a `scheduled` handler, the webinar cost
guard, which the Cron Trigger in `wrangler.jsonc` (`triggers.crons`) runs once a minute (see
"Webinar costs" above). `MEETLY_WEBINARS_ENABLED` and `MEETLY_WEBINAR_MINUTE_LIMIT` are `vars`
there. To switch webinars off at once, set `MEETLY_WEBINARS_ENABLED` to `0` in the dashboard
(Workers → meetly → Settings → Variables), which deploys that change straight away, and then in
`wrangler.jsonc`, or the next deploy turns them back on. `npx wrangler dev --test-scheduled`
runs the handler locally on `/__scheduled`; without `CLOUDFLARE_API_TOKEN` in `.dev.vars` it
does nothing and logs `"skipped":"not-configured"`.
