#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PYTHON="${ARCHIE_PYTHON:-/home/awesomekai/.venv-archie-cuda/bin/python}"
BASE_STATE="${ARCHIE_114M_STATE:-/home/awesomekai/archie-base-114m-v1}"
BASE_MODEL="${ARCHIE_BREAKTHROUGH_BASE_MODEL:-$REPO_ROOT/returns/generative-114m/archie-hybrid-114m.pt}"
BASE_RECEIPT="${ARCHIE_BREAKTHROUGH_BASE_RECEIPT:-$REPO_ROOT/returns/generative-114m/training-receipt.json}"
CORPUS_DIR="${ARCHIE_BREAKTHROUGH_CORPUS_DIR:-$BASE_STATE/corpus}"
STATE="${ARCHIE_BREAKTHROUGH_STATE:-/home/awesomekai/archie-world-state-breakthrough-v1}"
EXPORT="${ARCHIE_BREAKTHROUGH_EXPORT:-$REPO_ROOT/returns/world-state-breakthrough}"

SEQUENCE_LENGTH="${ARCHIE_BREAKTHROUGH_SEQUENCE_LENGTH:-1024}"
MICROBATCH="${ARCHIE_BREAKTHROUGH_BATCH_SIZE:-1}"
GRAD_ACCUM="${ARCHIE_BREAKTHROUGH_GRAD_ACCUM:-12}"
Q8_STEPS="${ARCHIE_BREAKTHROUGH_Q8_STEPS:-2000}"
Q4_STEPS="${ARCHIE_BREAKTHROUGH_Q4_STEPS:-500}"
Q8_FREEZE="${ARCHIE_BREAKTHROUGH_Q8_FREEZE_STEPS:-500}"
DEADLINE="${ARCHIE_BREAKTHROUGH_DEADLINE_MINUTES:-330}"
DISCOVERY_SEED="${ARCHIE_BREAKTHROUGH_SEED:-20260723}"
REPLICATION_SEED="${ARCHIE_BREAKTHROUGH_REPLICATION_SEED:-20260724}"
SUITE_CASES="${ARCHIE_BREAKTHROUGH_SUITE_CASES:-48}"
RETENTION_BATCHES="${ARCHIE_BREAKTHROUGH_RETENTION_BATCHES:-24}"

require_file() {
  if [[ ! -f "$1" ]]; then
    echo "Missing required file: $1" >&2
    return 1
  fi
}

if [[ ! -x "$PYTHON" ]]; then
  echo "Missing Archie CUDA Python: $PYTHON" >&2
  exit 1
fi
if ! "$PYTHON" -c 'import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)'; then
  echo "CUDA is unavailable in $PYTHON" >&2
  exit 1
fi
require_file "$HERE/train_archie_world_state_maximal.py"
require_file "$HERE/build_world_state_breakthrough_suite.py"
require_file "$HERE/evaluate_world_state_breakthrough.py"

ACTIVE="$(pgrep -af '([t]rain_archie|[r]esearch_archie|[n]p_transformer|[t]rain_causal)' || true)"
if [[ -n "$ACTIVE" && "${ARCHIE_ALLOW_CONCURRENT_GPU:-0}" != "1" ]]; then
  echo "Another Archie training process is active; refusing to split the GPU:" >&2
  echo "$ACTIVE" >&2
  exit 2
fi

base_complete() {
  [[ -f "$BASE_MODEL" && -f "$BASE_RECEIPT" ]] || return 1
  "$PYTHON" - "$BASE_RECEIPT" <<'PY'
import json, pathlib, sys
receipt = json.loads(pathlib.Path(sys.argv[1]).read_text())
opt = receipt.get("optimization", {})
step = int(opt.get("step", -1))
maximum = int(opt.get("max_steps", -2))
raise SystemExit(0 if maximum > 0 and step >= maximum else 1)
PY
}

