# Releasing Meetly

Production is the Cloudflare Worker `meetly` at https://meet.nandeesh.dev, deployed from the
`cloudflare-deploy` branch by `.github/workflows/deploy.yml`. Everything reaches production the
same way: through a pull request, with CI green, merged by a person.

```
feature branch ──PR──▶ main ──release PR (merge commit)──▶ cloudflare-deploy ──▶ Deploy workflow ──▶ meet.nandeesh.dev
                        │
                        └──▶ staging (auto-deploys from main, once set up: see "Staging")
```

## The normal flow

1. **Branch from `main`.** `git switch -c my-change origin/main`. One topic per branch.
2. **Open a pull request to `main`.** Fill in the template (summary, how tested, screenshots,
   risk and rollback, checklist). CI runs on the PR: types, lint, unit tests, a build for each
   provider (LiveKit, RealtimeKit), and the browser tests against a LiveKit dev server.
3. **Review.** Work through the checklist's code review and security review. Branch protection
   asks for 0 approvals, so the author can merge, but the review still has to happen.
4. **Merge to `main`** once the four required checks are green and the branch is up to date
   with `main` (GitHub offers **Update branch** if not). Squash or merge commit, either is fine.
   The branch is deleted automatically.
5. **Staging** deploys `main` (once set up; until then, check the change locally or with
   `npm run preview` on `cloudflare-deploy`).
6. **Release: open a PR from `main` to `cloudflare-deploy`.** Title it `Release YYYY-MM-DD`,
   and list the PRs it carries in the body. CI runs on it again.
7. **Merge it with "Create a merge commit".** Not squash, not rebase: a merge commit keeps
   `main`'s commits as they are, so `main` and `cloudflare-deploy` never disagree about history,
   and one revert of the merge commit undoes the whole release.
