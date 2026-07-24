#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${ARCHIE_PYTHON:-/home/awesomekai/.venv-archie-cuda/bin/python}"
PROFILE="${ARCHIE_TEACHER_ESCAPE_PROFILE:-smoke}"
DEVICE="${ARCHIE_TEACHER_ESCAPE_DEVICE:-cuda}"
ROOT="${ARCHIE_TEACHER_ESCAPE_STATE:-$HOME/archie-teacher-escape-$PROFILE}"

[[ -x "$PYTHON" ]] || { echo "Missing Archie Python: $PYTHON" >&2; exit 1; }
if [[ "$DEVICE" == "cuda" ]]; then
  "$PYTHON" -c 'import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)' || {
    echo "CUDA unavailable in $PYTHON" >&2
    exit 1
  }
fi

PYTHONPATH="$HERE" "$PYTHON" -m unittest -q test_archie_developmental_teacher_escape.DevelopmentalTeacherEscapeTest
mkdir -p "$ROOT"
exec env PYTHONPATH="$HERE" "$PYTHON" "$HERE/archie_developmental_teacher_escape_run.py" \
  --profile "$PROFILE" \
  --device "$DEVICE" \
  --output-dir "$ROOT"
