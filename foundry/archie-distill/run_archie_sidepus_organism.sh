#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PYTHON="${ARCHIE_PYTHON:-/home/awesomekai/.venv-archie-cuda/bin/python}"

BASE_STATE="${ARCHIE_114M_STATE:-/home/awesomekai/archie-base-114m-v1}"
BASE_MODEL="${ARCHIE_SIDEPUS_BASE_MODEL:-$REPO_ROOT/returns/generative-114m/archie-hybrid-114m.pt}"
BASE_RECEIPT="${ARCHIE_SIDEPUS_BASE_RECEIPT:-$REPO_ROOT/returns/generative-114m/training-receipt.json}"
RETENTION_CORPUS="${ARCHIE_SIDEPUS_RETENTION_CORPUS:-$BASE_STATE/corpus/development.u16}"

SIDEPUS_STATE="${SIDEPUS_STATE:-$HOME/sidepus-archive-v2}"
SIDEPUS_INVENTORY="${ARCHIE_SIDEPUS_INVENTORY:-$SIDEPUS_STATE/training-inventory.jsonl}"
SIDEPUS_INVENTORY_RECEIPT="${ARCHIE_SIDEPUS_INVENTORY_RECEIPT:-$SIDEPUS_INVENTORY.receipt.json}"
SIDEPUS_RIGHTS_MANIFEST="${ARCHIE_SIDEPUS_RIGHTS_MANIFEST:-}"

STATE="${ARCHIE_SIDEPUS_ORGANISM_STATE:-$HOME/archie-sidepus-organism-v1}"
EXPORT="${ARCHIE_SIDEPUS_ORGANISM_EXPORT:-$REPO_ROOT/returns/sidepus-organism}"
SEQUENCE_LENGTH="${ARCHIE_SIDEPUS_SEQUENCE_LENGTH:-1024}"
BATCH_SIZE="${ARCHIE_SIDEPUS_BATCH_SIZE:-1}"
PREFETCH_WORKERS="${ARCHIE_SIDEPUS_PREFETCH_WORKERS:-4}"
Q8_STEPS="${ARCHIE_SIDEPUS_Q8_STEPS:-2500}"
Q4_STEPS="${ARCHIE_SIDEPUS_Q4_STEPS:-500}"
FREEZE_STEPS="${ARCHIE_SIDEPUS_FREEZE_STEPS:-500}"
DEADLINE="${ARCHIE_SIDEPUS_DEADLINE_MINUTES:-330}"
DISCOVERY_SEED="${ARCHIE_SIDEPUS_SEED:-20260723}"
REPLICATION_SEED="${ARCHIE_SIDEPUS_REPLICATION_SEED:-20260724}"
EVAL_BATCHES="${ARCHIE_SIDEPUS_EVAL_BATCHES:-48}"
WRONG_OFFSET="${ARCHIE_SIDEPUS_WRONG_OFFSET_BATCHES:-97}"
RUN_CONTROLS="${ARCHIE_SIDEPUS_RUN_CONTROLS:-1}"

require_file() {
  [[ -f "$1" ]] || { echo "Missing required file: $1" >&2; exit 1; }
}

if [[ ! -x "$PYTHON" ]]; then
  echo "Missing CUDA Python: $PYTHON" >&2
  exit 1
fi
if ! "$PYTHON" -c 'import torch; raise SystemExit(0 if torch.cuda.is_available() else 1)'; then
  echo "CUDA unavailable in $PYTHON" >&2
  exit 1
fi

for file in \
  sidepus_training_stream.py \
  archie_sidepus_organism.py \
  train_archie_sidepus_organism.py \
  evaluate_archie_sidepus_organism.py; do
  require_file "$HERE/$file"
done

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
receipt=json.loads(pathlib.Path(sys.argv[1]).read_text())
opt=receipt.get("optimization", {})
step=int(opt.get("step", receipt.get("training", {}).get("step", -1)))
maximum=int(opt.get("max_steps", opt.get("maximum_steps", -2)))
raise SystemExit(0 if maximum > 0 and step >= maximum else 1)
PY
}

if ! base_complete; then
  echo "The 114M language parent is not complete. Keep the current run alive and rerun this campaign later." >&2
  exit 3
fi
require_file "$RETENTION_CORPUS"

