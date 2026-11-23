# The Meetly overlay: specification

A self-healing peer-relay overlay that carries a webinar's program feed from the host's browser
to a large audience. Viewers relay encoded media to each other. No media server is involved.

This document is the single source of truth for the engine in `packages/overlay/`. The wire
formats in §4–§6 are implemented, with tests, in `packages/overlay/protocol.ts`; if this document
and that file disagree, that is a bug in both, fixed in one change. Who builds what, and in what
order, is in [PLAN.md](./PLAN.md).

Where the research report (the proof and its design notes) did not say what to do, a decision was
made here. Each is marked **[D*n*]** and listed in §16, so it can be found and argued with.

Contents: 1 Scope · 2 Terms · 3 Architecture · 4 Packets · 5 Links · 6 Coordinator · 7 State
machines · 8 Scoring · 9 The program feed · 10 Jitter buffer and playout · 11 Congestion ·
12 Metrics and the gate · 13 Harness · 14 Security · 15 Stages · 16 Decisions · 17 Baselines

---

## 1. Scope

**Stage 1 builds this:** in a webinar, the audience is fed by the overlay. The stage (the host
and the speakers) stays on the existing provider, LiveKit or RealtimeKit, untouched. The host's
browser encodes one *program feed* (one video stream and one Opus audio stream) with WebCodecs
and seeds one tree of viewers. A coordinator admits people, signs grants, keeps a map of the
tree, places joiners and relays WebRTC signalling.

**The go/no-go gate for stage 1** (measured as §12.3 defines, by the harness of §13):

| Measure | Limit |
| --- | --- |
| Repair time, p95 | under 500 ms |
| Glass-to-glass latency, p95 | under 500 ms |
| Join time, p95 | under 3 s |
| At | 200 peers, with injected loss and churn |

**Not in stage 1**, but nothing below may need rewriting to add them: several trees per stream
with stripes, a parity stripe, SFrame end-to-end encryption, signed moderation grants, Safari and
Firefox viewers, phones, gossip repair, and 1,000- and 10,000-peer runs. §15 says where each one
fits.

**Never in scope:** conversation. Every hop adds delay, and talkers tolerate about two. Speakers
stay on a low-latency stage.

## 2. Terms

- **Session**: one webinar's overlay, from the host starting the program to its end. One
  coordinator per session. Named by Meetly's meeting code (`room`).
- **Peer**: one browser tab in a session. Named by a `PeerId` the coordinator mints.
- **Source**: the peer that encodes the program. One per session: the host's browser.
- **Relay**: a peer that forwards to other peers. **Leaf**: a peer that forwards to nobody.
- **Stream**: one encoded media stream. Stage 1 has two: video (`streamId` 0) and audio (1).
- **Stripe**: a part of a stream that travels down one tree. Stage 1: one stripe (0) per stream,
  carrying everything. A (stream, stripe) pair is the unit that has a parent.
- **Parent / child**: for a stripe, who a peer receives from, and who it sends to.
- **Backup**: a second peer, already connected and standing by, that becomes the parent if the
  parent dies.
- **Link**: the connection between two peers. At most one per pair, whatever flows on it.
- **Depth**: hops from the source. The source is 0.
- **Path**: a peer's ancestors: itself, its parent, … the source.
- **GOP**: a keyframe and the frames that follow it, up to the next keyframe.
- **Session clock**: milliseconds since the coordinator started the session (§4.1).

## 3. Architecture

### 3.1 Who talks to whom

```
                          Meetly's server (Next.js)
                          checks the webinar gate, signs a ticket
                                     |
                                     | ticket (in the browser's hands)
                                     v
    +----------------------- coordinator (one per session) ------------------------+
    |  admission · grants · tree map · placement · signalling relay · metrics      |
    +----^---------------^--------------------^-------------------^----------------+
         | WebSocket     | WebSocket          | WebSocket         | WebSocket
         | (JSON)        |                    |                   |
    +----+----+     +----+----+          +----+----+         +----+----+
    | source  |====>| relay A |=========>| relay C |========>| leaf E  |
    | (host)  |     +---------+          +---------+         +---------+
    |         |====>| relay B |=========>| leaf D  |
    +---------+     +----+----+          +---------+
        ^                :...................^   standby link: heartbeats only
        |
   the stage, on LiveKit or RealtimeKit (unchanged): the host composes it into the program

    ====>  a link: WebRTC data channels, media and control      ....>  a warm backup
```

The coordinator never carries media. A peer that is already watching keeps watching, and keeps
repairing, while the coordinator is unreachable; only joining needs it (§7.5).

### 3.2 A link

A link is one `RTCPeerConnection` with two data channels, both created with `negotiated: true`
so that neither side waits for a `datachannel` event:

| Channel | id | Settings | Carries |
| --- | --- | --- | --- |
| `ctl` | 0 | reliable, ordered | `PeerMessage`s as JSON text (§5.3) |
| `media` | 1 | unordered, `maxRetransmits: 0` | every binary packet (§4) |

These are the proof's two channels. Channel id 2 is reserved for an audio channel of its own,
should measurements show audio waiting behind video inside the browser's SCTP queue.

**[D1] Heartbeats travel on the `media` channel, not `ctl`.** The proof sent them on the reliable
channel. Under loss a reliable, ordered channel delays everything behind a lost packet until it
is retransmitted, and that delay is longer than the 200 ms that means "dead". A heartbeat that
can be lost is better than one that can be late.

### 3.3 Data flow

At the source, per encoded frame:

```
camera/stage -> compose -> VideoEncoder / AudioEncoder        (media)
             -> packetizeFrame -> GOP cache                   (protocol, topology)
             -> for each child: LayerGate.admit ? send : drop (congestion, transport)
```

At every other peer, per packet received from the parent:

```
Link 'packet' -> decodeMediaHeader -> duplicate? drop
              -> GOP cache                                    (topology)
              -> for each child: LayerGate.admit ? writeHopFields + send   <- forwarding: no decode,
              -> Reassembler -> whole frame?                                  no wait for the frame
                    -> JitterBuffer -> decoder -> screen / loudspeaker     (media)
```

Forwarding happens before, and independently of, this peer's own playout: a relay sends each
packet on as it arrives. The proof measured about 0.45 ms per hop for this path.

### 3.4 Modules

`packages/overlay/` is plain TypeScript: no React, no Next.js, nothing from `src/`. ESLint
enforces both directions (`eslint.config.mjs`).

| Module | Knows about | Does not know about |
| --- | --- | --- |
| `protocol.ts` | bytes and JSON on the wire | everything else |
| `transport/` | peer connections, channels, packets, frames | trees, bitrates, codecs |
| `topology/` | parents, backups, heartbeats, repair, the GOP cache, forwarding | codecs, sockets |
| `congestion/` | numbers about a link; whether a frame fits | links, timers, channels |
| `media/` | capture, encode, jitter buffer, decode, sync, playout | links, peers |
| `coordinator/` | who is in a session and where; the browser's client for it | media |
| `harness/` | all of the above, Playwright, Node | nothing depends on it |

Every module takes its clock and timers from outside (`runtime.ts`: `Clock`, `SessionClock`).
Nothing calls `Date.now`, `performance.now`, `setTimeout` or `setInterval` directly. That is
what makes each state machine below a unit test.

**[D2] The forwarding path must be able to move to a Worker.** `RTCDataChannel` is transferable
in Chromium, and a hidden tab's main thread is throttled. Stage 1 runs on the main thread; the
`transport` and `topology` interfaces touch no DOM object except the channel itself, so the move
needs no interface change.

---

## 4. Packets (the `media` channel)

All integers are unsigned and big-endian unless said otherwise. The first byte of every packet
is `version << 4 | type`. The version is 1.

| Type | Name | Direction | Purpose |
| --- | --- | --- | --- |
| 0 | MEDIA | parent → child | one fragment of one encoded frame |
| 1 | PARITY | parent → child | a parity symbol (stage 2; §4.8) |
| 2 | HEARTBEAT | parent → child | I am alive; this is where I am |
| 3 | FEEDBACK | child → parent | what arrived, and how |
| 4 | NACK | child → parent | send these fragments again |
| 5 | PROBE | either | padding, to measure a link |

**Rules for every receiver.** A packet of another version, of an unknown type, shorter than its
type requires, or otherwise malformed is dropped and counted; it never throws and never closes
the link. Unknown flag bits are ignored. Reserved bytes are sent as 0 and not checked. This is
what lets a later version add types and flags without breaking an older peer.

The largest packet is **1,150 bytes**, header included (`MAX_PACKET_BYTES`) **[D3]**: an IPv6
minimum-MTU path (1,280) less IP, UDP, DTLS and SCTP overhead, with room for a TURN header. The
proof sent each frame as one message and let SCTP fragment it; on an unreliable channel that
turns one lost IP packet into one lost frame. Fragmenting ourselves makes a loss cost one
fragment, which can be asked for again (§4.6).

### 4.1 The session clock

Every timestamp that leaves a peer is on the session clock: milliseconds (or microseconds, where
said) since the coordinator started the session.

A peer finds its offset with `time` probes on the coordinator's socket (§6.3): it sends its own
clock `t0`, the coordinator answers with `t0` and its session clock `t1`, and the peer notes its
own clock `t2` on arrival. The round trip is `t2 − t0`; the session clock at `t2` is taken to be
`t1 + (t2 − t0) / 2`. The peer sends five probes 100 ms apart on joining and one every 30 s
after, keeps the sample with the shortest round trip of the last eight, and moves toward a new
offset by at most 1 ms per second, so playout never jumps. Half that sample's round trip is the
clock's `uncertaintyMs`. **[D4]**

Glass-to-glass latency is measured between two session clocks, so it is wrong by up to the sum
of the two peers' uncertainties. Every report states that sum (§12.3).

### 4.2 MEDIA: the header

30 bytes, then the payload. The first 24 bytes are written by the source and are identical on
every hop; with SFrame they are authenticated as associated data (§15.2). The last 6 are
rewritten by each sender for each receiver.

```
 off  size  field       meaning
 ---  ----  ----------  end-to-end: written by the source ---------------------------------
   0     1  vt          version (high 4 bits) | packet type (low 4 bits)
   1     1  flags       bit 0 KEY          keyframe
                        bit 1 SFRAME       payload is SFrame ciphertext (stage 2)
                        bit 2 DISCARDABLE  no frame depends on this one
                        bit 3 END          the stream's last frame
   2     1  streamId    which stream of the session
   3     1  stripe      which stripe of the stream
   4     1  layer       spatial layer (high 4 bits) | temporal layer (low 4 bits)
   5     1  refDelta    frameId minus the frame this one needs; 0 = needs none
   6     2  keyDelta    frameId minus its GOP's keyframe; 0 on a keyframe
   8     4  frameId     counts the stream's frames from 0
  12     2  fragIndex   which fragment of the frame this is
  14     2  fragCount   how many fragments the frame has, 1..65535
  16     6  captureUs   when the frame was captured: session clock, microseconds
  22     1  configId    which StreamConfig the frame was encoded under
  23     1  reserved    0
 ---  ----  ----------  per hop: rewritten by each sender ---------------------------------
  24     1  hopFlags    bit 0 REPLAY      sent from the GOP cache, not live
                        bit 1 RETRANSMIT  sent again in answer to a NACK
  25     1  hops        0 from the source, +1 at each relay
  26     2  linkSeq     counts every packet this sender sends on this link, all types
  28     2  sendMs      low 16 bits of the sender's millisecond clock at sending
```

- **`frameId`** counts encoded frames of one stream, over all its layers and stripes, from 0.
  It does not wrap in any session (2³² frames at 30 a second is 4.5 years).
- **`refDelta`** names the one frame this frame needs decoded first. With temporal layers every
  frame has at most one such frame; that is all a receiver needs to order frames and to know
  which can be dropped, without reading a payload that SFrame will make unreadable. The proof
  carried the same fact as an absolute `dep`.
- **`keyDelta`** tells a receiver which keyframe starts the GOP, so "replay from the keyframe" is
  a frame id. 65,535 frames is the longest GOP.
