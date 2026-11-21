# Rehearsal: home feature grid ("Inside a meeting"), with motion

The stageshow skill's hand-over note for the feature grid (`src/components/home/`). The founder
asked for "more animation and jazz, and less text". The PM's claim checks
(`team/bento-approved.md`) still hold. The hero's note is `src/components/hero/REHEARSAL.md`.

## Plan

- **Copy.** A title and at most one short line per tile:
  - "Share your screen" / "From a computer"
  - "Noise suppression" / "On by default"
  - "Quick polls"
  - "Group reactions"
  - "Hands, in order"

  Nothing else; the pictures carry the rest.
- **Layout.** Unchanged: "hero and strip" from 64rem, two columns from 48rem, one column 358 wide
  at 390.
- **Motion.** Every tile is a short loop of the product's own behaviour, on one shared 10-second
  cycle with a 2-second slot per tile, so the busy moments go round the grid (share, noise, poll,
  reactions, hands) and at most two tiles move at once. Each loop starts and ends on its payoff
  (its poster) and gets back to it by doing what the product does next, never by rewinding:
  - **Share:** the pointer presses Stop sharing; the banner goes and the shared tab leaves for
    "Starting your screen share…"; the tab goes live again and the banner drops back in.
  - **Noise:** the pointer turns the switch off; keyboard clacks and a dog's bark rise through the
    signal, tagged; turned back on, the signal calms bar by bar from the left.
  - **Poll:** the finished poll gives way to a new one; the pointer votes Wednesday, a spinner, the
    tick lands, the results show at 7 votes, and the count rolls to 12.
  - **Reactions:** the lane runs out, oldest first; "👏 Sam" arrives, a burst of claps merges into
    it and it rolls to ×12; 🎉 ×5, ❤️ Lena and 😂 ×3 push in above (three rows on a phone).
  - **Hands:** the pointer presses Lower all; the rows clear in a cascade; hands go up one by one,
    each given its place, 1st, 2nd and 3rd.
- **Calm.**
  - A tile plays only while it is on screen; the kit's stage stops it off screen.
  - Only transform and opacity animate, except the real switch's colour.
  - Under reduced motion no animation loads and each tile is its poster.
- **Weight.**
  - First load grows by about 1.1 KB of JS and 1.0 KB of CSS (gzip); the posters are plain
    markup.
  - The motion loads as a deferred chunk once the grid is near and the page is idle: the grid's
    own code is about 1.4 KB, on the hero's stage engine (about 10 KB JS and 2.7 KB CSS, shared,
    not loaded twice).
- **Gold.** `bento` for the set; `subscriptions` and `payout-flow` for the cursorless reactions
  story; `hero-demo` for the pointer beats; `choreography` for overlap (the poll's old card leaves
  as the new one arrives).

## Captured

Every tile at 1440 and 390, on the production build: a contact sheet over a full cycle, the gate,
and the poster. Also a webm of the grid playing at 1440, and the `home` e2e suite (the copy, every
story's last beat and held payoff, nothing clipped at 390, reduced-motion posters).

## Gate

Every tile, at both widths:

```
rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)
```

## Film lines → fix

- `framing: target span.gm-lower is cut by the crop` (hands): "Lower all" kept its People-list
  inset and poked 10px past the picture. It now sits inside.
- `uneven gutters: div.gm-wave` and `framing: div.gm-menu ends 6px short` (noise): the signal and
  the menu row were two cards. They are now one card, the picture's full height.
- `framing: div.flex ends 9px / 10px short of the edge` (share at 390): the scaled screen put the
  banner a few pixels from its edge. The phone design is now 420 wide with the banner 16px down,
  a full gutter once drawn at 0.8.
- `unclipped` (share): each stage clips its own picture.
- `lands on a transform` (banner, tags, poll cards, lane rows, hands): each keeps a layer.
- `near-empty frames` (poll): the card vanished before the new one came. The old card now leaves
  over the new one arriving.
- `loop seam: cursor does not end where it starts` (noise): its last move is now awaited.
- Rolling percentages read "17 %": the kit counter's unit gap is zeroed for these scenes.
- Still printed, judged as intended:
  - `jump` on the counter's digit strips and the burst emoji, which are fast rolls and a
    short flight;
  - `near aligned` and `lopsided` on the poll card and lane chips, which are the product's own
    insets;
  - `shrunk` on the phone's screen share, which is a computer's screen drawn smaller on purpose.

## Not checked

- Safari and Firefox, and real devices.
- Live pacing on a slow phone.
- Switching to reduced motion mid-loop (the kit returns to the poster; not filmed).
