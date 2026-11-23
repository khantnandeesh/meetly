#!/usr/bin/env bash
# The startup script of every VM of a Google Cloud swarm (./run.sh creates them). One VM is one
# shard, its index the number at the end of its name. Everything the shards share goes through
# the run's folder in Cloud Storage ($PREFIX, from the VM's metadata):
#
#   config.json          the run (./run.sh writes it before the VMs exist)
#   nat/nat-N.json       what NAT shard N is behind, written once it is ready to start peers
#   rendezvous.json      shard 0's: the coordinator's internal address, the start, the secret, the layout
#   out/shard-N/…        shard N's result (shard-N.json) and everything else it wrote
#   reports/             shard 0's report, built once every shard is in
#   done-N, done         a shard has finished; the run has
#   logs/vm-N.log        this script's own output, also when it fails
#
# Unlike GitHub's runners, the VMs are in one VPC: shard 0's coordinator is reached on its
# internal address (no tunnel, a round trip well under a millisecond, so the session clock is
# tight), and peers link host to host on internal addresses, with STUN on their external one as
# well. Their NAT is Google's one-to-one NAT, never symmetric.
#
# Owner: E-harness.
set -uo pipefail
exec > >(tee -a /var/log/swarm.log) 2>&1

md() { curl -fsS -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/$1"; }
NAME=$(md instance/name)
SHARD=${NAME##*-}
PREFIX=$(md instance/attributes/swarm-prefix)
INTERNAL_IP=$(md instance/network-interfaces/0/ip)
WORK=/opt/swarm
OUT=$WORK/out
mkdir -p "$WORK" "$OUT"
log() { echo "[$(date -u +%H:%M:%S)] shard $SHARD: $*"; }

# This script's log goes up however it ends, and the VM stops, so a run nobody cleans up costs
# only its disk (./run.sh deletes the VMs; --max-run-duration deletes them if it cannot).
finish() {
  local code=$?
  log "exit $code"
  gcloud storage cp /var/log/swarm.log "$PREFIX/logs/vm-$SHARD.log" > /dev/null 2>&1 || true
  # Say so even when this ends early, so shard 0 and ./run.sh stop waiting for it.
  if [ "$SHARD" = 0 ]; then marker=done; else marker=done-$SHARD; fi
  gcloud storage ls "$PREFIX/$marker" > /dev/null 2>&1 || echo "exit $code" | gcloud storage cp - "$PREFIX/$marker" > /dev/null 2>&1 || true
  [ "$(jq -r '.keep // false' "$WORK/config.json" 2>/dev/null)" = "true" ] || shutdown -h +1 > /dev/null 2>&1 || true
}
trap finish EXIT

# Polls for an object in the run's folder until it exists or $2 seconds have passed.
await() {
  local deadline=$(( $(date +%s) + $2 ))
  until gcloud storage ls "$PREFIX/$1" > /dev/null 2>&1; do
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep 5
  done
}

log "up as $NAME ($INTERNAL_IP), run $PREFIX"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq jq git xz-utils chrony > /dev/null
# The session clock is judged against the wall clock (shard.ts reads `chronyc tracking`): use
# Google's own time servers, a hop away.
if ! grep -q metadata.google.internal /etc/chrony/chrony.conf 2>/dev/null; then
  mkdir -p /etc/chrony/sources.d
  echo "server metadata.google.internal prefer iburst" > /etc/chrony/sources.d/google.sources
  chronyc reload sources > /dev/null 2>&1 || systemctl restart chrony
fi

gcloud storage cp "$PREFIX/config.json" "$WORK/config.json" || { log "no config.json"; exit 1; }
cfg() { jq -r ".$1" "$WORK/config.json"; }
SHARDS=$(cfg shards); SCENARIO=$(cfg scenario); PEERS=$(cfg peers); CHURN_S=$(cfg churnS); SEED=$(cfg seed)
RUN_ID=$(cfg runId); PORT=$(cfg port); STUN=$(cfg stun); MERGE=$(cfg merge)

# Node, as CI has it.
NODE_MAJOR=$(cfg nodeVersion)
tarball=$(curl -fsSL "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/SHASUMS256.txt" | awk '/linux-x64.tar.xz$/ {print $2}')
curl -fsSL "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/$tarball" | tar -xJ -C /usr/local --strip-components=1
log "node $(node --version)"

# The commit the run is pinned to (./run.sh resolved it), and the engineers' branches if asked.
git clone --quiet --filter=blob:none "$(cfg repo)" "$WORK/meetly"
cd "$WORK/meetly"
git fetch --quiet origin "$(cfg sha)" && git checkout --quiet --detach "$(cfg sha)" || { log "cannot check out $(cfg sha)"; exit 1; }
if [ "$MERGE" != "none" ]; then bash packages/overlay/harness/ci/merge.sh "$OUT/merged.json" "$MERGE" "$(cfg integrationSha)"; fi
npm ci --no-audit --no-fund > "$WORK/npm.log" 2>&1 || { tail -n 40 "$WORK/npm.log"; exit 1; }
node packages/overlay/harness/swarm.mjs modules --out "$OUT" > /dev/null

if [ "$SHARD" != 0 ]; then
  npm install --no-audit --no-fund --prefix "$WORK/pw" "playwright@$(cfg playwrightVersion)" > /dev/null 2>&1
  "$WORK/pw/node_modules/.bin/playwright" install --with-deps --only-shell chromium > "$WORK/playwright.log" 2>&1 || { tail -n 40 "$WORK/playwright.log"; exit 1; }
  export NODE_PATH=$WORK/pw/node_modules
fi

timeout 30 node packages/overlay/harness/ci/natcheck.mjs "$OUT/nat.json" || true
[ -f "$OUT/nat.json" ] || echo '{"mapped":[],"symmetric":null}' > "$OUT/nat.json"
gcloud storage cp "$OUT/nat.json" "$PREFIX/nat/nat-$SHARD.json" > /dev/null
log "ready"

if [ "$SHARD" = 0 ]; then
  # Shard 0: wait for the others to be ready (a VM not ready by the deadline is laid out as late),
  # lay the run out, start the coordinator on the internal address, publish the rendezvous.
  deadline=$(( $(date +%s) + $(cfg readyTimeoutS) ))
  while :; do
    have=$(gcloud storage ls "$PREFIX/nat/" 2>/dev/null | grep -c 'nat-[0-9]*\.json$' || true)
    [ "$have" -ge "$SHARDS" ] && break
    [ "$(date +%s)" -ge "$deadline" ] && { log "$have of $SHARDS ready by the deadline"; break; }
    sleep 5
  done
  mkdir -p "$WORK/nat"
  gcloud storage cp "$PREFIX/nat/*" "$WORK/nat/" > /dev/null
  rm -f "$WORK/nat/nat-0.json"
  node packages/overlay/harness/swarm.mjs layout --shards "$SHARDS" --nat-dir "$WORK/nat" > "$WORK/layout.json"
  secret=$(openssl rand -hex 24)
  start_at=$(( $(date +%s%3N) + $(cfg leadS) * 1000 ))
  churn=(); [ "$CHURN_S" != "0" ] && churn=(--churn-s "$CHURN_S")
  nohup node packages/overlay/harness/swarm.mjs coordinator --scenario "$SCENARIO" --peers "$PEERS" "${churn[@]}" --seed "$SEED" \
    --port "$PORT" --host 0.0.0.0 --start-at "$start_at" --secret "$secret" --stun "$STUN" > "$OUT/coordinator.log" 2>&1 &
  for _ in $(seq 1 30); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/overlay/v1/health" && break; sleep 1; done
  jq -n --arg url "http://$INTERNAL_IP:$PORT" --argjson startAt "$start_at" --arg secret "$secret" --slurpfile layout "$WORK/layout.json" \
    '{url: $url, urls: [$url], startAt: $startAt, secret: $secret, layout: $layout[0]}' > "$WORK/rendezvous.json"
  gcloud storage cp "$WORK/rendezvous.json" "$PREFIX/rendezvous.json" > /dev/null
  COORDINATOR="http://127.0.0.1:$PORT"
  log "coordinator at http://$INTERNAL_IP:$PORT, the run starts at $(date -u -d @$((start_at / 1000)) +%H:%M:%S)"
else
  await rendezvous.json "$(cfg rendezvousTimeoutS)" || { log "no rendezvous from shard 0"; exit 1; }
  gcloud storage cp "$PREFIX/rendezvous.json" "$WORK/rendezvous.json" > /dev/null
  COORDINATOR=$(jq -r .url "$WORK/rendezvous.json")
  late=$(( $(date +%s%3N) - $(jq -r .startAt "$WORK/rendezvous.json") ))
  [ "$late" -gt 0 ] && log "found the rendezvous ${late} ms after the run's start: its peers join late"
fi
START_AT=$(jq -r .startAt "$WORK/rendezvous.json")
SECRET=$(jq -r .secret "$WORK/rendezvous.json")
jq '{layout}' "$WORK/rendezvous.json" > "$OUT/layout.json"

common=(--peers "$PEERS" --seed "$SEED" --run-id "$RUN_ID" --shard "$SHARD/$SHARDS" --layout "$OUT/layout.json" --nat "$OUT/nat.json" --ice stun --out "$OUT")
if jq -e --argjson s "$SHARD" '.layout.excluded | any(.shard == $s)' "$WORK/rendezvous.json" > /dev/null; then
  node packages/overlay/harness/swarm.mjs excluded "$SCENARIO" "${common[@]}"
else
  churn=(); [ "$CHURN_S" != "0" ] && churn=(--churn-s "$CHURN_S")
  merged=(); [ -f "$OUT/merged.json" ] && merged=(--merged "$OUT/merged.json")
  OVERLAY_PROFILE_SOURCE=$OUT node packages/overlay/harness/swarm.mjs run "$SCENARIO" "${common[@]}" "${churn[@]}" "${merged[@]}" \
    --coordinator "$COORDINATOR" --start-at "$START_AT" --secret "$SECRET" --stun "$STUN" || log "the shard's run failed"
fi
gcloud storage cp -r "$OUT/*" "$PREFIX/out/shard-$SHARD/" > /dev/null
log "result uploaded"

if [ "$SHARD" = 0 ]; then
  # The coordinator ends by itself (--for); then one report from every shard that came in.
  while pgrep -f "swarm.mjs coordinator" > /dev/null; do sleep 5; done
  tail -n 20 "$OUT/coordinator.log" || true
  gcloud storage cp "$OUT/coordinator.log" "$PREFIX/out/shard-0/coordinator.log" > /dev/null
  deadline=$(( $(date +%s) + 600 ))
  for s in $(seq 1 $(( SHARDS - 1 ))); do
    until gcloud storage ls "$PREFIX/done-$s" > /dev/null 2>&1 || [ "$(date +%s)" -ge "$deadline" ]; do sleep 5; done
  done
  mkdir -p "$WORK/all" "$WORK/reports"
  gcloud storage cp "$PREFIX/out/shard-*/shard-*.json" "$WORK/all/" > /dev/null
  node packages/overlay/harness/swarm.mjs report "$WORK/all" --out "$WORK/reports" > /dev/null || true
  [ -f "$OUT/merged.json" ] && { echo; echo "Merged before the run: \`$(tr -d '\n' < "$OUT/merged.json")\`"; } >> "$WORK/reports/report.md"
  gcloud storage cp -r "$WORK/reports/*" "$PREFIX/reports/" > /dev/null
fi
echo ok | gcloud storage cp - "$PREFIX/$([ "$SHARD" = 0 ] && echo done || echo "done-$SHARD")" > /dev/null
log "done"
