from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import tempfile
import unicodedata
from collections import Counter
from typing import Any, Iterable

SCHEMA_CONFIG = "archie-distill-config/v1"
SCHEMA_COLLECTION = "archie-distill-collection/v1"
SCHEMA_TRAINING = "archie-distill-training/v1"
SCHEMA_EVALUATION = "archie-distill-evaluation/v1"
SCHEMA_SELECTION = "archie-distill-selection/v1"

_REASONING_KEYS = {
    "analysis",
    "reasoning",
    "rationale",
    "chain_of_thought",
    "chain-of-thought",
    "scratchpad",
    "thoughts",
    "thinking",
}
_REASONING_BLOCK = re.compile(
    r"<(?:think|thinking|analysis|reasoning|scratchpad)>.*?</(?:think|thinking|analysis|reasoning|scratchpad)>",
    flags=re.IGNORECASE | re.DOTALL,
)
_CODE_FENCE = re.compile(r"^```(?:json|text)?\s*(.*?)\s*```$", re.IGNORECASE | re.DOTALL)
_FINAL_PREFIX = re.compile(r"^(?:final(?: answer)?|answer|response)\s*:\s*", re.IGNORECASE)


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_text(value: str) -> str:
    return sha256_bytes(value.encode("utf-8"))


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def manifest(root: pathlib.Path) -> list[dict[str, Any]]:
    if not root.exists():
        return []
    rows: list[dict[str, Any]] = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        rows.append(
            {
                "path": path.relative_to(root).as_posix(),
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
            }
        )
    return rows


def read_json(path: pathlib.Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def read_jsonl(path: pathlib.Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"{path}:{line_number} must contain a JSON object")
        rows.append(value)
    return rows


def _atomic_write(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def write_json(path: pathlib.Path, value: Any) -> None:
    _atomic_write(path, json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n")


def write_jsonl(path: pathlib.Path, rows: Iterable[dict[str, Any]]) -> None:
    _atomic_write(path, "".join(stable_json(row) + "\n" for row in rows))


def _drop_reasoning(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): _drop_reasoning(item)
            for key, item in value.items()
            if str(key).casefold() not in _REASONING_KEYS
        }
    if isinstance(value, list):
        return [_drop_reasoning(item) for item in value]
    return value


def extract_final(raw: str) -> tuple[str, float | None]:
    """Return only a teacher's final answer and optional confidence.

    Reasoning-tag blocks and reasoning-shaped JSON fields are deleted before
    anything is admitted to the training dataset. Raw responses are never
    required by downstream code.
    """

    text = _REASONING_BLOCK.sub("", str(raw)).strip()
    fenced = _CODE_FENCE.match(text)
    if fenced:
        text = fenced.group(1).strip()

    confidence: float | None = None
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        value = None

    if isinstance(value, dict):
        clean = _drop_reasoning(value)
        for key in ("confidence", "score", "certainty"):
            candidate = clean.get(key)
            if isinstance(candidate, (int, float)):
                confidence = max(0.0, min(1.0, float(candidate)))
                break
        for key in ("answer", "final", "output", "response", "result"):
            candidate = clean.get(key)
            if isinstance(candidate, str) and candidate.strip():
                text = candidate.strip()
                break
        else:
            text = stable_json(clean)

    text = _REASONING_BLOCK.sub("", text).strip()
    text = _FINAL_PREFIX.sub("", text).strip()
    return text, confidence


def normalize_answer(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold().strip()
    normalized = re.sub(r"\s+", " ", normalized)
    normalized = re.sub(r"(?<!\d)\.|\.(?!\d)", "", normalized)
    normalized = re.sub(r"[^\w\s.+/%=-]", "", normalized)
    return normalized.strip()


def estimated_tokens(value: str) -> int:
    return max(1, (len(value.encode("utf-8")) + 3) // 4)


def answer_quality(answer: str, max_output_tokens: int) -> float:
    if not answer.strip():
        return float("-inf")
    if _REASONING_BLOCK.search(answer):
        return float("-inf")
    token_count = estimated_tokens(answer)
    if token_count > max_output_tokens:
        return float("-inf")
    printable = sum(character.isprintable() for character in answer) / max(1, len(answer))
    concise_bonus = 1.0 / (1.0 + token_count / max(1, max_output_tokens))
    return printable + concise_bonus


def choose_consensus(
    candidates: list[dict[str, Any]],
    *,
    max_output_tokens: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    valid = [
        candidate
        for candidate in candidates
        if answer_quality(str(candidate.get("answer", "")), max_output_tokens) != float("-inf")
    ]
    if not valid:
        raise ValueError("No valid teacher answers")

    groups: dict[str, list[dict[str, Any]]] = {}
    for candidate in valid:
        groups.setdefault(normalize_answer(str(candidate["answer"])), []).append(candidate)

    winning_key, winning_group = max(
        groups.items(),
        key=lambda item: (
            len(item[1]),
            max(answer_quality(str(row["answer"]), max_output_tokens) for row in item[1]),
            -min(int(row.get("priority", 0)) for row in item[1]),
            item[0],
        ),
    )
    winner = max(
        winning_group,
        key=lambda row: (
            answer_quality(str(row["answer"]), max_output_tokens),
            -int(row.get("priority", 0)),
        ),
    )
    counts = Counter(normalize_answer(str(row["answer"])) for row in valid)
    metadata = {
        "agreement": len(winning_group),
        "candidate_count": len(valid),
        "distinct_answers": len(groups),
        "winning_normalized_sha256": sha256_text(winning_key),
        "answer_histogram": sorted(counts.values(), reverse=True),
    }
    return winner, metadata


def should_verify(prompt_id: str, *, seed: int, verify_rate: float) -> bool:
    if verify_rate <= 0:
        return False
    if verify_rate >= 1:
        return True
    sample = int(sha256_text(f"{seed}:{prompt_id}")[:16], 16) / float(0xFFFFFFFFFFFFFFFF)
    return sample < verify_rate


def token_f1(prediction: str, references: list[str]) -> float:
    predicted = normalize_answer(prediction).split()
    if not predicted:
        return 0.0
    best = 0.0
    predicted_counts = Counter(predicted)
    for reference in references:
        expected = normalize_answer(reference).split()
        if not expected:
            continue
        overlap = sum((predicted_counts & Counter(expected)).values())
        if overlap == 0:
            continue
        precision = overlap / len(predicted)
        recall = overlap / len(expected)
        best = max(best, 2 * precision * recall / (precision + recall))
    return best


def score_answer(prediction: str, references: list[str]) -> dict[str, float]:
    exact = float(any(normalize_answer(prediction) == normalize_answer(item) for item in references))
    f1 = token_f1(prediction, references)
    return {"exact": exact, "token_f1": f1, "combined": 0.8 * exact + 0.2 * f1}


def select_best(receipts: list[dict[str, Any]], *, minimum_score: float) -> dict[str, Any]:
    eligible = [
        receipt
        for receipt in receipts
        if receipt.get("schema") == SCHEMA_EVALUATION
        and float(receipt.get("metrics", {}).get("combined", -1.0)) >= minimum_score
    ]
    if not eligible:
        raise ValueError("No evaluation receipt meets the minimum score")
    return max(
        eligible,
        key=lambda receipt: (
            float(receipt["metrics"]["combined"]),
            float(receipt["metrics"].get("exact", 0.0)),
            -int(receipt.get("generated_tokens", 0)),
            str(receipt.get("adapter", {}).get("digest", "")),
        ),
    )
