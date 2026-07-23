#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${ARCHIE_PYTHON:-/home/awesomekai/.venv-archie-cuda/bin/python}"
SIDEPUS_STATE="${SIDEPUS_STATE:-$HOME/sidepus-archive-v2}"
STATE="${ARCHIE_SIDEPUS_PURSUIT_STATE:-$HOME/archie-sidepus-pursuit-v2}"
SOURCE_INVENTORY="${ARCHIE_SIDEPUS_INVENTORY:-$SIDEPUS_STATE/training-inventory.jsonl}"
DEV_EPISODES="${ARCHIE_SIDEPUS_DEVELOPMENTAL_EPISODES_PER_DOMAIN:-128}"
DEV_STEPS="${ARCHIE_SIDEPUS_DEVELOPMENTAL_STEPS:-16}"
SEED="${ARCHIE_SIDEPUS_SEED:-20260725}"

[[ -x "$PYTHON" ]] || { echo "Missing Archie Python: $PYTHON" >&2; exit 1; }
[[ -f "$SOURCE_INVENTORY" ]] || { echo "Missing source inventory: $SOURCE_INVENTORY" >&2; exit 1; }
mkdir -p "$STATE/corpus"
DEV_INVENTORY="$STATE/corpus/developmental-inventory.jsonl"
PREPARED_INVENTORY="$STATE/corpus/prepared-source-inventory.jsonl"

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

"$PYTHON" - "$PREPARED_INVENTORY" <<'PY'
import collections, json, pathlib, sys
path = pathlib.Path(sys.argv[1])
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
if records < 100 or len(sequences) < 10 or visible_bytes < 4096:
    raise SystemExit(f"Prepared corpus is too small: records={records} sequences={len(sequences)} visible_bytes={visible_bytes}")
print(json.dumps({"records": records, "sequences": len(sequences), "visible_bytes": visible_bytes, "domains": dict(sorted(counts.items()))}, indent=2))
PY

export ARCHIE_SIDEPUS_INVENTORY="$PREPARED_INVENTORY"
exec "$HERE/run_archie_sidepus_pursuit.sh"
