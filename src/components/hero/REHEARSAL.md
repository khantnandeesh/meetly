# Rehearsal: home hero ("Pat wants to join")

The stageshow skill's hand-over note for `HeroArt` (`src/components/HeroArt.tsx`, `src/components/hero/`).

## Plan

- **Medium.** A looping animation in the home hero, beside "Video meetings, one link away", on
  the page's dark ground (a transparent stage, no plate). The slot is the old illustration's: at
  most 34rem, 483px wide at 1440, 421px at 1024 and 544px at 768. The phone column is 358px at
  390 (the wrapper's gutter is now 16px, so the compact design draws 1:1).
- **Designs.** Wide is 558 × 440 (shown at 0.86 on a 1440 screen). Compact is 358 × 434, a
  redesign as Meetly's phone call (top bar with the code and People, the phone's six controls,
  notifications under the top bar), not the wide one squeezed. It switches below 400px.
- **Story.** In a meeting that asks people to knock, somebody opens the link and asks to join.
  The host admits them and they are in the call. It is the hero copy's own promise ("one link…
  People join from their browser"), and the knock with Deny and Admit is distinctive to Meetly.
  The hands queue was the alternative, but the feature row under the hero already says "raise a
  hand", and it does not pay off the hero copy.
- **The call.** One-to-one: you (the host) and Maya. Two people get two tall tiles side by side
  (Stage.tsx's own grid rule, at both widths), which leaves a band of plain tile between each
  avatar and its name chip. The notification sits in that band, so on the poster and in every
  held frame it cuts no avatar and no chip (measured: about 8px clear of Maya's speaking halo and
  of her chip on a computer; 27px clear of both avatars on a phone).
  - On a phone it is exactly where the app puts it: under the top bar, over the tiles' plain tops.
  - On a computer it stays at the bottom right, but sits higher than the app's 28px over the
    controls. At 28px, whichever chip is under it shows a 4px sliver below its edge.
- **Beats (about 11 s).** (0) The request: "Pat wants to join · Deny · Admit", and People showing
  1 waiting. (1) The pointer presses Admit (on a phone, a fingertip). (2) The notification and
  badge go, the two tiles make room (side by side → 2+1), Pat's tile grows in under them, and
  People rolls 2 → 3. (3) Pat speaks (the speaking ring moves from Maya to Pat, then back). (4) Pat
  leaves (their tile fades, the others grow back, 3 → 2), then knocks again, which is the opening
  frame. The loop has no seam.
- **Poster.** Beat 0: the request on screen with Admit one press away. It is what the page paints
  first, and all it shows under reduced motion.
- **Fidelity.** Realistic: real names on every tile, no placeholder bars. Five real strings carry
  the story: the notification, Deny, Admit, the count and the badge.
- **Left out.** Video (avatars are the real camera-off tile), reactions, More, layout, chat
  panels, a muted participant and a raised hand (kept off so the frame stays calm; the feature
  row covers hands).

## Gold

`hero-demo` (an animated hero beside copy, a cursor gesture, named targets, a stage about 720 ×
340 with a compact design), with `dark-hero` for the dark ground (depth from surface steps, one
lit colour). Kept from them: the Stage/script/poster structure, named `data-target`s, a rest point
for the cursor, `compact` as a second design, and one lit colour (Meetly's lime). Changed: the
layout is not corner bleed. Meetly's call screen has no window chrome and its ground is the page's
own `--bg`, so the call screen *fills* the stage (framing.md: "bleeds or fills"). Drawing it as a
window cut by the stage would put a hard edge in the middle of the page.

## Look

Built from Meetly's own classes and icons: `tile`, `avatar-disc`, `chip`, `bars`, `ctrl`,
`ctrl-split`, `ctrl-danger`, lucide, `LogoMark`, `initials`, and the avatar palette. The real
`Tile`, `ControlBar` and `Toaster` need a live call, so their markup is mirrored with the same
classes. The kit's tokens are mapped from `globals.css` in `hero.css` (accent, surfaces, greys,
font, radii, control height). Motion uses the app's `--ease-*` and `--dur-*`. The glide (380 ms)
and arrival (320 ms) are slower than in a call (260/200 ms), so they read at this size.

## Captured

- Widths: 1440 (wide, 0.86), 1024 (wide, 0.75), 390 (compact, 1:1), all on the production build
  (`next start`).
- Loops: `contact-sheet-1440.png`, `contact-sheet-390.png`. States: `states-1440.png`,
  `states-390.png`. Beats stepped with `--at` (pat-leaves at 60 ms, on dev).
- Reduced motion: the page shows the server-rendered poster, and the animation chunk is never
  fetched (checked: no `.hero-stage` under `reducedMotion: 'reduce'`).
- The menu: on a phone the notification steps aside (`data-quiet`, opacity 0) while the New
  meeting menu is open, on the poster and on the live stage, and comes back when it closes.

## Gate

```
1440: rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)
390:  rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)
```

Both also pass with `--states --gate`, and so does the loop at 1024. Film calls every run
"inconclusive" because headless Chrome on this machine misses frames (sampling gaps over 27 ms).
The gate does not count those gaps, but motion inside them was not judged.

## Film lines → fix

- **Integrator review: the notification sliced avatars.** The first version was a four-person
  call. On a computer the notification cut Priya's avatar in half; on a phone, Alex's and Maya's.
  No film line names this; it was found by eye. With 182px or 154px tiles the notification always
  lands on the centred avatar. The call is now one-to-one, and the notification sits in the band
  between avatars and chips (see "The call" above). The gap from the notification to every avatar
  (with its halo) and chip was measured in the browser at 1440, 1024, 768 and 390, poster and
  live, with a throwaway Playwright script.
- `framing: tile ends 7px short of the edge` and `jump: chip … height +6px` (wide, first
  version): the 8px inset was neither a gutter nor a bleed, and five tiles in three columns fell
  under Meetly's 11rem dense-chip width, so every chip changed size as Pat came and went. The wide
  call now runs to the stage's edges, at 558 wide so the grid divides exactly (2 × 273 + 12).
  Every tile stays over 11rem. Chat was added after People (its real place), so the waiting badge
  stays in frame.
- `half-pixel glyph` / `steps in its box` (bar): the count's text width put every control on
  fractions. The count now has a one-digit slot. People was sampled every frame for 13 s and
  never moves. The `steps in its box` line on People still prints: its Count strip rolls by
  transform. Not a gate line; looked at, no hop seen.
- `lands on a transform` (toast, badge, tiles): each keeps a layer for good (`will-change`).
- `tight inset: Admit 6.9px from the toast's edge`, and `uneven padding: hero-toast bottom 7px`
  (only while Admit shows its pressed fill): the answers sit 4px further in, and the card has
  12px under them (the app has 8).
- `uneven gutters: tile … from div.backdrop-glow` (390): the check found the page wrapper as the
  nearest painted surface and judged each grid tile as a card on it (its "731px from the bottom"
  is the end of the page). The scene root is marked `ss-window` (no styles), which says what it
  is: the product's own surface, filling the stage. **A judgment call**: it also exempts the
  tiles from the box-edge checks, which then judge the screen as a whole (it fills the stage).
- `framing: hero-toast opens within a gutter of the stage's edge`: the toast is tagged `ss-toast`
  so overlay checks judge it. It now keeps 24px on a computer (16 or more at 0.75) and 16px on a
  phone. The phone gutter became 16px so the tiles line up with it.
- `uneven padding: div.tile` (1024 only): the speaking bars are 2.5px, under 2px on screen at
  0.75, so the check could not see them. They are drawn 3px wide here, which also reads better.
- `clipped: i … by span.hero-bars`: the bars now fade in after their room has opened.
- An onion-skin frame seen in the states sheet (a tile gliding under Pat's fading one): the others
  now start closing up 160 ms after a leaving tile starts to fade.
- Still printed, not gate lines: `half-pixel glyph: a 24px svg … in 105x22 span.chip` (390).
  Measured: the icons are 14px at whole-pixel offsets in their chip. The 24 is the SVG's `width`
  attribute, and the remaining fraction is the page's text flow above the stage. `scale: 0.75`
  at 1024: the hero column is narrowest there; type is about 10px. Left, because the brief keeps
  the old illustration's space.

## Review

No independent reviewer was available. This pass was the builder's, by `verify.md`, against the
frames above, and it is not a fresh eye. What it found:

1. Framing: in my own pass I kept the notification covering half of an avatar, because that is
   where Meetly puts it. The integrator's review sent it back (a shape cut mid-way reads as a
   glitch), and it is fixed above. That was the largest fault, and I had passed it.
2. Motion: on 2 → 3, the two tall tiles shrink to the top row before Pat's grows in under them.
   For about a quarter second the lower half of the stage is empty (contact sheet, 1.6s). It is
   the real reflow's order; kept.
3. Hierarchy: the eye lands on the notification first, then the speaking ring; the payoff (Pat's
   tile, ringed) is the largest change. Nothing to fix.

## Assumptions

- The meeting is in "Ask to join" mode (a host setting; the default is "Anyone with the link").
  The knock only exists in that mode.
- A person who has left can knock again (Pat's second knock closes the loop).
- No "Pat joined" notification: Meetly shows none when the newcomer's tile is on screen.

## Unresolved

- At 1024–1100px the illustration draws at 0.75–0.8, and its smallest type is about 10px.

## Not checked

- Real devices and Safari or Firefox: only headless Chrome (Playwright's `chromium` channel, with
  the system's Google Chrome).
- Live pacing on a slow phone (rAF timestamps against transforms), and switching to reduced
  motion during playback (the kit returns to the poster; not filmed).
- Contrast of the chip text over the tile gradients, beyond the eye.
