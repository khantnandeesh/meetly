#!/usr/bin/env bash
# PLAN H5: makes a coordinator on this runner reachable from the others. GitHub's runners cannot
# reach each other, so the coordinator (Node, on 127.0.0.1:$1) is put behind a Cloudflare quick
# tunnel: no account, a random https URL, WebSockets carried. Prints the URL once the tunnel
# answers the coordinator's health route from outside.
#
# Owner: E-harness.
set -euo pipefail
port="$1"
log="${2:-cloudflared.log}"
version="2025.2.0"
bin="$RUNNER_TEMP/cloudflared"
if [ ! -x "$bin" ]; then
  curl -fsSL --retry 4 -o "$bin" "https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-linux-amd64"
  chmod +x "$bin"
fi
nohup "$bin" tunnel --no-autoupdate --url "http://127.0.0.1:${port}" > "$log" 2>&1 &
url=""
for _ in $(seq 1 60); do
  url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -n 1 || true)
  [ -n "$url" ] && break
  sleep 1
done
if [ -z "$url" ]; then
  echo "no tunnel URL after 60 s" >&2
  cat "$log" >&2
  exit 1
fi
# A new quick tunnel's name takes a few seconds to resolve everywhere.
for _ in $(seq 1 90); do
  if curl -fsS -o /dev/null --max-time 5 "$url/overlay/v1/health"; then
    echo "$url"
    exit 0
  fi
  sleep 2
done
echo "the tunnel $url never answered /overlay/v1/health" >&2
cat "$log" >&2
exit 1
