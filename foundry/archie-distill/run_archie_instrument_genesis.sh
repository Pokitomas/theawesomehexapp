#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-smoke}"
if [[ "${PROFILE}" != "smoke" && "${PROFILE}" != "full" ]]; then
  printf 'usage: %s [smoke|full] [extra python arguments...]\n' "$0" >&2
  exit 2
fi
shift || true

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CUDA_PYTHON="${ARCHIE_CUDA_PYTHON:-/home/awesomekai/.venv-archie-cuda/bin/python}"

case "${PROFILE}" in
  smoke)
    OUTPUT_DIR="${ARCHIE_OUTPUT_DIR:-${HOME}/archie-instrument-genesis-smoke}"
    if [[ -x "${CUDA_PYTHON}" ]]; then
      PYTHON_BIN="${CUDA_PYTHON}"
    else
      PYTHON_BIN="${PYTHON_BIN:-python3}"
    fi
    ;;
  full)
    OUTPUT_DIR="${ARCHIE_OUTPUT_DIR:-${HOME}/archie-instrument-genesis-full}"
    if [[ ! -x "${CUDA_PYTHON}" ]]; then
      printf 'required CUDA interpreter is not executable: %s\n' "${CUDA_PYTHON}" >&2
      exit 3
    fi
    PYTHON_BIN="${CUDA_PYTHON}"
    ;;
esac

exec "${PYTHON_BIN}" "${SCRIPT_DIR}/archie_instrument_genesis.py" \
  --profile "${PROFILE}" \
  --output-dir "${OUTPUT_DIR}" \
  "$@"
