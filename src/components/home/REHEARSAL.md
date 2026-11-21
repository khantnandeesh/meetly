# Rehearsal: home feature grid ("Inside a meeting"), v2

The stageshow skill's hand-over note for the feature grid (`src/components/home/`). The hero's note is
`src/components/hero/REHEARSAL.md`.

v1 gave the grid motion and short copy. The founder turned it down ("looking awful"), with the
reaction tile as the example. The review of v1's posters found these faults, fixed here:

- **Reactions:** four chips on black in a mostly empty tile (void, wireframe).
- **Hands:** a gap under the title and an empty band under the list.
- **Polls and noise:** a bordered card inside the tile card (boxed).
- **Share:** black bands either side of the slide.
- **The grid:** tiles framed differently from one another.

## Gold

- `bento` (Kite): pictures pinned to the tile's foot, measured to the tile's width, at 1:1, a card
  inset on the gutters and run off the bottom (Approvals).
- `dark-bento`: depth on dark from a lighter raised surface on a darker ground.
- `hero-grid`: real UI large enough to read, every tile filled to its edges.

The difference from the gold that remains: every tile here is product UI (the PM's five call
moments), where the gold mixes in stat and object tiles. The variety comes instead from the grounds:
a light shared screen, a full-bleed signal, a video tile in the speaker's colour, and two panels.

## Plan

- **One frame.** Same radius, ground and gutter (24px on a phone, 28px from 48rem) in every tile.
  The copy sits top left in every tile. The ground is the call's own page (`--bg`), so the product's
  surfaces sit raised on it, as in a meeting.
- **Pictures.** Each picture fills the tile under its copy, out to the tile's sides and bottom,
  measured and drawn at 1:1 at the tile's own width (no scaling, except the phone's screen share,
  a computer screen drawn at 0.8). The product surface starts on the copy's gutter right under the
  copy, and the tile's foot crops it.
- **One height.** 351px from 48rem, 347 on a phone (the copy sits 4px higher there), so a one-line
  tile's picture is 280px everywhere. Every crop is composed for that height: it falls on a list
  running on (the menu's next group, a poll's fifth option as a wordless row, the panel's next
  section), a full gutter clear of the last thing that matters. Alone in its row (two columns), the
  share tile keeps 2:1. Three columns from 72rem, where a tile is about 350 wide (at 64rem hand
  names truncated and the noise hint wrapped under the crop).
- **The five:**
  - Share: the presenter's screen-share tile, the shared slide filling it edge to edge (no
    letterbox), the "You're sharing your screen / Stop sharing" banner at its top.
  - Noise: the microphone's signal across the tile, edge to edge, in syllables, over the real
    Audio settings menu (Microphone, its device, the Noise suppression switch, then the Speaker
    group off the crop).
  - Polls: the poll card as it sits atop the chat panel, five options, the fifth running off.
  - Reactions: a speaker's video tile (camera off: the call's gradient, avatar and speaking ring,
    name label with bars) filling the whole tile, copy on it. The lane sits where Reactions.tsx puts
    it, above the name label, four rows: 👏 ×12, 🎉 ×5, ❤️ Lena, 😂 ×3.
  - Hands: the People panel (header, Raised hands with Lower all, 1st/2nd/3rd, then In this
    meeting) running off the foot.
- **Motion** (one 10s cycle, a 2s slot each, so the busy moments go round the grid):
  - Share: Stop sharing pressed, the banner goes, "Starting your screen share…", live again, the
    banner drops in.
  - Noise: the switch off, keyboard clacks and a bark rise in the gaps between syllables (tagged),
    then back on and the signal calms bar by bar.
  - Polls: a new poll replaces the old one (overlapping), the vote, a spinner, the ✓, the counts
    roll from 7 to 12 votes.
  - Reactions: the lane runs out, "👏 Sam" arrives, nine claps rise from the tile's foot, arc over
    the lane and drop into the row, which pops as it rolls to ×12, then the other rows push in.
  - Hands: Lower all, the rows clear in a cascade, the list below glides up into their place
    (the panel's own behaviour), and each hand that goes up pushes it back down a row. Rows of the
    list show only while they fit whole above the crop.
- **Calm and weight** as v1:
  - Stages play only in view; only transform and opacity animate; reduced motion keeps the posters.
  - First load is +1.6 KB JS and +1.6 KB CSS gzip against main (242,456 → 244,085 JS;
    16,947 → 18,507 CSS).
  - The grid's motion is a 1.3 KB deferred chunk on the hero's engine.

## Gate

Every tile, at 1440 and 390, on the production build:

```
rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)
```

## Film lines → fix

- `real words … are cut by the crop` and `runs only 19/23px past the bottom edge` (polls): the
  crop went through "Friday". The fifth option is now a wordless row running 24px+ past.
- `tight inset: div.gm-menu-label` (noise): the labels' words now sit in their own box in the
  label's padding.
- `half-pixel glyph` (noise tags): even widths.
- `emoji icon` (reactions burst): the burst and lane are marked `data-emoji`; they are reactions.
- `framing: div.flex ends 10px short of the top edge` (share, 390): the phone design puts the
  banner 24px down (19px once drawn at 0.8) and the slide under it.
- `real words … "Amara Osei" / "DB" cut by the crop` (hands): the list now shows only the rows
  that fit whole above the crop at each count.
- `lands on a transform` (share page) and `steps in its box` (name label): lasting layers.
- Still printed, judged intended:
  - `near aligned` and `lopsided` on the poll card and lane chips: Polls.tsx's and Reactions.tsx's
    own insets;
  - `jump` and `settle snap` on Count's digit strips;
  - `appears with no entrance` on a Count or the old poll card (an identical copy taking over);
  - `near-empty frames` at each loop's reset (sharing stopped, the lane run out, hands lowered),
    which are the product's real states.

## Review

Fresh-eye pass on the frames (review.md), by the builder, not an independent reviewer:

- The reaction speaker's yellow repeated the hero's yellow "AC". Now pink, a pastel from
  Avatar.tsx that the page uses nowhere else.
- The lane's top half of the tile was empty. A fourth row lifts the lane level with the avatar.
- The hands list sat empty for half a second after Lower all. Now the list glides up.
- At 1024 the share tile cropped the screen by 55% and three columns truncated names. Fixed by the
  2:1 share tile and the 72rem breakpoint.

## Not checked

- Safari and Firefox, and real devices.
- An independent reviewer: a separate designer reviews before the founder.
- Widths between those filmed (390, 768, 1024, 1152, 1440) only by posters.
