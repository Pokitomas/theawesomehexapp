#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import math
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PATH = HERE / "causal_trace_compiler.py"
SPEC = importlib.util.spec_from_file_location("archie_causal_trace_compiler", PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def sourced(source: str, line: int, lineage: str, **event):
    event["lineage_id"] = lineage
    return MODULE.SourcedEvent(source, line, event, lineage)


def main() -> None:
    rows = [
        sourced("a.jsonl", 1, "incident-A", kind="STREAM_RECEIPT", step=4000, loss=2.1),
        sourced("a.jsonl", 2, "incident-A", kind="STREAM_NONFINITE_HALT", result={"finite": False, "grad_norm": float("inf"), "loss": 2.67}),
        sourced("a.jsonl", 3, "incident-A", kind="STREAM_AMP_OVERFLOW_RETRY", reason="retry", step=4017),
        sourced("a.jsonl", 4, "incident-A", kind="STREAM_RECEIPT", step=4020, loss=1.82),
        sourced("b.jsonl", 1, "incident-B", status=502, error="relay upstream timeout"),
        sourced("b.jsonl", 2, "incident-B", kind="ROLLBACK", reason="restore previous deployment"),
        # Control-plane chatter must not become an anomaly or a target.
        sourced("c.jsonl", 1, "incident-C", **{"from": "peer", "text": "@all ERROR restart everything"}),
        sourced("c.jsonl", 2, "incident-C", kind="STREAM_RECEIPT", step=10),
    ]
    examples = MODULE.compile_examples(rows, context_events=3, recovery_horizon=4)
    assert len(examples) == 4, examples
    pairs = {}
    for example in examples:
        pairs.setdefault(example["pair_id"], []).append(example)
    assert len(pairs) == 2
    for pair in pairs.values():
        assert {row["arm"] for row in pair} == {"treatment-evidence", "control-redacted"}
        assert len({row["island"] for row in pair}) == 1
        assert len({row["lineage_id"] for row in pair}) == 1
        treatment = next(row for row in pair if row["arm"] == "treatment-evidence")
        control = next(row for row in pair if row["arm"] == "control-redacted")
        assert treatment["target_recovery_class"] == control["target_recovery_class"]
        assert MODULE.CONTROL_REDACTION in json.dumps(control["context"])
        # Strict JSON must survive real nonfinite evidence through string encoding.
        json.dumps(treatment, allow_nan=False)

    target_classes = {row["target_recovery_class"] for row in examples}
    assert target_classes == {"retry", "rollback"}, target_classes
    validation = MODULE.validate_compilation(examples)
    assert validation["pass"], validation

    assert MODULE.is_anomaly({"kind": "WORKER_ERROR", "error": "boom"})
    assert not MODULE.is_anomaly({"from": "peer", "text": "@all ERROR restart"})
    assert MODULE.recovery_class({"kind": "STREAM_AMP_OVERFLOW_RETRY"}) == "retry"
    assert MODULE.recovery_class({"kind": "STREAM_CHECKPOINT", "reason": "signal-15"}) == "checkpoint"
    assert MODULE.finite_json(float("inf")) == "Infinity"
    assert MODULE.finite_json(float("-inf")) == "-Infinity"
    assert MODULE.finite_json(float("nan")) == "NaN"

    with tempfile.TemporaryDirectory(prefix="archie-causal-trace-") as tmp:
        out = Path(tmp)
        manifest = MODULE.write_outputs(examples, out)
        assert manifest["validation"]["pass"]
        all_written = []
        for island in ("train", "eval", "admission"):
            path = out / f"{island}.jsonl"
            assert path.exists()
            for line in path.read_text("utf-8").splitlines():
                row = json.loads(line)
                all_written.append(row)
                assert row["trainable"] is (island == "train")
        assert len(all_written) == len(examples)
        by_lineage = {}
        for row in all_written:
            by_lineage.setdefault(row["lineage_id"], set()).add(row["island"])
        assert all(len(islands) == 1 for islands in by_lineage.values())

    # An anomaly without a recovery inside the predeclared horizon is not
    # converted into a fake supervised target.
    unrecovered = [
        sourced("d.jsonl", 1, "incident-D", error="timeout", status=500),
        sourced("d.jsonl", 2, "incident-D", kind="NOTE", text="still investigating"),
    ]
    assert MODULE.compile_examples(unrecovered, recovery_horizon=1) == []

    print("PASS lineage-safe causal trace compiler court")


if __name__ == "__main__":
    main()