echo "Archie maximal breakthrough campaign"
echo "  GPU:          $("$PYTHON" -c 'import torch; print(torch.cuda.get_device_name(0))')"
echo "  base:         $BASE_MODEL"
echo "  corpus:       $CORPUS_DIR"
echo "  state:        $STATE"
echo "  export:       $EXPORT"
echo "  context:      $SEQUENCE_LENGTH"
echo "  effective:    $((MICROBATCH * GRAD_ACCUM)) sequences/update"
echo "  discovery:    q8=$Q8_STEPS updates, q4=$Q4_STEPS updates"
echo "  replication:  only after discovery clears transfer + retention"

if [[ "${ARCHIE_DRY_RUN:-0}" == "1" || "${ARCHIE_BREAKTHROUGH_DRY_RUN:-0}" == "1" ]]; then
  echo "Dry run complete; no model or corpus bytes changed."
  exit 0
fi

if ! base_complete; then
  if [[ "${ARCHIE_BREAKTHROUGH_ALLOW_PARTIAL_BASE:-0}" != "1" ]]; then
    echo "The trained 114M language shell is not complete. Resuming that prerequisite first."
    bash "$HERE/run_archie_114m.sh"
    if ! base_complete; then
      echo "The baseline invocation checkpointed safely but is not finished."
      echo "Run this same breakthrough command again; it will resume the prerequisite."
      exit 0
    fi
  else
    require_file "$BASE_MODEL"
    require_file "$BASE_RECEIPT"
    echo "WARNING: partial baseline explicitly authorized; breakthrough claims remain disabled."
  fi
fi

require_file "$CORPUS_DIR/train.u16"
require_file "$CORPUS_DIR/development.u16"
mkdir -p "$STATE" "$EXPORT"

phase_complete() {
  local receipt="$1"
  local expected="$2"
  [[ -f "$receipt" ]] || return 1
  "$PYTHON" - "$receipt" "$expected" <<'PY'
import json, pathlib, sys
payload = json.loads(pathlib.Path(sys.argv[1]).read_text())
raise SystemExit(0 if int(payload.get("training", {}).get("step", -1)) >= int(sys.argv[2]) else 1)
PY
}

run_q8() {
  local seed="$1"
  local root="$2"
  mkdir -p "$root/q8"
  PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True PYTHONPATH="$HERE" "$PYTHON" \
    "$HERE/train_archie_world_state_maximal.py" \
    --train-corpus "$CORPUS_DIR/train.u16" \
    --eval-corpus "$CORPUS_DIR/development.u16" \
    --output-dir "$root/q8" \
    --preset small \
    --initialize-from "$BASE_MODEL" \
    --steps "$Q8_STEPS" \
    --batch-size "$MICROBATCH" \
    --eval-batch-size 1 \
    --seq-len "$SEQUENCE_LENGTH" \
    --grad-accum "$GRAD_ACCUM" \
    --learning-rate 0.0002 \
    --language-lr-scale 0.10 \
    --warmup-steps 200 \
    --freeze-language-steps "$Q8_FREEZE" \
    --eval-every 100 \
    --eval-batches 4 \
    --save-every 50 \
    --log-every 5 \
    --state-quant-bits 8 \
    --state-aux-weight 0.35 \
    --event-size 16 \
    --state-slots 8 \
    --state-top-k 2 \
    --amp-dtype float16 \
    --gradient-checkpointing \
    --tf32 \
    --deadline-minutes "$DEADLINE" \
    --seed "$seed" \
    --generate-tokens 24
}

