#!/usr/bin/env python3
"""Build the v3 compositional controller from the immutable v2 controller.

The learned linear route expert and quantized weights remain bit-identical. This
patch only repairs generic clause grammar: "instead of" is no longer treated as
a correction, and explicit ordered connectors are recognized as clause borders.
"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

SOURCE_SHA256 = "4d0c382fd384b51dd53ce4b04c5b252e8814c45b0012de802b411c4a98b9ec3d"
OUTPUT_SHA256 = "98c81fd2a83b70686155027d830372ca35852918d81b27b75e411ef423fd1e71"

CORRECTION_OLD = r"const CORRECTION = /(?:\bdisregard that request and instead\b|\binstead\b|\breplace (?:that|it) with\b|\bdo this instead\b|\bthe replacement is\b)[:,]?\s*(.+)$/i;"
CORRECTION_NEW = r"const CORRECTION = /(?:\bdisregard that request and instead\b|\breplace (?:that|it) with\b|\bdo this instead\b|\bthe replacement is\b|(?:^|[.;,])\s*instead\b(?!\s+of\b))[:,]?\s*(.+)$/i;"

SPLIT_OLD = r"""    /\s*(?:;|,|—|-)\s*(?:only after that|after that|afterward|next|following completion|subsequently|and then|then|also)\s*/i,
    /\.\s*(?:after that|afterward|next|then|once that is complete)\s*,?\s*/i,"""
SPLIT_NEW = r"""    /\s*(?:;|,|—|-)\s*(?:and\s+)?(?:only after that|after that|afterward|next|following completion|upon completion|followed by|subsequently|and then|then|also)\s*:?[ ]*/i,
    /\s+(?:and\s+)?(?:afterward|following completion|upon completion|followed by|subsequently)\s*:?[ ]*/i,
    /\.\s*(?:after that|afterward|next|then|once that is complete|upon completion|following completion)\s*,?\s*/i,"""

EXPLICIT_OLD = r"const explicitCompoundSyntax = /(?:;\s*also\b|\band then\b|\bafter that\b|\bonly after that\b|\bfollowing completion\b|\bsubsequently\b|\bplus\b|\bas well as\b|\balong with\b)/i.test(String(request || ''));"
EXPLICIT_NEW = r"const explicitCompoundSyntax = /(?:;\s*also\b|\band then\b|\band afterward\b|\bafterward\b|\bafter that\b|\bonly after that\b|\bfollowing completion\b|\bupon completion\b|\bfollowed by\b|\bsubsequently\b|\bplus\b|\bas well as\b|\balong with\b)/i.test(String(request || ''));"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one source anchor, found {count}")
    return source.replace(old, new, 1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    raw = args.source.read_bytes()
    if digest(raw) != SOURCE_SHA256:
        raise SystemExit(f"source digest mismatch: {digest(raw)}")
    text = raw.decode("utf-8")
    text = replace_once(text, CORRECTION_OLD, CORRECTION_NEW, "correction grammar")
    text = replace_once(text, SPLIT_OLD, SPLIT_NEW, "ordered clause grammar")
    text = replace_once(text, EXPLICIT_OLD, EXPLICIT_NEW, "compound syntax grammar")
    output = text.encode("utf-8")
    if digest(output) != OUTPUT_SHA256:
        raise SystemExit(f"output digest mismatch: {digest(output)}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(output)


if __name__ == "__main__":
    main()
