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

STATE="${ARCHIE_SIDEPUS_PURSUIT_STATE:-$HOME/archie-sidepus-pursuit-v4-evidence-islands}"
EXPORT="${ARCHIE_SIDEPUS_PURSUIT_EXPORT:-$REPO_ROOT/returns/sidepus-pursuit-v4-evidence-islands}"
CACHE="${ARCHIE_SIDEPUS_CACHE_DIR:-$HOME/sidepus-ephemeral-cache-v4-evidence-islands}"
CACHE_BYTES="${ARCHIE_SIDEPUS_CACHE_BYTES:-8589934592}"
EVAL_CACHE_BYTES="${ARCHIE_SIDEPUS_EVAL_CACHE_BYTES:-$(( CACHE_BYTES / 4 ))}"
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
DEV_EVAL_BATCHES="${ARCHIE_SIDEPUS_DEV_EVAL_BATCHES:-12}"
ADMISSION_EVAL_BATCHES="${ARCHIE_SIDEPUS_ADMISSION_EVAL_BATCHES:-32}"
DEV_WRONG_OFFSET="${ARCHIE_SIDEPUS_DEV_WRONG_OFFSET:-17}"
ADMISSION_WRONG_OFFSET="${ARCHIE_SIDEPUS_ADMISSION_WRONG_OFFSET:-41}"
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
  sidepus_evidence_split.py \
  evaluate_archie_sidepus_pursuit.py \
  sidepus_campaign_verdict.py \
  sidepus_select_candidate.py \
  train_archie_sidepus_pursuit.py \
  test_sidepus_causality.py \
  test_sidepus_evidence_islands.py; do
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

# Structural stop gates: no corpus or GPU work unless both causal thought and split mechanics pass.
PYTHONPATH="$HERE" "$PYTHON" -m unittest -q \
  test_sidepus_causality.SidepusCausalityCourt \
  test_sidepus_evidence_islands.SidepusEvidenceIslandTest

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
EVIDENCE_DIR="$STATE/evidence-islands"
SPLIT_RECEIPT="$EVIDENCE_DIR/evidence-split-receipt.json"
TRAIN_INVENTORY="$EVIDENCE_DIR/train-inventory.jsonl"
DEV_INVENTORY="$EVIDENCE_DIR/development-inventory.jsonl"
ADMISSION_INVENTORY="$EVIDENCE_DIR/admission-inventory.jsonl"
TRAIN_PLAN="$STATE/train-intent-plan.jsonl"
DEV_PLAN="$STATE/development-intent-plan.jsonl"
ADMISSION_PLAN="$STATE/admission-intent-plan.jsonl"
TRAIN_SAMPLES=$(( STEPS * BATCH_SIZE + LOOKAHEAD + 128 ))
DEV_SAMPLES=$(( (DEV_WRONG_OFFSET + DEV_EVAL_BATCHES + 8) * BATCH_SIZE ))
ADMISSION_SAMPLES=$(( (ADMISSION_WRONG_OFFSET + ADMISSION_EVAL_BATCHES + 8) * BATCH_SIZE ))

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

PYTHONPATH="$HERE" "$PYTHON" "$HERE/sidepus_evidence_split.py" \
  --inventory "$EXPERIENCE_INVENTORY" \
  --output-dir "$EVIDENCE_DIR" \
  --seed "$(( SEED ^ 0x1A51A ))" \
  --train-fraction 0.80 \
  --development-fraction 0.10 \
  --admission-fraction 0.10

build_plan() {
  local inventory="$1"
  local output="$2"
  local samples="$3"
  local seed="$4"
  PYTHONPATH="$HERE" "$PYTHON" "$HERE/sidepus_pursuit_stream.py" plan \
    --inventory "$inventory" \
    --output "$output" \
    --samples "$samples" \
    --sequence-length "$SEQUENCE_LENGTH" \
    --seed "$seed" \
    --minimum-quality 0.25 \
    --require-channel observation \
    --exclude-flag rights-blocked \
    --domain-targets "$DOMAIN_TARGETS" \
    --sequence-follow-probability "$SEQUENCE_FOLLOW"
}

