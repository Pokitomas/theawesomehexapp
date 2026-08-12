#!/usr/bin/env python3
"""Compile raw work traces into treatment/control belief-revision examples.

The unit of data is not polished prose. It is an incident lineage containing an
observable anomaly followed by a later recovery action.  For every example we
emit two twins:

* treatment: the recent structured evidence is preserved;
* control:   the anomaly payload is redacted while timing/order is preserved.

Whole lineages are assigned atomically to train/eval/admission so twins and
near-duplicate incidents cannot leak across islands.  The admission island is
compiled but is not a training source.

This compiler intentionally predicts a coarse recovery *class*, not Bash/Python
spelling.  It is a corpus court for whether causal evidence changes action
selection, not a claim that the system has learned belief revision.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

SCHEMA = "archie/causal-trace-compiler-v1"
EXAMPLE_SCHEMA = "archie/causal-revision-example-v1"
CONTROL_REDACTION = "<ANOMALY_EVIDENCE_REDACTED>"

ANOMALY_RE = re.compile(
    r"(?:\berror\b|\bfail(?:ed|ure)?\b|\bhalt\b|\bnonfinite\b|\binf(?:inity)?\b|"
    r"\boverflow\b|\bmismatch\b|\btimeout\b|\brefus(?:e|ed|al)\b|\b[45]\d\d\b)",
    re.IGNORECASE,
)

RECOVERY_CLASSES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("retry", re.compile(r"retry|backoff|requeue", re.I)),
    ("rollback", re.compile(r"rollback|restore|revert", re.I)),
    ("checkpoint", re.compile(r"checkpoint|save[_ -]?state", re.I)),
    ("restart", re.compile(r"restart|start(?:ed)?\b|resume(?:d)?\b", re.I)),
    ("refuse", re.compile(r"refuse|blocked|fail[-_ ]?closed", re.I)),
    ("repair", re.compile(r"patch|repair|fix(?:ed)?\b", re.I)),
    ("continue", re.compile(r"receipt|pass\b|proceed|advance|continued?", re.I)),
    ("stop", re.compile(r"\bstop(?:ped)?\b|signal-?15|sigterm", re.I)),
)

CONTROL_PREFIX_RE = re.compile(r"^@(all|gpt|archie|claude|peer|codex)\b", re.I)


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


def event_text(event: dict[str, Any]) -> str:
    pieces: list[str] = []
    for key in ("kind", "status", "phase", "reason", "error", "text", "message"):
        value = event.get(key)
        if value is not None:
            pieces.append(f"{key}={value}")
    result = event.get("result")
    if isinstance(result, dict):
        for key in ("finite", "loss", "grad_norm", "error", "status"):
            if key in result:
                pieces.append(f"result.{key}={result[key]}")
    return " | ".join(pieces)


def is_control_chatter(event: dict[str, Any]) -> bool:
    text = str(event.get("text") or event.get("message") or "").strip()
    return bool(text and CONTROL_PREFIX_RE.match(text))


def is_anomaly(event: dict[str, Any]) -> bool:
    if is_control_chatter(event):
        return False
    if event.get("ok") is False or event.get("finite") is False:
        return True
    result = event.get("result")
    if isinstance(result, dict) and result.get("finite") is False:
        return True
    return bool(ANOMALY_RE.search(event_text(event)))


def recovery_class(event: dict[str, Any]) -> str | None:
    if is_control_chatter(event):
        return None
    text = event_text(event)
    for name, pattern in RECOVERY_CLASSES:
        if pattern.search(text):
            return name
    return None


def lineage_id(event: dict[str, Any], source: str) -> str:
    for key in ("lineage_id", "incident_id", "session_id", "run_id", "trace_id"):
        value = event.get(key)
        if value not in (None, ""):
            return str(value)
    # A source file is a conservative lineage boundary when the raw event has
    # no explicit incident/session identity. We do not synthesize per-row IDs,
    # because that would permit adjacent events from one incident to leak.
    return f"source:{source}"


def island_for(lineage: str) -> str:
    bucket = int(hashlib.sha256(lineage.encode("utf-8")).hexdigest()[:8], 16) % 100
    if bucket < 72:
        return "train"
    if bucket < 90:
        return "eval"
    return "admission"


def finite_json(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        if math.isnan(value):
            return "NaN"
        return "Infinity" if value > 0 else "-Infinity"
    if isinstance(value, dict):
        return {str(k): finite_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [finite_json(v) for v in value]
    return value


def compact_event(event: dict[str, Any]) -> dict[str, Any]:
    keep = (
        "t", "time_unix", "t_ns", "from", "actor", "kind", "status", "phase",
        "reason", "ok", "finite", "step", "tokens_seen", "error", "result",
        "stream", "text", "message",
    )
    compact = {key: finite_json(event[key]) for key in keep if key in event}
    return compact


def redact_anomaly(event: dict[str, Any]) -> dict[str, Any]:
    redacted = compact_event(event)
    for key in ("error", "result", "stream", "text", "message", "reason", "status", "kind"):
        if key in redacted:
            redacted[key] = CONTROL_REDACTION
    redacted["anomaly_present"] = True
    return redacted


@dataclass
class SourcedEvent:
    source: str
    line: int
    event: dict[str, Any]
    lineage: str


def read_jsonl(paths: Iterable[Path]) -> list[SourcedEvent]:
    rows: list[SourcedEvent] = []
    for path in paths:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line_no, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict):
                    continue
                source = str(path.resolve())
                rows.append(SourcedEvent(source, line_no, event, lineage_id(event, source)))
    return rows


def compile_examples(
    rows: list[SourcedEvent], *, context_events: int = 8, recovery_horizon: int = 24
) -> list[dict[str, Any]]:
    if context_events < 1 or recovery_horizon < 1:
        raise ValueError("context_events and recovery_horizon must be positive")
    grouped: dict[str, list[SourcedEvent]] = defaultdict(list)
    for row in rows:
        grouped[row.lineage].append(row)

    examples: list[dict[str, Any]] = []
    for lineage, events in sorted(grouped.items()):
        for index, row in enumerate(events):
            if not is_anomaly(row.event):
                continue
            target: str | None = None
            target_index: int | None = None
            for j in range(index + 1, min(len(events), index + 1 + recovery_horizon)):
                candidate = recovery_class(events[j].event)
                if candidate is not None:
                    target = candidate
                    target_index = j
                    break
            if target is None or target_index is None:
                continue

            prefix_start = max(0, index - context_events + 1)
            prefix_rows = events[prefix_start : index + 1]
            treatment_context = [compact_event(item.event) for item in prefix_rows]
            control_context = treatment_context[:-1] + [redact_anomaly(row.event)]
            base = {
                "schema": EXAMPLE_SCHEMA,
                "lineage_id": lineage,
                "island": island_for(lineage),
                "source": row.source,
                "anomaly_line": row.line,
                "recovery_line": events[target_index].line,
                "recovery_distance_events": target_index - index,
                "target_recovery_class": target,
            }
            incident_key = canonical({
                "lineage": lineage,
                "source": row.source,
                "anomaly_line": row.line,
                "target": target,
            })
            pair_id = sha256_text(incident_key)[:20]
            examples.append({
                **base,
                "pair_id": pair_id,
                "arm": "treatment-evidence",
                "context": treatment_context,
            })
            examples.append({
                **base,
                "pair_id": pair_id,
                "arm": "control-redacted",
                "context": control_context,
            })
    return examples


def validate_compilation(examples: list[dict[str, Any]]) -> dict[str, Any]:
    pairs: dict[str, list[dict[str, Any]]] = defaultdict(list)
    lineages: dict[str, set[str]] = defaultdict(set)
    targets = Counter()
    for example in examples:
        pairs[str(example["pair_id"])].append(example)
        lineages[str(example["lineage_id"])].add(str(example["island"]))
        targets[str(example["target_recovery_class"])] += 1

    bad_pairs = [pair for pair, rows in pairs.items() if sorted(r["arm"] for r in rows) != ["control-redacted", "treatment-evidence"]]
    leaked_lineages = [lineage for lineage, islands in lineages.items() if len(islands) != 1]
    admission_trainable = [e["pair_id"] for e in examples if e["island"] == "admission" and e.get("trainable") is True]
    return {
        "pair_count": len(pairs),
        "example_count": len(examples),
        "lineage_count": len(lineages),
        "bad_pair_count": len(bad_pairs),
        "lineage_leak_count": len(leaked_lineages),
        "admission_trainable_count": len(admission_trainable),
        "target_histogram": dict(sorted(targets.items())),
        "pass": not bad_pairs and not leaked_lineages and not admission_trainable,
    }


def write_outputs(examples: list[dict[str, Any]], output: Path) -> dict[str, Any]:
    output.mkdir(parents=True, exist_ok=True)
    handles = {name: (output / f"{name}.jsonl").open("w", encoding="utf-8") for name in ("train", "eval", "admission")}
    counts = Counter()
    try:
        for example in examples:
            island = str(example["island"])
            record = dict(example)
            record["trainable"] = island == "train"
            handles[island].write(canonical(record) + "\n")
            counts[island] += 1
    finally:
        for handle in handles.values():
            handle.close()

    validation = validate_compilation([
        {**example, "trainable": example["island"] == "train"} for example in examples
    ])
    manifest = {
        "schema": SCHEMA,
        "counts": {name: counts[name] for name in ("train", "eval", "admission")},
        "validation": validation,
        "claim_boundary": (
            "This corpus tests whether structured causal evidence improves prediction of a coarse recovery class. "
            "It does not establish autonomous diagnosis, planning, or general belief revision."
        ),
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", "utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("inputs", nargs="+")
    parser.add_argument("--output", required=True)
    parser.add_argument("--context-events", type=int, default=8)
    parser.add_argument("--recovery-horizon", type=int, default=24)
    args = parser.parse_args()
    paths = [Path(value).expanduser().resolve() for value in args.inputs]
    rows = read_jsonl(paths)
    examples = compile_examples(rows, context_events=args.context_events, recovery_horizon=args.recovery_horizon)
    manifest = write_outputs(examples, Path(args.output).expanduser().resolve())
    print(json.dumps(manifest, indent=2, sort_keys=True))
    raise SystemExit(0 if manifest["validation"]["pass"] else 1)


if __name__ == "__main__":
    main()
