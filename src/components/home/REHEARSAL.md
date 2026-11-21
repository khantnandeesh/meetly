# Rehearsal: home feature grid ("Inside a meeting"), v3

The stageshow skill's hand-over note for the feature grid (`src/components/home/`). The hero's note is
`src/components/hero/REHEARSAL.md`.

## History

- **v1:** motion and short copy. The founder turned it down ("looking awful").
- **v2:** every tile became a filled, real call moment, framed alike. The independent review passed
  the stills, nearly, and failed the motion:
  - five loops competed, four of them with cursors;
  - the share tile went black;
  - three tiles rewound their own data in view;
  - claps flew over the speaker's label.

  Its smaller findings:
  - the speaker's avatar outweighed the lane;
  - the phone's slide fell under 10px;
  - two copy patterns sat in one grid;
  - a hairline landed on the noise crop;
  - gate polish, and lime everywhere.
- **v3:** the founder still wants "more animation and jazz", so the tiles stay alive. They are
  calm, truthful, and only one moves at a time.

## Gold

`bento` (pictures pinned to the tile's foot at 1:1, a card on the gutters running off),
`dark-bento` (raised surfaces on a dark ground), `hero-grid` (UI large enough to read). Kept from
v2, which the review accepted, the bordered poll card and People panel included.

## Plan

- **One frame.** Same radius, ground (the call's page), gutter and title, a title alone on every
  tile ("From a computer" and "On by default" are gone).
  - Each picture fills the tile under its title, to its sides and foot, at 1:1 at the tile's own
    width.
  - Every tile is 351px tall from 48rem (347 on a phone), so every picture is 280px. Each crop is
    composed for that.
  - Three columns from 72rem; below that two, with the share tile at 2:1.
- **One tile moves at a time.**
  - A conductor (GridStages.tsx) hands out turns in reading order, skipping tiles that are off
    screen.
  - Each turn is one beat of about 1.5 to 2.5s; it settles (450ms), and the next comes after a
    900ms pause.
  - A full round is about 17s. No cursors anywhere.
- **Stories only go forward.** Each script runs for as long as its stage is on screen and keeps its
  own state, so nothing resets in view; off screen the kit resets the stage to its poster, unseen.
  - Share: the presenter's chart takes in a new week; the bars move along one place, the new one
    grows, the oldest fades out at the left. The banner stays. Never black.
  - Noise, on, as by default: each beat is the next few words (the voice bars change), and a
    noise reaches the microphone (Keyboard, Dog, Coffee machine in turn). It shows in grey behind
    the voice, named, and goes; the voice carries on. The switch never flips.
  - Polls: new votes arrive and the counts tick up; your ✓ stays. On the third turn the poll ends
    ("Ended · 18 votes", the product's own words). The next one rises in as the old one leaves,
    and your vote lands in it (spinner, then ✓).
    - The polls cycle: offsite day, lunch, venue. Askers Sam, Noor, Theo.
  - Reactions: every other beat a row's count ticks up and its emoji nudges once. In between, a
    reaction arrives on top (named if alone, a count if several), and the oldest at the bottom
    expires: it slides out and the rest glide down.
    - The lane's order is the product's: oldest at the bottom, newest on top (Reactions.tsx).
    - Nothing flies.
  - Hands: a hand goes up per beat and gets its ordinal; with three up, Lower all is pressed (its
    fill, no cursor) and the rows go.
    - The list below glides up into their place, then is pushed down a row per new hand.
    - Each round is new people in a new order. The heading keeps its count as it fades, so there
      is no "Raised hands 1" over no rows, and no ghost row.
- **The review's other items:**
  - Avatar: 96px from 48rem, 64px on a phone, centred in the tile, ringed, clear of the lane.
  - Phone share: the screen runs off the right and the bottom, drawn at 0.85 (every word 10px or
    more). The banner is whole, 24px down and a gutter from the right.
    - At 1:1 the banner is 350px, which a 358px tile cannot hold with a gutter.
  - Noise crop: the menu runs on (`data-crop`); the crop cuts through the Speaker list's device
    row, not along a rule.
  - Poll: the question sits on the options' left edge; the counts are separate spans with a gap.
  - Numbers: the grid's counters are a small tick (the new figure rises in, the old rises out).
    The kit's Count re-centred its digit strip after each roll, which film read as a 120 to 140px
    snap.
  - Hand badges: they fade with their row and change scale only while invisible, so there is no
    snap.
  - Lime only on each tile's payoff: the share banner's icon (the product's), the noise switch,
    your vote (✓ and your bar; everyone else's bars grey), "1st".
    - Calmed: the waveform (light), the device check (muted), the speaking bars (light), the hand
      badges (the hand-raised tint), Lower all (text colour).
- **Weight.**
  - First load: +2.1 KB JS and +1.6 KB CSS gzip against main (242,456 → 244,545 JS;
    16,947 → 18,503 CSS).
  - The grid's motion is a 1.8 KB deferred chunk, on the hero's 10.2 KB engine chunk, shared.
  - GridStages imports the kit's Count only so the bundler keeps one engine chunk for both.
    Without it the engine shipped twice.

## Gate

Every tile, at 1440 and 390, on the production build:

```
rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)
```

The home e2e suite also samples the grid every 100ms for 21s. It checks that:

- at most one tile is mid-beat at any time;
- all five take a turn;
- every tile at rest still shows its payoff.

## Film lines → fix (v3)

- `framing: span runs only 19px past the right edge` (phone share chart): the presenter's slide
  is cut on purpose, so the chart carries `data-crop`.
- `hard edge` (the oldest chart bar sliding out): it fades in 90ms, before the screen's edge.
- `hard edge` on the counters (a clipped tick): no clip; the figure fades in from below.
- `jump` on lane rows: the lane's glide was overridden by the scenes' generic transition; it is
  now 420ms on a standard curve.
- `half-pixel glyph` (noise tags): even widths with even padding.
- Still printed, judged intended:
  - `lopsided` lane chips: Reactions.tsx's own `pl-2 pr-3`;
  - `jump` on a poll count's left edge when it gains a digit: the product's own reflow;
  - `vanishes with no exit` on a poll figure: an outgoing tick already faded.

## Not checked

- Safari and Firefox, and real devices.
- An independent review of v3 (the reviewer reviews it before the founder).
- Widths between those filmed (390, 768, 1024, 1440) only by posters.