- **`captureUs`** is the frame's presentation time, shared by audio and video, and what latency
  is measured from. 48 bits of microseconds is 8.9 years.
- **`linkSeq`** lets the receiver count what was lost on this one link (§11.1). **`sendMs`**
  lets it see a queue building (§11.1) and is echoed back for a round-trip time (§4.4).
- **`hops`** is the sender's depth. A packet arriving with `hops` ≥ 32 is dropped: a loop.

`packetizeFrame` splits a frame into packets of at most 1,120 payload bytes. An audio frame is
always one packet. `writeHopFields` rewrites the per-hop section in place: `RTCDataChannel.send`
copies its argument, so a relay uses one buffer for all its children in turn.

**[D43] Keyframes are paced** (decided by integrator 2026-11-21). A keyframe bigger than two
frame intervals of *B* is not handed to a child's channel in one burst: its packets are spread
evenly so that the last leaves two frame intervals after its own (three intervals from its
first packet: 100 ms at 30 fps). What arrives for that child behind it (a later frame) waits
its turn, so frames leave in order; audio, control, retransmissions and replays do not wait.
Each child is paced on its own, at every hop, from when the keyframe reaches that relay.

### 4.3 What a stream is

A stream is described by a `StreamConfig` (JSON; from the coordinator in `welcome`, and again
from the parent in `sub-ack`, so that a repair does not need the coordinator):

```
id, kind ("video" | "audio"), configId, codec (a WebCodecs codec string), bitrateKbps,
width, height, fps                    (video)
sampleRate, channels, frameUs         (audio)
scalability ("L1T3"), keyIntervalFrames
stripes: [{ index, kind: "data" | "parity", temporal: [layers it carries] }]
sframe (boolean), description (base64url decoder configuration, for codecs that need one)
```

A change to anything a decoder is configured with gets a new `configId`, announced with a
`config` peer message before the first frame that uses it, and that frame is a keyframe.

### 4.4 HEARTBEAT

Parent to child: every `heartbeatMs` (50) on a link with an active subscription, every
`standbyHeartbeatMs` (250) on a standby link.

```
   0  1  vt                      6  2  echoMs      sendMs of the last packet received from the peer
   1  1  flags                   8  2  echoHoldMs  ms between receiving it and sending this; 0xffff = none
   2  2  linkSeq                10  1  depth       the sender's depth; 255 = not known
   4  2  sendMs                 11  1  n           then n × { streamId u8, headFrameId u32, keyFrameId u32 }
```

Flags: bit 0 **STALLED** (I have lost my own parent and am repairing; §7.4), bit 1 **LEAVING**,
bit 2 **FULL** (no free slot), bit 3 **STANDBY** (this link is standby).

`headFrameId` is the newest frame the sender has forwarded whole; `keyFrameId` the newest
keyframe in its GOP cache. A child reads from them how far behind it is, and what a replay would
start from.

Any packet from the parent proves it alive. The heartbeat is there for when there is no media,
and to carry the echo: the receiver's round-trip time is
`now − echoMs − echoHoldMs` (mod 2¹⁶), with no clock agreement needed.

### 4.5 FEEDBACK

Child to parent, every `feedbackMs` (100). 26 bytes. It is also how a parent knows a child is
still there: none for `childDeadMs` (1,000) and the child is dropped.

```
   0  1  vt                     12  2  received        packets that arrived in this interval
   1  1  flags                  14  2  expected        packets that should have (from linkSeq)
   2  2  linkSeq                16  2  jitter          interarrival jitter (RFC 3550), 0.1 ms units
   4  2  sendMs                 18  2  queueDelay      one-way delay above its floor, 0.1 ms units
   6  2  echoMs                 20  2  playoutDelayMs  the receiver's playout delay target
   8  2  echoHoldMs             22  2  bufferMs        media held ahead of playout
  10  2  highestSeq             24  1  max spatial (high 4 bits) | max temporal (low 4 bits) wanted
                                25  1  reserved
```

Flags: bit 0 **STANDBY**, bit 1 **STARVED** (my playout is stalling for want of data from you).

### 4.6 NACK

Child to parent. **[D5] Stage 1 recovers loss hop by hop, by asking again.** The report's answer
to loss is the parity stripe, which is stage 2; the gate has injected loss in stage 1. Each hop
is short, so one round trip to the parent fits inside the playout delay (§10.2).

```
   0  1  vt        2  2  linkSeq      6  n × { streamId u8, frameId u32, firstFrag u16, mask u16 }
   1  1  n         4  2  sendMs
```

Each item asks for fragment `firstFrag` and each fragment `firstFrag + 1 + i` whose bit `i` is
set in `mask`. `firstFrag` = 0xffff asks for the whole frame (none of it arrived, so its
fragment count is unknown). At most 64 items.

Rules:

- A fragment is asked for once it is *due*: a later packet has arrived and the reordering
  window has passed. It is asked for at most `nackRetries` (1) more times, an RTT apart.