run_q4() {
  local seed="$1"
  local root="$2"
  mkdir -p "$root/q4"
  PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True PYTHONPATH="$HERE" "$PYTHON" \
    "$HERE/train_archie_world_state_maximal.py" \
    --train-corpus "$CORPUS_DIR/train.u16" \
    --eval-corpus "$CORPUS_DIR/development.u16" \
    --output-dir "$root/q4" \
    --preset small \
    --initialize-from "$root/q8/archie-world-state.pt" \
    --steps "$Q4_STEPS" \
    --batch-size "$MICROBATCH" \
    --eval-batch-size 1 \
    --seq-len "$SEQUENCE_LENGTH" \
    --grad-accum "$GRAD_ACCUM" \
    --learning-rate 0.00006 \
    --language-lr-scale 0.05 \
    --warmup-steps 50 \
    --freeze-language-steps 0 \
    --eval-every 50 \
    --eval-batches 4 \
    --save-every 25 \
    --log-every 5 \
    --state-quant-bits 4 \
    --state-aux-weight 0.35 \
    --event-size 16 \
    --state-slots 8 \
    --state-top-k 2 \
    --amp-dtype float16 \
    --gradient-checkpointing \
    --tf32 \
    --deadline-minutes "$DEADLINE" \
    --seed "$seed" \
    --generate-tokens 24
}

evaluate_arm() {
  local arm="$1"
  local root="$2"
  local model="$root/$arm/archie-world-state.pt"
  local suite="$root/$arm/posttrain-transfer-suite.json"
  local receipt="$root/$arm/breakthrough-receipt.json"
  PYTHONPATH="$HERE" "$PYTHON" "$HERE/build_world_state_breakthrough_suite.py" \
    --model "$model" --output "$suite" --count "$SUITE_CASES" --seed "$DISCOVERY_SEED"
  PYTHONPATH="$HERE" "$PYTHON" "$HERE/evaluate_world_state_breakthrough.py" \
    --base-model "$BASE_MODEL" \
    --candidate-model "$model" \
    --suite "$suite" \
    --eval-corpus "$CORPUS_DIR/development.u16" \
    --output "$receipt" \
    --device cuda \
    --minimum-reset-gain 0.01 \
    --minimum-wrong-gain 0.01 \
    --maximum-retention-regression 0.05 \
    --retention-seq-len 512 \
    --retention-batches "$RETENTION_BATCHES" \
    --retention-batch-size 1
}

select_discovery() {
  "$PYTHON" - "$1" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
rows = []
for arm in ("q8", "q4"):
    path = root / arm / "breakthrough-receipt.json"
    if not path.exists():
        continue
    receipt = json.loads(path.read_text())
    transfer = receipt["transfer"]["metrics"]
    retention = receipt["retention"]["relative_regression"]
    score = (
        float(transfer["mean_gain_vs_reset"])
        + float(transfer["mean_gain_vs_wrong"])
        - max(float(retention), 0.0)
    )
    rows.append((bool(receipt["passed"]), score, arm, receipt))
rows.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
decision = {
    "schema": "archie-world-state-discovery-decision/v1",
    "candidates": [
        {"arm": arm, "passed": passed, "score": score}
        for passed, score, arm, _ in rows
    ],
    "selected": rows[0][2] if rows and rows[0][0] else None,
}
(root / "discovery-decision.json").write_text(json.dumps(decision, indent=2, sort_keys=True) + "\n")
print(json.dumps(decision, indent=2, sort_keys=True))
raise SystemExit(0 if decision["selected"] else 3)
PY
}

finalize() {
  "$PYTHON" - "$STATE" "$EXPORT" <<'PY'
import hashlib, json, pathlib, shutil, sys
state = pathlib.Path(sys.argv[1])
export = pathlib.Path(sys.argv[2])
discovery = json.loads((state / "discovery/discovery-decision.json").read_text())
arm = discovery["selected"]
replication_receipt = state / "replication" / arm / "breakthrough-receipt.json"
replication = json.loads(replication_receipt.read_text())
passed = bool(replication["passed"])
decision = {
    "schema": "archie-world-state-breakthrough-decision/v1",
    "selected_arm": arm,
    "discovery_passed": True,
    "replication_passed": passed,
    "passed": passed,
    "promotion": "replicated-breakthrough-candidate" if passed else "discovery-not-replicated",
    "claim_boundary": (
        "A replicated candidate is still not admitted until practical throughput and a second "
        "independent frozen task family are measured."
    ),
}
decision["receipt_digest"] = hashlib.sha256(
    json.dumps(decision, sort_keys=True, separators=(",", ":")).encode()
).hexdigest()
export.mkdir(parents=True, exist_ok=True)
(export / "decision.json").write_text(json.dumps(decision, indent=2, sort_keys=True) + "\n")
if passed:
    source = state / "replication" / arm / "archie-world-state.pt"
    shutil.copy2(source, export / "archie-world-state-breakthrough.pt")
    shutil.copy2(replication_receipt, export / "replication-receipt.json")
    shutil.copy2(
        state / "discovery" / arm / "breakthrough-receipt.json",
        export / "discovery-receipt.json",
    )
print(json.dumps(decision, indent=2, sort_keys=True))
raise SystemExit(0 if passed else 4)
PY
}

