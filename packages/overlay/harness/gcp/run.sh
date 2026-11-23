#!/usr/bin/env bash
# A sharded swarm on Google Cloud VMs instead of GitHub's runners (README.md, "On Google Cloud").
# Creates one VM per shard in one zone, lets them set up and meet through a Cloud Storage folder
# (./vm.sh), waits for shard 0's report, downloads everything and deletes the VMs, also when it
# fails or is interrupted.
#
#   bash packages/overlay/harness/gcp/run.sh --scenario gate-small --peers 25 --churn-s 120 --shards 3
#   bash packages/overlay/harness/gcp/run.sh --scenario gate --peers 200 --churn-s 600 --shards 10 --merge integration
#
# Options (defaults in brackets):
#   --scenario NAME     a scenario of ../scenarios.ts [gate-small]
#   --peers N           peers in the whole run [25]
#   --churn-s S         seconds of churn, 0 for none [120]
#   --shards N          VMs: shard 0 the coordinator alone, shard 1 the source, the rest viewers [3]
#   --machine TYPE      machine type of every VM [n2-standard-4]
#   --zone ZONE         [us-central1-a]
#   --ref REF           commit or branch to run, as pushed to the repository [overlay-integration]
#   --merge MODE        none, branches or integration: ../ci/merge.sh before the run [none]
#   --seed N            [the time]
#   --spot              Spot VMs: about a third of the price, but Google may take one mid-run
#   --no-address        no external addresses (needs Cloud NAT on the network; see README.md)
#   --keep              leave the VMs running at the end, to look at them
#   --out DIR           where the results go [swarm-out/gcp/<run>]
#
# Needs gcloud, jq, and either GCP_SERVICE_ACCOUNT_KEY (a key's JSON) or gcloud already signed in
# as an account with Compute Instance Admin (v1), Service Account User, and Storage Object Admin
# on the bucket. GCP_PROJECT_ID names the project; SWARM_BUCKET the bucket
# [meetly-overlay-swarm-<project number>].
#
# Owner: E-harness.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)

scenario=gate-small peers=25 churn=120 shards=3 machine=n2-standard-4 zone=us-central1-a
ref=overlay-integration merge=none seed=$(date +%s) spot=0 address=1 keep=false out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --scenario) scenario=$2; shift ;;
    --peers) peers=$2; shift ;;
    --churn-s) churn=$2; shift ;;
    --shards) shards=$2; shift ;;
    --machine) machine=$2; shift ;;
    --zone) zone=$2; shift ;;
    --ref) ref=$2; shift ;;
    --merge) merge=$2; shift ;;
    --seed) seed=$2; shift ;;
    --spot) spot=1 ;;
    --no-address) address=0 ;;
    --keep) keep=true ;;
    --out) out=$2; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 64 ;;
  esac
  shift
done
[ "$shards" -ge 2 ] || { echo "--shards: at least 2 (the coordinator's and one with peers)" >&2; exit 64; }
case "$merge" in none|branches|integration) ;; *) echo "--merge: none, branches or integration" >&2; exit 64 ;; esac

project=${GCP_PROJECT_ID:?GCP_PROJECT_ID names the Google Cloud project}
# An environment may set a placeholder token that gcloud would send instead of the key's.
unset CLOUDSDK_AUTH_ACCESS_TOKEN
if [ -n "${GCP_SERVICE_ACCOUNT_KEY:-}" ]; then
  keyfile=$(mktemp)
  printf '%s' "$GCP_SERVICE_ACCOUNT_KEY" > "$keyfile"
  gcloud auth activate-service-account --key-file="$keyfile" --quiet > /dev/null 2>&1
  rm -f "$keyfile"
fi
g() { gcloud --project="$project" --quiet "$@"; }

