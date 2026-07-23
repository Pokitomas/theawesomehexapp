#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PYTHON="${ARCHIE_PYTHON:-/home/awesomekai/.venv-archie-cuda/bin/python}"
STATE="${ARCHIE_SIDEPUS_STATE:-/home/awesomekai/archie-sidepus-v1}"
PLAN="${ARCHIE_SIDEPUS_PLAN:-$STATE/source-plan.json}"
EXPORT="${ARCHIE_SIDEPUS_EXPORT:-$STATE/export}"

if [[ ! -x "$PYTHON" ]]; then
  echo "Missing Archie Python environment: $PYTHON" >&2
  exit 1
fi

mkdir -p "$STATE"
if [[ ! -f "$PLAN" ]]; then
  "$PYTHON" "$HERE/sidepus_broad_diet.py" init \
    --output "$PLAN" \
    --local-source "$REPO_ROOT"
  echo "Created the initial source plan at $PLAN"
  echo "Edit it to add pinned GitHub, URL, or Internet Archive sources, then run:" 
  echo "  $PYTHON $HERE/sidepus_broad_diet.py seal --plan $PLAN"
fi

if [[ -f "$STATE/source-lock.json" ]]; then
  "$PYTHON" "$HERE/sidepus_broad_diet.py" fetch \
    --plan "$PLAN" \
    --state-dir "$STATE" \
    --reuse >/dev/null
else
  "$PYTHON" "$HERE/sidepus_broad_diet.py" fetch \
    --plan "$PLAN" \
    --state-dir "$STATE" >"$STATE/fetch-result.json"
fi

"$PYTHON" "$HERE/sidepus_broad_diet.py" compile \
  --lock "$STATE/source-lock.json" \
  --output-dir "$EXPORT" >"$STATE/compile-result.json"
"$PYTHON" "$HERE/sidepus_broad_diet.py" verify --export-dir "$EXPORT"

echo "Sidepus export: $EXPORT"
echo "Use it for observational pursuit training with:"
echo "  ARCHIE_SIDEPUS_EXPORTS=$EXPORT ARCHIE_RECORD_MODE=raw bash $HERE/run_archie_pursuit.sh"