mkdir -p "$STATE" "$EXPORT"
if [[ ! -f "$SIDEPUS_INVENTORY" ]]; then
  if [[ -z "$SIDEPUS_RIGHTS_MANIFEST" ]]; then
    echo "No direct archive inventory exists and ARCHIE_SIDEPUS_RIGHTS_MANIFEST is unset." >&2
    echo "Refusing to silently train from the small public export or unresolved-rights archive records." >&2
    exit 4
  fi
  require_file "$SIDEPUS_RIGHTS_MANIFEST"
  PYTHONPATH="$REPO_ROOT" "$PYTHON" -m foundry.sidepus.developmental_cli extract-warc-inventory \
    --state-dir "$SIDEPUS_STATE" \
    --output "$SIDEPUS_INVENTORY" \
    --rights-manifest "$SIDEPUS_RIGHTS_MANIFEST"
fi
require_file "$SIDEPUS_INVENTORY_RECEIPT"
PYTHONPATH="$REPO_ROOT" "$PYTHON" -m foundry.sidepus.developmental_cli verify-inventory \
  --receipt "$SIDEPUS_INVENTORY_RECEIPT" >/dev/null

phase_complete() {
  local receipt="$1"
  local expected="$2"
  [[ -f "$receipt" ]] || return 1
  "$PYTHON" - "$receipt" "$expected" <<'PY'
import json, pathlib, sys
payload=json.loads(pathlib.Path(sys.argv[1]).read_text())
raise SystemExit(0 if int(payload.get("training", {}).get("step", -1)) >= int(sys.argv[2]) else 1)
PY
}

plan_samples() {
  "$PYTHON" - "$1" "$2" "$3" <<'PY'
import sys
steps,batch,minimum=map(int,sys.argv[1:])
print(max(steps*batch, minimum))
PY
}

build_plan() {
  local root="$1"
  local seed="$2"
  local mode="$3"
  local steps="$4"
  local plan="$root/$mode-plan.jsonl"
  local minimum=$(( (WRONG_OFFSET + EVAL_BATCHES + 8) * BATCH_SIZE ))
  local samples
  samples="$(plan_samples "$steps" "$BATCH_SIZE" "$minimum")"
  if [[ ! -f "$plan" ]]; then
    PYTHONPATH="$HERE" "$PYTHON" "$HERE/sidepus_training_stream.py" plan \
      --state-dir "$SIDEPUS_STATE" \
      --inventory "$SIDEPUS_INVENTORY" \
      --output "$plan" \
      --samples "$samples" \
      --sequence-length "$SEQUENCE_LENGTH" \
      --seed "$seed" \
      --render-mode "$mode" \
      --minimum-quality 0.35 \
      --require-channel utterance \
      --exclude-flag rights-blocked \
      --exclude-flag derivative-replay >/dev/null
  fi
  echo "$plan"
}

run_organism() {
  local root="$1"
  local plan="$2"
  local source="$3"
  local steps="$4"
  local bits="$5"
  local seed="$6"
  local carry="$7"
  mkdir -p "$root"
  PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True PYTHONPATH="$HERE" "$PYTHON" \
    "$HERE/train_archie_sidepus_organism.py" \
    --plan "$plan" \
    --plan-receipt "$plan.receipt.json" \
    --retention-corpus "$RETENTION_CORPUS" \
    --init-model "$source" \
    --output-dir "$root" \
    --seq-len "$SEQUENCE_LENGTH" \
    --batch-size "$BATCH_SIZE" \
    --prefetch-workers "$PREFETCH_WORKERS" \
    --max-steps "$steps" \
    --learning-rate 0.0002 \
    --language-lr-scale 0.05 \
    --freeze-language-steps "$FREEZE_STEPS" \
    --warmup-steps 200 \
    --state-quant-bits "$bits" \
    --state-aux-weight 0.35 \
    --plastic-mode delta \
    --plastic-rank 16 \
    --deliberation-max-steps 4 \
    --deliberation-ponder-weight 0.002 \
    --state-carry-policy "$carry" \
    --eval-every 100 \
    --save-every 50 \
    --log-every 5 \
    --deadline-minutes "$DEADLINE" \
    --seed "$seed"
}

