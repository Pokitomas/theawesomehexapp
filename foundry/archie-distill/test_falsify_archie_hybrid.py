#!/usr/bin/env python3
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile

from archie_hybrid_corpus import build_u16_corpus
from falsify_archie_hybrid import ARMS, fit_budget


def main() -> None:
    smoke_budget = 50_000
    smoke_tolerance = 0.50
    for arm in ARMS:
        cfg, count = fit_budget(arm, smoke_budget, 1, 5, smoke_tolerance)
        assert count > 0
        assert abs(count - smoke_budget) / smoke_budget <= smoke_tolerance
        assert cfg.max_seq_len == 6
    with tempfile.TemporaryDirectory() as temporary:
        root = pathlib.Path(temporary)
        corpus = root / "tiny.u16"
        build_u16_corpus(corpus, [("probe", "equal budget falsification " * 32)], max_tokens=None)
        receipts = []
        for arm in ARMS:
            output = root / arm
            command = [
                sys.executable, str(pathlib.Path(__file__).with_name("falsify_archie_hybrid.py")), "train",
                "--architecture", arm, "--corpus", str(corpus), "--output", str(output),
                "--parameter-budget", str(smoke_budget), "--parameter-tolerance", str(smoke_tolerance),
                "--layers", "1", "--seq-len", "5", "--batch-size", "1",
                "--eval-batch-size", "1", "--grad-accum", "1", "--max-steps", "1",
                "--eval-every", "1", "--eval-batches", "1", "--log-every", "1",
                "--deadline-minutes", "0", "--device", "cpu", "--seed", "11",
            ]
            result = subprocess.run(command, text=True, capture_output=True)
            if result.returncode:
                raise RuntimeError(result.stdout + result.stderr)
            receipt = output / "receipt.json"
            assert receipt.exists()
            receipts.append(receipt)
        report = root / "report.json"
        command = [sys.executable, str(pathlib.Path(__file__).with_name("falsify_archie_hybrid.py")), "aggregate"]
        for receipt in receipts:
            command.extend(["--receipt", str(receipt)])
        command.extend(["--output", str(report), "--practical-margin", "0.02"])
        result = subprocess.run(command, text=True, capture_output=True)
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
        payload = json.loads(report.read_text())
        assert payload["verdict"] in {"hybrid-win", "transformer-win", "ssm-win", "unresolved"}
        assert len(payload["ranking"]) == 3
        print(json.dumps(payload, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
