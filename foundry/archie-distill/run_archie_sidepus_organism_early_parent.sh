#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PYTHON="${ARCHIE_PYTHON:-/home/awesomekai/.venv-archie-cuda/bin/python}"
CANONICAL="$HERE/run_archie_sidepus_organism.sh"

BASE_STATE="${ARCHIE_114M_STATE:-/home/awesomekai/archie-base-114m-v1}"
BASE_MODEL="${ARCHIE_SIDEPUS_BASE_MODEL:-$REPO_ROOT/returns/generative-114m/archie-hybrid-114m.pt}"
BASE_RECEIPT="${ARCHIE_SIDEPUS_BASE_RECEIPT:-$REPO_ROOT/returns/generative-114m/training-receipt.json}"
MINIMUM_STEP="${ARCHIE_SIDEPUS_PARTIAL_PARENT_MIN_STEP:-15000}"

require_file() {
  [[ -f "$1" ]] || { echo "Missing required file: $1" >&2; exit 1; }
}

require_file "$CANONICAL"
require_file "$BASE_MODEL"
require_file "$BASE_RECEIPT"
if [[ ! -x "$PYTHON" ]]; then
  echo "Missing Python: $PYTHON" >&2
  exit 1
fi

ACTIVE="$(pgrep -af '([t]rain_archie|[r]esearch_archie|[n]p_transformer|[t]rain_causal)' || true)"
if [[ -n "$ACTIVE" && "${ARCHIE_ALLOW_CONCURRENT_GPU:-0}" != "1" ]]; then
  echo "Another Archie training process is active; refusing to snapshot or split the GPU:" >&2
  echo "$ACTIVE" >&2
  exit 2
fi

read -r BASE_STEP BASE_MAXIMUM BASE_STOP_REASON <<<"$("$PYTHON" - "$BASE_RECEIPT" <<'PY'
import json, pathlib, sys
receipt = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
opt = receipt.get("optimization", {})
training = receipt.get("training", {})
step = int(opt.get("step", training.get("step", -1)))
maximum = int(opt.get("max_steps", opt.get("maximum_steps", -1)))
stop = str(opt.get("stop_reason", training.get("stop_reason", "unknown"))).replace(" ", "_")
print(step, maximum, stop)
PY
)"

if (( BASE_STEP < 0 || BASE_MAXIMUM <= 0 )); then
  echo "Base receipt does not expose a valid step/max_steps pair." >&2
  exit 3
fi

if (( BASE_STEP >= BASE_MAXIMUM )); then
  echo "The parent is complete at step $BASE_STEP/$BASE_MAXIMUM; using the canonical launcher."
  exec bash "$CANONICAL"
fi

if (( BASE_STEP < MINIMUM_STEP )); then
  echo "Early-parent campaign requires at least step $MINIMUM_STEP; current parent is $BASE_STEP/$BASE_MAXIMUM." >&2
  exit 3
fi

STATE="${ARCHIE_SIDEPUS_ORGANISM_STATE:-$HOME/archie-sidepus-organism-early-step-$BASE_STEP}"
EXPORT="${ARCHIE_SIDEPUS_ORGANISM_EXPORT:-$REPO_ROOT/returns/sidepus-organism-early-step-$BASE_STEP}"
SNAPSHOT="$STATE/parent-snapshot"
SNAPSHOT_MODEL="$SNAPSHOT/archie-hybrid-114m-step-$BASE_STEP.pt"
SNAPSHOT_RECEIPT="$SNAPSHOT/training-receipt-step-$BASE_STEP.json"
SNAPSHOT_DECISION="$SNAPSHOT/early-parent-decision.json"
mkdir -p "$SNAPSHOT" "$EXPORT"

if [[ ! -f "$SNAPSHOT_DECISION" ]]; then
  MODEL_TMP="$SNAPSHOT_MODEL.tmp.$$"
  RECEIPT_TMP="$SNAPSHOT_RECEIPT.tmp.$$"
  if ! cp --reflink=auto "$BASE_MODEL" "$MODEL_TMP" 2>/dev/null; then
    cp "$BASE_MODEL" "$MODEL_TMP"
  fi
  cp "$BASE_RECEIPT" "$RECEIPT_TMP"
  mv "$MODEL_TMP" "$SNAPSHOT_MODEL"
  mv "$RECEIPT_TMP" "$SNAPSHOT_RECEIPT"

  "$PYTHON" - "$BASE_MODEL" "$BASE_RECEIPT" "$SNAPSHOT_MODEL" "$SNAPSHOT_RECEIPT" \
    "$SNAPSHOT_DECISION" "$BASE_STEP" "$BASE_MAXIMUM" "$BASE_STOP_REASON" <<'PY'
import hashlib, json, pathlib, sys

def sha(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1 << 20):
            digest.update(block)
    return digest.hexdigest()

