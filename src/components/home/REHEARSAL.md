# Rehearsal: home feature grid ("Inside a meeting")

The stageshow skill's hand-over note for `FeatureGrid` (`src/components/home/`). The content is
the PM-approved list. The hero's note is `src/components/hero/REHEARSAL.md`.

## Plan

- **Layout.** The skill's "hero and strip" (`references/bento.md`):
  - From 64rem: three columns. The screen share takes two thirds of the first row, then three
    equal tiles.
  - From 48rem: two columns, with the screen share across both.
  - Below that: one column, 358 wide at 390 (the hero's width).
- **Gold.** `bento` for the set (rounded tiles on a gap, run-in copy at the top, one wide picture
  tile); `ruled-bento` and `dark-bento` for a dark page.
- **Kinds.** Screen share (wide UI), noise suppression (statement), poll (component), reactions
  (collection, the real lane), raised hands (component). Neighbours differ across and down.
  Nothing repeats from tile to tile or from the hero (no Alex, Maya or Pat).
- **Words.** Each picture uses the product's own strings and markup classes (Stage.tsx, Tile.tsx,
  Polls.tsx, Reactions.tsx, PeoplePanel.tsx, the noise menu row in ControlBar.tsx).
- **Motion.** Stills, except the poll's bars:
  - they fill once, by scaleX from the left, with `--dur-slow` and `--ease-move`, when the card
    is first half visible;
  - the bars render full, so no-JS visitors and screenshots see the result;
  - nothing moves under reduced motion.
  The hero above stays the page's only loop.
- **Weight.** Plain markup and CSS, not the hero's stage engine. The page gains about 1.7 KB of
  JS and 1.0 KB of CSS, gzipped.

## Captured

- Widths 1440, 1024, 768 and 390, on the production build. Reduced motion is covered by the
  `home` e2e suite.
- Each picture carries `ss-stage` (styled by `feature-grid.css`, not by the kit) so the film checks
  judge it.

## Gate

```
1440: rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)
390:  rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)
```

## Film lines → fix

- `unclipped: fg-share-frame runs 48px past the stage`: the share picture now clips at the
  tile's edge itself (`overflow: hidden`).
- Still printed, judged as the product's own geometry, not changed:
  - `near aligned` (the poll question 8px left of its options' text): Polls.tsx's `px-1` header
    over `px-3` options.
  - `lopsided` (lane chips 10px and 15px): Reactions.tsx's `pl-2 pr-3`.
  - `near aligned` (390: the banner and the "Your screen" label in the scaled screen): one is
    centred, the other sits in a corner.
  - `steps in its box`: the section's own rise as the page loads.

## Fixed by eye

- **Reactions:** a void under the lane. The lane now sits at the bottom left, as in a call, at
  1.25 times its size.
- **Noise:** a band under the line. The statement is sized to the tile, and the share picture's
  height matches it.
- **Poll:** the first version emptied an off-screen card ahead of time, so a full-page screenshot
  showed empty bars. It now animates from empty only at the moment it fills.

## Not checked

- Safari and Firefox (`zoom` on the lane needs Firefox 126 or later), and real devices.
- 640–767px is a single column of wide tiles: looked at, not gated.
