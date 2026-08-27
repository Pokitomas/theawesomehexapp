from __future__ import annotations

import copy
import hashlib
import json
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from core import canonical, receipt, verify_receipt
from video_editor import EditOp, Project as BaseProject, Timebase


class Project(BaseProject):
    """Frame-exact editor core with a receipt for every mutation."""

    def _apply(self, kind: str, args: dict[str, Any], fn) -> dict[str, Any]:
        before = self.snapshot()
        fn()
        self._validate()
        after = self.snapshot()
        op = EditOp(uuid.uuid4().hex, kind, copy.deepcopy(args), before, after)
        self.history.append(op)
        self.redo_stack.clear()
        return receipt("editor.edit", {
            "op_id": op.id,
            "op": kind,
            "before_sha256": hashlib.sha256(canonical(before)).hexdigest(),
            "after_sha256": hashlib.sha256(canonical(after)).hexdigest(),
            "history_depth": len(self.history),
        })


def benchmark(iterations: int = 1000) -> dict[str, Any]:
    iterations = max(10, int(iterations))
    p = Project(name="court", timebase=Timebase(24000, 1001))
    first = p.add_clip("V1", "synthetic.mov", 0, 24_000, 0, clip_id="c0")
    start = time.perf_counter_ns()
    mutation_receipts_valid = verify_receipt(first)
    for i in range(iterations):
        r = p.set_gain("V1", "c0", 1.0 + (i % 7) * 0.01)
        mutation_receipts_valid = mutation_receipts_valid and verify_receipt(r)
    elapsed_ns = time.perf_counter_ns() - start
    snap = canonical(p.snapshot())

    q = Project(name="court", timebase=Timebase(24000, 1001))
    q.add_clip("V1", "synthetic.mov", 0, 24_000, 0, clip_id="c0")
    for i in range(iterations):
        q.set_gain("V1", "c0", 1.0 + (i % 7) * 0.01)

    probes = (0, 1, 23, 24, 24000)
    times = [p.timebase.seconds_at_frame(x) for x in probes]
    return receipt("editor.benchmark.v2", {
        "iterations": iterations,
        "elapsed_ns": elapsed_ns,
        "ops_per_s": iterations / max(1e-12, elapsed_ns / 1e9),
        "deterministic_replay": snap == canonical(q.snapshot()),
        "exact_frame_roundtrip": [p.timebase.frame_at_seconds(x) for x in times] == list(probes),
        "mutation_receipts_valid": mutation_receipts_valid,
        "history_depth": len(p.history),
    })


def court() -> dict[str, Any]:
    p = Project(name="video-court", timebase=Timebase(24, 1))
    add = p.add_clip("V1", "a.mov", 0, 240, 0, clip_id="a")
    split = p.split("V1", "a", 120)
    before_undo = canonical(p.snapshot())
    undo = p.undo()
    redo = p.redo()
    after_redo = canonical(p.snapshot())
    with tempfile.TemporaryDirectory(prefix="archie-edit-") as td:
        path = Path(td) / "project.json"
        save = p.save(path)
        loaded = Project.load(path)
        portable = canonical(loaded.snapshot()) == canonical(p.snapshot())
    bench = benchmark(750)
    return receipt("editor.court.v2", {
        "add_receipt": verify_receipt(add),
        "split_receipt": verify_receipt(split),
        "undo_receipt": verify_receipt(undo) and bool(undo["payload"]["ok"]),
        "redo_receipt": verify_receipt(redo) and bool(redo["payload"]["ok"]),
        "redo_exact": before_undo == after_redo,
        "portable_roundtrip": portable,
        "save_receipt": verify_receipt(save),
        "benchmark": bench["payload"],
    })


if __name__ == "__main__":
    print(json.dumps(court(), indent=2, default=str))
