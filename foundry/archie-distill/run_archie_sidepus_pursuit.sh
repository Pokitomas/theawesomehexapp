#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PYTHON="${ARCHIE_PYTHON:-/home/awesomekai/.venv-archie-cuda/bin/python}"

BASE_STATE="${ARCHIE_114M_STATE:-/home/awesomekai/archie-base-114m-v1}"
BASE_MODEL="${ARCHIE_SIDEPUS_BASE_MODEL:-$REPO_ROOT/returns/generative-114m/archie-hybrid-114m.pt}"
RETENTION_CORPUS="${ARCHIE_SIDEPUS_RETENTION_CORPUS:-$BASE_STATE/corpus/development.u16}"
SIDEPUS_STATE="${SIDEPUS_STATE:-$HOME/sidepus-archive-v2}"
SOURCE_INVENTORY="${ARCHIE_SIDEPUS_INVENTORY:-$SIDEPUS_STATE/training-inventory.jsonl}"
REMOTE_MANIFEST="${ARCHIE_SIDEPUS_REMOTE_MANIFEST:-}"

STATE="${ARCHIE_SIDEPUS_PURSUIT_STATE:-$HOME/archie-sidepus-pursuit-v2}"
EXPORT="${ARCHIE_SIDEPUS_PURSUIT_EXPORT:-$REPO_ROOT/returns/sidepus-pursuit-v2}"
CACHE="${ARCHIE_SIDEPUS_CACHE_DIR:-$HOME/sidepus-ephemeral-cache-v2}"
CACHE_BYTES="${ARCHIE_SIDEPUS_CACHE_BYTES:-8589934592}"
SEQUENCE_LENGTH="${ARCHIE_SIDEPUS_SEQUENCE_LENGTH:-1024}"
BATCH_SIZE="${ARCHIE_SIDEPUS_BATCH_SIZE:-1}"
STEPS="${ARCHIE_SIDEPUS_PURSUIT_STEPS:-3000}"
LOOKAHEAD="${ARCHIE_SIDEPUS_PURSUIT_LOOKAHEAD:-64}"
PREFETCH="${ARCHIE_SIDEPUS_PREFETCH_WORKERS:-4}"
SEED="${ARCHIE_SIDEPUS_SEED:-20260725}"
DEADLINE="${ARCHIE_SIDEPUS_DEADLINE_MINUTES:-330}"
RUN_SEQUENTIAL_CONTROL="${ARCHIE_SIDEPUS_RUN_SEQUENTIAL_CONTROL:-1}"
MICROPHYSICS_EPISODES="${ARCHIE_SIDEPUS_MICROPHYSICS_EPISODES:-256}"
SEQUENCE_FOLLOW="${ARCHIE_SIDEPUS_SEQUENCE_FOLLOW_PROBABILITY:-0.8}"
DEFAULT_DOMAIN_TARGETS='{"multimodal_episode":0.45,"formal_executable":0.20,"empirical_world":0.15,"language_expression":0.08,"social_institutional":0.07,"adversarial_messy":0.05}'
DOMAIN_TARGETS="${ARCHIE_SIDEPUS_DOMAIN_TARGETS:-$DEFAULT_DOMAIN_TARGETS}"

require_file() { [[ -f "$1" ]] || { echo "Missing required file: $1" >&2; exit 1; }; }
for file in \
  sidepus_experience_compiler.py \
  sidepus_ephemeral_cache.py \
  sidepus_microphysics.py \
  sidepus_inventory_union.py \
  sidepus_remote_experience.py \
  sidepus_developmental_graph.py \
  sidepus_pursuit_plan.py \
  sidepus_pursuit_controller.py \
  sidepus_pursuit_stream.py \
  sidepus_pursuit_objectives.py \
  sidepus_pursuit_forward.py \
  sidepus_pursuit_step.py \
  sidepus_pursuit_cli.py \
  train_archie_sidepus_pursuit.py; do
  require_file "$HERE/$file"
done
require_file "$BASE_MODEL"
require_file "$RETENTION_CORPUS"
require_file "$SOURCE_INVENTORY"
if [[ -n "$REMOTE_MANIFEST" ]]; then
  require_file "$REMOTE_MANIFEST"