evaluate_arm() {
  local root="$1"
  local plan="$2"
  PYTHONPATH="$HERE" "$PYTHON" "$HERE/evaluate_archie_sidepus_organism.py" \
    --candidate "$root/archie-sidepus-organism.pt" \
    --base-model "$BASE_MODEL" \
    --plan "$plan" \
    --plan-receipt "$plan.receipt.json" \
    --retention-corpus "$RETENTION_CORPUS" \
    --output "$root/causal-evaluation.json" \
    --batches "$EVAL_BATCHES" \
    --batch-size "$BATCH_SIZE" \
    --sequence-length "$SEQUENCE_LENGTH" \
    --wrong-offset-batches "$WRONG_OFFSET" \
    --prefetch-workers "$PREFETCH_WORKERS"
}

select_arm() {
  local root="$1"
  "$PYTHON" - "$root" <<'PY'
import json, pathlib, sys
root=pathlib.Path(sys.argv[1])
rows=[]
for arm in ("q8","q4"):
    path=root/arm/"causal-evaluation.json"
    if not path.exists(): continue
    value=json.loads(path.read_text())
    effects=value["causal"]["effects"]
    regression=value["retention"]["relative_regression"]
    score=effects["gain_vs_reset"]+effects["gain_vs_wrong"]-max(regression,0.0)
    rows.append((bool(value["passed"]),score,arm,value))
rows.sort(key=lambda x:(x[0],x[1],x[2]), reverse=True)
decision={
  "schema":"archie-sidepus-organism-discovery-decision/v1",
  "candidates":[{"arm":arm,"passed":passed,"score":score} for passed,score,arm,_ in rows],
  "selected":rows[0][2] if rows and rows[0][0] else None,
}
(root/"discovery-decision.json").write_text(json.dumps(decision,indent=2,sort_keys=True)+"\n")
print(json.dumps(decision,indent=2,sort_keys=True))
raise SystemExit(0 if decision["selected"] else 3)
PY
}

echo "Archie direct Sidepus organism campaign"
echo "  base:       $BASE_MODEL"
echo "  archive:    $SIDEPUS_STATE"
echo "  inventory:  $SIDEPUS_INVENTORY"
echo "  state:      $STATE"
echo "  export:     $EXPORT"
echo "  context:    $SEQUENCE_LENGTH"
echo "  mechanisms: recurrence + plastic fast weights + persistent Q8/Q4 state + adaptive deliberation"
echo "  controls:   $RUN_CONTROLS"

DISCOVERY="$STATE/discovery"
mkdir -p "$DISCOVERY"
MAIN_PLAN="$(build_plan "$DISCOVERY" "$DISCOVERY_SEED" multichannel "$Q8_STEPS")"

if ! phase_complete "$DISCOVERY/q8/training-receipt.json" "$Q8_STEPS"; then
  run_organism "$DISCOVERY/q8" "$MAIN_PLAN" "$BASE_MODEL" "$Q8_STEPS" 8 "$DISCOVERY_SEED" carry-with-domain-reset
fi
if ! phase_complete "$DISCOVERY/q8/training-receipt.json" "$Q8_STEPS"; then
  echo "Discovery Q8 checkpointed before completion. Run the same command again."
  exit 0
fi
if [[ ! -f "$DISCOVERY/q8/causal-evaluation.json" ]]; then
  evaluate_arm "$DISCOVERY/q8" "$MAIN_PLAN" || true
fi

if ! phase_complete "$DISCOVERY/q4/training-receipt.json" "$Q4_STEPS"; then
  run_organism "$DISCOVERY/q4" "$MAIN_PLAN" "$DISCOVERY/q8/archie-sidepus-organism.pt" "$Q4_STEPS" 4 "$DISCOVERY_SEED" carry-with-domain-reset
fi
if ! phase_complete "$DISCOVERY/q4/training-receipt.json" "$Q4_STEPS"; then
  echo "Discovery Q4 checkpointed before completion. Run the same command again."
  exit 0
fi
if [[ ! -f "$DISCOVERY/q4/causal-evaluation.json" ]]; then
  evaluate_arm "$DISCOVERY/q4" "$MAIN_PLAN" || true
fi

