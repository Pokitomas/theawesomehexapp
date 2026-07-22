#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PYTHON="${ARCHIE_PYTHON:-/home/awesomekai/.venv-archie-cuda/bin/python}"
STATE="${ARCHIE_PURSUIT_STATE:-/home/awesomekai/archie-pursuit-v1}"
STUDENT_MODEL="${ARCHIE_STUDENT_MODEL:-$REPO_ROOT/returns/generative-next/archie-hybrid-generative-next.pt}"
PARENT_MODEL="${ARCHIE_PARENT_MODEL:-$REPO_ROOT/returns/generative-final/archie-hybrid-generative.pt}"
EXPORT_DIR="${ARCHIE_PURSUIT_EXPORT_DIR:-$REPO_ROOT/returns/generative-pursuit}"
DEFAULT_PWA="/mnt/c/Users/AwesomeKai/Documents/New project/Archie-Admitted-PWA"
DEVICE="${ARCHIE_EXCHANGE_DEVICE:-cuda}"
FOCUS_FRACTION="${ARCHIE_FOCUS_FRACTION:-0.5}"
MAX_DOMAIN_SHARE="${ARCHIE_MAX_DOMAIN_SHARE:-0.45}"
PROBE_TOKENS="${ARCHIE_TASTE_PROBE_TOKENS:-256}"
PROBES_PER_DOCUMENT="${ARCHIE_TASTE_PROBES_PER_DOCUMENT:-2}"
MAX_SCORED_DOCUMENTS="${ARCHIE_MAX_SCORED_DOCUMENTS:-4096}"
PLASTIC_MODE="${ARCHIE_PLASTIC_MODE:-delta}"

if [[ ! -x "$PYTHON" ]]; then
  echo "Missing Archie Python environment: $PYTHON" >&2
  exit 1
fi
if [[ ! -f "$STUDENT_MODEL" ]]; then
  echo "Missing trained student model: $STUDENT_MODEL" >&2
  exit 1
fi
if [[ -n "$PARENT_MODEL" && ! -f "$PARENT_MODEL" ]]; then
  echo "Missing parent model: $PARENT_MODEL" >&2
  exit 1
fi

SIDEPUS_EXPORTS=()
if [[ -n "${ARCHIE_SIDEPUS_EXPORTS:-}" ]]; then
  IFS=':' read -r -a SIDEPUS_EXPORTS <<< "$ARCHIE_SIDEPUS_EXPORTS"
fi
SOURCES=()
if [[ "${ARCHIE_INCLUDE_LOCAL_SOURCES:-1}" == "1" ]]; then
  SOURCES+=("$REPO_ROOT")
  if [[ -d "$DEFAULT_PWA" ]]; then
    SOURCES+=("$DEFAULT_PWA")
  fi
fi
for source in "$@"; do
  if [[ ! -e "$source" ]]; then
    echo "Extra source does not exist: $source" >&2
    exit 1
  fi
  SOURCES+=("$source")
done
for export in "${SIDEPUS_EXPORTS[@]}"; do
  if [[ ! -d "$export" ]]; then
    echo "Sidepus export does not exist: $export" >&2
    exit 1
  fi
