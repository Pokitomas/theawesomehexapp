#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
PYTHON="${ARCHIE_PYTHON:-/home/awesomekai/.venv-archie-cuda/bin/python}"
SIDEPUS_STATE="${SIDEPUS_STATE:-$HOME/sidepus-archive-v2}"
SOURCE_INVENTORY="${ARCHIE_SIDEPUS_INVENTORY:-$SIDEPUS_STATE/training-inventory.jsonl}"
SEED="${ARCHIE_SIDEPUS_SEED:-20260725}"
PROFILE="${ARCHIE_SIDEPUS_PROFILE:-full}"
STATE="${ARCHIE_SIDEPUS_PURSUIT_STATE:-$HOME/archie-sidepus-pursuit-v4-evidence-islands-$PROFILE}"

case "$PROFILE" in
  smoke)
    DEFAULT_DEV_EPISODES=8
    DEFAULT_DEV_STEPS=8
    DEFAULT_MICROPHYSICS=32
    DEFAULT_TRAINING_STEPS=100
    DEFAULT_LOOKAHEAD=16
    DEFAULT_CACHE_BYTES=1073741824
    DEFAULT_DEV_EVAL_BATCHES=6
    DEFAULT_ADMISSION_EVAL_BATCHES=12
    DEFAULT_DEV_WRONG_OFFSET=9
    DEFAULT_ADMISSION_WRONG_OFFSET=17
    MIN_FREE_KIB=3145728
    ;;
  full)
    # 81,920 deterministic non-microphysics records before inherited and remote inventory.
    DEFAULT_DEV_EPISODES=512
    DEFAULT_DEV_STEPS=32
    DEFAULT_MICROPHYSICS=4096
    DEFAULT_TRAINING_STEPS=30000
    DEFAULT_LOOKAHEAD=256
    DEFAULT_CACHE_BYTES=17179869184
    DEFAULT_DEV_EVAL_BATCHES=16
    DEFAULT_ADMISSION_EVAL_BATCHES=48
    DEFAULT_DEV_WRONG_OFFSET=21
    DEFAULT_ADMISSION_WRONG_OFFSET=53
    MIN_FREE_KIB=23068672
    ;;
  *)
    echo "Unknown ARCHIE_SIDEPUS_PROFILE=$PROFILE (expected smoke or full)" >&2
    exit 2
    ;;
esac

DEV_EPISODES="${ARCHIE_SIDEPUS_DEVELOPMENTAL_EPISODES_PER_DOMAIN:-$DEFAULT_DEV_EPISODES}"
DEV_STEPS="${ARCHIE_SIDEPUS_DEVELOPMENTAL_STEPS:-$DEFAULT_DEV_STEPS}"
export ARCHIE_SIDEPUS_PURSUIT_STATE="$STATE"
export ARCHIE_SIDEPUS_PURSUIT_EXPORT="${ARCHIE_SIDEPUS_PURSUIT_EXPORT:-$REPO_ROOT/returns/sidepus-pursuit-v4-evidence-islands-$PROFILE}"
export ARCHIE_SIDEPUS_CACHE_DIR="${ARCHIE_SIDEPUS_CACHE_DIR:-$HOME/sidepus-ephemeral-cache-v4-evidence-islands-$PROFILE}"
export ARCHIE_SIDEPUS_MICROPHYSICS_EPISODES="${ARCHIE_SIDEPUS_MICROPHYSICS_EPISODES:-$DEFAULT_MICROPHYSICS}"
export ARCHIE_SIDEPUS_PURSUIT_STEPS="${ARCHIE_SIDEPUS_PURSUIT_STEPS:-$DEFAULT_TRAINING_STEPS}"
export ARCHIE_SIDEPUS_PURSUIT_LOOKAHEAD="${ARCHIE_SIDEPUS_PURSUIT_LOOKAHEAD:-$DEFAULT_LOOKAHEAD}"
export ARCHIE_SIDEPUS_CACHE_BYTES="${ARCHIE_SIDEPUS_CACHE_BYTES:-$DEFAULT_CACHE_BYTES}"
export ARCHIE_SIDEPUS_DEV_EVAL_BATCHES="${ARCHIE_SIDEPUS_DEV_EVAL_BATCHES:-$DEFAULT_DEV_EVAL_BATCHES}"
export ARCHIE_SIDEPUS_ADMISSION_EVAL_BATCHES="${ARCHIE_SIDEPUS_ADMISSION_EVAL_BATCHES:-$DEFAULT_ADMISSION_EVAL_BATCHES}"
export ARCHIE_SIDEPUS_DEV_WRONG_OFFSET="${ARCHIE_SIDEPUS_DEV_WRONG_OFFSET:-$DEFAULT_DEV_WRONG_OFFSET}"
export ARCHIE_SIDEPUS_ADMISSION_WRONG_OFFSET="${ARCHIE_SIDEPUS_ADMISSION_WRONG_OFFSET:-$DEFAULT_ADMISSION_WRONG_OFFSET}"

