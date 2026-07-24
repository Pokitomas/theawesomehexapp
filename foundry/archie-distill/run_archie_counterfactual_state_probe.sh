#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${ARCHIE_PYTHON:-/home/awesomekai/.venv-archie-cuda/bin/python}"
PROFILE="${ARCHIE_COUNTERFACTUAL_PROFILE:-smoke}"
ROOT="${ARCHIE_COUNTERFACTUAL_STATE:-$HOME/archie-counterfactual-state-$PROFILE}"
DEVICE="${ARCHIE_COUNTERFACTUAL_DEVICE:-cuda}"

[[ -x "$PYTHON" ]] || { echo "Missing Archie Python: $PYTHON" >&2; exit 1; }
if [[ "$DEVICE" == "cuda" ]]; then
  "$PYTHON" -c 'import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)' || {
    echo "CUDA is unavailable in $PYTHON" >&2
    exit 1
  }
fi

PYTHONPATH="$HERE" "$PYTHON" -m unittest -q test_archie_counterfactual_state_probe.CounterfactualStateProbeTest
mkdir -p "$ROOT"
exec env PYTHONPATH="$HERE" "$PYTHON" "$HERE/archie_counterfactual_state_probe.py" \
  --profile "$PROFILE" \
  --device "$DEVICE" \
  --output-dir "$ROOT"
