#!/usr/bin/env bash
# Shard 0, before it lays the run out: gathers every other shard's NAT report (an artifact
# "nat-<run>-<shard>" holding nat-<shard>.json) into $3, until all $2 have come or $4 seconds have
# passed. A shard still queued for a runner by then is laid out as late, and left out.
#
# Needs GH_TOKEN with actions: read. Owner: E-harness.
set -uo pipefail
prefix="$1"
want="$2"
dir="$3"
deadline=$(( $(date +%s) + ${4:-360} ))
api="$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/actions"
mkdir -p "$dir"
while :; do
  have=$(ls "$dir"/nat-*.json 2>/dev/null | wc -l)
  [ "$have" -ge "$want" ] && break
  [ "$(date +%s)" -ge "$deadline" ] && { echo "$have of $want NAT reports by the deadline"; break; }
  list=$(curl -fsS -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" "$api/runs/$GITHUB_RUN_ID/artifacts?per_page=100" || echo '{}')
  for row in $(echo "$list" | jq -r --arg p "$prefix" '.artifacts[]? | select(.name | startswith($p)) | "\(.id)=\(.name)"'); do
    id="${row%%=*}"
    shard="${row##*-}"
    [ -f "$dir/nat-$shard.json" ] && continue
    if curl -fsSL -H "Authorization: Bearer $GH_TOKEN" -o "$dir/a.zip" "$api/artifacts/$id/zip"; then
      unzip -o -q "$dir/a.zip" -d "$dir" && rm -f "$dir/a.zip"
    fi
  done
  sleep 10
done
ls "$dir"