fi
if [[ ! -x "$PYTHON" ]]; then echo "Missing Archie Python: $PYTHON" >&2; exit 1; fi
if ! "$PYTHON" -c 'import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)'; then
  echo "CUDA unavailable in $PYTHON" >&2; exit 1
fi
ACTIVE="$(pgrep -af '([t]rain_archie|[r]esearch_archie|[n]p_transformer|[t]rain_causal)' || true)"
if [[ -n "$ACTIVE" && "${ARCHIE_ALLOW_CONCURRENT_GPU:-0}" != "1" ]]; then
  echo "Another Archie training process is active; refusing to split the GPU:" >&2
  echo "$ACTIVE" >&2
  exit 2
fi

mkdir -p "$STATE" "$EXPORT" "$CACHE"
MICROPHYSICS_INVENTORY="$STATE/microphysics-inventory.jsonl"
REMOTE_INVENTORY="$STATE/remote-experience-inventory.jsonl"
COMBINED_INVENTORY="$STATE/combined-inventory.jsonl"
EXPERIENCE_INVENTORY="$STATE/experience-inventory.jsonl"
PLAN="$STATE/pursuit-intent-plan.jsonl"
SAMPLES=$(( STEPS * BATCH_SIZE + LOOKAHEAD + 128 ))

PYTHONPATH="$HERE" "$PYTHON" "$HERE/sidepus_microphysics.py" \
  --state-dir "$SIDEPUS_STATE" \
  --output "$MICROPHYSICS_INVENTORY" \
  --episodes "$MICROPHYSICS_EPISODES" \
  --seed "$SEED" \
  --size 16 \
  --body-count 3 \
  --frames 16 \
  --frames-per-record 2

UNION_ARGS=(
  --inventory "$SOURCE_INVENTORY"
  --inventory "$MICROPHYSICS_INVENTORY"
)
if [[ -n "$REMOTE_MANIFEST" ]]; then
  PYTHONPATH="$HERE" "$PYTHON" "$HERE/sidepus_remote_experience.py" \
    --manifest "$REMOTE_MANIFEST" \
    --output "$REMOTE_INVENTORY"
  UNION_ARGS+=(--inventory "$REMOTE_INVENTORY")
fi

PYTHONPATH="$HERE" "$PYTHON" "$HERE/sidepus_inventory_union.py" \
  "${UNION_ARGS[@]}" \
  --output "$COMBINED_INVENTORY"

PYTHONPATH="$HERE" "$PYTHON" "$HERE/sidepus_experience_compiler.py" \
  --inventory "$COMBINED_INVENTORY" \
  --output "$EXPERIENCE_INVENTORY"

PYTHONPATH="$HERE" "$PYTHON" "$HERE/sidepus_pursuit_stream.py" plan \
  --inventory "$EXPERIENCE_INVENTORY" \
  --output "$PLAN" \
  --samples "$SAMPLES" \
  --sequence-length "$SEQUENCE_LENGTH" \
  --seed "$SEED" \
  --minimum-quality 0.25 \
  --require-channel observation \
  --exclude-flag rights-blocked \
  --domain-targets "$DOMAIN_TARGETS" \
  --sequence-follow-probability "$SEQUENCE_FOLLOW"

