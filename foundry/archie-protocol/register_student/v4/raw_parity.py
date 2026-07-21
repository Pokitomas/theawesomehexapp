#!/usr/bin/env python3
"""Provider-independent raw inference for Archie register linear model parity."""
from __future__ import annotations

import argparse
import base64
import json
import math
import re
import unicodedata
from collections import Counter
from pathlib import Path

TOKEN = re.compile(r"[a-z0-9]+(?:['-][a-z0-9]+)*")


def normalize(value: str) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    return "".join(ch for ch in text if not ("\u0300" <= ch <= "\u036f")).lower()


def features(value: str) -> list[str]:
    text = normalize(value)
    words = TOKEN.findall(text)
    out = [f"w:{word}" for word in words]
    out.extend(f"b:{words[i]}_{words[i + 1]}" for i in range(len(words) - 1))
    out.extend(f"t:{words[i]}_{words[i + 1]}_{words[i + 2]}" for i in range(len(words) - 2))
    for word in words:
        if len(word) > 30:
            continue
        marked = f"^{word}$"
        for size in range(3, 6):
            out.extend(f"c{size}:{marked[i:i + size]}" for i in range(max(0, len(marked) - size + 1)))
    if words:
        out.append(f"s:first:{words[0]}")
        if len(words) > 1:
            out.append(f"s:first2:{words[0]}_{words[1]}")
    out.append(f"s:length:{min(12, len(words) // 5)}")
    if "?" in text:
        out.append("s:question")
    if ";" in text:
        out.append("s:semicolon")
    if re.search(r"\bbefore\b", text):
        out.append("s:before")
    if re.search(r"\bafter(?:ward| that)?\b|\bonly after that\b|\bfollowing completion\b|\bsubsequently\b", text):
        out.append("s:ordered")
    if re.search(r"\b(?:and then|then|next|plus|also|as well as|along with|while also)\b", text):
        out.append("s:connector")
    if re.search(r"\b(?:instead|disregard|replace)\b", text):
        out.append("s:correction")
    if re.search(r"\b(?:do not|don't|skip|ignore|leave out|omit|avoid)\b", text):
        out.append("s:negation")
    if re.search(r"(?:template\s*<|#include|struct\s+\w+\s*\{|\bdef\s+\w+\(|\bclass\s+\w+\s*[:{]|\bfn\s+\w+\s*\(|\bfunction\s+\w+\s*\(|\bimpl\s+\w+\s*\{)", text, re.I):
        out.append("s:raw-source")
    return out


def decode_rows(model: dict) -> list[list[float]]:
    rows = []
    for encoded, scale in zip(model["weights_int8"]["rows"], model["weights_int8"]["scales"]):
        raw = base64.b64decode(encoded)
        rows.append([((byte - 256) if byte > 127 else byte) * float(scale) for byte in raw])
    return rows


def infer(model: dict, vocab: dict[str, int], rows: list[list[float]], text: str) -> dict:
    counts = Counter(vocab[feature] for feature in features(text) if feature in vocab)
    values = []
    norm = 0.0
    for index, count in counts.items():
        value = math.log1p(count) * float(model["idf"][index])
        values.append((index, value))
        norm += value * value
    norm = math.sqrt(norm) or 1.0
    logits = []
    for output, bias in enumerate(model["bias"]):
        value = float(bias)
        row = rows[output]
        for index, raw in values:
            value += row[index] * (raw / norm)
        logits.append(value)
    temperature = max(0.05, float(model.get("temperature") or 1.0))
    maximum = max(value / temperature for value in logits)
    exp_values = [math.exp(value / temperature - maximum) for value in logits]
    total = sum(exp_values) or 1.0
    probabilities = [value / total for value in exp_values]
    best = max(range(len(probabilities)), key=probabilities.__getitem__)
    return {
        "route": model["classes"][best],
        "confidence": probabilities[best],
        "distribution": probabilities,
        "recognized": len(counts),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    model = json.loads(args.model.read_text())
    requests = json.loads(args.input.read_text())
    vocab = {feature: index for index, feature in enumerate(model["vocabulary"])}
    rows = decode_rows(model)
    output = [infer(model, vocab, rows, str(item)) for item in requests]
    args.output.write_text(json.dumps(output, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