- **[D39] The reordering window follows the jitter** (decided by integrator 2026-11-21; it was a
  fixed 10 ms, **[D6]**). It is max(10 ms, the p95 of the stream's inter-arrival jitter), at most
  60 ms. Jitter is RFC 3550's |D| with the frame's `captureUs` as the media timestamp, over the
  last 256 live video packets from the parent, read every 250 ms. That is the stream as it
  arrives, every hop's reordering in it: a relay forwards in the order packets reached it, so the
  link's own jitter would miss the hops above. Replays and retransmissions are left out: they are
  late on purpose. A loss is declared only once the window has passed, and the retries keep
  their RTT spacing on top of it. With 0–40 ms of jitter (the gate mix's "bad"), a 10 ms window
  asked for about four packets for each one really lost; this one asks for fewer than two.
- Nothing is asked for that playout no longer wants (§10): a discardable frame past its time, or
  anything older than the oldest frame the jitter buffer still holds a place for.
- The parent answers from its GOP cache with the RETRANSMIT hop flag. What is no longer in the
  cache is not answered.
- A parent spends at most 20% of the stream's bitrate on retransmissions to one child, over any
  second. Beyond that it ignores NACKs. This bounds what a hostile child can cost.
- **[D36] Nothing is sent again into a backlog** (decided by integrator 2026-11-21). While a
  child's link holds more than §11.2's strained line (50 ms of *B*), its NACKs for the
  enhancement layers are not answered: a link that overflowed asks for what it lost, and
  answering refills the queue it lost it from. NACKs for base-layer (layer 0) and keyframe
  packets are still answered, within the same budget, because losing a keyframe costs the whole
  GOP: the parent holds them and sends them once the backlog is under the line again, or drops
  them after 500 ms, by when they would come too late.
- A relay does not wait for its own recovery before forwarding. A fragment it recovers late is
  forwarded when it arrives; its children will meanwhile have asked for it themselves, and the
  answer serves them.

### 4.7 PROBE

`vt`, a zero byte, `linkSeq`, `sendMs`, then padding to the size wanted. It counts in feedback
like any other packet. Used to measure spare uplink before a peer is made a relay (§8.1).

### 4.8 PARITY (stage 2, reserved now)

A parity packet has the MEDIA header with type 1, travels on a stripe whose `kind` is "parity",
and is forwarded, cached and counted exactly as a media packet: a stage-1 relay needs no change
to carry one. How its header fields name the packets it protects, and its payload, are fixed in
stage 2 (§15.1). A stage-1 receiver drops it.

---

## 5. Links

### 5.1 Making a link

Either side may start. Signalling (`SignalData`: an SDP description or an ICE candidate) goes
through the coordinator (`signal`, §6.3). Both sides may start at once: the link uses the
"perfect negotiation" pattern, and the *polite* side, which gives way, is the one whose `PeerId`
sorts later. **[D7]**

ICE servers come from `welcome`. A peer first tries without a relay. The link's `turn` property
says whether the chosen route goes through TURN.

### 5.2 `hello`

The first message each side sends on `ctl` is `hello { v, peer, grant }`. The other side checks
the grant (§6.5) with the session's public key: signed, for this session, naming that peer, not
expired. Until a valid `hello` has arrived, every other message and every packet from that side
is dropped; an invalid one, or none within 5 s, closes the link ("auth-failed").

### 5.3 Peer messages

JSON text on `ctl`. Each has a `t`. Anything that does not parse as exactly one of these is
dropped and counted; three in a row close the link. Unknown fields are removed on decoding, so
they are never passed on.

| `t` | From | Fields | Meaning |
| --- | --- | --- | --- |
| `hello` | both | `v`, `peer`, `grant` | §5.2 |
| `sub` | child | `id`, `stream`, `stripes`, `mode`, `fromFrame`, `maxSpatial`, `maxTemporal` | subscribe; **subscribe-from-frame** (below) |
| `repair` | child | `id`, `stream`, `stripes`, `fromFrame`, `dead` | my parent `dead` is gone; you are my parent now (§7.5) |
| `sub-ack` | parent | `id`, `ok`, `code?`, `config?`, `headFrame?`, `keyFrame?`, `path?`, `maxTemporal?` | the answer to `sub` or `repair` |
| `unsub` | child | `stream`, `stripes` | stop sending |
| `layers` | either | `stream`, `maxSpatial`, `maxTemporal`, `reason` | child: send me no more than this. Parent: I am sending you no more than this (§11.3) |
| `path` | parent | `path` | my path to the source changed |
| `peers` | either | `peers` | other peers you could connect to |
| `sig` | either | `to`, `from`, `ttl`, `data` | signalling carried over the overlay (stage 3; §15.3) |
| `config` | parent | `stream` (a `StreamConfig`) | a stream's configuration changed |
| `keyreq` | child | `stream` | I need a keyframe (stage 2; §9.3) |
| `bye` | either | `reason`, `alt?` | I am closing this link; `alt` is where to go instead |

**`sub`.** `mode: "active"` asks for media. `mode: "standby"` asks for heartbeats only and a
held place (§7.3). `fromFrame` says where an active subscription starts:

- a frame id *X*: send everything after *X*. The parent replays from its GOP cache every packet
  of every frame newer than *X* that the subscription covers, then continues live. If *X* is
  older than the cache reaches, it starts from the newest keyframe instead.
- `−1` (`FROM_LATEST_KEYFRAME`): start from the newest keyframe in the cache. What a joiner
  sends.
- `−2` (`FROM_LIVE`): replay nothing.

**`sub-ack`** with `ok: false` carries a `code`: `full` (no slot), `no-stream`, `loop` (you are
one of my ancestors), `denied`, `leaving`. With `ok: true` it carries the stream's `config`, the
parent's `path`, and the highest temporal layer the parent will send for now.

---

## 6. The coordinator

One per session. It handles admission, grants, the tree map, placement and signalling. It does
not handle media, and it is not on the repair path.

Its logic is one class, `CoordinatorCore`, which does no I/O: it is told what happened (a socket
opened, text arrived, time passed) and answers with a list of effects (send this, close that,
wake me at this time, store this). Two thin entry points run it: a Cloudflare Durable Object for
production, and a Node WebSocket server for tests. Because both run the same core, they cannot
behave differently; one contract test suite runs against both. **[D8]**

### 6.1 Admission: tickets

There are no accounts in Meetly; its server already decides who may join a webinar
(`src/lib/webinarGate.server.ts`, the pass cookie). The coordinator trusts that decision through
a **ticket**: `<base64url JSON>.<base64url HMAC-SHA-256>`, signed with a secret the two servers
share (`OVERLAY_ADMISSION_SECRET`).

```
{ v, room, identity, name, role: "source" | "viewer", exp, nonce }
```

A ticket lives 60 seconds and is used once: the coordinator remembers each `nonce` until its
`exp`. The browser carries the ticket but can neither read meaning into it nor make one. **[D9]**

The coordinator itself enforces the audience limit (`viewerCap`): it is the one place that knows
how many are watching. The source is never refused.

### 6.2 HTTP

Under the coordinator's origin. The four `rooms` routes other than `ws` need
`Authorization: Bearer <OVERLAY_SERVER_SECRET>`: they are for Meetly's server, not for browsers.

| Method and path | Purpose |
| --- | --- |
| `GET /overlay/v1/health` | 200 when up |
| `GET /overlay/v1/rooms/:room/ws?ticket=…` | upgrade to the WebSocket of §6.3 |
| `GET /overlay/v1/rooms/:room/stats` | `{ viewers, relays, maxDepth, started, ended }`: for the webinar gate and the viewer count |
| `POST /overlay/v1/rooms/:room/end` | end the session for everyone (`{ reason }`) |
| `POST /overlay/v1/rooms/:room/kick` | remove `{ identity }` |
| `GET /overlay/v1/rooms/:room/tree` | the tree map (`RoomSnapshot`): debugging and the harness |

The Node entry point also serves `GET …/metrics` (every sample received) to the harness.

WebSocket close codes: 4001 bad ticket, 4002 full, 4003 kicked, 4004 ended, 4005 bad message,
4006 replaced by a newer socket of the same peer.

### 6.3 WebSocket messages

JSON text, one message per frame, each with a `t`.

**Peer to coordinator**

| `t` | Fields | Meaning |
| --- | --- | --- |
| `hello` | `v`, `caps`, `resume?` | first message. `resume { peer, grant }`: I was this peer a moment ago |
| `time` | `t0` | a clock probe (§4.1) |
| `signal` | `to`, `data` | signalling for another peer |
| `need` | `id`, `stream`, `stripe`, `want` ("parent" \| "backup"), `exclude` | I need someone to connect to |
| `status` | `depth`, `links`, `children`, `standby`, `free`, `caps`, `lossPct`, `rttMs` | where I am, every `statusMs` (5 s) and on change |
| `report` | `event`, `stream`, `stripe`, `peer`, `next?` | something happened, after the fact: `parent-dead`, `parent-switch`, `backup-lost`, `link-failed`, `child-gone` |
| `metrics` | `sample` | a `MetricsSample` (§12.1), every `metricsMs` (2 s) |
| `streams` | `streams` | the source says what it is sending |
| `bye` | | leaving |

**Coordinator to peer**

| `t` | Fields | Meaning |
| --- | --- | --- |
| `welcome` | `v`, `peer`, `room`, `role`, `grant`, `key`, `epochMs`, `ice`, `params`, `streams`, `assign` | you are in; everything needed to start |
| `time` | `t0`, `t1` | the answer to `time` |
| `signal` | `from`, `data` | signalling from another peer |
| `assign` | `id?`, `reason`, `assign` | connect to these (answers `need`, or unasked for a rebalance) |
| `role` | `role`, `grant` | you are now a relay, or no longer one |
| `grant` | `grant` | a fresh grant, before the old one expires |
| `streams` | `streams` | the streams changed |
| `hint` | `stream`, `bitrateKbps` | to the source: the audience would do better at this bitrate (§11.4) |
| `peer-gone` | `peer` | advisory: close any link to it |
| `kick` | `reason` | you are removed |
| `end` | `reason` | the session is over |
| `error` | `code`, `message`, `id?` | `bad-message`, `denied`, `full`, `not-found`, `rate`, `version`, `internal` |

`caps` (`Capabilities`) is what a peer says of itself: `browser`, `desktop`, `onPower`, `nat`,
`uplinkKbps`, `cores`, `decode` (codec strings), `dataSaver`, `visible`. It is a claim. §8 says
how far it is trusted.

`params` (`OverlayParams`) carries the timings and limits that this document refers to by name
(`heartbeatMs`, `deadMs`, `maxFanout` …), so a session, or a test, can run with
different ones without a release. `DEFAULT_PARAMS` in `protocol.ts` has stage 1's values, and
this document quotes them. Numbers given here without such a name are constants of the
implementation.

`assign` is a list of `Assignment { stream, stripe, parents: PeerHint[], backups: PeerHint[] }`,
candidates in the coordinator's order of preference. A `PeerHint` is `{ peer, depth, free,
region? }`.

Limits per peer, beyond which the coordinator answers `error rate` and, if it goes on, closes
the socket: 50 `signal` a second, 5 `need` a second, 2 `status` a second, 1 `metrics` a second,
64 kB a message.

### 6.4 Signalling relay

`signal { to, data }` is delivered to `to` as `signal { from, data }` if both are in the session
and the coordinator has, in the last minute, named one to the other in an `assign` or `welcome`.
A peer cannot make the coordinator carry signalling to a peer it was never pointed at. **[D10]**

### 6.5 Grants

A **grant** is the coordinator's statement about one peer, signed with the session's Ed25519
key: `<base64url JSON>.<base64url signature>`.

```
{ v, room, peer, role: "source" | "relay" | "leaf", scope: [...], iat, exp, kid }
```

`scope` holds what the holder may do: `"view"`, `"relay"`, `"publish:<streamId>"`. The public
key is in `welcome.key`; every peer checks every other peer's grant with it, on `hello`, without
asking anyone (§5.2).

A grant lives 10 minutes and is replaced 2 minutes before it expires (`grant`). Links already
open are not re-checked when a grant expires; a peer that is removed gets `kick`, and its
neighbours get `peer-gone`. Removing someone *cryptographically*, by rotating the key (`kid`),
belongs to stage 2 with SFrame (§15.2). **[D11]**

Stage 1 uses the grant for one thing: a peer accepts links, and a relay accepts a `sub`, only
from holders of a valid grant for this session, and only the holder of `publish:<n>` is believed
when it says it is the source. Stage 2 adds scopes (mute, stage), not a new format.

### 6.6 The tree map and placement

**The tree map is soft state** **[D12]**. The coordinator does not decide the tree and record
it; peers decide (§7) and say what they did (`status`, `report`), and the coordinator's map is
the latest of what it has been told. A peer that has said nothing for 3 × `statusMs` is marked
stale and not offered to anyone; one whose socket has been closed for 30 s is forgotten.

So a coordinator that restarts, or a Durable Object that is evicted, loses nothing that matters:
peers reconnect with `resume`, send `status`, and the map is back within one `statusMs`. Only
three things are stored durably: the session's signing key, the used ticket nonces, and whether
the session has ended.

**Placing a joiner.** For each (stream, stripe), from the map:

1. Candidates are the source and every relay that is not stale, has a free slot, and is not the
   joiner itself.
2. Sort by depth (shallowest first), then by same `region`, then by relay score (§8.2), highest
   first.
3. `parents` is the first three. `backups` is the next three whose path does not contain any of
   the `parents` (so one death does not take both), falling back to any three.

Filling shallowest-first keeps the tree as short as its relays allow. With a fan-out of 4 and a
source fan-out of 3, 200 peers sit within depth 4 if a quarter of them can relay.
**[D54]** A joiner that can never relay is placed shallowest-first too, no longer deepest-first:
a relay with few children never takes a deeper subtree while a shallower one has room. (The
coordinator has no joiner-to-relay round trip; among feeders at one depth it prefers the same
`region`.) Depth 3 for 200 peers is not reachable at `maxFanout` 4: within depth 3 the tree holds
3 + 12 + 48 = 63 peers (6 + 24 + 96 = 126 with [D49]'s six on the source); depth 3 needs a fan-out
of about 6 throughout. *Decided by integrator 2026-11-22.*

**Answering `need`.** The same, with `exclude` removed, and, for `want: "backup"`, without any
peer whose path contains the asker's current parent.

**Promotion.** A joiner starts as a leaf. When §8.1 finds it eligible, and the tree's free slots
are fewer than a fifth of the audience, the coordinator sends `role: relay` with a new grant.
A relay that stops being eligible gets `role: leaf`; it finishes with `bye { reason:
"rebalance", alt }` to its children (§7.7).

**Rebalancing** is the peer's own (§7.6); the coordinator's part is to keep answering `need`
well and, at most once a minute per peer, to send an unasked `assign { reason: "rebalance" }`
to a peer more than two levels deeper than the tree needs.

### 6.7 Deployment

**[D13] The coordinator is its own Worker**, `meetly-overlay`, not part of the app's Worker
(`custom-worker.ts` on the `cloudflare-deploy` branch). It has one Durable Object class,
`OverlayRoom`, addressed by `idFromName(room)`, with SQLite storage and hibernatable WebSockets,
so a session with nobody talking costs nothing. Reasons: the app's Worker is built by OpenNext
and wraps its output, and a second class and its migrations there would tie the overlay's
releases to the app's; and the overlay can be removed again by deleting one Worker.

A hibernating Durable Object loses its memory. The core's `attach` effect keeps a peer's id,
role and identity with its socket (`serializeAttachment`), `restore` rebuilds the socket table
from them on waking, and the tree map comes back from `status` as above.

The app reaches it through `NEXT_PUBLIC_OVERLAY_URL` (the browser's WebSocket) and
`OVERLAY_ADMISSION_SECRET` / `OVERLAY_SERVER_SECRET` (the server's tickets and API calls).

TURN credentials are minted per peer by the coordinator from a Cloudflare TURN key and sent in
`welcome.ice`, valid for the session's length. Without a key configured, only STUN is offered.

---

## 7. State machines

One state machine per (stream, stripe), in each peer. Stage 1 runs two (video, audio), and
**[D14] in stage 1 they move together**: one parent and one backup serve both streams, and a
repair moves both. They are separate machines because stage 2 gives each stripe its own tree.

```
                  welcome
   idle ------------------------> probing ---- first link open ----> subscribing
    ^                                |                                    |
    |                                | none opened in 5 s                 | sub-ack ok
    |                                v                                    v
    |   backoff                 cold-repair <----- no live backup ----- active <-----------+
    +---------- rejoining <------    |                                  |   |              |
                    ^        fails   | new parent linked                |   | silent for   |
                    |                +--------> subscribing             |   | deadMs       |
                    |                                                   |   v              |
                    |                         parent says STALLED       | repairing        |
                    |                                |                  |   |  sub-ack ok  |
                    |                                v                  |   +--------------+
                    +-- everything failed ------ waiting <--------------+
                                                     |  stallGraceMs passed, or parent silent
                                                     +-----------> repairing
```

### 7.1 Join

1. The browser asks Meetly's server for a ticket and opens the coordinator's WebSocket.
2. `hello` → `welcome`. The peer starts its clock probes (§4.1).
3. For each assignment the peer opens links to the first two `parents` and the first `backup`,
   at once (`probing`).
4. **[D15] The first parent link to open and pass `hello` wins.** The peer sends it `sub { mode:
   "active", fromFrame: −1 }` (`subscribing`) without waiting to measure the others. Join time
   matters more than the best parent; §7.6 fixes a poor choice later.
5. `sub-ack ok` → `active`. The parent replays from its newest keyframe and continues live. The
   player decodes the replay without showing it until it reaches the playout point (§10.4), so
   the first picture is a current one.
6. The peer sends `sub { mode: "standby" }` to one other open link, which becomes the backup
   (§7.3), closes the rest, and sends `status`.

`sub-ack` with `full`, `loop` or `leaving`: try the next candidate. No candidates left, or no
link opened within 5 s: `cold-repair` (§7.5).

**[D37] A parent at its fan-out takes a viewer with nothing to watch** (decided by integrator
2026-11-21). A `sub` from the latest keyframe (`fromFrame` −1: a joiner, or a peer the
coordinator found no free slot for) is accepted over the fan-out, up to twice it; only beyond
that is it refused `full`. While over, the parent sheds the top temporal layer for every child
(§11.3 rule 8, as for a repair taken in, §7.5) until the coordinator moves someone. A `sub` from a
frame of the subscriber's own (a switch, a `move`: it is watching elsewhere) is refused `full` at
the fan-out as before. A lower frame rate at once is better than no picture until a relay is
promoted, which at a session's start is a probation away.

Budget for the 3 s gate: ticket and socket 200 ms, `welcome` 100 ms, link (ICE and DTLS) 300 ms
to 2 s, replay and first frame 100 ms. The proof measured 20–45 ms from joining to first frame
on loopback, where ICE costs nothing; ICE is the whole budget.

### 7.2 Choosing a parent

A peer may take as parent any peer that holds a valid grant with scope `relay` or `publish`,
has said it has a free slot, and **whose path does not contain this peer**. That last rule is
what prevents loops: `sub-ack` carries the parent's path, a parent that changes its own path
tells its children (`path`), and they tell theirs with themselves in front. A peer that finds
itself in a path it is given unsubscribes at once and goes to `cold-repair`. A parent refuses
with `loop` a `sub` from anyone in its own path. As a last defence, a packet arriving with
`hops` ≥ 32 is dropped.

Among those it may take, a peer prefers the lowest *parent cost* (§8.3).

### 7.3 Warm backup

For each stripe a peer keeps one **backup**: a link that is open, authenticated and subscribed
`standby`. Nothing flows on it but heartbeats every `standbyHeartbeatMs` (250), which tell the
peer the backup is alive and how far it is from the source, and let it measure the round trip.

A backup must not be the parent, must not have this peer in its path, and should not have the
parent in its path. A relay holds a place for each standby child: it accepts up to 2 ×
`maxFanout` of them. A promotion is then never refused (§7.5).

A backup silent for `standbyDeadMs` (1,000), or whose path comes to contain this peer or its
parent, is replaced: `need { want: "backup" }`, a new link, `sub standby`. Until the new one is
up the peer has no backup, and a failure then is a cold repair. That window is one link setup
(0.3–2 s).

Timers that must not be slowed (heartbeats, the failure detector) run from the injected `Clock`.
In a browser that clock is driven by a dedicated Worker, because a hidden tab's own timers are
slowed to one a second. **[D16]**

### 7.4 Failure detection

A parent is **dead** when nothing has arrived from it on the `media` channel for `deadMs` (200):
no media, no heartbeat. These are the proof's numbers: heartbeats every 50 ms, dead after four
are missed. The detector checks every 10 ms.

**[D59] `deadMs` is 150: dead after three heartbeats missed** (decided by integrator
2026-11-23). In the gate run 45130383283, of 6.7 million page timer ticks none ran 150 ms late
and one in a million 100 ms late, so a live parent's own stall is not a silence of 150 ms; three
heartbeats lost in a row on a relay's link (relays have under 2% loss, §8.1; the gate mix's
relays 1% or less) is about one in a million heartbeats, about two false alarms in a 200-peer,
10-minute run. A false alarm costs a warm repair, which loses nothing. It takes 50 ms off every
warm and wait repair. **Withdrawn 2026-11-23** (integration engineer): in gate run 45155864248,
with fan-out 6 (D56), three storms of 190–230 cold repairs followed relay kills, and most of
the parents found dead in them (25 of 42, 33 of 47, 56 of 63) were alive and sampling
afterwards: a heartbeat waits in the channel behind a busy relay's media, and 150 ms was not
enough. `deadMs` is 200 again.

Also dead, at once: the link's state becomes "closed", or a `bye` arrives.

**[D17] A parent that is alive but cut off says so.** When a relay's own parent dies, the relay
keeps sending heartbeats, with the STALLED flag, while it repairs. Its children then move to
`waiting` instead of repairing: they hold for up to `stallGraceMs` (600). If media resumes, they
are `active` again, having done nothing; the relay's repair repaired its whole subtree. If the
grace runs out, or the relay goes silent, they repair for themselves. Without this, the death of
one relay near the source would make every peer below it switch parents at once, and the
backups would be swamped.

The proof killed relays whose children were leaves, so it did not meet this case.

A false alarm (a burst of loss or a 200 ms stall on a live link) costs one switch to the backup;
the old parent, if it turns out to be alive, becomes the new backup.

### 7.5 Repair

**Warm repair** (the backup is alive). On detecting the parent dead:

1. `repair { stream, stripes, fromFrame: X, dead }` to the backup, where *X* is the newest frame
   of the stream that this peer holds whole and decodable (for video, the newest base-layer
   frame decoded, and then the frames after it as far as every one is decodable: the layer-1
   and layer-2 frames it already has are not replayed again ahead of what it lacks; for audio,
   the newest frame received). Audio's `repair` (and `sub`) goes first: the parent starts each
   replay as its message arrives, and audio's few hundred bytes behind a video replay would
   come too late to be played. A parent's replays to one child likewise go audio first.
2. The backup answers `sub-ack ok` and replays from its GOP cache everything after *X*, then
   continues live. **It does not refuse for want of a slot**: if it is over its fan-out, it
   accepts, sets its children's layer caps to shed the top temporal layer (`reason:
   "overload"`, §11.3), and tells the coordinator, which moves someone (§6.6).
3. The peer is `active` with the backup as parent. Its own children, who saw STALLED, see media
   again.
4. Afterwards, and not before: `report { event: "parent-dead" }` to the coordinator, `need {
   want: "backup" }`, and a new backup (§7.3).

Nothing in steps 1–3 involves the coordinator. The proof measured this at 205–210 ms of freeze
and no frames lost, of which about 170–200 ms is detection.

**Cold repair** (no live backup). The peer asks the coordinator (`need { want: "parent" }`),
links to the candidate and subscribes from *X* as above. The proof measured 225–227 ms on
loopback; with real ICE it is the link setup time, 0.3–2 s. If the coordinator cannot be reached
either, the peer waits, retrying both, and after 5 s goes to `rejoining`: it starts again from
§7.1 with backoff (1, 2, 4 … 30 s). Stage 3 gives it a third way, through its neighbours
(§15.3).

**What makes repair lossless is the GOP cache.** Every peer with children, and the source, keeps
the packets of each stream from the newest keyframe on (and the GOP before it), up to
`gopCacheMs` (4 s) and `gopCacheBytes` (4 MB). A replay is sent as class "replay": behind live
media, at a rate the congestion module allows (§11.5). The receiver's jitter buffer puts replayed
and live frames in order.

### 7.6 Rebalancing

A peer may leave a healthy parent for a better one, of its own accord:

- Every 10 s it compares its parent's cost (§8.3) with its backup's and with any candidates the
  coordinator has sent.
- It switches only if the better one is better by 20% **and** by 20 ms, has been for three
  comparisons running, and the peer has not switched in the last `rebalanceMinMs` (30 s).
- A switch is make-before-break: `sub active fromFrame: X` to the new parent; when its first
  packet arrives, `unsub` to the old one, which becomes the backup. Frames arriving from both
  are deduplicated by `frameId` and fragment. No freeze.
- An unasked `assign { reason: "rebalance" }` from the coordinator adds candidates. It is advice;
  the same rule decides.

A peer whose parent reports it STARVED, or says `layers` down to the base layer for 2 s, may
switch without waiting out `rebalanceMinMs` (§11.3).

### 7.7 Leaving

On `close()`, and on `pagehide`:

1. `bye { reason: "leave", alt }` to every child, where `alt` is this peer's parent and backup.
   A child treats `bye` as "dead now": it repairs to its own backup at once, without waiting
   `deadMs`. It may also use `alt` as candidates.
2. `bye` to parent and backup. `bye` to the coordinator.
3. Close.

A tab that is killed sends nothing; that is §7.4. `pagehide` gives no guarantee that anything
is sent, so leaving gracefully is an optimisation, never relied on.

---

## 8. Scoring

### 8.1 Who may relay

A peer is **eligible** to relay only if all of these hold. The first six are what it says of
itself; the rest are observed. `judgeRelay` in `topology/` implements this, and both the
coordinator and the peer call it.

| Check | Rule |
| --- | --- |
| browser | Chromium |
| device | desktop |
| power | on mains, or no battery. "Unknown" is allowed, and scores lower |
| NAT | "open" or "cone": others can reach it. "symmetric" and "relay" (needed TURN) are leaf-only |
| data saver | off |
| visible | the tab is in view |
| uplink | measured spare uplink ≥ 2 × 1.15 × the session's bitrate (room for two children) |
| probation | in the session for `probationMs` (20 s) **[D18]** |
| loss | under 2% from its own parent |

NAT type is found by gathering candidates against two STUN servers: the same public port from
both means "cone", different ports "symmetric", a public host address "open". A peer whose every
link so far needed TURN is "relay". **[D48]** The answer comes as soon as the candidates decide
it, not at the end of gathering or the probe's 3 s timeout: a public host address or one socket
mapped two ways at once; otherwise "cone" 300 ms after the first server-reflexive candidate (a
browser reports one candidate per distinct mapping, so a cone NAT never shows a second). The
short probe (D38) waits for that answer rather than finding "nat" against the peer and trying
again 10 s later. *Decided by integrator 2026-11-22.*

Spare uplink is not known when a peer joins, and nothing a browser reports can be trusted for
it. After probation the peer sends its parent PROBE packets (§4.7) for one second at what a full
fan-out would cost (§11.6) and reads the result from feedback (§11.6). **[D19]**

**[D38] Provisional relays** (decided by integrator 2026-11-21). Probation makes a session's
first viewers wait: until someone has been in for 20 s nobody may relay, and only the source's
few slots exist. So a viewer that passes every check of the table but probation and uplink, and
whose short probe (1 s, [D41]; sized for two children: 2 × 1.15 × *B* / 0.7, the larger of that
and the uplink rule's 2 × 1.15 × *B*) shows the room, may be made a **provisional relay**, with a
fan-out of 2 whatever its uplink. The `role` message carries `fanout: 2`, and the relay takes no
more active children than that (a repair or a viewer with nothing to watch over it as §7.5 and
[D37] say). The coordinator places joiners under provisional relays only when no full relay has a
free slot. One that misbehaves in its first 20 s (its children's loss or STARVED, as for
demotion below) is demoted, and its children are moved first, make-before-break (`move`). Past
probation, and with the full probe's result, it is judged as any relay and its fan-out is the
table's.

**[D41] The provisional probe lasts 1 s** (decided by integrator 2026-11-21), at the same
fan-out-2 target: the floor E-coordinator found for session-start joins under 3 s. Measured in
the simulator through the node, with congestion's estimator and probe, on uplinks capped at 2,000,
4,500 and 8,000 kbps (fan-out 2 needs 3,943 at *B* = 1,200): on the gate mix's "home" profile a
1 s probe decided eligibility right in every run, within 1% of the target (0.5 s was 3–5% short,
still right, with less margin). On "bad" no probe of any length shows spare uplink, because the
link is never *ok*; such a peer is not eligible in any case (loss under 2%, the table above).

**Fan-out** is how many active children a relay takes:
`min(maxFanout, floor(0.7 × spareUplinkKbps / (1.15 × sessionKbps)))`. The 0.7 leaves room for
the peer's own use; the 1.15 for retransmissions and replays. `maxFanout` is 4; the source's is
3, because the host's uplink also carries the stage. **[D20]**

**[D56] `maxFanout` is 6** (decided by integrator 2026-11-23). Within depth 3 a tree of fan-out
4 holds 63 peers (126 with six on the source); 200 peers need about 6. The formula still caps
each relay at what its probe shows: six children take 6 × 1.15 × *B* (8.5 Mbps at 1,232 kbps)
at the 0.7 share, a spare uplink of 12.1 Mbps; a relay with less takes fewer. The gate mix
(D28) caps no relay's uplink ("slow", the only capped profile, never relays), so the gate's
relays reach six; a home uplink of 10 Mbps reaches four.
**[D60] A join leaves a full relay's last slot to repairs** (decided by integrator 2026-11-23). A
full relay with a fan-out of 4 or more is offered to joiners only while it has two or more slots
free; its last is kept for a repair (warm or cold) or a move. With fan-out 6 a depth-1 relay
carries a sixth of the audience: in gate run 45146597862, with every slot taken by joiners, two
kills of such relays each ended in about 180 cold repairs and 120 peers rejoining for want of a
place. In the simulator depth p95 stays 3 (78% of peers at depth 3, 0–1% at 4).

**[D57] The source keeps its probed fan-out** (decided by integrator 2026-11-23): D49's
`sourceFanout` to `sourceAloneFanout`, at its measured uplink, holds whether or not other relays
exist. Its probe measures what is spare beyond what it already sends, the stage included. In the
simulator (200 peers, the gate's join rate, 80% able to relay, five minutes of churn) depth p95
is 4 with fan-out 4 whatever the source does, and 3 with fan-out 6 and the source keeping six
(73% of peers at depth 3, 2–3% at 4).

**[D49] The source alone takes up to six** (decided by integrator 2026-11-22). While no other
relay, full or provisional, is connected, the source's fan-out is the formula's at its measured
uplink, between `sourceFanout` and `sourceAloneFanout` (6 when the params do not say): at a
session's start every joiner can go to it at once, instead of waiting for relays to finish
probation or their short probe. The source has no parent: once it has a child it probes toward
that child (sized for `sourceAloneFanout` children), which reports in its FEEDBACK as any child
does. The coordinator tells the source its fan-out in `role` (`role: source`, with `fanout`) when
it rises, and again when the first relay appears and it falls back to `sourceFanout`; children
over it are then moved as for any relay. Only with [D48] and the probe waiting for the NAT type.

**[D51] `sourceAloneFanout`** (decided by integrator 2026-11-22) is an optional session param,
6 when absent: the ceiling of [D49]. A scenario about a fixed tree (the proof's, a chain) sets it
to its `sourceFanout`. With D49 a depth-1 peer's backup can never be clear of the source, so at
least 93% of first backups are clear of the first parent, not 95%; and a short probe put off for
want of the NAT type is checked as slower than one that waits for it, no longer as over 4 s.

**[D50] One fan-out, everywhere** (decided by integrator 2026-11-22). The probe is sized by the
same *sessionKbps* as the formula (video and audio together), so a probe that reaches its target
shows the fan-out it was sized for. Every relay's `role` carries its `fanout`, provisional or
full, and is sent again when the verdict's changes; the node takes no more active children than
it (D37's over-fan-out aside). The coordinator's placement and relief, and the node, agree.

Because `caps` is a claim, the coordinator also watches what a relay's children report. A relay
whose children's loss is over 5%, or who are STARVED, for 10 s, is demoted (`role: leaf`).
**[D47]** "Its children's loss" is more than half of the children that report, and at least two
of them, over 5%: one child's bad link is the child's, not the relay's. In the simulator this cut
demotions from 90–146 to 7–9, and moves that deepen the tree from 70–104 to 2–6, per 10 minutes.
*Decided by integrator 2026-11-22.*

### 8.2 Relay score

Among eligible relays, who is put nearer the source. 0 to 1:

```
score = 0.35 × min(1, spareUplinkKbps / (maxFanout × 1.15 × sessionKbps))
      + 0.25 × min(1, uptime / 10 min)
      + 0.20 × (1 − min(1, lossPct / 2))
      + 0.10 × (onPower is true ? 1 : 0)
      + 0.10 × (1 − min(1, parentChangesPerMinute / 2))
```

Someone who has been here ten minutes on a fast, clean line is the best relay there is; the
score says so. **[D21]**

### 8.3 Parent cost

What a peer minimises when it chooses among parents it may take. Lower is better, in
milliseconds:

```
cost = rttMs                       (150 if not yet measured)
     + 30 × depth                  (each hop above costs about this much delay)
     + 20 × lossPct
     + 100 if the link goes through TURN
     + ∞  if it has no free slot
```

The report says "parents are chosen by RTT". RTT alone builds deep trees of near neighbours; the
depth term is what keeps a peer from choosing a close parent five hops down over a slightly
farther one two hops down. **[D22]**

---

## 9. The program feed

### 9.1 What it is

**[D23] The host's browser composes the stage into one picture and one sound**, and encodes
those: a canvas laid out like the stage, and the stage's audio mixed with Web Audio. The
audience sees a single program, as a broadcast viewer does, not a grid of tiles it lays out
itself. One video and one audio stream is the least an overlay can carry, and it makes the
audience's cost independent of how many people are on stage. The wire format does not assume it:
`streamId` allows a stream per speaker later.

The composing and the input tracks are the integration's business (PLAN.md); `media/` takes a
video `MediaStreamTrack` and an audio one.

### 9.2 Encoding

| | Video | Audio |
| --- | --- | --- |
| Codec | VP8 | Opus |
| Layers | `L1T3`: one size, three temporal layers | none |
| Target | 1,200 kbps, 1280×720, 30 fps | 32 kbps, mono, 48 kHz, 20 ms frames |
| Keyframes | every 60 frames (2 s) | every frame is one |
| Mode | `latencyMode: "realtime"` | |

The proof ran VP8 `L1T2` at 640×360 and 600 kbps. Three temporal layers give two steps down
(15 and 7.5 fps) before the picture has to freeze. The numbers are a starting point; they travel
in `StreamConfig`, not in code.

With `L1T3`, layer 0 is every fourth frame and needs the previous layer-0 frame; layer 1 needs
the layer-0 frame before it; layer 2 needs the layer-0 or layer-1 frame before it. Layer-2
frames are DISCARDABLE. The source sets `refDelta` accordingly; no receiver derives it.

`captureUs` is taken when the frame is read from the camera (or composed), on the session clock.
The encoder is never allowed a queue: if it has two frames waiting, the next is skipped, as in
the proof.

**[D43] A keyframe may be up to 500 ms of *B*** (decided by integrator 2026-11-21). A stage's
keyframe is several times a delta frame; the source lets it be, and lowers its size (downscales)
only for keyframes beyond 500 ms of *B*, not for the encoder's ordinary overshoot. Every relay
paces such a keyframe to each child (§4.2, below), and rules 3 and 6 of §11.3 read what of it
the link has yet to absorb as the keyframe's, not as a backlog.

### 9.3 Keyframes

**[D24] Stage 1 has no keyframe requests.** A keyframe comes every 2 s regardless. A joiner or a
repairing peer does not need one sooner, because the GOP cache replays from the last one. A peer
that loses a base-layer frame for good waits for the next keyframe: at most 2 s, and only after
a NACK has failed. A request travelling up a tree of 200, from anyone, is a way for one bad link
to cost everyone bitrate; `keyreq` is defined but not used until the source can limit it
(stage 2).

### 9.4 Audio

**[D25] Each audio frame is sent twice**, the second copy one frame (20 ms) after the first,
with the same `frameId`. Receivers and relays drop the duplicate by id. At 32 kbps this costs
32 kbps, under 3% of the session, and it turns isolated loss on a hop into nothing, with no
round trip. Audio is never dropped to make room for video (§11.3).

**[D35] An audio frame's `captureUs` is the time of the sound it decodes to**, not of its first
input sample. Opus decodes each frame to sound that starts its look-ahead earlier than the
frame's first input sample: 312 samples at 48 kHz, 6.5 ms (measured in Chromium: 6.6 ms). The
source stamps each Opus frame with its first input sample's capture time less 6.5 ms, so that a
sound and a picture captured together are played together. *(Decided by integrator
2026-11-21.)*

---

## 10. The jitter buffer and playout

The contract between the network and the decoders. One jitter buffer per stream;
`media/types.ts` has the interface. Its acceptance tests are this section, case by case.

### 10.1 In and out

**In:** whole frames (`ReceivedFrame`), in any order, with duplicates.

**Out:** `pop(nowUs)` returns every frame that is *decodable* and *due*, in decode order. A frame
is decodable if it is a keyframe, or the frame it needs (`frameId − refDelta`) has already been
handed out, in the same GOP. A frame is due at `captureUs + D`, where *D* is the playout delay
counted from the frame's arrival, not from its capture: see below.

The buffer never hands out a frame the decoder cannot decode, and never hands out the same frame
twice.

### 10.2 The playout delay *D*

```
D = clamp( playoutMinMs + 2.5 × jitterMs + (lossPct > 0.5 ? rttMs + 20 : 0),
           playoutMinMs, playoutMaxMs )
```

`playoutMinMs` is 60, `playoutMaxMs` 400. The middle term rides out jitter; the last gives a
NACK time to be answered when the link is losing packets, and is not paid when it is not.
`jitterMs`, `rttMs` and `lossPct` are those of the link to the parent (§11.1).

*D* rises at once and falls by at most 10 ms a second. A change in *D* is made in the audio
(§10.5), and the video follows it.

Only this peer's own *D* adds delay: relays forward without buffering. Glass-to-glass is
therefore roughly `encode (30) + Σ per hop (one-way delay + 0.5) + D + decode and display (30)`,
in milliseconds. At depth 4 with 30 ms hops and *D* = 100 that is about 280 ms.

**[D33] The delay a frame is played at is the path, then *D*, then the audio pipeline.**
*(Decided by integrator 2026-11-21.)* Read literally, "due at `captureUs + D`" makes every frame
late at any peer whose path is longer than *D*, which is anyone a few hops down; the formula
above is the intent. So a frame captured at *t* is played at *t* + *path* + *D* + *pipeline*:

- *path* is how long frames take to get here at best: the lowest (arrival − `captureUs`) on the
  session clock over the last second, for the slower of the two streams, leaving out frames
  that came by a replay or a retransmission. It includes encoding at the source and every hop.
  When even the lowest of the last 200 ms says frames now come too late to be played, the path
  grew (a repair to a parent further down) and that value is taken at once.
- *D* is the formula above, all of it the network's.
- *pipeline* is what the sound needs on its way out: a frame reaches the AudioWorklet 15 ms
  before it renders it, and the worklet renders the sound card's output latency ahead of what
  is heard. Taking these out of *D* would leave the network almost nothing of *D* = 60 on a
  sound card with 40 ms of latency, and the second copy of an audio frame (§9.4) would never
  come in time to help. Without an audio stream it is 0. A light viewer (§13.2) takes the output
  latency to be 40 ms, so that its latency is a decoding viewer's.

Each jitter buffer is told how much of this is beyond *D* for its own stream, so that §10.4 does
not take media held for the slower stream, or for the sound card, for a backlog.

### 10.3 When a frame is not there

At a frame's due time, if it is missing or not decodable:

| The frame is | Then |
| --- | --- |
| DISCARDABLE (top temporal layer) | it is skipped. Playout goes on. Counted `lost`. |
| layer 1 | it and the layer-2 frames that need it are skipped. Playout goes on at the base rate. |
| base layer, or audio | see below |

**A missing base-layer video frame stalls video.** The buffer waits for it up to 150 ms past its
due time (`stall` is announced; the topology module may already be asking for it). If it
arrives, playout resumes and is now late; §10.4 brings it back. If not, the buffer gives up on
this GOP: it announces `skip` and resumes at the next keyframe, at most 2 s later. Everything in
between is counted `lost`.

**Missing audio never waits.** At its due time it is concealed (§10.5).

A frame that arrives after its due time is used only if a later frame needs it, and then
`decodeOnly`: decoded, not shown.

**[D45] A replay is played forward, not given up.** *(Decided by integrator 2026-11-22.)* A
join's or a repair's replay arrives already past due, often by 300 ms and more; a fragment of
it lost and asked for again would find its frame's 150 ms long gone, and the whole GOP would be
given up for the next keyframe, up to 2 s away. So while a replay is coming (frames marked
`recovered`, which a replay and a retransmission already are, any within the last 300 ms):

- a missing frame is waited for 300 ms from when playout reached it, not 150 ms past its due
  time;
- but only while the replay can still reach the playout point before the next keyframe would
  be due: the capture time it delivers per second of arrival against the lag it has to make up.
  A replay that cannot is given up as above;
- frames played forward past their time are decoded and not shown (§10.4), except that the
  newest of them that others build on is shown at least every 100 ms, so that the picture
  skips forward rather than standing still.

Without a replay, nothing of this applies, and §10.4 is as it was.

### 10.4 Catching up

After a join, a repair or a stall, the buffer may hold more than *D* of media: a replay arrives
in a burst, and is old. Whenever the newest frame's `captureUs` is more than *D* + 100 ms ahead
of the playout point, the buffer hands out the older frames as `decodeOnly` until it is within
*D* again. The viewer sees the picture jump forward once; it does not see old video played out.
The proof returned to normal latency 173–245 ms after a kill this way.

### 10.5 Audio playout and A/V sync

Audio is the master clock. Decoded audio goes into a ring buffer read by an AudioWorklet; the
worklet reports the `captureUs` of the sample it is playing.

- A video frame is shown when the audio being played reaches the frame's `captureUs`. It may be
  shown up to 15 ms early or 45 ms late; later than that it is dropped (if discardable) or
  shown at once.
- With no audio stream, or audio blocked by the browser's autoplay rule, video is timed against
  the session clock instead, with the same *D*.
- A missing audio frame is concealed: the last frame repeated once with a fade, then silence.
  Concealed time is counted.
- *D* is changed by at most one audio frame (20 ms) a second: one is dropped, or one repeated,
  at the quietest frame of that second. **[D26]** (Time-stretching without a pitch change is
  better and is deferred.)
- **[D34] Further off than that adapts to, playout starts again in the right place.**
  *(Decided by integrator 2026-11-21.)* When the delay in force leaves less than 25 ms beyond the
  path and the audio pipeline (§10.2, [D33]), frames are being lost, and creeping up 20 ms a
  second would lose them for seconds: playout stops and starts again at the target, one audible
  gap of about the growth. When it is more than 250 ms over the target, the same. A rise in *D*
  alone is still followed a frame a second. Light viewers follow the same rule.

The player gives the picture as a `MediaStreamTrack`, so a `<video>` element shows it as it
shows any other.

---

## 11. Congestion

A data channel has congestion control of its own: SCTP's. It does not drop what it cannot send;
it queues it, and `bufferedAmount` grows. An overlay that ignored this would deliver video late
instead of not at all, which is worse. So the rule everywhere is: **never queue stale media.
Decide what not to send, before sending it.**

### 11.1 Signals, per link

`LinkEstimator`, one per link, from what §4 carries:

| Signal | From | Meaning |
| --- | --- | --- |
| `rttMs` | echo fields of heartbeat and feedback | round trip |
| `lossPct` | `received` / `expected` in feedback (from `linkSeq`), over 1 s | lost on this hop |
| `queueDelayMs` | `sendMs` against arrival time, less the smallest difference of the last 10 s | a queue is building on the path |
| `jitterMs` | RFC 3550 interarrival jitter | how uneven arrival is |
| `bufferedBytes` | the sender's own `bufferedAmount` | the channel cannot take what it is given |
| `sendKbps`, `deliveredKbps` | bytes sent; bytes the receiver counted | what the link is carrying |

`queueDelayMs` needs no clock agreement: it is a difference of differences, and a slow drift
between two clocks is absorbed by the ten-second floor.

### 11.2 The state of a link

With *B* the stream's full bitrate:

| State | When any of |
| --- | --- |
| **congested** | `bufferedBytes` over 150 ms of *B* · `lossPct` ≥ 10 · `queueDelayMs` ≥ 100, for 500 ms |
| **strained** | `bufferedBytes` over 50 ms of *B* · `lossPct` ≥ 3 · `queueDelayMs` ≥ 40 |
| **ok** | otherwise |

**[D30] A backlog counts once it has stood over a line for 150 ms** (`backlogWindowMs`): every
`bufferedBytes` sample in that time over 50 ms of *B* for *strained*, over 150 ms of *B* for
*congested*. A keyframe is several delta frames' worth, handed to the channel at once; on a link
with room for the stream the backlog it leaves is gone a few frames later, and is not the link
falling behind. Read sample by sample, every keyframe makes a link under about 4.6 Mbps
*strained*, rule 5's five seconds of *ok* never come, and a layer once dropped is never given
back. Rule 6 and the replay budget (§11.5) read the backlog as it is now. *Decided by integrator
2026-11-21.*

**[D32] Loss counts only where the link shows a queue**: `queueDelayMs` ≥ 40, or
`bufferedBytes` over 50 ms of *B*. Loss on a path with no queue (a lossy radio, the gate mix's
"bad" bursts) is NACK's to repair (§4.6); dropping a layer does not make one packet fewer of it
lost, and at 3% it would keep the link *strained*, so a layer once dropped never came back.
Congestion that overflows a queue shows the queue too. `lossPct` is reported as measured.
*The guard*: loss at or over 10% with no queue, at every look for 3 s running, is a policer or a
lossy last hop, and the link is *congested* all the same. Once the guard has fired, loss counts
as the table above has it, queue or none, until it has been under 3% for 60 s, so that rule 5's
rises are judged by it and its back-off doubles. The 10% line is set from the gate mix (§12.3):
"bad" never holds 10% for more than about a second, and its one-second loss at its lowest over
any 3 s is at most 3.7%; a policer at 900 kbps under the 1,200 kbps stream loses 17% at its
lowest. (The integrator first named 15%, which leaves that policer two points from the line.)
Rule 3's second drop (§11.3) reads loss the same way. *Decided by integrator 2026-11-21.*

### 11.3 Layer drop, per child

`LayerGate`, one per child and stream. It answers one question per frame: send this frame to
this child, or not. Always for the whole frame, at its first packet; a frame is never sent in
part.

1. **Control and audio are always sent.** They are small, and without them nothing else works.
   A gate is told which kind of stream it serves (`LayerGateOptions.kind`); an audio stream's
   gate refuses nothing. Told nothing, a gate takes stream 1 for audio and every other stream
   for video, which is stage 1 (§2). *Decided by integrator 2026-11-21.*
2. A video frame above the child's cap is not sent. The cap starts at the top layer.
3. **Down:** when the link is *congested*, the cap drops one temporal layer, at the next frame,
   at most once every 500 ms. **[D31] A further drop waits to see what the last one did.** From
   a drop until the cap next rises, the next drop waits one observation window: the longer of
   1 s and 2 × the link's reaction time (its round trip, 150 if not yet measured, plus 250 ms:
   a feedback interval and the backlog's standing window of [D30]). After it, the cap drops
   again only if the backlog or the loss is still over the line: `lossPct` ≥ 10, counted as
   [D32] counts it, or `bufferedBytes` over 150 ms of *B* at every frame for the whole window
   with its low point no lower than in the window before. Congestion by `queueDelayMs` alone does not drop a second
   layer: a link that just carries a layer reads *ok* between keyframes and then, for each
   keyframe's queue, congested by delay. The first drop, and a failed rise's drop back
   (rule 5), are at the next frame as before. So a child capped at 900 kbps or 1.1 Mbps under a
   1,200 kbps stream settles on the middle layer, not the base; one at 600 kbps gets its second
   drop a window after the first, within PLAN C3's 2 s. *Decided by integrator 2026-11-21.*
4. **Hold:** while *strained*, the cap does not move.
5. **Up:** after 5 s *ok*, the cap rises one layer. If the link is *congested* again within 3 s,
   the cap drops back and the wait doubles (10, 20 … 60 s); it resets after a rise that holds.
6. **No stale video:** whatever the cap, a video frame is not sent if `bufferedBytes` is already
   over 200 ms of *B*. **[D43]** While a paced keyframe (§4.2) is in flight the line is
   max(200 ms of *B*, the keyframe's remainder): what of the keyframe the link has yet to absorb,
   which is how far the backlog (channel and pacing queue) stands over the one the keyframe
   found, never more than the keyframe itself. Once its pacing is done the remainder never
   rises again (a backlog that grows back is the link's), and it ends when the backlog is back
   where it was, or after 4 × the keyframe's own time at *B*. *Decided by integrator 2026-11-21;
   the remainder as measured here, decided by integrator 2026-11-22.*
   By the same token, for rule 3 a link *congested* with `lossPct` under 10 and `bufferedBytes`
   less the remainder under 150 ms of *B* is held as *strained*: at 1.1 × *B* a 300 ms keyframe
   keeps the queue delay over 100 ms for 700 ms, and the backlog over 150 ms of *B* for 300 ms,
   both of which would otherwise drop a layer. *Decided by integrator 2026-11-22.*
7. **Starved:** a link *congested* for 1 s with the cap already at the base layer cannot carry
   the stream at all. The gate then sends only whole GOPs it can start cleanly (it resumes at a
   keyframe), announces `starved`, and the parent tells the child (`layers`, reason
   "congestion"). The child sets STARVED in its feedback and may leave for its backup without
   waiting out the rebalance interval (§7.6).
8. **Overload:** a relay with more active children than its fan-out (after taking in a repair)
   caps every child one layer down (`reason: "overload"`) until it is back within it.
9. A child may ask for less than it is sent (`maxTemporal` in feedback, or `layers`): a small
   window, a slow decoder. The cap is the lower of what is asked and what fits.

Every change of cap is told to the child (`layers`) and recorded as a `layer` metric event.

Dropping a temporal layer needs no keyframe and no word from the source: the frames that remain
decode without the ones removed. That is why stage 1 uses temporal layers.

### 11.4 The source's bitrate

One bad viewer must not lower the picture for everyone: that is what layers are for. The source
changes its encoder's target only for two reasons. **[D27]**

- **Its own uplink.** Once a second: if at least half of its direct children's links are
  *congested*, target × 0.85, not below 300 kbps. If all have been *ok* for 10 s, target × 1.05,
  not above the configured bitrate.
- **The audience as a whole.** If more than 30% of viewers have been below the top layer for
  10 s, the coordinator sends `hint` with a lower bitrate (the next of 1,200 / 800 / 500), and
  raises it again after 60 s under 10%. The hint is a ceiling on the target.

### 11.5 Replay

A replay (join, repair) is a burst of up to a GOP. `LayerGate.replayBudget` allows it only what
keeps `bufferedBytes` under 250 ms of *B*; live media goes first, replay fills what is left. A
replay to a child whose cap is below the top layer leaves out the layers above the cap.

That is more than rule 6's 200 ms and §11.2's 150 ms, so for 500 ms after the gate last gave a
replay a budget (`replayGraceMs`) the backlog is taken for the replay's own: a link *congested*
by backlog alone, with `lossPct` under 10 and `queueDelayMs` under 100, is held as *strained*,
and rule 6's line is 250 ms of *B*. Loss or path delay still count at once. Without this, every
join would end with the joiner's first live frames refused and a layer dropped. *Decided by
integrator 2026-11-21.*

**[D44] Per child, live video waits behind its replay** (decided by integrator 2026-11-22).
"Live media goes first" stays true of the channel as a whole, but for the child being replayed
to (a join, a repair), its own live video frames are sent after its replay, in order, within the
same budget. Live frames that overtake the replay need frames not there and long past due, so
§10.3 gives the GOP up at once (150 ms past due has already gone) and the replay is wasted: in
the first valid gate run (44970866134) the joins slow to a first frame, and most repairs that
froze over 600 ms, ended that way. Audio, control and retransmissions do not wait. What a relay
receives marked `Replay` (its own repair) it forwards as it comes, as before.

**A joiner's replay is thinned** (decided by integrator 2026-11-22). For a join (`fromFrame`
−1), what is more than 500 ms behind the newest frame goes as the keyframe and the base layer
only: the joiner only decodes it, and no later frame needs a frame above the base layer (§9.2).
The replay is smaller and the first frame sooner; the jitter buffer counts a few of the frames
left out as lost.

### 11.6 Measuring spare uplink

`UplinkProbe`: PROBE packets to the parent for 1 s, on top of whatever the peer is already
sending. The parent counts them in feedback like anything else and discards them. Spare uplink
is `deliveredKbps` during the probe, if the link stayed *ok*; if it did not, the highest rate
before it left *ok*. Run after probation, and again every 5 minutes while eligible.

- **The probe's target is what a full fan-out costs** (a correction of the "twice the session's
  bitrate" this section first said): `maxFanout × 1.15 × B / 0.7`, 7,900 kbps for stage 1, so
  that §8.1's fan-out formula can come out at `maxFanout`. A probe can report no more than its
  target, and at twice the bitrate (2.4 Mbps) no peer could ever show the 2.76 Mbps that
  eligibility asks for. The probe never queues more than the link took since its last tick and
  a few packets, so on a slower link it finds the link's pace rather than flooding it. Probe
  packets go in the lowest send class. *Decided by integrator 2026-11-21.*
- **FEEDBACK goes down the link while PROBE packets come up it.** FEEDBACK is otherwise child to
  parent (§4.5), but the prober needs to hear how its probe fared: a peer receiving PROBE
  packets on a link sends FEEDBACK on that link every `feedbackMs` for as long as they keep
  coming (the first interval's count is discarded, so the report starts with the probe), and
  stops one second after the last. *Decided by integrator 2026-11-21.*

---

## 12. Metrics and the gate

### 12.1 `MetricsSample`

Every peer produces one every `metricsMs` (2 s), sends it to the coordinator (`metrics`), and
offers it to the application. The harness reads them from the page. Counters cover the interval,
not the session, so samples add up. Defined in `protocol.ts`:

```
peer, seq, at, intervalMs, role, depth, playoutDelayMs
video?  { rendered, dropped, lost, glassToGlass: histogram, frameGap: histogram, maxTemporal,
          catchUp?: { frames, age: histogram } }
audio?  { playedMs, concealedMs, underruns, glassToGlass: histogram, avOffsetMs }
up?     { parent, rttMs, lossPct, queueDelayMs, rxKbps, nacksSent, retransmitsReceived,
          duplicates, turn }
relay?  { children, standby, txKbps, forwardP50Us, forwardP95Us, bufferedMaxBytes, layerDrops,
          retransmitsSent }
events: MetricsEvent[]
```

**Histograms** all use one fixed set of 97 buckets (`LATENCY_BUCKET_EDGES_MS`): 10 ms wide to
500 ms, 50 ms wide to 2 s, 500 ms wide to 10 s, and one for anything longer. Because the buckets
are fixed, histograms from any number of peers and shards add up bucket by bucket, and a
quantile read from the sum is exact to the bucket. `histogramQuantile` returns the bucket's
upper edge: it can overstate a latency by up to 10 ms below 500 ms, and never understates one.

**Events** (`MetricsEvent`), each with session-clock times:

| `t` | Fields | |
| --- | --- | --- |
| `join` | `start`, `welcome`, `linked`, `firstPacket`, `firstFrame`, `turn` | once per join |
| `repair` | `stream`, `stripe`, `dead`, `next`, `kind` (warm \| cold \| wait), `lastHeard`, `detected`, `resubscribed`, `firstPacket`, `freezeMs`, `framesLost`, `usedCoordinator` | once per lost parent |
| `switch` | `stream`, `stripe`, `from`, `to`, `at`, `freezeMs`, `reason?` | a voluntary change of parent; `reason`: `move` (the coordinator's), `rebalance` (the node's own, §7.6), `starved` (§11.3) |
| `layer` | `stream`, `peer`, `at`, `maxTemporal`, `reason` | a cap changed |
| `freeze` | `stream`, `at`, `ms` | rendering stopped, for any reason |
| `error` | `at`, `where`, `message` | |

### 12.2 Definitions

- **Rendered:** a video frame is rendered at the moment the player hands it to the track, at its
  playout time. (The display adds up to one refresh after that; the camera up to one frame
  before capture. Neither is measured; both are the same for any transport.)
- **Glass-to-glass latency** of a rendered frame: render time − `captureUs`, both on the session
  clock. **[D46]** A frame shown while a replay is played forward ([D45], §10.3) is old by design,
  and its cost is already in the freeze and repair measures: it is not in `glassToGlass`. It is
  counted in `video.catchUp` instead, with its age (capture to render) as a histogram, and the
  harness reports both, so nothing is hidden. *Decided by integrator 2026-11-22.*
- **Freeze:** a gap of more than 200 ms between two rendered frames.
- **Repair time** of one lost parent, at one peer: the longest gap between two rendered frames
  from the last packet heard from the lost parent until one second after the first packet from
  the new one. It includes the frame interval that is always there, as the proof's `freezeMs`
  did. A peer in `waiting` whose parent recovered reports `kind: "wait"` with the freeze it saw.
  **[D55]** A repair's `framesLost` counts every frame after the last decodable one before the
  loss, up to the newest that arrived in the window, that never became decodable, less the frames
  the new parent never sent: a layer it was shedding, and any frame of a temporal layer above the
  lowest cap it announced during the repair (`sub-ack` `maxTemporal`, `layers`). An overloaded
  backup (D37) sheds the top layer; the frame the old parent had begun and the new one never sent
  is shed, not lost. *Decided by integrator 2026-11-22.* So is the frame at the switch of a
  layer the new parent was not sending at all, which shows as the next frame of that layer never
  being sent either: the new parent's own feed lacked the layer, so its replay did too. (After
  the switch the link's sequence settles which frames were sent; only the one at the switch is in
  doubt.) *Clarified by the integration engineer 2026-11-23: the smoke test's lost frame, 3 of 9
  runs, with no overload at the new parent.*
- **Join time:** `firstFrame − start`: from `connect()` being called to the first frame rendered.

### 12.3 The gate run

The gate of §1 is passed by one run of the harness that meets all of this:

- **200 peers:** 1 source and 199 viewers, across as many machines as it takes.
- **Networks:** each viewer's links impaired by a profile drawn from the mix: 50% "good" (15 ms,
  0.1% loss), 30% "home" (30 ms, 1%), 15% "bad" (60 ms, 3%, in bursts), 5% "slow" (capped at
  900 kbps, under the session's bitrate). (`PROFILES`, `GATE_MIX` in `harness/`.)
- **Churn:** over 10 minutes after the swarm has filled: every 10 s one relay is killed without
  warning, one viewer leaves gracefully, and two join. And once, for 30 s, the coordinator is
  killed, while the relay kills continue.
- **Measures:** repair time p95 over every `repair` event of kind warm, cold or wait; latency
  p95 over every rendered video frame of every viewer; join time p95 over every `join` event.
- **Valid only if:** at least 100 repair events; no peer failed to start; no machine was starved
  (below); and the clocks agree to under 20 ms at p95 (below). A run that is not valid is neither
  a pass nor a fail.
- **A starved machine** **[D42]** is one whose timers ran more than 20 ms late at p99: on every
  runner, the driver's and each page's 20 ms timers are measured against the moment each was set
  for. Load average is reported for every runner and judges nothing: it is a proxy, and timer lag
  is what corrupts the timings.
- **The clocks** **[D40]**. Each viewer's session clock and the source's are read against their
  machines' wall clocks, synchronised by chrony. A viewer's disagreement is the largest gap
  between the two at any moment of the run, plus both machines' chrony error bounds (|offset| +
  root delay / 2 + root dispersion). Its p95 over all viewers must be under 20 ms. If any shard's
  wall clock cannot be bounded that way, the sum of clock uncertainties (§4.1) at p95 must be
  under 20 ms instead. Every report states both numbers, and which one judged the run.

**[D28]** The report did not say what "injected loss and churn" are; the numbers above are that.
They are stricter than the proof, which ran clean.

---

## 13. The harness

Real peers, in headless Chromium driven by Playwright, against one coordinator.

### 13.1 Impairment

CDP network throttling does not reach data channels. Impairment is therefore injected where the
transport hands a packet to a channel: `TransportOptions.wrapChannel` lets the harness wrap each
`PacketChannel` in one that delays, reorders (through jitter), drops (singly, or in bursts) and
caps the rate with a bounded queue. On the reliable channel a "dropped" message is delayed by a
retransmission time instead. A seed makes a run repeatable.

Impairment is per sender and per link, so each direction of each link is impaired by its
sender's profile.

### 13.2 Fitting many peers on one machine

This machine has 4 shared cores; a GitHub Actions runner has 2 to 4. Decoding 720p in every tab
would spend them all on something that is not under test.

- **Light viewers** **[D29]**: most viewers run the player with `decode: false`. The jitter
  buffer, the clocks and every network path run as normal; a frame is "rendered" when it would
  have been handed to the decoder at its playout time. One viewer in `decodeEvery` decodes for
  real, as a check that the light ones are honest: the two kinds' latency must agree to within
  the decode time. **[D58]** Compared at the same depths: the light viewers' latency is weighed
  to the decoding viewers' depth mix before the p50s are compared. One in twenty decodes, and
  sixteen viewers do not sit where 180 do (run 45130383283: 21% of decoding samples at depth 2,
  12% of light ones), while latency grows about 40 ms a hop; unweighed, that run's 20 ms apart
  was the depth mix (10 ms weighed). *Decided by integrator 2026-11-23.*
- **One source**, encoding Chromium's fake camera, on shard 0.
- Several pages per browser process.

Locally this should reach 30–60 peers. Every shard reports its own event-loop lag and load, so a
run that starved its machine is seen to be invalid rather than taken for a slow overlay.

### 13.3 Shards

`SwarmConfig.shard { index, count }`: a process runs the peers whose index modulo `count` is
`index`. Everything a shard does is derived from the run's `seed` and the peer's index, so
shards need not talk to each other. Each writes a `ShardResult` (its peers' samples);
`buildReport` adds any number of them into one `SwarmReport` with p50, p95 and p99 and the
gate's verdict.

On GitHub Actions: a matrix of shard jobs, each uploading its `ShardResult` as an artifact, and
a final job that downloads them all and builds the report. All shards join one coordinator.

Two things must be true for that to work, and neither is yet known:

- **The shards must reach one coordinator.** Runners cannot reach each other. The coordinator is
  therefore the deployed Worker (a staging session), or the Node one behind a public tunnel.
- **Peers on different runners must reach each other.** Runners sit behind NAT. If hole punching
  between them fails, links between shards go through TURN (`ice: "turn"`), which is a valid
  test of the overlay but adds a relay's delay to those hops.

The first task of the sharded harness is to measure both (PLAN.md, E-harness M5), before any
gate run is planned around them.

### 13.4 CI

Every push runs the `overlay` job: the package's own type check, lint, unit tests, and a swarm
smoke test (7 peers, one relay killed, the overlay repairs). The gate run is started by hand or
nightly, not on every push.

---

## 14. Security

What the overlay defends against, and what stage 1 leaves open. The last list matters most.

**Who is trusted for what.** Meetly's server decides who may join (tickets). The coordinator
decides who is who (grants) and is trusted with that, but never sees media. A peer is trusted
with nothing beyond its grant.

**Defended in stage 1**

- Joining without Meetly's say-so: tickets are HMAC-signed, short-lived and single-use.
- Linking to a peer of another session, or one that was never admitted: every link starts with
  a grant, checked against the session's key.
- Pretending to be the source to one's children: only the holder of a `publish` grant is
  accepted as a parent at depth 0, and `hops` and `path` must agree with it.
- Using the coordinator to reach arbitrary peers: signalling is only relayed between peers it
  has introduced.
- Making a parent work for nothing: retransmissions are capped at 20% of the bitrate per child;
  subscriptions and replays are rate-limited (one `sub` a second per child); a child silent for
  1 s is dropped; malformed packets are counted and, past 100 a second, close the link.
- Malformed input: every decoder for the unreliable channel returns null rather than throwing;
  every JSON message is validated field by field and unknown fields are removed.
- Lying about capabilities to become a relay and then performing badly: children's reports
  demote it (§8.1).

**Open in stage 1. Each must be closed, or accepted in writing, before a real audience.**

1. **A relay can alter or replace the media it forwards.** Nothing in stage 1 lets a viewer tell
   the source's frames from a relay's. One hostile viewer who becomes a relay can show its whole
   subtree anything. SFrame with a key shared by the whole audience does not fix this either: a
   viewer holds that key. The fix is a signature only the source can make (§15.2).
2. **Viewers learn each other's IP addresses.** That is what peer-to-peer means. In a webinar
   with a public link, any viewer can collect the addresses of the peers it is connected to.
   People must be told and asked, and a viewer who declines must be able to watch as a leaf
   through TURN, which hides its address from peers (and costs TURN traffic).
3. **Viewers' uplink and battery are used for others.** Relaying is limited to desktops on mains
   power with data saver off, but it is still someone's bandwidth. It needs consent and an off
   switch (the switch sets `dataSaver`, which is already honoured).
4. **A relay can see the program.** Without SFrame, media is encrypted hop by hop (DTLS) and in
   the clear inside each relay. For a webinar's audience, who are all entitled to watch, this is
   not a leak; it becomes one the moment anything is sent to only some viewers.
5. **A relay can drop or delay selectively** and stay inside every limit. Children notice loss
   and leave it, and the coordinator demotes it; a patient attacker still degrades a subtree.
6. **The coordinator is a single point for joining**, and a target: its limits are per socket,
   not per network address.

---

## 15. Stages

### 15.1 Stage 2: several trees, parity

- **Stripes.** A stream has *k* data stripes and one parity stripe; each stripe has its own
  tree; a peer is interior in at most one tree and a leaf in the others (the report's 4 stripes:
  layers plus parity). Already in place: `stripe` in every packet, `StripeConfig` in
  `StreamConfig`, a state machine per (stream, stripe), `stripes` in `sub`, an `Assignment` per
  stripe, `links` per stripe in `status`. What changes: the coordinator builds *k* trees and
  keeps the "interior in one" rule; **[D14]** is lifted so stripes repair independently.
- **Redundant base layer.** The proof's result that a base layer on two trees makes a relay's
  death invisible is one line of `StreamConfig`: two data stripes both listing temporal layer 0.
  Receivers already deduplicate by `frameId` and fragment.
- **Parity.** Packet type 1 exists and stage-1 relays forward it. Stage 2 fixes the code
  (the candidates are XOR over a GOP's packets and Reed–Solomon) and a decoder in `transport/`
  beside the reassembler. NACK stays as the cheap path for isolated loss.

### 15.2 Stage 2: SFrame, grants, a source signature

- **SFrame.** The source encrypts each frame's payload before `packetizeFrame`; the SFRAME flag
  says so; the first 24 header bytes are the associated data. Relays forward ciphertext and
  need nothing: they never read a payload, because `refDelta`, `keyDelta` and the layer are in
  the header. Receivers decrypt after reassembly. The interfaces already carry opaque bytes.
- **Source signature.** Closes §14 item 1. The source signs a digest of each GOP (or each frame;
  to be measured) with a key whose public half the coordinator vouches for in the `publish`
  grant. This needs a field the header does not have; it goes in the payload's SFrame trailer
  or in a packet of a new type, both of which older peers forward untouched.
- **Moderation by key.** Remove means rotate: a new `kid`, new grants to everyone else, a new
  SFrame epoch. Mute and stage become scopes in grants. The grant format does not change.
- **Keyframe requests** (`keyreq`), limited at the source.
- **Source handover**, so a session survives its host's tab.

### 15.3 Stage 3

- **Safari and Firefox as leaves.** They need only the receive side; `Capabilities.browser` and
  `decode` already keep them out of relaying and tell the coordinator what they can decode.
  The Worker-driven clock and `MediaStreamTrack` output are the parts to port.
- **Phones.** Leaf-only by §8.1 already. Work: decode cost, background behaviour, data use.
- **Gossip fallback.** When the coordinator is gone and the backup is too: `peers` messages
  spread candidates between neighbours, and `sig` carries signalling over existing links
  (`ttl`-limited). Both messages exist. This removes the coordinator from cold repair.
- **1,000 and 10,000 peers.** The sharded harness scales by adding shards. The coordinator is
  one single-threaded object per session; at these sizes its signalling load is the question,
  and the answer is likely one object per region under a session object.

### 15.4 Stage 4 (research)

Rotating speakers on the overlay. Out of scope.

---

## 16. Decisions the research report did not make

| | Decision | § |
| --- | --- | --- |
| D1 | Heartbeats on the unreliable channel; any packet proves the parent alive | 3.2 |
| D2 | Forwarding path free of DOM, so it can move to a Worker | 3.4 |
| D3 | Fragment frames ourselves, 1,150-byte packets | 4 |
| D4 | One session clock, synchronised through the coordinator's socket | 4.1 |
| D5 | Stage 1 recovers loss by NACK to the parent, answered from the GOP cache | 4.6 |
| D6 | 10 ms reordering window before a gap is called loss (superseded by D39) | 4.6 |
| D7 | Either side may open a link; perfect negotiation; the later `PeerId` gives way | 5.1 |
| D8 | One I/O-free coordinator core, two entry points, one contract suite | 6 |
| D9 | Admission by HMAC ticket from Meetly's server: 60 s, single-use | 6.1 |
| D10 | Signalling relayed only between peers the coordinator introduced | 6.4 |
| D11 | Grants: Ed25519, 10 minutes, verified by peers on `hello`; key rotation deferred | 6.5 |
| D12 | The tree map is soft state, rebuilt from peers' `status` | 6.6 |
| D13 | The coordinator is its own Worker, apart from the app's | 6.7 |
| D14 | In stage 1, audio and video share one parent and one backup | 7 |
| D15 | On joining, the first parent link to open wins | 7.1 |
| D16 | Heartbeat and detector timers run from a Worker-driven clock | 7.3 |
| D17 | STALLED: a cut-off relay tells its children to wait, so one death causes one repair | 7.4 |
| D18 | 20 s probation before anyone may relay | 8.1 |
| D19 | Spare uplink is measured with probe packets, not taken from the browser | 8.1 |
| D20 | Fan-out from spare uplink, at most 4; the source at most 3 | 8.1 |
| D21 | The relay score and its weights | 8.2 |
| D22 | Parent cost prices depth and loss, not only RTT | 8.3 |
| D23 | The program is the stage composed in the host's browser: one video, one audio | 9.1 |
| D24 | No keyframe requests in stage 1; a keyframe every 2 s | 9.3 |
| D25 | Each audio frame sent twice | 9.4 |
| D26 | Playout delay changes by dropping or repeating one audio frame a second | 10.5 |
| D27 | The source's bitrate follows its own uplink and the audience as a whole, never one viewer | 11.4 |
| D28 | What the gate's "loss and churn" are | 12.3 |
| D29 | Light viewers in the harness, with decoding viewers as a check | 13.2 |
| D30 | A backlog counts once it has stood over a line for 150 ms (integrator, 2026-11-21) | 11.2 |
| D31 | Rule 3: a further drop waits one observation window, and needs the backlog or the loss still over the line (integrator, 2026-11-21) | 11.3 |
| D32 | Loss counts only where the link shows a queue, with a guard for a policer: 10% for 3 s (integrator, 2026-11-21) | 11.2 |
| D33 | A frame is played at path + D + audio pipeline; the path followed at once when it grows (integrator, 2026-11-21) | 10.2 |
| D34 | Audio playout restarts in place when the delay is too far off to adapt a frame a second (integrator, 2026-11-21) | 10.5 |
| D35 | An Opus frame is stamped with the time of the sound it decodes to: first sample less 6.5 ms (integrator, 2026-11-21) | 9.4 |
| D36 | No retransmission of enhancement layers into a backlog over 50 ms of B; base layer and keyframes held until it clears (integrator, 2026-11-21) | 4.6 |
| D37 | A parent at its fan-out takes a viewer with nothing to watch, up to twice the fan-out, and sheds a layer (integrator, 2026-11-21) | 7.1 |
| D38 | Provisional relays: fan-out 2 on a short probe, before probation ends, used only when no full relay has a slot (integrator, 2026-11-21) | 8.1 |
| D39 | The reordering window is max(10 ms, p95 inter-arrival jitter), at most 60 ms (integrator, 2026-11-21) | 4.6 |
| D40 | The gate's clocks are judged as measured against chrony-synced wall clocks, the §4.1 bound only where a shard has no chrony (decided by integrator 2026-11-21) | 12.3 |
| D41 | The provisional probe lasts 1 s, at the fan-out-2 target (integrator, 2026-11-21) | 8.1 |
| D42 | A runner is starved when its timers run over 20 ms late at p99; its load is reported, not judged (decided by integrator 2026-11-22) | 12.3 |
| D43 | Keyframes up to 500 ms of B; paced over their own interval and two more; rule 6 (and rule 3) read the paced remainder as the keyframe's (integrator, 2026-11-21; remainder and rule 3, 2026-11-22) | 9.2, 4.2, 11.3 |
| D44 | Per child, live video waits behind its replay (integrator, 2026-11-22) | 11.5 |
| D45 | A replay is played forward: a missing frame waited for from when playout reached it while the replay can catch up, the newest frame shown every 100 ms (integrator, 2026-11-22) | 10.3 |
| D46 | Frames shown during a [D45] catch-up are not in glass-to-glass latency; counted apart, with their age (integrator, 2026-11-22) | 12.1, 12.2 |
| D47 | A relay is demoted for its children's loss only when more than half of them, and two at least, report over 5% (integrator, 2026-11-22) | 8.1 |
| D48 | The NAT probe answers as soon as the candidates decide it; the short probe waits for it (integrator, 2026-11-22) | 8.1 |
| D49 | While it is the only relay, the source takes up to `sourceAloneFanout` (6) children, as its probe toward a child shows (integrator, 2026-11-22) | 8.1 |
| D51 | `sourceAloneFanout`, an optional param (6), the ceiling of D49; fixed-tree scenarios set it to `sourceFanout` (integrator, 2026-11-22) | 8.1 |
| D54 | A joiner goes under the shallowest feeder with room, dead ends included (integrator, 2026-11-22) | 6.6 |
| D55 | A repair's lost frames exclude those of a layer above the new parent's lowest announced cap (integrator, 2026-11-22) | 12.2 |
| D56 | `maxFanout` 6: depth 3 for 200 peers; each relay still capped by its probe (integrator, 2026-11-23) | 8.1 |
| D57 | The source keeps its probed fan-out (up to `sourceAloneFanout`), not only while alone (integrator, 2026-11-23) | 8.1 |
| D58 | The honesty check compares light and decoding viewers at the same depths (integrator, 2026-11-23) | 13.2 |
| D59 | `deadMs` 150: three heartbeats missed (integrator, 2026-11-23); withdrawn the same day, false alarms under fan-out 6 | 7.4 |
| D60 | A join leaves a full relay's last slot (fan-out 4 or more) to repairs (integrator, 2026-11-23) | 6.6, 8.1 |
| D50 | The probe is sized by the session's bitrate; every relay's `role` carries its fan-out, and the node holds to it (integrator, 2026-11-22) | 8.1 |

Also decided by the integrator on 2026-11-21, without a number of their own: a gate is told
whether its stream is audio (§11.3 rule 1); a replay's own backlog is not congestion for 500 ms
(§11.5); the probe's target is a full fan-out's cost, and FEEDBACK goes down a link while PROBE
packets come up it (§11.6).

Also decided by the integrator on 2026-11-22, without a number of their own: a joiner's replay is
the base layer only beyond 500 ms behind the newest frame (§11.5).

Also decided here, with their numbers, because the report gave only the idea: the layer-drop
rules (§11.3), the jitter buffer's contract (§10), the standby reservation that makes a repair
never refused (§7.3, §7.5), and the rebalancing hysteresis (§7.6).

## 17. Baselines from the proof

Loopback, 4 shared cores, 1 source and 6 peers, VP8 L1T2 at 600 kbps asked (about 230 kbps sent
by the fake camera), 20 fps rendered. From `tree-results.json`.

| Measure | Proof |
| --- | --- |
| Forwarding, per hop | about 0.45 ms (2.5 ms at depth 1 to 4.7 ms at depth 6) |
| Join to first frame | 18–45 ms (no ICE cost on loopback) |
| Warm repair: detected | 169–172 ms after the kill |
| Warm repair: freeze | 206–209 ms; 0 frames lost; latency normal again after 173–176 ms |
| Warm repair: coordinator calls before media resumed | none |
| Cold repair through the coordinator: freeze | 225–227 ms; 0 frames lost |
| Two trees, enhancement relay killed | 100–102 ms gap, 1 frame lost |
| Two trees, base relay killed | 180–183 ms freeze, 0 frames lost |
| Base layer on both trees, either relay killed | 52–53 ms (the normal frame gap), or 100–104 ms with 1 frame lost |

These are what PLAN.md's acceptance tests are set against. They were measured with no loss, no
delay, no real NAT and seven peers; the gate is about what happens without those comforts.
