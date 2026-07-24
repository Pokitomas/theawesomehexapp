#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${ARCHIE_PYTHON:-/home/awesomekai/.venv-archie-cuda/bin/python}"
PROFILE="${ARCHIE_INSTRUMENT_PROFILE:-smoke}"
DEVICE="${ARCHIE_INSTRUMENT_DEVICE:-auto}"
ROOT="${ARCHIE_INSTRUMENT_STATE:-$HOME/archie-instrument-genesis-$PROFILE}"

[[ -x "$PYTHON" ]] || {
  echo "Missing Archie Python: $PYTHON" >&2
  exit 1
}

if [[ "$DEVICE" == "auto" ]]; then
  if "$PYTHON" -c 'import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)'; then
    DEVICE="cuda"
  else
    DEVICE="cpu"
  fi
fi

if [[ "$DEVICE" == "cuda" ]]; then
  "$PYTHON" -c 'import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)' || {
    echo "CUDA requested but unavailable in $PYTHON" >&2
    exit 1
  }
fi

PYTHONPATH="$HERE" "$PYTHON" -m unittest -q \
  test_archie_instrument_genesis.InstrumentGenesisTest

mkdir -p "$ROOT"
exec env PYTHONPATH="$HERE" "$PYTHON" "$HERE/archie_instrument_genesis.py" \
  --profile "$PROFILE" \
  --device "$DEVICE" \
  --output-dir "$ROOT"