DISCOVERY="$STATE/discovery"
if ! phase_complete "$DISCOVERY/q8/receipt.json" "$Q8_STEPS"; then
  run_q8 "$DISCOVERY_SEED" "$DISCOVERY"
fi
if ! phase_complete "$DISCOVERY/q8/receipt.json" "$Q8_STEPS"; then
  echo "Q8 discovery checkpointed before completion. Run the same command again."
  exit 0
fi
if ! phase_complete "$DISCOVERY/q4/receipt.json" "$Q4_STEPS"; then
  run_q4 "$DISCOVERY_SEED" "$DISCOVERY"
fi
if ! phase_complete "$DISCOVERY/q4/receipt.json" "$Q4_STEPS"; then
  echo "Q4 continuation checkpointed before completion. Run the same command again."
  exit 0
fi
evaluate_arm q8 "$DISCOVERY"
evaluate_arm q4 "$DISCOVERY"
if ! select_discovery "$DISCOVERY"; then
  echo "Discovery was falsified: neither low-bit state arm cleared transfer plus retention."
  exit 3
fi
SELECTED="$("$PYTHON" -c 'import json,sys; print(json.load(open(sys.argv[1]))["selected"])' "$DISCOVERY/discovery-decision.json")"

REPLICATION="$STATE/replication"
if ! phase_complete "$REPLICATION/q8/receipt.json" "$Q8_STEPS"; then
  run_q8 "$REPLICATION_SEED" "$REPLICATION"
fi
if ! phase_complete "$REPLICATION/q8/receipt.json" "$Q8_STEPS"; then
  echo "Replication Q8 checkpointed before completion. Run the same command again."
  exit 0
fi
if [[ "$SELECTED" == "q4" ]]; then
  if ! phase_complete "$REPLICATION/q4/receipt.json" "$Q4_STEPS"; then
    run_q4 "$REPLICATION_SEED" "$REPLICATION"
  fi
  if ! phase_complete "$REPLICATION/q4/receipt.json" "$Q4_STEPS"; then
    echo "Replication Q4 checkpointed before completion. Run the same command again."
    exit 0
  fi
fi

PYTHONPATH="$HERE" "$PYTHON" "$HERE/build_world_state_breakthrough_suite.py" \
  --model "$REPLICATION/$SELECTED/archie-world-state.pt" \
  --output "$REPLICATION/$SELECTED/posttrain-transfer-suite.json" \
  --count "$SUITE_CASES" \
  --seed "$REPLICATION_SEED"
PYTHONPATH="$HERE" "$PYTHON" "$HERE/evaluate_world_state_breakthrough.py" \
  --base-model "$BASE_MODEL" \
  --candidate-model "$REPLICATION/$SELECTED/archie-world-state.pt" \
  --suite "$REPLICATION/$SELECTED/posttrain-transfer-suite.json" \
  --eval-corpus "$CORPUS_DIR/development.u16" \
  --output "$REPLICATION/$SELECTED/breakthrough-receipt.json" \
  --device cuda \
  --minimum-reset-gain 0.01 \
  --minimum-wrong-gain 0.01 \
  --maximum-retention-regression 0.05 \
  --retention-seq-len 512 \
  --retention-batches "$RETENTION_BATCHES" \
  --retention-batch-size 1 \
  --seed "$REPLICATION_SEED"

finalize
