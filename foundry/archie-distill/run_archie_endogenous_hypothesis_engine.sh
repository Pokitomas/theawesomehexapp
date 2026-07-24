#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${ARCHIE_PYTHON:-/home/awesomekai/.venv-archie-cuda/bin/python}"
PROFILE="${ARCHIE_HYPOTHESIS_PROFILE:-smoke}"
DEVICE="${ARCHIE_HYPOTHESIS_DEVICE:-cuda}"
ROOT="${ARCHIE_HYPOTHESIS_STATE:-$HOME/archie-endogenous-hypothesis-$PROFILE}"

[[ -x "$PYTHON" ]] || { echo "Missing Archie Python: $PYTHON" >&2; exit 1; }
if [[ "$DEVICE" == "cuda" ]]; then
  "$PYTHON" -c 'import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)' || {
    echo "CUDA unavailable in $PYTHON" >&2
    exit 1
  }
fi

PYTHONPATH="$HERE" "$PYTHON" -m unittest -q test_archie_endogenous_hypothesis_engine.EndogenousHypothesisEngineTest
mkdir -p "$ROOT"
exec env PYTHONPATH="$HERE" "$PYTHON" "$HERE/archie_endogenous_hypothesis_engine.py" \
  --profile "$PROFILE" \
  --device "$DEVICE" \
  --output-dir "$ROOT"
