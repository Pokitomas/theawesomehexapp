#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PATH = HERE / "homeostatic_surprise_memory.py"
SPEC = importlib.util.spec_from_file_location("archie_homeostatic_surprise_memory", PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def expect_raises(fn, exc_type):
    try:
        fn()
    except exc_type:
        return
    raise AssertionError(f"expected {exc_type.__name__}")


def main() -> None:
    result = MODULE.run_developmental_court(5602)
    assert result["pass"], result
    assert result["stable_final_surprise"] < result["stable_initial_surprise"]
    assert result["shift_final_surprise"] < result["shift_initial_surprise"]
    assert math.isclose(result["fast_norm_after_shock"], 4.0, rel_tol=0.0, abs_tol=1e-9)
    assert result["snapshot_restore_max_abs_error"] == 0.0

    memory = MODULE.HomeostaticSurpriseMemory(MODULE.MemoryConfig(dim=2))
    low = memory.observe([1.0, 0.0], [0.01, 0.0])
    high = memory.observe([0.0, 1.0], [0.0, 2.0])
    assert high["novelty_gate"] > low["novelty_gate"]

    before = memory.snapshot()
    memory.relax(10)
    after = memory.snapshot()
    before_fast = math.sqrt(sum(v * v for row in before["fast"] for v in row))
    after_fast = math.sqrt(sum(v * v for row in after["fast"] for v in row))
    assert after_fast < before_fast
    assert after["slow"] == before["slow"]

    expect_raises(lambda: memory.observe([1.0], [1.0, 2.0]), ValueError)
    expect_raises(lambda: memory.observe([float("inf"), 0.0], [0.0, 0.0]), ValueError)

    print("PASS homeostatic surprise memory court")


if __name__ == "__main__":
    main()