8. **The push to `cloudflare-deploy` starts Deploy**: the CI jobs again, then (after the
   `production` environment's approval, if required reviewers are on) `opennextjs-cloudflare
   build` and `deploy`, then the smoke test of https://meet.nandeesh.dev. Watch it: Actions →
   Deploy. The run's summary shows the Worker version id.
9. If the smoke test fails or the site misbehaves, **roll back first, then fix** (below).

Never push to `main` or `cloudflare-deploy` directly; branch protection refuses it, for admins
too.

## Staging

Not set up yet. The plan: `main` becomes identical to `cloudflare-deploy` (a one-time
fast-forward, pending the founder's decision), so `main` carries the Workers files
(`wrangler.jsonc`, `open-next.config.ts`, `.env.production`), and a second Worker (for example
`meetly-staging`, with its own secrets and its own RealtimeKit app or minute limit) is deployed
by a workflow on every push to `main`. Until it exists, step 5 is a manual check.

## Emergency path: deploying without the tests

`deploy.yml` on `cloudflare-deploy` has a `skip_tests` input: **Actions → Deploy → Run
workflow**, branch `cloudflare-deploy`, tick **skip_tests**. It deploys the current head of
`cloudflare-deploy` without running CI (the Workers build still has to succeed, and the smoke
test still runs).

**When it is allowed** (the founder decides, and says so in the PR or issue):

- Production is broken, the Rollback workflow cannot fix it (for example, every earlier version
  is broken too because something outside the code changed), and the fix is small and read.
- A beta the founder explicitly chooses to ship ahead of its tests.

Not allowed: to get past a failing or slow test, or because CI is red for a reason nobody
understands. A flaky failure is re-run (below), not skipped.

**It needs admin enforcement off.** Getting the fix onto `cloudflare-deploy` without waiting for
the required checks means merging before they pass, which "Do not allow bypassing the above
settings" (`enforce_admins`) refuses even to admins. So:

1. Settings → Branches → the `cloudflare-deploy` rule → **Edit** → untick **Do not allow
   bypassing the above settings** → **Save changes**.
2. Merge the fix PR into `cloudflare-deploy` as an admin, bypassing the pending checks (the
   push also starts a normal Deploy, which waits behind yours and redeploys the same commit
   once CI passes; that is fine).
3. Actions → Deploy → Run workflow on `cloudflare-deploy` with **skip_tests** ticked. Watch the
   smoke test.
4. **Turn the setting back on** at once (step 1, tick the box). Check it: the rule shows
   "Do not allow bypassing the above settings".
5. Open a PR bringing the same fix to `main`, so the next release does not undo it, and an issue
   recording what happened and why the tests were skipped.

## Rolling back

Cloudflare keeps every uploaded version of the Worker, and a rollback switches production to one
of them instantly, without a rebuild. Use `.github/workflows/rollback.yml`:

- **Actions → Rollback → Run workflow**, action `list`: shows recent deployments and versions,
  changes nothing.
- Action `rollback`, version empty: goes back to the version before the current one. With a
  version id (from `list`, a Deploy run's summary, or the dashboard): goes back to that one. It
  then runs the smoke test.
- Without GitHub: Cloudflare dashboard → Workers & Pages → `meetly` → Deployments → **⋯** →
  Rollback, or `npx wrangler rollback [<version-id>] --message "why"` on `cloudflare-deploy`.

A rollback changes production, not the code: the next push to `cloudflare-deploy` deploys
whatever is there. So after rolling back, revert the cause on `main` with a PR (GitHub's
**Revert** button on the merged PR makes one), and release again as usual. Prefer that to
reverting the release's merge commit on `cloudflare-deploy`: a reverted merge is not brought
back by merging `main` again, which surprises people. More detail: README → Deploying →
Rolling back.

## Flaky tests and re-running a job

`test/e2e/run.cjs` runs each browser-test suite once more if any of its checks fails. If the
second run passes, the job passes but the suite is reported as **flaky: passed on retry**: a
`FLAKY` line in the log, a warning annotation on the run, and a table in the run's summary
naming the checks that failed the first time. If the second run fails too, the job fails.
Locally, `MEETLY_E2E_RETRIES=0 node test/e2e/run.cjs polls` turns the retry off.

A flaky suite is a bug: open an issue (label `bug`, title `Flaky e2e: <suite> <check>`) with the
run link, unless one exists; then add the run link to it.

**Re-running a failed job.** Re-run only when the failure matches a known flaky issue, or is
clearly infrastructure (runner lost, download timed out); otherwise fix it.

- In the browser: open the run (the PR's **Checks** tab → the failed check → **View more
  details**, or Actions → the run) → **Re-run jobs** → **Re-run failed jobs**. Tick
  **Enable debug logging** for more detail.
- In a terminal: `gh run rerun <run-id> --failed` (the run id is the number in the run's URL).

If the same check fails on the re-run, it is not flaky: treat it as a real failure. Add the run
link to the flaky issue either way.

## Branch protection

`main` and `cloudflare-deploy` are protected. Two ways to set it up (an admin of the repository
does this once). Do the one-time fast-forward of `main` to `cloudflare-deploy` first, if it is
approved: afterwards nobody can push to either branch directly.

### With the script

```bash
gh auth login                          # once, as the repository admin
scripts/protect-branches.sh --dry-run  # shows exactly what it will send
scripts/protect-branches.sh
```

It applies the rules below to both branches, turns on automatic deletion of merged branches,
keeps merge commits allowed, and prints the result read back from GitHub.

### By hand in the GitHub UI

For each of `main` and `cloudflare-deploy`:

1. Repository → **Settings** → **Branches** → **Add classic branch protection rule** (or
   **Add rule**). If GitHub offers rulesets first, choose the classic rule.
2. **Branch name pattern**: `main` (then repeat with `cloudflare-deploy`).
3. Tick **Require a pull request before merging**. Leave **Require approvals** unticked (0
   approvals). Leave **Require review from Code Owners** unticked.
4. Tick **Require status checks to pass before merging**.
   - For `main`, tick **Require branches to be up to date before merging**. For
     `cloudflare-deploy`, leave it **unticked**: each release PR leaves a merge commit on
     `cloudflare-deploy` that `main` lacks, so `main` could never be "up to date" with it. The
     PR's checks still test the merged result, and Deploy runs CI again before deploying.
   - In the search box add these four checks, each from **GitHub Actions** (the source shown
     next to the name; pick it so no other app can satisfy the check). They appear once CI has
     run in the last week:
     `Types, lint, unit tests`, `Build (livekit)`, `Build (realtimekit)`,
     `Browser tests (LiveKit dev server)`.
5. Tick **Do not allow bypassing the above settings** (applies the rules to admins too).
6. Leave **Allow force pushes** and **Allow deletions** unticked.
7. **Create** (or **Save changes**).

Then once, for the repository: **Settings** → **General** → **Pull Requests**: keep **Allow
merge commits** ticked, and tick **Automatically delete head branches**. (Protected branches
are never deleted by this, so a merged release PR does not delete `main`.)

Check it: open a PR, and the four checks show as **Required**; `git push origin main` from a
clone is refused with "protected branch".
