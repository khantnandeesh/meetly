# Writing for Meetly's screens

The less text the better. A recognisable icon with a tooltip says most things; words are for what
an icon cannot say. These rules apply to every string a person sees: pages, dialogs, menus,
toasts, notices, empty states and errors. A reviewer can check each one.

## The rules

1. **Icon + accessible name + tooltip, over words.** A control a person already knows (microphone,
   camera, chat, hand, share, close, more) is an icon button with an `aria-label` and a `Tip`
   (src/components/ui/Tip.tsx). A fact that would otherwise be a sentence is a `Fact`
   (src/components/ui/Fact.tsx): an icon, two or three words, and the full sentence in its tooltip
   and for screen readers.
2. **Buttons and menu items are one or two words**, a verb or a well-known noun: "Join", "Go live",
   "Copy link", "Schedule…". Up to three when the object must be named ("End for everyone").
   An ellipsis means "asks for more before doing it".
3. **No explanatory paragraphs on screens.** No sentence that only explains how something works.
   If it matters, it is a `Fact` (or a list of them) with the sentence in the tooltip, or it goes
   behind a "How it works" disclosure. A menu item has no second line, unless without it the item
   could be misread (Sounds → "Off: You still hear people").
4. **An error is "what happened + what to do", in one short line.** "No camera was found. Connect
   one, then try again." Not why, not background. Under 15 words.
5. **One idea per element.** A heading names the state ("Asking to join…"), the line under it, if
   any, says the one thing to know next.
6. **Every icon-only control has an accessible name**, and a tooltip on hover and focus. Text
   removed from the screen moves into `aria-label`, `sr-only` text or a tooltip; it does not
   disappear for screen readers.

## When text must stay

- **Consequences people agree to**: ending something for everyone, being seen and heard, being
  visible to others (the serverless webinar's "Peers see your IP address", "You may relay the
  video"). Short, but on the screen, not only in a tooltip: a tooltip does not open on a phone.
- **Errors and blocked states**: what happened and what to do.
- **Destructive confirmations**: a short dialog naming who is affected ("It stops for all 7
  viewers, and the link stops working for good.").
- **Labels on form fields**: a visible label, not a placeholder in its place.
- **What an icon would leave ambiguous**: "Via our servers" next to the server icon, "Up to 50
  viewers".

## Word budgets

Visible words on a screen as it first appears (headings, labels, buttons, placeholders; not
illustrations marked `aria-hidden`, not tooltips, not `sr-only` text). The browser test
`test/e2e/copy.cjs` (`node test/e2e/run.cjs copy`) counts them at 1440 px and 390 px and fails
over budget, listing the words.

| Screen | Budget | Before this standard | After |
| --- | ---: | ---: | ---: |
| Home | 35 | 47 | 32 |
| Webinar chooser ("New webinar…") | 26 | 65 | 24 |
| Meeting pre-join (form column) | 15 | 34 | 13 |
| Serverless webinar, host before going live | 52 | 175 | 47 |
| Serverless webinar, viewer before Watch | 33 | 73 | 30 |

For screens without a test: a dialog 30 words, a toast 12, a menu 2 per item, an empty state 10,
an error 15. A screen that needs more says why in its pull request, and its budget is raised in
the test in the same pull request.

## In review

Every pull request that changes visible text ticks the **Copy** item of the checklist
(.github/pull_request_template.md): it follows this page, and has before and after screenshots at
desktop and phone width.
