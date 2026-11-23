#!/usr/bin/env bash
# Protects `main` and `cloudflare-deploy` and turns on "Automatically delete head branches".
# Run it yourself, as a repository admin, with your own GitHub CLI login:
#
#   gh auth login                       # once; needs the `repo` scope
#   scripts/protect-branches.sh         # apply
#   scripts/protect-branches.sh --dry-run   # only print what it would send
#
# Both branches get:
#   - a pull request to change them (0 approvals required, so you can merge your own PRs);
#   - the four CI checks must pass: "Types, lint, unit tests", "Build (livekit)",
#     "Build (realtimekit)", "Browser tests (LiveKit dev server)" (from GitHub Actions only);
#   - the rules apply to admins too ("Do not allow bypassing the above settings");
#   - no force pushes, no deletion.
# `main` also requires the PR branch to be up to date with `main` before merging ("strict").
# `cloudflare-deploy` does not: every release PR from `main` lands as a merge commit that `main`
# does not have, so with "strict" the next release PR could never be up to date. Its checks still
# test the merge result, and deploy.yml runs CI again on the merged commit before deploying.
#
# Afterwards nobody, admins included, can push to either branch directly: changes go through PRs.
# Same rules by hand in the GitHub UI: docs/RELEASING.md → "Branch protection".
set -euo pipefail

REPO="${REPO:-khantnandeesh/meetly}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# GitHub Actions' app id: required checks must come from Actions, not from any app or token
# that can post a status with the same name.
ACTIONS_APP_ID=15368

protection_json() {
  local strict="$1"
  cat <<JSON
{
  "required_status_checks": {
    "strict": ${strict},
    "checks": [
      { "context": "Types, lint, unit tests", "app_id": ${ACTIONS_APP_ID} },
      { "context": "Build (livekit)", "app_id": ${ACTIONS_APP_ID} },
      { "context": "Build (realtimekit)", "app_id": ${ACTIONS_APP_ID} },
      { "context": "Browser tests (LiveKit dev server)", "app_id": ${ACTIONS_APP_ID} }
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": false,
  "lock_branch": false,
  "allow_fork_syncing": false
}
JSON
}

command -v gh >/dev/null || { echo "Needs the GitHub CLI: https://cli.github.com" >&2; exit 1; }

if [ "$DRY_RUN" = 0 ]; then
  gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first." >&2; exit 1; }
  admin="$(gh api "repos/$REPO" --jq '.permissions.admin')"
  [ "$admin" = "true" ] || { echo "Your gh login is not an admin of $REPO; branch protection needs admin." >&2; exit 1; }
fi

apply() {
  local branch="$1" strict="$2"
  echo "== $branch (strict: $strict)"
  if [ "$DRY_RUN" = 1 ]; then
    echo "PUT repos/$REPO/branches/$branch/protection"
    protection_json "$strict"
    return
  fi
  protection_json "$strict" | gh api --method PUT "repos/$REPO/branches/$branch/protection" --input - >/dev/null
  gh api "repos/$REPO/branches/$branch/protection" --jq '
    "  required checks: \([.required_status_checks.checks[].context] | join(", "))",
    "  up to date before merging: \(.required_status_checks.strict)",
    "  applies to admins: \(.enforce_admins.enabled)",
    "  pull request required, approvals: \(.required_pull_request_reviews.required_approving_review_count)",
    "  force pushes: \(.allow_force_pushes.enabled), deletions: \(.allow_deletions.enabled)"'
}

# Protection first: with it on, "delete head branches" can never delete main or cloudflare-deploy
# after the release PR (main → cloudflare-deploy) merges.
apply main true
apply cloudflare-deploy false

echo "== repository settings"
if [ "$DRY_RUN" = 1 ]; then
  echo "PATCH repos/$REPO delete_branch_on_merge=true allow_merge_commit=true"
else
  # Merge commits must stay allowed: release PRs into cloudflare-deploy use them.
  gh api --method PATCH "repos/$REPO" -F delete_branch_on_merge=true -F allow_merge_commit=true \
    --jq '"  delete head branches on merge: \(.delete_branch_on_merge), merge commits allowed: \(.allow_merge_commit)"'
fi
echo "Done."