[[ -x "$PYTHON" ]] || { echo "Missing Archie Python: $PYTHON" >&2; exit 1; }
[[ -f "$SOURCE_INVENTORY" ]] || { echo "Missing source inventory: $SOURCE_INVENTORY" >&2; exit 1; }
if ! "$PYTHON" -c 'import numpy, torch; raise SystemExit(0 if torch.cuda.is_available() else 1)'; then
  echo "Required Python packages or CUDA are unavailable in $PYTHON" >&2
  exit 1
fi
FREE_KIB="$(df -Pk "$HOME" | awk 'NR==2 {print $4}')"
if [[ "$FREE_KIB" -lt "$MIN_FREE_KIB" && "${ARCHIE_ALLOW_LOW_DISK:-0}" != "1" ]]; then
  echo "Insufficient free disk for $PROFILE profile: ${FREE_KIB} KiB available; ${MIN_FREE_KIB} KiB required" >&2
  exit 1
fi

# Fail before corpus work if token-local thought or evidence splitting has regressed.
PYTHONPATH="$HERE" "$PYTHON" -m unittest -q \
  test_sidepus_causality.SidepusCausalityCourt \
  test_sidepus_evidence_islands.SidepusEvidenceIslandTest

mkdir -p "$STATE/corpus"
DEV_INVENTORY="$STATE/corpus/developmental-inventory-$PROFILE.jsonl"
PREPARED_INVENTORY="$STATE/corpus/prepared-source-inventory-$PROFILE.jsonl"

PYTHONPATH="$HERE" "$PYTHON" "$HERE/sidepus_developmental_corpus.py" \
  --state-dir "$SIDEPUS_STATE" \
  --output "$DEV_INVENTORY" \
  --episodes-per-domain "$DEV_EPISODES" \
  --steps "$DEV_STEPS" \
  --seed "$SEED"

PYTHONPATH="$HERE" "$PYTHON" "$HERE/sidepus_inventory_union.py" \
  --inventory "$SOURCE_INVENTORY" \
  --inventory "$DEV_INVENTORY" \
  --output "$PREPARED_INVENTORY"

"$PYTHON" - "$PREPARED_INVENTORY" "$PROFILE" "$DEV_EPISODES" "$DEV_STEPS" <<'PY'
import collections, json, pathlib, sys
path = pathlib.Path(sys.argv[1])
profile = sys.argv[2]
expected_dev_records = 5 * int(sys.argv[3]) * int(sys.argv[4])
counts = collections.Counter()
records = 0
sequences = set()
visible_bytes = 0
for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
    if not line.strip():
        continue
    row = json.loads(line)
    records += 1
    counts[str(row.get("domain", "unknown"))] += 1
    visible_bytes += int(row.get("bytes", 0))
    if row.get("sequence_id"):
        sequences.add(str(row["sequence_id"]))
required = {"formal_executable", "empirical_world", "language_expression", "social_institutional", "adversarial_messy"}
missing = sorted(required - set(counts))
if missing:
    raise SystemExit(f"Prepared corpus lacks required developmental domains: {missing}")
if records < expected_dev_records or len(sequences) < 5 * int(sys.argv[3]):
    raise SystemExit(f"Prepared corpus is incomplete: records={records}, sequences={len(sequences)}, expected_dev_records={expected_dev_records}")
summary = {
    "profile": profile,
    "records": records,
    "sequences": len(sequences),
    "visible_bytes": visible_bytes,
    "domains": dict(sorted(counts.items())),
}
print(json.dumps(summary, indent=2))
(path.parent / f"corpus-preflight-{profile}.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
PY

export ARCHIE_SIDEPUS_INVENTORY="$PREPARED_INVENTORY"
echo "Launching Sidepus evidence-island profile=$PROFILE steps=$ARCHIE_SIDEPUS_PURSUIT_STEPS lookahead=$ARCHIE_SIDEPUS_PURSUIT_LOOKAHEAD microphysics=$ARCHIE_SIDEPUS_MICROPHYSICS_EPISODES"
exec "$HERE/run_archie_sidepus_pursuit.sh"