build_plan "$TRAIN_INVENTORY" "$TRAIN_PLAN" "$TRAIN_SAMPLES" "$SEED"
build_plan "$DEV_INVENTORY" "$DEV_PLAN" "$DEV_SAMPLES" "$(( SEED ^ 0xD3E ))"
build_plan "$ADMISSION_INVENTORY" "$ADMISSION_PLAN" "$ADMISSION_SAMPLES" "$(( SEED ^ 0xAD115510 ))"

run_arm() {
  local name="$1"
  local lookahead="$2"
  local output="$STATE/$name"
  mkdir -p "$output"
  PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True PYTHONPATH="$HERE" "$PYTHON" \
    "$HERE/train_archie_sidepus_pursuit.py" \
    --plan "$TRAIN_PLAN" \
    --plan-receipt "$TRAIN_PLAN.receipt.json" \
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

candidate_for() {
  local name="$1"
  if [[ -f "$STATE/$name/selected-archie-sidepus-pursuit.pt" ]]; then
    printf '%s\n' "$STATE/$name/selected-archie-sidepus-pursuit.pt"
  elif [[ -f "$STATE/$name/best-archie-sidepus-pursuit.pt" ]]; then
    printf '%s\n' "$STATE/$name/best-archie-sidepus-pursuit.pt"
  else
    printf '%s\n' "$STATE/$name/archie-sidepus-pursuit.pt"
  fi
}

evaluate_candidate() {
  local name="$1"
  local label="$2"
  local candidate="$3"
  local split="$4"
  local plan="$5"
  local batches="$6"
  local wrong_offset="$7"
  local output="$STATE/$name/${split}-${label}-court.json"
  PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True PYTHONPATH="$HERE" "$PYTHON" \
    "$HERE/evaluate_archie_sidepus_pursuit.py" \
    --candidate "$candidate" \
    --base-model "$BASE_MODEL" \
    --plan "$plan" \
    --plan-receipt "$plan.receipt.json" \
    --sidepus-state "$SIDEPUS_STATE" \
    --cache-dir "$CACHE/court/$name/$split/$label" \
    --cache-bytes "$EVAL_CACHE_BYTES" \
    --retention-corpus "$RETENTION_CORPUS" \
    --output "$output" \
    --split-receipt "$SPLIT_RECEIPT" \
    --split-name "$split" \
    --batches "$batches" \
    --batch-size "$BATCH_SIZE" \
    --sequence-length "$SEQUENCE_LENGTH" \
    --wrong-offset-batches "$wrong_offset" \
    --prefetch-workers "$PREFETCH" \
    --compute-cost 0.002 \
    --seed "$(( SEED ^ wrong_offset ))"
}

select_on_development() {
  local name="$1"
  local final_model="$STATE/$name/archie-sidepus-pursuit.pt"
  local final_court="$STATE/$name/development-final-court.json"
  local selected_model="$STATE/$name/selected-archie-sidepus-pursuit.pt"
  local selection_receipt="$STATE/$name/development-selection.json"
  evaluate_candidate "$name" final "$final_model" development "$DEV_PLAN" \
    "$DEV_EVAL_BATCHES" "$DEV_WRONG_OFFSET"
  local candidates=(--candidate "$final_model=$final_court")
  local best_model="$STATE/$name/best-archie-sidepus-pursuit.pt"
  if [[ -f "$best_model" ]]; then
    local best_court="$STATE/$name/development-training-best-court.json"
    evaluate_candidate "$name" training-best "$best_model" development "$DEV_PLAN" \
      "$DEV_EVAL_BATCHES" "$DEV_WRONG_OFFSET"
    candidates+=(--candidate "$best_model=$best_court")
  fi
  PYTHONPATH="$HERE" "$PYTHON" "$HERE/sidepus_select_candidate.py" \
    "${candidates[@]}" \
    --output-model "$selected_model" \
    --output-receipt "$selection_receipt"
}

evaluate_selected_on_admission() {
  local name="$1"
  local selected
  selected="$(candidate_for "$name")"
  evaluate_candidate "$name" selected "$selected" admission "$ADMISSION_PLAN" \
    "$ADMISSION_EVAL_BATCHES" "$ADMISSION_WRONG_OFFSET"
  cp -f "$STATE/$name/admission-selected-court.json" "$STATE/$name/admission-court.json"
}

echo "Archie Sidepus pursuit v4 evidence-island campaign"
echo "  base:          $BASE_MODEL"
echo "  source:        $SOURCE_INVENTORY"
echo "  evidence:      $EVIDENCE_DIR (train/development/admission before sampling)"
echo "  train plan:    $TRAIN_PLAN ($TRAIN_SAMPLES samples)"
echo "  dev plan:      $DEV_PLAN ($DEV_SAMPLES samples)"
echo "  admission:     $ADMISSION_PLAN ($ADMISSION_SAMPLES samples, untouched until final court)"
echo "  cache:         $CACHE"
echo "  pursuit:       lookahead=$LOOKAHEAD; thread_follow=$SEQUENCE_FOLLOW"
echo "  mechanisms:    causal token-local thought + foreign-history margin + value-of-computation"
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
else
  echo "Sequential control disabled; admission superiority cannot be decided."
fi

# Development fixes checkpoint identity before the admission plan is opened.
select_on_development pursuit
if [[ "$RUN_SEQUENTIAL_CONTROL" == "1" ]]; then
  select_on_development sequential-control
fi

evaluate_selected_on_admission pursuit
if [[ "$RUN_SEQUENTIAL_CONTROL" == "1" ]]; then
  evaluate_selected_on_admission sequential-control
  PYTHONPATH="$HERE" "$PYTHON" "$HERE/sidepus_campaign_verdict.py" \
    --pursuit "$STATE/pursuit/admission-court.json" \
    --sequential "$STATE/sequential-control/admission-court.json" \
    --output "$STATE/admission-verdict.json"
fi

mkdir -p "$EXPORT"
cp -f "$STATE/pursuit/archie-sidepus-pursuit.pt" "$EXPORT/archie-sidepus-pursuit.pt"
cp -f "$(candidate_for pursuit)" "$EXPORT/selected-archie-sidepus-pursuit.pt"
cp -f "$STATE/pursuit/training-receipt.json" "$EXPORT/training-receipt.json"
cp -f "$STATE/pursuit/development-selection.json" "$EXPORT/development-selection.json"
cp -f "$STATE/pursuit/development-final-court.json" "$EXPORT/development-final-court.json"
if [[ -f "$STATE/pursuit/development-training-best-court.json" ]]; then
  cp -f "$STATE/pursuit/development-training-best-court.json" "$EXPORT/development-training-best-court.json"
fi
cp -f "$STATE/pursuit/admission-court.json" "$EXPORT/admission-court.json"
cp -f "$SPLIT_RECEIPT" "$EXPORT/evidence-split-receipt.json"
cp -f "$TRAIN_PLAN.receipt.json" "$EXPORT/train-plan-receipt.json"
cp -f "$DEV_PLAN.receipt.json" "$EXPORT/development-plan-receipt.json"
cp -f "$ADMISSION_PLAN.receipt.json" "$EXPORT/admission-plan-receipt.json"
cp -f "$MICROPHYSICS_INVENTORY.receipt.json" "$EXPORT/microphysics-receipt.json"
if [[ -n "$REMOTE_MANIFEST" ]]; then
  cp -f "$REMOTE_INVENTORY.receipt.json" "$EXPORT/remote-experience-receipt.json"
fi
cp -f "$COMBINED_INVENTORY.receipt.json" "$EXPORT/inventory-union-receipt.json"
cp -f "$EXPERIENCE_INVENTORY.receipt.json" "$EXPORT/experience-inventory-receipt.json"
if [[ -f "$STATE/admission-verdict.json" ]]; then
  cp -f "$STATE/admission-verdict.json" "$EXPORT/admission-verdict.json"
fi

echo "Pursuit campaign complete: $EXPORT"
if [[ -f "$STATE/admission-verdict.json" ]]; then
  "$PYTHON" - "$STATE/admission-verdict.json" <<'PY'
import json, pathlib, sys
v=json.loads(pathlib.Path(sys.argv[1]).read_text())
e=v["effects"]
print("Admission verdict:", v["promotion"], "passed=" + str(v["passed"]))
print("  pursuit gain vs sequential bpb:", e["pursuit_gain_vs_sequential_bpb"])
print("  correct-state gain vs wrong bpb:", e["pursuit_gain_vs_wrong_state_bpb"])
print("  compute gain vs step1 nats/token:", e["pursuit_compute_adjusted_gain_vs_step1_nats_per_token"])
PY
fi