number=$(g projects describe "$project" --format='value(projectNumber)' 2>/dev/null || true)
bucket=${SWARM_BUCKET:-meetly-overlay-swarm-${number:?set SWARM_BUCKET: the project number could not be read}}
repo=${SWARM_REPO:-https://github.com/khantnandeesh/meetly}
region=${zone%-*}

# The commit every VM checks out: a branch is read once, here, so that all run the same one.
if [[ "$ref" =~ ^[0-9a-f]{40}$ ]]; then sha=$ref
else sha=$(git ls-remote "$repo" "refs/heads/$ref" | cut -f1); fi
[ -n "$sha" ] || { echo "--ref: $ref is not a branch of $repo" >&2; exit 64; }
integration_sha=""
[ "$merge" = "integration" ] && integration_sha=$(git ls-remote "$repo" refs/heads/overlay-integration | cut -f1)

# Quota, before anything is created: a VM refused halfway leaves a run that cannot start.
vcpus=$(g compute machine-types describe "$machine" --zone "$zone" --format='value(guestCpus)')
need=$(( vcpus * shards ))
read -r global_free < <(g compute project-info describe --format=json | jq -r '[.quotas[] | select(.metric == "CPUS_ALL_REGIONS")][0] | (.limit - .usage)')
family=$(echo "${machine%%-*}" | tr a-z A-Z)
read -r region_free < <(g compute regions describe "$region" --format=json | jq -r --arg m "${family}_CPUS" \
  '[.quotas[] | select(.metric == $m or .metric == "CPUS")] | map(.limit - .usage) | min')
if [ "${global_free%.*}" -lt "$need" ] || [ "${region_free%.*}" -lt "$need" ]; then
  echo "quota: $shards x $machine needs $need vCPUs; free: ${global_free%.*} in all regions, ${region_free%.*} for ${family} in $region." >&2
  echo "Ask for more under IAM & Admin > Quotas (CPUS_ALL_REGIONS, and ${family}_CPUS in $region), or use fewer or smaller VMs." >&2
  exit 3
fi
if [ "$address" = 1 ]; then
  read -r ips_free < <(g compute regions describe "$region" --format=json | jq -r '[.quotas[] | select(.metric == "IN_USE_ADDRESSES")][0] | (.limit - .usage)')
  if [ "${ips_free%.*}" -lt "$shards" ]; then
    echo "quota: $shards VMs need $shards external addresses, $region has ${ips_free%.*} free. Use --no-address (with Cloud NAT) or ask for IN_USE_ADDRESSES." >&2
    exit 3
  fi
fi

stamp=$(date -u +%Y%m%d-%H%M%S)
run="${scenario}-${stamp}"
name="swarm-$(echo "$run" | tr -c 'a-z0-9\n' '-' | cut -c1-40)"
prefix="gs://$bucket/runs/$run"
out=${out:-swarm-out/gcp/$run}
mkdir -p "$out"
echo "run $run: $shards x $machine in $zone, $scenario at $peers peers, churn ${churn}s, $sha (merge: $merge)"
echo "folder $prefix"

jq -n --arg runId "$run" --arg repo "$repo" --arg sha "$sha" --arg integrationSha "$integration_sha" --arg scenario "$scenario" \
  --argjson peers "$peers" --argjson churnS "$churn" --argjson seed "$seed" --argjson shards "$shards" --arg merge "$merge" \
  --argjson keep "$keep" \
  '{runId: $runId, repo: $repo, sha: $sha, integrationSha: $integrationSha, scenario: $scenario, peers: $peers, churnS: $churnS,
    seed: $seed, shards: $shards, merge: $merge, keep: $keep, nodeVersion: "22", playwrightVersion: "1.63.0", port: 4280,
    stun: "stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478", readyTimeoutS: 900, rendezvousTimeoutS: 1800, leadS: 45}' \
  > "$out/config.json"
g storage cp "$out/config.json" "$prefix/config.json" > /dev/null

names=()
for i in $(seq 0 $(( shards - 1 ))); do names+=("$name-$i"); done
cleanup() {
  local code=$?
  g storage cp -r "$prefix/logs" "$out/" > /dev/null 2>&1 || true
  if [ "$keep" = true ]; then
    echo "--keep: the VMs stay up. Delete them with: gcloud compute instances delete --zone $zone ${names[*]}"
  else
    echo "deleting the VMs"
    g compute instances delete --zone "$zone" "${names[@]}" > /dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# The run's longest part is its scenario; the VMs delete themselves well after it, if this
# script dies without deleting them.
create=(--zone "$zone" --machine-type "$machine" --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud
  --boot-disk-size 30GB --boot-disk-type pd-balanced --scopes storage-rw,logging-write
  --labels "overlay-swarm=$(echo "$run" | tr -c 'a-z0-9\n' '-')"
  --metadata "swarm-prefix=$prefix" --metadata-from-file "startup-script=$here/vm.sh"
  --max-run-duration "$(( (churn + 3600) / 60 ))m" --instance-termination-action DELETE)
[ "$spot" = 1 ] && create+=(--provisioning-model SPOT)
[ "$address" = 0 ] && create+=(--no-address)
g compute instances create "${names[@]}" "${create[@]}" > /dev/null
echo "created ${#names[@]} VMs; they set up (about five minutes), then the run starts"

# Wait for shard 0's "done", saying who is ready as they come.
deadline=$(( $(date +%s) + 900 + 1800 + churn + 1200 ))
seen=-1
while ! g storage ls "$prefix/done" > /dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then echo "no report by the deadline" >&2; exit 1; fi
  ready=$(g storage ls "$prefix/nat/" 2>/dev/null | grep -c 'nat-[0-9]*\.json$' || true)
  if [ "$ready" != "$seen" ]; then
    echo "[$(date -u +%H:%M:%S)] $ready of $shards ready$(g storage ls "$prefix/rendezvous.json" > /dev/null 2>&1 && echo ', running')"
    seen=$ready
  fi
  sleep 20
done

g storage cp -r "$prefix/out" "$prefix/reports" "$out/" > /dev/null 2>&1 || true
if [ -f "$out/reports/report.md" ]; then
  cat "$out/reports/report.md"
  echo
  echo "results in $out"
else
  echo "shard 0 finished without a report: $(g storage cat "$prefix/done" 2>/dev/null). Logs in $out/logs" >&2
  exit 1
fi