run_arm() {
  local name="$1"
  local lookahead="$2"
  local output="$STATE/$name"
  mkdir -p "$output"
  PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True PYTHONPATH="$HERE" "$PYTHON" \
    "$HERE/train_archie_sidepus_pursuit.py" \
    --plan "$PLAN" \
    --plan-receipt "$PLAN.receipt.json" \
    --sidepus-state "$SIDEPUS_STATE" \
    --cache-dir "$CACHE/$name" \
    --cache-bytes "$CACHE_BYTES" \
    --retention-corpus "$RETENTION_CORPUS" \
    --init-model "$BASE_MODEL" \
    --output-dir "$output" \
    --seq-len "$SEQUENCE_LENGTH" \
    --batch-size "$BATCH_SIZE" \
    --prefetch-workers "$PREFETCH" \
    --pursuit-lookahead "$lookahead" \
    --max-steps "$STEPS" \
    --freeze-language-steps 1200 \
    --state-carry-policy carry-with-domain-reset \
    --counterfactual-every 4 \
    --state-order-weight 0.5 \
    --deliberation-compute-cost 0.002 \
    --deliberation-policy-weight 0.05 \
    --deliberation-trajectory-weight 0.20 \
    --deliberation-improvement-margin 0.002 \
    --deliberation-halt-warmup-steps 75 \
    --deliberation-floor-weight 0.05 \
    --halt-entropy-weight 0.001 \
    --interference-every 8 \
    --interference-weight 0.1 \
    --eval-every 100 \
    --save-every 50 \
    --log-every 5 \
    --deadline-minutes "$DEADLINE" \
    --seed "$SEED"
}

complete() {
  local receipt="$1"
  [[ -f "$receipt" ]] || return 1
  "$PYTHON" - "$receipt" "$STEPS" <<'PY'
import json, pathlib, sys
value=json.loads(pathlib.Path(sys.argv[1]).read_text())
raise SystemExit(0 if int(value.get("training",{}).get("step",-1)) >= int(sys.argv[2]) else 1)
PY
}

echo "Archie Sidepus pursuit v2 campaign"
echo "  base:         $BASE_MODEL"
echo "  archive:      $SOURCE_INVENTORY"
echo "  microphysics: $MICROPHYSICS_INVENTORY ($MICROPHYSICS_EPISODES episodes)"
if [[ -n "$REMOTE_MANIFEST" ]]; then
  echo "  remote:       $REMOTE_MANIFEST -> $REMOTE_INVENTORY (zero-download manifest)"
else
  echo "  remote:       none supplied"
fi
echo "  union:         $COMBINED_INVENTORY"
echo "  experience:    $EXPERIENCE_INVENTORY"
echo "  intent:        $PLAN"
echo "  cache:         $CACHE ($CACHE_BYTES bytes per arm)"
echo "  pursuit:       lookahead=$LOOKAHEAD; thread_follow=$SEQUENCE_FOLLOW; learned prerequisite frontier"
echo "  mechanisms:    foreign-history causal margin + value-of-computation + immutable retention/interference taxes"
echo "  control:       sequential=$RUN_SEQUENTIAL_CONTROL"

if ! complete "$STATE/pursuit/training-receipt.json"; then
  run_arm pursuit "$LOOKAHEAD"
fi
if ! complete "$STATE/pursuit/training-receipt.json"; then
  echo "Pursuit arm checkpointed. Run the same command again."
  exit 0
fi

if [[ "$RUN_SEQUENTIAL_CONTROL" == "1" ]]; then
  if ! complete "$STATE/sequential-control/training-receipt.json"; then
    run_arm sequential-control "$BATCH_SIZE"
  fi
  if ! complete "$STATE/sequential-control/training-receipt.json"; then
    echo "Sequential control checkpointed. Run the same command again."
    exit 0
  fi
fi

mkdir -p "$EXPORT"
cp -f "$STATE/pursuit/archie-sidepus-pursuit.pt" "$EXPORT/archie-sidepus-pursuit.pt"
cp -f "$STATE/pursuit/training-receipt.json" "$EXPORT/training-receipt.json"
cp -f "$MICROPHYSICS_INVENTORY.receipt.json" "$EXPORT/microphysics-receipt.json"
if [[ -n "$REMOTE_MANIFEST" ]]; then
  cp -f "$REMOTE_INVENTORY.receipt.json" "$EXPORT/remote-experience-receipt.json"
fi
cp -f "$COMBINED_INVENTORY.receipt.json" "$EXPORT/inventory-union-receipt.json"
cp -f "$EXPERIENCE_INVENTORY.receipt.json" "$EXPORT/experience-inventory-receipt.json"
cp -f "$PLAN.receipt.json" "$EXPORT/pursuit-intent-receipt.json"
echo "Pursuit campaign complete: $EXPORT"