done
if [[ ${#SOURCES[@]} -eq 0 && ${#SIDEPUS_EXPORTS[@]} -eq 0 ]]; then
  echo "No local sources or Sidepus exports were configured." >&2
  exit 1
fi

CONTRACT="$STATE/exchange/curriculum-exchange.json"
SETTLEMENT="$STATE/exchange/curriculum-settlement.json"
LEDGER="$STATE/exchange/pursuit-ledger.json"
mkdir -p "$STATE/exchange" "$EXPORT_DIR"

echo "Archie pursuit training"
echo "  student:      $STUDENT_MODEL"
echo "  parent:       ${PARENT_MODEL:-none}"
echo "  state:        $STATE"
echo "  focus:        $FOCUS_FRACTION"
echo "  domain cap:   $MAX_DOMAIN_SHARE"
echo "  taste sample: $MAX_SCORED_DOCUMENTS documents"
echo "  plasticity:   $PLASTIC_MODE"
echo "  sources:"
if [[ ${#SOURCES[@]} -gt 0 ]]; then
  printf '    - %s\n' "${SOURCES[@]}"
else
  echo "    - none (Sidepus-only diet)"
fi
if [[ ${#SIDEPUS_EXPORTS[@]} -gt 0 ]]; then
  echo "  Sidepus exports:"
  printf '    - %s\n' "${SIDEPUS_EXPORTS[@]}"
fi

if [[ "${ARCHIE_DRY_RUN:-0}" == "1" ]]; then
  echo "Dry run complete; no exchange, corpus, or weights were changed."
  exit 0
fi

ACTIVE_ARCHIE_GPU="$(pgrep -af '([t]rain_archie_hybrid.py|[r]esearch_archie_hybrid.py|[c]alibrate_hybrid_vram.py)' || true)"
if [[ -n "$ACTIVE_ARCHIE_GPU" && "${ARCHIE_ALLOW_CONCURRENT_GPU:-0}" != "1" ]]; then
  echo "Another Archie GPU job is already active; refusing to negotiate or train:" >&2
  echo "$ACTIVE_ARCHIE_GPU" >&2
  exit 1
fi

SOURCE_ARGUMENTS=()
for source in "${SOURCES[@]}"; do
  SOURCE_ARGUMENTS+=(--source "$source")
done
for export in "${SIDEPUS_EXPORTS[@]}"; do
  SOURCE_ARGUMENTS+=(--sidepus-export "$export")
done
PARENT_ARGUMENTS=()
if [[ -n "$PARENT_MODEL" ]]; then
  PARENT_ARGUMENTS+=(--parent-model "$PARENT_MODEL")
fi
LEDGER_ARGUMENTS=()
if [[ -f "$LEDGER" ]]; then
  LEDGER_ARGUMENTS+=(--ledger "$LEDGER")
fi

RENEGOTIATE="${ARCHIE_RENEGOTIATE:-0}"
if [[ "$RENEGOTIATE" == "1" || ! -f "$CONTRACT" ]]; then
  PYTHONPATH="$HERE" "$PYTHON" "$HERE/curriculum_exchange.py" negotiate \
    "${SOURCE_ARGUMENTS[@]}" \
    --student-model "$STUDENT_MODEL" \
    "${PARENT_ARGUMENTS[@]}" \
    "${LEDGER_ARGUMENTS[@]}" \
    --output "$CONTRACT" \
    --device "$DEVICE" \
    --focus-fraction "$FOCUS_FRACTION" \
    --max-domain-share "$MAX_DOMAIN_SHARE" \
    --probe-tokens "$PROBE_TOKENS" \
    --probes-per-document "$PROBES_PER_DOCUMENT" \
    --max-scored-documents "$MAX_SCORED_DOCUMENTS"
else
  echo "Reusing sealed curriculum exchange: $CONTRACT"
fi

ARCHIE_STATE="$STATE" \
ARCHIE_BASE_MODEL="$STUDENT_MODEL" \
ARCHIE_EXPORT_DIR="$EXPORT_DIR" \
ARCHIE_CURRICULUM_EXCHANGE="$CONTRACT" \
ARCHIE_PLASTIC_MODE="$PLASTIC_MODE" \
ARCHIE_REBUILD_CORPUS="${ARCHIE_REBUILD_CORPUS:-$RENEGOTIATE}" \
bash "$HERE/run_archie_next.sh" "$@"

STOP_REASON="$($PYTHON -c 'import json,sys; print(json.load(open(sys.argv[1]))["optimization"]["stop_reason"])' "$EXPORT_DIR/training-receipt.json")"
if [[ "$STOP_REASON" != "max_steps" ]]; then
  echo "Training round stopped at $STOP_REASON; resume before curriculum settlement."
  exit 0
fi

if [[ -f "$SETTLEMENT" ]]; then
  if ! "$PYTHON" - "$SETTLEMENT" "$CONTRACT" "$EXPORT_DIR/training-receipt.json" <<'PY'
import json
import sys

settlement = json.load(open(sys.argv[1], encoding="utf-8"))
contract = json.load(open(sys.argv[2], encoding="utf-8"))
receipt = json.load(open(sys.argv[3], encoding="utf-8"))
valid = (
    settlement.get("contract_digest") == contract.get("contract_digest")
    and settlement.get("after_model_sha256") == receipt.get("model", {}).get("export_sha256")
)
raise SystemExit(0 if valid else 1)
PY
  then
    echo "Existing settlement belongs to another round; use a fresh ARCHIE_PURSUIT_STATE." >&2
    exit 1
  fi
  echo "Reusing exact completed curriculum settlement: $SETTLEMENT"
else
  PYTHONPATH="$HERE" "$PYTHON" "$HERE/curriculum_exchange.py" settle \
    --contract "$CONTRACT" \
    --after-model "$EXPORT_DIR/archie-hybrid-generative-next.pt" \
    --training-receipt "$EXPORT_DIR/training-receipt.json" \
    --output "$SETTLEMENT" \
    --ledger "$LEDGER" \
    --device "$DEVICE"
fi

cp "$SETTLEMENT" "$EXPORT_DIR/curriculum-settlement.json"
cp "$LEDGER" "$EXPORT_DIR/pursuit-ledger.json"
echo "Pursuit model: $EXPORT_DIR/archie-hybrid-generative-next.pt"
echo "Exchange: $EXPORT_DIR/curriculum-exchange.json"
echo "Settlement: $EXPORT_DIR/curriculum-settlement.json"
