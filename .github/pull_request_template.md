<!-- Pull requests go to `main`. A release is a PR from `main` to `cloudflare-deploy` (docs/RELEASING.md). -->

## Summary

<!-- What changes for people using Meetly, and why. Link the issue if there is one. -->

## How it was tested

<!-- What you ran and what you saw: unit tests, which browser suites (`node test/e2e/run.cjs polls`),
     a manual check on which provider (LiveKit / RealtimeKit), desktop or phone. -->

## Screenshots

<!-- Before and after, for anything visible; phone width too if the layout changed. Delete if none. -->

## Risk and rollback

<!-- What could break, for whom, and how you would notice. How to undo it: revert this PR, a
     flag, or the Rollback workflow (docs/RELEASING.md → Rolling back). Say if it changes cost
     (RealtimeKit minutes), secrets, wrangler.jsonc or stored data. -->

## Checklist

- [ ] CI is green: types, lint, unit tests, both builds, browser tests. If a suite was marked
      **flaky: passed on retry**, there is an issue for it.
- [ ] **Code review**: someone other than the author read the diff (or the author re-read it
      later with fresh eyes and says so here).
- [ ] **Security review**: no secrets in code, logs or screenshots; new API routes check the
      session or host token; user input is validated on the server; nothing new is shown to
      people who were not let in; new dependencies are justified.
- [ ] **Copy**: visible text follows docs/UI-WRITING.md (icon + accessible name + tooltip over
      words; buttons of 1–2 words; no explanatory paragraphs; errors say what happened and what to
      do in one line; the screen stays within its word budget). Any change to visible text has
      before and after screenshots, desktop and phone, under Screenshots.
- [ ] Tests added or updated for the change; no test was loosened or deleted to make CI pass.
- [ ] Docs updated (README, docs/RELEASING.md) if setup, deploy or behaviour changed.
- [ ] Release PR only (`main` → `cloudflare-deploy`): merge with **Create a merge commit**, then
      watch the Deploy run and its smoke test.
