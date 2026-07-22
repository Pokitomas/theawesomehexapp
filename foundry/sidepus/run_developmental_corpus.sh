#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROGRAM="${SIDEPUS_DEVELOPMENT_PROGRAM:-$ROOT/foundry/sidepus/plans/developmental-program-v1.json}"
POLICY="${SIDEPUS_CONTENT_POLICY:-$ROOT/foundry/sidepus/plans/content-policy-broad-v2.json}"
OUTPUT="${SIDEPUS_DEVELOPMENT_OUTPUT:?set SIDEPUS_DEVELOPMENT_OUTPUT}"

if [[ "$#" -lt 1 ]]; then
  echo "usage: SIDEPUS_DEVELOPMENT_OUTPUT=/path $0 inventory.jsonl [inventory-2.jsonl ...]" >&2
  exit 2
fi

inventory_args=()
for inventory in "$@"; do
  inventory_args+=(--inventory "$inventory")
done

cd "$ROOT"
python -m foundry.sidepus.developmental_cli validate-program --program "$PROGRAM"
python -m foundry.sidepus.developmental_cli compile \
  --program "$PROGRAM" \
  --content-policy "$POLICY" \
  "${inventory_args[@]}" \
  --output-dir "$OUTPUT"
python -m foundry.sidepus.developmental_cli verify \
  --receipt "$OUTPUT/developmental-receipt.json"
