#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${ARCHIE_PYTHON:-/home/awesomekai/.venv-archie-cuda/bin/python}"
PROFILE="${ARCHIE_INSTRUMENT_PROFILE:-smoke}"
ROOT="${ARCHIE_INSTRUMENT_STATE:-$HOME/archie-instrument-genesis-$PROFILE}"

[[ -x "$PYTHON" ]] || { echo "Missing Archie Python: $PYTHON" >&2; exit 1; }
"$PYTHON" -c 'import numpy' || { echo "NumPy unavailable in $PYTHON" >&2; exit 1; }
PYTHONPATH="$HERE" "$PYTHON" -m unittest -q test_archie_instrument_genesis.InstrumentGenesisTest
mkdir -p "$ROOT"
exec env PYTHONPATH="$HERE" "$PYTHON" "$HERE/archie_instrument_genesis.py" \
  --profile "$PROFILE" \
  --output-dir "$ROOT"
