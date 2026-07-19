#!/usr/bin/env python3
"""Deterministic uint16 raw-text corpus builder for Archie HybridLM."""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
from collections.abc import Iterable, Iterator
from typing import Any

import numpy as np

from archie_hybrid_core import BOS_ID, EOS_ID, SEP_ID, VOCAB_SIZE, ByteTokenizer

CORPUS_SCHEMA = "archie-u16-byte-corpus/v1"
TEXT_SUFFIXES = {
    ".txt", ".md", ".rst", ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
    ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".sh", ".bash",
    ".html", ".css", ".scss", ".sql", ".java", ".kt", ".go", ".rs", ".c", ".h",
    ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".scala", ".lua", ".ex", ".exs",
}
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "dist", "build", "coverage", "__pycache__"}


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_file(path: pathlib.Path, chunk_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def iter_local_documents(roots: list[pathlib.Path], max_file_bytes: int) -> Iterator[tuple[str, str]]:
    for root in sorted(path.resolve() for path in roots):
        if root.is_file():
            candidates = [root]
        elif root.is_dir():
            candidates = sorted(
                path for path in root.rglob("*")
                if path.is_file() and not any(part in SKIP_DIRS for part in path.parts)
            )
        else:
            continue
        for path in candidates:
            if path.suffix.lower() not in TEXT_SUFFIXES:
                continue
            try:
                if not 0 < path.stat().st_size <= max_file_bytes:
                    continue
                raw = path.read_bytes()
            except OSError:
                continue
            if b"\x00" in raw[:4096]:
                continue
            text = raw.decode("utf-8", errors="replace").strip()
            if text:
                yield str(path), text


def iter_hf_documents(specs: list[str], seed: int) -> Iterator[tuple[str, str]]:
    """Stream `dataset|config|split|field|max_docs` specifications."""
    if not specs:
        return
    try:
        from datasets import load_dataset  # type: ignore
    except Exception as exc:
        raise SystemExit("--hf-source requires the datasets package") from exc
    for spec in specs:
        parts = spec.split("|")
        dataset_name = parts[0]
        config = parts[1] if len(parts) > 1 and parts[1] else None
        split = parts[2] if len(parts) > 2 and parts[2] else "train"
        field = parts[3] if len(parts) > 3 and parts[3] else "text"
        max_docs = int(parts[4]) if len(parts) > 4 and parts[4] else 100_000
        stream = load_dataset(dataset_name, config, split=split, streaming=True)
        if hasattr(stream, "shuffle"):
            stream = stream.shuffle(seed=seed, buffer_size=min(10_000, max_docs))
        for index, row in enumerate(stream):
            if index >= max_docs:
                break
            value = row.get(field)
            if isinstance(value, str) and value.strip():
                yield f"hf://{dataset_name}/{config or '-'}:{split}:{index}", value.strip()


def build_u16_corpus(output: pathlib.Path, documents: Iterable[tuple[str, str]],
                     *, max_tokens: int | None) -> dict[str, Any]:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    digest, source_digest = hashlib.sha256(), hashlib.sha256()
    document_count = token_count = 0
    with temporary.open("wb") as handle:
        for source, text in documents:
            encoded = [BOS_ID, *text.encode("utf-8", errors="replace"), EOS_ID, SEP_ID]
            if max_tokens is not None:
                encoded = encoded[:max(0, max_tokens - token_count)]
            if not encoded:
                break
            block = np.asarray(encoded, dtype="<u2").tobytes(order="C")
            handle.write(block)
            digest.update(block)
            source_digest.update(source.encode("utf-8", errors="replace") + b"\0")
            source_digest.update(hashlib.sha256(text.encode("utf-8", errors="replace")).digest())
            document_count += 1
            token_count += len(encoded)
            if max_tokens is not None and token_count >= max_tokens:
                break
        handle.flush()
        os.fsync(handle.fileno())
    if token_count < 2:
        temporary.unlink(missing_ok=True)
        raise SystemExit("corpus contains fewer than two tokens")
    os.replace(temporary, output)
    metadata = {
        "schema": CORPUS_SCHEMA, "path": str(output), "dtype": "<u2",
        "endianness": "little", "bytes_per_token": 2, "token_count": token_count,
        "document_count": document_count, "sha256": digest.hexdigest(),
        "source_digest": source_digest.hexdigest(), "tokenizer": ByteTokenizer.metadata(),
    }
    atomic_json(output.with_suffix(output.suffix + ".json"), metadata)
    return metadata


def verify_u16_corpus(path: pathlib.Path) -> dict[str, Any]:
    metadata = json.loads(path.with_suffix(path.suffix + ".json").read_text(encoding="utf-8"))
    if metadata.get("schema") != CORPUS_SCHEMA or metadata.get("dtype") != "<u2":
        raise SystemExit("unsupported corpus metadata")
    if path.stat().st_size % 2 or path.stat().st_size // 2 != int(metadata.get("token_count", -1)):
        raise SystemExit("corpus byte length or token count is invalid")
    if sha256_file(path) != metadata.get("sha256"):
        raise SystemExit("corpus SHA-256 does not match metadata")
    probe = np.memmap(path, dtype="<u2", mode="r")
    if int(probe.max()) >= VOCAB_SIZE:
        raise SystemExit("corpus contains a token outside the vocabulary")
    if not np.any(probe > 255):
        raise SystemExit("corpus did not preserve special IDs above 255")
    return metadata