source_model, source_receipt, snapshot_model, snapshot_receipt, output = map(pathlib.Path, sys.argv[1:6])
step, maximum, stop_reason = int(sys.argv[6]), int(sys.argv[7]), sys.argv[8]
source_model_sha = sha(source_model)
snapshot_model_sha = sha(snapshot_model)
source_receipt_sha = sha(source_receipt)
snapshot_receipt_sha = sha(snapshot_receipt)
if source_model_sha != snapshot_model_sha or source_receipt_sha != snapshot_receipt_sha:
    raise SystemExit("early-parent snapshot differs from source files")
value = {
    "schema": "archie-sidepus-early-parent-decision/v1",
    "parent_status": "partial",
    "parent_step": step,
    "parent_maximum_steps": maximum,
    "parent_stop_reason": stop_reason,
    "source_model": str(source_model.resolve()),
    "source_model_sha256": source_model_sha,
    "source_receipt": str(source_receipt.resolve()),
    "source_receipt_sha256": source_receipt_sha,
    "snapshot_model": str(snapshot_model.resolve()),
    "snapshot_model_sha256": snapshot_model_sha,
    "snapshot_receipt": str(snapshot_receipt.resolve()),
    "snapshot_receipt_sha256": snapshot_receipt_sha,
    "campaign_class": "full-radical-early-parent",
    "canonical_comparison_required": True,
    "claim_boundary": (
        "This campaign may test the complete Sidepus organism from a useful but unfinished "
        "language parent. It cannot replace the later 30000-step canonical-parent campaign."
    ),
}
body = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
value["receipt_digest"] = hashlib.sha256(body).hexdigest()
output.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
  chmod a-w "$SNAPSHOT_MODEL" "$SNAPSHOT_RECEIPT" "$SNAPSHOT_DECISION" 2>/dev/null || true
else
  "$PYTHON" - "$SNAPSHOT_DECISION" "$SNAPSHOT_MODEL" "$SNAPSHOT_RECEIPT" "$BASE_STEP" <<'PY'
import hashlib, json, pathlib, sys

def sha(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1 << 20):
            digest.update(block)
    return digest.hexdigest()

decision_path, model_path, receipt_path = map(pathlib.Path, sys.argv[1:4])
expected_step = int(sys.argv[4])
value = json.loads(decision_path.read_text(encoding="utf-8"))
if value.get("schema") != "archie-sidepus-early-parent-decision/v1":
    raise SystemExit("unsupported early-parent decision")
if int(value.get("parent_step", -1)) != expected_step:
    raise SystemExit("early-parent snapshot step differs from requested parent")
if sha(model_path) != value.get("snapshot_model_sha256"):
    raise SystemExit("early-parent model snapshot digest mismatch")
if sha(receipt_path) != value.get("snapshot_receipt_sha256"):
    raise SystemExit("early-parent receipt snapshot digest mismatch")
PY
fi

TEMP_LAUNCHER="$(mktemp "$HERE/.sidepus-early-parent.XXXXXX.sh")"
cleanup() { rm -f "$TEMP_LAUNCHER"; }
trap cleanup EXIT

"$PYTHON" - "$CANONICAL" "$TEMP_LAUNCHER" <<'PY'
import pathlib, sys
source, output = map(pathlib.Path, sys.argv[1:3])
text = source.read_text(encoding="utf-8")
old = '''if ! base_complete; then
  echo "The 114M language parent is not complete. Keep the current run alive and rerun this campaign later." >&2
  exit 3
fi
'''
new = '''if ! base_complete; then
  if [[ "${ARCHIE_ALLOW_PARTIAL_PARENT:-0}" != "1" ]]; then
    echo "The 114M language parent is not complete. Keep the current run alive and rerun this campaign later." >&2
    exit 3
  fi
  echo "EARLY-PARENT MODE: running the full radical campaign from an immutable partial-parent snapshot." >&2
fi
'''
if text.count(old) != 1:
    raise SystemExit("canonical launcher completion gate changed; refusing unsafe patch")
output.write_text(text.replace(old, new), encoding="utf-8")
PY
chmod +x "$TEMP_LAUNCHER"

echo "Archie Sidepus full radical early-parent campaign"
echo "  parent:     step $BASE_STEP / $BASE_MAXIMUM ($BASE_STOP_REASON)"
echo "  snapshot:   $SNAPSHOT_MODEL"
echo "  state:      $STATE"
echo "  export:     $EXPORT"
echo "  status:     research-only early-parent; later 30000-step comparison remains required"

set +e
ARCHIE_ALLOW_PARTIAL_PARENT=1 \
ARCHIE_SIDEPUS_BASE_MODEL="$SNAPSHOT_MODEL" \
ARCHIE_SIDEPUS_BASE_RECEIPT="$SNAPSHOT_RECEIPT" \
ARCHIE_SIDEPUS_ORGANISM_STATE="$STATE" \
ARCHIE_SIDEPUS_ORGANISM_EXPORT="$EXPORT" \
bash "$TEMP_LAUNCHER"
STATUS=$?
set -e
exit "$STATUS"
