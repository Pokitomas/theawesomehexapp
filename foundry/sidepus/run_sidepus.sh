#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PYTHON="${SIDEPUS_PYTHON:-python3}"
STATE="${SIDEPUS_STATE:-$HOME/sidepus-archive-v2}"
POLICY="${SIDEPUS_CONTENT_POLICY:-$HERE/plans/content-policy-broad-v2.json}"
PROGRAM="${SIDEPUS_DEVELOPMENT_PROGRAM:-$HERE/plans/developmental-program-v1.json}"

cd "$REPO_ROOT"

if [[ "${1:-}" == "doctor" ]]; then
  exec "$PYTHON" -m foundry.sidepus.governed_cli doctor --network --require-parity
fi

if [[ ! -f "$STATE/archive-plan.json" ]]; then
  "$PYTHON" -m foundry.sidepus.governed_cli init --state-dir "$STATE"
fi

"$PYTHON" -m foundry.sidepus.governed_cli install-content-policy \
  --state-dir "$STATE" \
  --policy "$POLICY" >/dev/null

"$PYTHON" -m foundry.sidepus.developmental_cli validate-program \
  --program "$PROGRAM" >/dev/null

cat <<EOF
Sidepus broad archive authority is initialized at:
  $STATE

Installed immutable acquisition policy:
  $POLICY

Validated developmental program:
  $PROGRAM

The archive may now be discovered and captured through the canonical governed CLI.
Archive intake ratios are not training ratios: downstream inventory extraction and
developmental compilation remain separate hash-bound stages.

Canonical entrypoints:
  $PYTHON -m foundry.sidepus.governed_cli ...
  $PYTHON -m foundry.sidepus.developmental_cli ...

Run the hard parity gate with:
  $0 doctor
EOF
