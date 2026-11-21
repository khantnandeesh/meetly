#!/usr/bin/env bash
# PLAN H5: how shards on different runners find their run's coordinator without talking to each
# other. Shard 0 uploads an artifact named $1 holding the tunnel's URL, the run's start time and
# its admission secret; every other shard waits for it here (artifacts of a run in progress are
# listed by the API as soon as they are uploaded), then unpacks it into $2.
#
# Needs GH_TOKEN with actions: read. Owner: E-harness.
set -euo pipefail
name="$1"
dir="$2"
api="$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/actions"
id=""
# Every 15 s: twenty shards polling share the token's 1,000 requests an hour.
for _ in $(seq 1 60); do
  id=$(curl -fsS -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" "$api/runs/$GITHUB_RUN_ID/artifacts?name=$name" | jq -r '.artifacts[0].id // empty' || true)
  [ -n "$id" ] && break
  sleep 15
done
if [ -z "$id" ]; then
  echo "no artifact \"$name\" after 15 minutes: shard 0 never came up" >&2
  exit 1
fi
mkdir -p "$dir"
# An artifact can be listed a moment before its archive can be fetched: try again for a minute.
for attempt in $(seq 1 12); do
  if curl -fsSL -H "Authorization: Bearer $GH_TOKEN" -o "$dir/rendezvous.zip" "$api/artifacts/$id/zip"; then break; fi
  [ "$attempt" = 12 ] && { echo "artifact $id could not be fetched" >&2; exit 1; }
  sleep 5
done
unzip -o -q "$dir/rendezvous.zip" -d "$dir"
rm "$dir/rendezvous.zip"
