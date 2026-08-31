#!/usr/bin/env bash
# Retry provisioning until an AZ has capacity.
#
# p5.4xlarge (H100) is routinely capacity-constrained in every us-east-1 AZ, and
# it is the only P type under a 16 vCPU quota, so there is nothing to fall back
# to within the P family. Capacity frees up in bursts, so poll for it.
#
#   ATTEMPTS=40 INTERVAL=90 bash scripts/provision-retry.sh
set -u
ATTEMPTS="${ATTEMPTS:-40}"
INTERVAL="${INTERVAL:-90}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

for i in $(seq 1 "$ATTEMPTS"); do
  echo "== attempt $i/$ATTEMPTS  $(date '+%H:%M:%S')"
  if bash "$ROOT/scripts/provision-gpu.sh" 2>&1 | tee /tmp/mc-provision.log | tail -4; then
    if grep -q 'wrote data/worker.json' /tmp/mc-provision.log; then
      echo "== LAUNCHED at $(date '+%H:%M:%S')"
      exit 0
    fi
  fi
  # Only capacity errors are worth retrying; anything else is a real fault.
  if ! grep -q 'InsufficientInstanceCapacity' /tmp/mc-provision.log; then
    echo "== non-capacity failure, stopping:"; tail -3 /tmp/mc-provision.log; exit 1
  fi
  sleep "$INTERVAL"
done
echo "== gave up after $ATTEMPTS attempts"; exit 1
