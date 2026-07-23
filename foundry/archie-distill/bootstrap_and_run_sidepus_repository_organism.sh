#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PYTHON="${ARCHIE_PYTHON:-/home/awesomekai/.venv-archie-cuda/bin/python}"
SIDEPUS_STATE="${SIDEPUS_STATE:-$HOME/sidepus-archive-v2}"
RIGHTS_MANIFEST="${ARCHIE_SIDEPUS_RIGHTS_MANIFEST:-$SIDEPUS_STATE/training-rights.json}"
BOOTSTRAP_RECEIPT="$SIDEPUS_STATE/repository-bootstrap-receipt.json"
INVENTORY="${ARCHIE_SIDEPUS_INVENTORY:-$SIDEPUS_STATE/training-inventory.jsonl}"
INVENTORY_RECEIPT="${ARCHIE_SIDEPUS_INVENTORY_RECEIPT:-$INVENTORY.receipt.json}"

if [[ ! -x "$PYTHON" ]]; then
  echo "Missing Archie Python: $PYTHON" >&2
  exit 1
fi

if ! "$PYTHON" -c 'import warcio' >/dev/null 2>&1; then
  if ! "$PYTHON" -m pip --version >/dev/null 2>&1; then
    echo "Bootstrapping pip inside Archie CUDA environment..."
    "$PYTHON" -m ensurepip --upgrade
  fi
  echo "Installing required warcio package into Archie CUDA environment..."
  "$PYTHON" -m pip install --disable-pip-version-check warcio
fi

mkdir -p "$SIDEPUS_STATE"
if [[ ! -f "$BOOTSTRAP_RECEIPT" ]]; then
  PYTHONPATH="$REPO_ROOT" "$PYTHON" "$HERE/bootstrap_sidepus_repository_archive.py" \
    --repo "$REPO_ROOT" \
    --state-dir "$SIDEPUS_STATE" \
    --rights-manifest "$RIGHTS_MANIFEST" \
    --receipt "$BOOTSTRAP_RECEIPT"
fi

if [[ ! -f "$INVENTORY" ]]; then
  PYTHONPATH="$REPO_ROOT" "$PYTHON" -m foundry.sidepus.developmental_cli extract-warc-inventory \
    --state-dir "$SIDEPUS_STATE" \
    --output "$INVENTORY" \
    --rights-manifest "$RIGHTS_MANIFEST"
fi

PYTHONPATH="$REPO_ROOT" "$PYTHON" -m foundry.sidepus.developmental_cli verify-inventory \
  --receipt "$INVENTORY_RECEIPT"

export SIDEPUS_STATE
export ARCHIE_SIDEPUS_INVENTORY="$INVENTORY"
export ARCHIE_SIDEPUS_INVENTORY_RECEIPT="$INVENTORY_RECEIPT"
export ARCHIE_SIDEPUS_RIGHTS_MANIFEST="$RIGHTS_MANIFEST"

exec bash "$HERE/run_archie_sidepus_organism_early_parent.sh"
