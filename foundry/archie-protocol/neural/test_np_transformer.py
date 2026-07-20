#!/usr/bin/env python3
"""Verification for the NumPy transformer lane. Run: python3 test_np_transformer.py"""
from __future__ import annotations

import json, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import np_transformer as T  # noqa: E402

failures = []


def check(name, cond, detail=""):
    print(("ok  " if cond else "FAIL") + f" {name}" + (f"  {detail}" if detail else ""))
    if not cond:
        failures.append(name)


# 1. Hand-derived backprop matches finite differences.
check("gradcheck", T.gradcheck(seed=11))

# 2. Tokenizer: deterministic, lowercased, punctuation-splitting.
check("tokenize", T.tokenize("Before X, do Y!") == ["before", "x", ",", "do", "y", "!"])

# 3. Context payloads become tokens behind channel markers.
row = {"request": "extend it", "attachments": "usable support", "memory": "", "thread": ""}
toks = T.row_tokens(row)
check("context-tokens", toks[0] == "<cls>" and "<att>" in toks and "<mem>" not in toks)

# 4. Label structure: compound carries ordered outcomes; clarify carries none.
lab = T.labels_for({"expected": {"route": "compound", "authority": "allow", "context": "ready",
                                   "reference_type": "none", "outcomes": ["plan", "decision"]}})
check("compound-labels", T.ROUTES[lab["route"]] == "compound" and T.OUT1[lab["out1"]] == "plan" and T.OUT2[lab["out2"]] == "decision")
lab2 = T.labels_for({"expected": {"route": "clarify", "authority": "allow", "context": "ambiguous",
                                    "reference_type": "ambiguous", "outcomes": []}})
check("clarify-labels", T.OUT1[lab2["out1"]] == "<none>" and T.OUT2[lab2["out2"]] == "<none>")

# 5. Frozen pack digest is intact and untouched by this lane.
frozen = HERE.parent / "factorized" / "blind-challenge-pack.frozen.json"
import hashlib
check("frozen-pack-digest",
      hashlib.sha256(frozen.read_bytes()).hexdigest() == "3d053ee28c346e712a4e422a73cc8154f492db13947a129581084857a0ad101f")

# 6. Any receipt in runs/ carries the not-admitted boundary and a digest.
runs = HERE / "runs"
if runs.exists():
    for f in sorted(runs.glob("*-receipt.json")):
        r = json.loads(f.read_text())
        check(f"receipt-boundary:{f.name}", r.get("promotion") == "not-admitted" and len(r.get("receipt_digest", "")) == 64)

print(json.dumps({"failures": failures}))
sys.exit(1 if failures else 0)
