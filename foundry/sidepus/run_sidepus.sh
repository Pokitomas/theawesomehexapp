#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PYTHON="${SIDEPUS_PYTHON:-python3}"
STATE="${SIDEPUS_STATE:-$HOME/sidepus-archive-v2}"

cd "$REPO_ROOT"

if [[ "${1:-}" == "doctor" ]]; then
  exec "$PYTHON" -m foundry.sidepus.cli doctor --network --require-parity
fi

if [[ ! -f "$STATE/archive-plan.json" ]]; then
  "$PYTHON" -m foundry.sidepus.cli init --state-dir "$STATE"
fi

cat <<EOF
Sidepus archive infrastructure is initialized at:
  $STATE

No content policy has been selected. Historical discovery queries, fresh-crawl
seeds, subject mix, language mix, era mix, and curriculum ratios remain blocked
until the operator explicitly decides them.

Run the hard parity gate with:
  $0 doctor
EOF