if [[ "$RUN_CONTROLS" == "1" ]]; then
  if ! phase_complete "$DISCOVERY/control-reset/training-receipt.json" "$Q8_STEPS"; then
    run_organism "$DISCOVERY/control-reset" "$MAIN_PLAN" "$BASE_MODEL" "$Q8_STEPS" 8 "$DISCOVERY_SEED" reset-each-window
  fi
  FLAT_PLAN="$(build_plan "$DISCOVERY" "$DISCOVERY_SEED" flattened-control "$Q8_STEPS")"
  if ! phase_complete "$DISCOVERY/control-flattened/training-receipt.json" "$Q8_STEPS"; then
    run_organism "$DISCOVERY/control-flattened" "$FLAT_PLAN" "$BASE_MODEL" "$Q8_STEPS" 8 "$DISCOVERY_SEED" carry-with-domain-reset
  fi
fi

if ! select_arm "$DISCOVERY"; then
  echo "Discovery falsified: neither Q8 nor Q4 cleared correct/reset/wrong plus retention."
  exit 3
fi
SELECTED="$("$PYTHON" -c 'import json,sys; print(json.load(open(sys.argv[1]))["selected"])' "$DISCOVERY/discovery-decision.json")"

REPLICATION="$STATE/replication"
mkdir -p "$REPLICATION"
REPLICATION_PLAN="$(build_plan "$REPLICATION" "$REPLICATION_SEED" multichannel "$Q8_STEPS")"
if ! phase_complete "$REPLICATION/q8/training-receipt.json" "$Q8_STEPS"; then
  run_organism "$REPLICATION/q8" "$REPLICATION_PLAN" "$BASE_MODEL" "$Q8_STEPS" 8 "$REPLICATION_SEED" carry-with-domain-reset
fi
if ! phase_complete "$REPLICATION/q8/training-receipt.json" "$Q8_STEPS"; then
  echo "Replication Q8 checkpointed before completion. Run the same command again."
  exit 0
fi
if [[ "$SELECTED" == "q4" ]]; then
  if ! phase_complete "$REPLICATION/q4/training-receipt.json" "$Q4_STEPS"; then
    run_organism "$REPLICATION/q4" "$REPLICATION_PLAN" "$REPLICATION/q8/archie-sidepus-organism.pt" "$Q4_STEPS" 4 "$REPLICATION_SEED" carry-with-domain-reset
  fi
  if ! phase_complete "$REPLICATION/q4/training-receipt.json" "$Q4_STEPS"; then
    echo "Replication Q4 checkpointed before completion. Run the same command again."
    exit 0
  fi
fi
if [[ ! -f "$REPLICATION/$SELECTED/causal-evaluation.json" ]]; then
  evaluate_arm "$REPLICATION/$SELECTED" "$REPLICATION_PLAN" || true
fi

"$PYTHON" - "$STATE" "$EXPORT" "$SELECTED" <<'PY'
import hashlib, json, pathlib, shutil, sys
state=pathlib.Path(sys.argv[1]); export=pathlib.Path(sys.argv[2]); arm=sys.argv[3]
discovery=json.loads((state/"discovery"/arm/"causal-evaluation.json").read_text())
replication=json.loads((state/"replication"/arm/"causal-evaluation.json").read_text())
passed=bool(discovery["passed"] and replication["passed"])
decision={
  "schema":"archie-sidepus-organism-campaign-decision/v1",
  "selected_arm":arm,
  "discovery_passed":bool(discovery["passed"]),
  "replication_passed":bool(replication["passed"]),
  "passed":passed,
  "promotion":"replicated-research-candidate" if passed else "not-replicated",
  "claim_boundary":"Replication does not establish general intelligence, admission, or 2B scale readiness.",
}
decision["receipt_digest"]=hashlib.sha256(json.dumps(decision,sort_keys=True,separators=(",",":")).encode()).hexdigest()
export.mkdir(parents=True,exist_ok=True)
(export/"decision.json").write_text(json.dumps(decision,indent=2,sort_keys=True)+"\n")
if passed:
    shutil.copy2(state/"replication"/arm/"archie-sidepus-organism.pt", export/"archie-sidepus-organism.pt")
    shutil.copy2(state/"discovery"/arm/"causal-evaluation.json", export/"discovery-evaluation.json")
    shutil.copy2(state/"replication"/arm/"causal-evaluation.json", export/"replication-evaluation.json")
print(json.dumps(decision,indent=2,sort_keys=True))
raise SystemExit(0 if passed else 4)
PY
