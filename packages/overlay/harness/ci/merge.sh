#!/usr/bin/env bash
# PLAN H6: run against whatever of the engine is real. Merges each engineer's branch into the
# checkout (never pushed anywhere), one at a time; a branch that does not merge cleanly is left
# out and said so. Writes what it did to $1 (JSON), for the report job.
#
# Owner: E-harness.
set -uo pipefail
out="${1:-merged.json}"
branches=(overlay-transport overlay-media overlay-congestion overlay-coordinator)
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
  else
    files=$(git diff --name-only --diff-filter=U | tr '\n' ' ')
    git merge --abort
    entries+=("{\"branch\":\"$branch\",\"sha\":\"$sha\",\"result\":\"conflict\",\"files\":\"$files\"}")
    echo "::warning title=Overlay swarm::$branch ($sha) does not merge cleanly with the harness; left out. Conflicts: $files"
  fi
done
(IFS=,; echo "[${entries[*]}]") > "$out"
cat "$out"
