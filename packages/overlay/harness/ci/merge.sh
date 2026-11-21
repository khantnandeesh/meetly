#!/usr/bin/env bash
# PLAN H6: run against whatever of the engine is real. Merges each engineer's branch into the
# checkout (never pushed anywhere), one at a time; a branch that does not merge cleanly is left
# out and said so. Writes what it did to $1 (JSON), for the report job.
#
# Owner: E-harness.
set -uo pipefail
out="${1:-merged.json}"
# "integration": the whole engine as the integrator has put it together (overlay-integration),
# composition root included. Otherwise each engineer's branch on its own.
mode="${2:-branches}"
# The coordinator first: until the composition root exists, the pages run the harness's stand-in
# peer, so the coordinator is the only module a swarm really exercises. A branch that conflicts
# with one merged before it is the one left out.
branches=(overlay-coordinator overlay-transport overlay-media overlay-congestion)
[ "$mode" = "integration" ] && branches=(overlay-integration)
git config user.name "overlay-swarm"
git config user.email "overlay-swarm@users.noreply.github.com"
entries=()
for branch in "${branches[@]}"; do
  if ! git fetch --quiet origin "$branch" 2>/dev/null; then
    entries+=("{\"branch\":\"$branch\",\"result\":\"missing\"}")
    continue
  fi
  sha=$(git rev-parse --short FETCH_HEAD)
  if git merge --quiet --no-edit FETCH_HEAD >/dev/null 2>&1; then
    entries+=("{\"branch\":\"$branch\",\"sha\":\"$sha\",\"result\":\"merged\"}")
    echo "merged $branch at $sha"
  elif [ "$(git diff --name-only --diff-filter=U)" = "packages/overlay/skeleton.test.ts" ]; then
    # Every engineer removes their own lines from the list of stubs; neighbouring removals
    # conflict. A swarm does not run that test, so keep this side's and say so.
    git checkout --ours packages/overlay/skeleton.test.ts
    git add packages/overlay/skeleton.test.ts
    git commit --quiet --no-edit
    entries+=("{\"branch\":\"$branch\",\"sha\":\"$sha\",\"result\":\"merged\",\"note\":\"skeleton.test.ts conflicted and was not merged; the swarm does not run it\"}")
    echo "merged $branch at $sha (skeleton.test.ts conflicted: kept the harness side, which a swarm does not run)"
  else
    files=$(git diff --name-only --diff-filter=U | tr '\n' ' ')
    git merge --abort
    entries+=("{\"branch\":\"$branch\",\"sha\":\"$sha\",\"result\":\"conflict\",\"files\":\"$files\"}")
    echo "::warning title=Overlay swarm::$branch ($sha) does not merge cleanly with the harness; left out. Conflicts: $files"
  fi
done
(IFS=,; echo "[${entries[*]}]") > "$out"
cat "$out"
