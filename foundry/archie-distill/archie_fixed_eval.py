#!/usr/bin/env python3
"""Immutable-window evaluation for the exact Archie 114M baseline.

The module refuses advancing/random windows and verifies the historical source
core before loading any checkpoint. Fixed evaluation remains blocked until all
nine manifests are sealed to one exact corpus.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import pathlib
from dataclasses import asdict, dataclass
from typing import Any, Iterable

import numpy as np
import torch
import torch.nn.functional as F

from archie_baseline_identity import (
    BASELINE_EXPORT_SHA256,
    CORPUS_SCHEMAS,
    SOURCE_CORE_BLOB,
    load_baseline_export,
    sha256_file,
    stable_json,
    verify_source_core,
)
from archie_hybrid_core import ArchieHybridLM, ByteTokenizer
from archie_tokenizers import token_byte_lengths, tokenizer_from_metadata

MANIFEST_SCHEMA = "archie-fixed-eval-manifest/v1"
RECEIPT_SCHEMA = "archie-fixed-eval-receipt/v1"
INPUT_RECEIPT_SCHEMA = "archie-fixed-eval-input-receipt/v1"
SOURCE_INDEX_SCHEMA = "archie-corpus-source-index/v1"
DOMAINS = (
    "general-prose",
    "code-completion",
    "json-structure",
    "utf8-multilingual",
    "long-copy",
    "identifier-recall",
    "repetition",
    "heldout-sources",
    "git-transitions",
)


@dataclass(frozen=True)
class EvalWindow:
    source_id: str
    offset: int
    length: int
    split: str = "eval"


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def atomic_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _read_json(path: pathlib.Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def corpus_metadata(corpus_path: pathlib.Path) -> dict[str, Any]:
    metadata_path = corpus_path.with_suffix(corpus_path.suffix + ".json")
    metadata = _read_json(metadata_path)
    if metadata.get("schema") not in CORPUS_SCHEMAS:
        raise ValueError("unsupported corpus metadata schema")
    if metadata.get("dtype") != "<u2":
        raise ValueError("fixed evaluation requires little-endian uint16 corpus")
    token_count = int(metadata.get("token_count", -1))
    if token_count < 2 or corpus_path.stat().st_size != token_count * 2:
        raise ValueError("corpus length does not match metadata")
    digest = sha256_file(corpus_path)
    if digest != metadata.get("sha256"):
        raise ValueError("corpus digest does not match metadata")
    tokenizer_metadata = metadata.get("tokenizer") or ByteTokenizer.metadata()
    tokenizer = tokenizer_from_metadata(tokenizer_metadata)
    corpus = np.memmap(corpus_path, dtype="<u2", mode="r")
    if int(corpus.max()) >= tokenizer.vocab_size:
        raise ValueError("corpus contains a token outside the declared tokenizer vocabulary")
    normalized = dict(metadata)
    normalized["tokenizer"] = tokenizer_metadata
    normalized["tokenizer_digest"] = sha256_bytes(stable_json(tokenizer_metadata).encode("utf-8"))
    normalized["original_byte_count"] = int(
        metadata.get("original_byte_count", sum(token_byte_lengths(tokenizer_metadata)[int(token)] for token in corpus))
    )
    return normalized


def validate_manifest(path: pathlib.Path, corpus_path: pathlib.Path) -> dict[str, Any]:
    manifest = _read_json(path)
    if manifest.get("schema") != MANIFEST_SCHEMA:
        raise ValueError(f"{path} has unsupported manifest schema")
    if manifest.get("sealed") is not True:
        raise ValueError(f"{path} is an unsealed blocker, not an evaluation manifest")
    domain = manifest.get("domain")
    if domain not in DOMAINS:
        raise ValueError(f"{path} has unknown domain {domain!r}")
    metadata = corpus_metadata(corpus_path)
    if manifest.get("corpus_sha256") != metadata["sha256"]:
        raise ValueError(f"{path} is bound to a different corpus")
    if int(manifest.get("corpus_token_count", -1)) != int(metadata["token_count"]):
        raise ValueError(f"{path} corpus token count drifted")
    windows = manifest.get("windows")
    if not isinstance(windows, list) or not windows:
        raise ValueError(f"{path} has no immutable windows")
    seen: set[tuple[str, int, int]] = set()
    intervals: list[tuple[int, int, str]] = []
    normalized: list[dict[str, Any]] = []
    for raw in windows:
        if not isinstance(raw, dict):
            raise ValueError("window must be an object")
        window = EvalWindow(
            source_id=str(raw.get("source_id", "")),
            offset=int(raw.get("offset", -1)),
            length=int(raw.get("length", -1)),
            split=str(raw.get("split", "")),
        )
        if not window.source_id or window.split != "eval":
            raise ValueError("every window needs source_id and split=eval")
        if window.offset < 0 or window.length < 2:
            raise ValueError("window offset/length is invalid")
        if window.offset + window.length > int(metadata["token_count"]):
            raise ValueError("window exceeds corpus bounds")
        identity = (window.source_id, window.offset, window.length)
        if identity in seen:
            raise ValueError("duplicate evaluation window")
        seen.add(identity)
        intervals.append((window.offset, window.offset + window.length, window.source_id))
        normalized.append(asdict(window))
    intervals.sort()
    for left, right in zip(intervals, intervals[1:]):
        if left[1] > right[0]:
            raise ValueError(f"overlapping windows: {left} and {right}")
    canonical = dict(manifest)
    canonical["windows"] = normalized
    expected = canonical.pop("manifest_digest", None)
    actual = sha256_bytes(stable_json(canonical).encode("utf-8"))
    if expected != actual:
        raise ValueError(f"{path} manifest digest mismatch")
    canonical["manifest_digest"] = actual
    return canonical


def seal_manifests(source_index_path: pathlib.Path, output_dir: pathlib.Path) -> list[pathlib.Path]:
    index = _read_json(source_index_path)
    if index.get("schema") != SOURCE_INDEX_SCHEMA:
        raise ValueError("unsupported source-index schema")
    corpus_path = pathlib.Path(str(index["corpus_path"])).resolve()
    metadata = corpus_metadata(corpus_path)
    if index.get("corpus_sha256") != metadata["sha256"]:
        raise ValueError("source index is bound to another corpus")
    domains = index.get("domains")
    if not isinstance(domains, dict):
        raise ValueError("source index domains must be an object")
    output: list[pathlib.Path] = []
    for domain in DOMAINS:
        raw_windows = domains.get(domain)
        if not isinstance(raw_windows, list) or not raw_windows:
            raise ValueError(f"source index has no windows for {domain}")
        manifest: dict[str, Any] = {
            "schema": MANIFEST_SCHEMA,
            "sealed": True,
            "domain": domain,
            "corpus_sha256": metadata["sha256"],
            "corpus_token_count": int(metadata["token_count"]),
            "windows": raw_windows,
            "selection": "operator-reviewed-source-index",
            "promotion": "research-only-not-admitted",
        }
        manifest["manifest_digest"] = sha256_bytes(stable_json(manifest).encode("utf-8"))
        path = output_dir / f"{domain}.json"
        atomic_json(path, manifest)
        validate_manifest(path, corpus_path)
        output.append(path)
    return output


def load_model(
    export_path: pathlib.Path,
    device: torch.device,
    *,
    expected_sha256: str | None = BASELINE_EXPORT_SHA256,
) -> tuple[ArchieHybridLM, dict[str, Any]]:
    return load_baseline_export(export_path, device=device, expected_sha256=expected_sha256)


@torch.no_grad()
def score_window(
    model: ArchieHybridLM,
    tokens: np.ndarray,
    device: torch.device,
    byte_lengths: np.ndarray | None = None,
) -> dict[str, Any]:
    row = torch.from_numpy(np.asarray(tokens, dtype=np.int64)).to(device)[None]
    inputs, targets = row[:, :-1], row[:, 1:]
    logits = model(inputs)["logits"].float()
    log_probs = F.log_softmax(logits, dim=-1)
    selected = log_probs.gather(-1, targets[..., None]).squeeze(-1)
    if byte_lengths is None:
        lengths = targets.lt(256).to(dtype=torch.float32)
    else:
        table = torch.from_numpy(np.asarray(byte_lengths, dtype=np.float32)).to(device)
        lengths = table[targets]
    original_bytes = int(lengths.sum().item())
    token_mask = lengths.gt(0)
    if original_bytes == 0 or not bool(token_mask.any()):
        raise ValueError("window has no original-byte targets")
    nll_nats = float((-selected[token_mask]).sum().cpu())
    return {
        "scored_tokens": int(token_mask.sum().item()),
        "original_bytes": original_bytes,
        "nll_nats": nll_nats,
        "bits_per_original_byte": nll_nats / math.log(2.0) / original_bytes,
    }


def attest_inputs(
    model_path: pathlib.Path,
    corpus_path: pathlib.Path,
    output_path: pathlib.Path,
    device_name: str,
    expected_model_sha256: str | None = BASELINE_EXPORT_SHA256,
) -> dict[str, Any]:
    device = torch.device(device_name)
    metadata = corpus_metadata(corpus_path)
    model, identity = load_model(model_path, device, expected_sha256=expected_model_sha256)
    tokenizer = tokenizer_from_metadata(metadata["tokenizer"])
    if model.cfg.vocab_size != tokenizer.vocab_size:
        raise ValueError("model vocabulary does not match corpus tokenizer")
    receipt: dict[str, Any] = {
        "schema": INPUT_RECEIPT_SCHEMA,
        "model": identity,
        "corpus": {
            "schema": metadata["schema"],
            "sha256": metadata["sha256"],
            "token_count": int(metadata["token_count"]),
            "original_byte_count": int(metadata["original_byte_count"]),
            "tokenizer_digest": metadata["tokenizer_digest"],
        },
        "source_core_blob": verify_source_core(),
        "status": "inputs-loaded-fixed-evaluation-still-requires-sealed-manifests",
        "promotion": "research-only-not-admitted",
    }
    receipt["receipt_digest"] = sha256_bytes(stable_json(receipt).encode("utf-8"))
    atomic_json(output_path, receipt)
    return receipt


def evaluate(
    model_path: pathlib.Path,
    corpus_path: pathlib.Path,
    manifest_paths: Iterable[pathlib.Path],
    output_path: pathlib.Path,
    device_name: str,
    expected_model_sha256: str | None = BASELINE_EXPORT_SHA256,
) -> dict[str, Any]:
    device = torch.device(device_name)
    metadata = corpus_metadata(corpus_path)
    model, identity = load_model(model_path, device, expected_sha256=expected_model_sha256)
    tokenizer = tokenizer_from_metadata(metadata["tokenizer"])
    if model.cfg.vocab_size != tokenizer.vocab_size:
        raise ValueError("model vocabulary does not match corpus tokenizer")
    lengths = np.asarray(token_byte_lengths(metadata["tokenizer"]), dtype=np.float32)
    corpus = np.memmap(corpus_path, dtype="<u2", mode="r")
    domains: dict[str, Any] = {}
    total_nll = 0.0
    total_bytes = 0
    manifest_digests: dict[str, str] = {}
    for manifest_path in sorted(manifest_paths):
        manifest = validate_manifest(manifest_path, corpus_path)
        domain = str(manifest["domain"])
        records: list[dict[str, Any]] = []
        domain_nll = 0.0
        domain_bytes = 0
        for raw in manifest["windows"]:
            start = int(raw["offset"])
            stop = start + int(raw["length"])
            score = score_window(model, corpus[start:stop], device, lengths)
            records.append({**raw, **score})
            domain_nll += float(score["nll_nats"])
            domain_bytes += int(score["original_bytes"])
        domains[domain] = {
            "bits_per_original_byte": domain_nll / math.log(2.0) / domain_bytes,
            "original_bytes": domain_bytes,
            "windows": records,
        }
        total_nll += domain_nll
        total_bytes += domain_bytes
        manifest_digests[domain] = str(manifest["manifest_digest"])
    if set(domains) != set(DOMAINS):
        missing = sorted(set(DOMAINS) - set(domains))
        raise ValueError(f"fixed evaluation is incomplete; missing domains: {missing}")
    receipt: dict[str, Any] = {
        "schema": RECEIPT_SCHEMA,
        "model": identity,
        "model_sha256": identity["export_sha256"],
        "source_core_blob": SOURCE_CORE_BLOB,
        "corpus_sha256": metadata["sha256"],
        "corpus_schema": metadata["schema"],
        "tokenizer_digest": metadata["tokenizer_digest"],
        "manifest_digests": manifest_digests,
        "aggregate_bits_per_original_byte": total_nll / math.log(2.0) / total_bytes,
        "original_bytes": total_bytes,
        "domains": domains,
        "sampling": {"mode": "none", "evaluation": "teacher-forced-fixed-windows"},
        "promotion": "research-only-not-admitted",
    }
    receipt["receipt_digest"] = sha256_bytes(stable_json(receipt).encode("utf-8"))
    atomic_json(output_path, receipt)
    return receipt


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__)
    sub = cli.add_subparsers(dest="command", required=True)
    seal = sub.add_parser("seal")
    seal.add_argument("--source-index", required=True)
    seal.add_argument("--output-dir", default="eval")
    verify = sub.add_parser("verify")
    verify.add_argument("--corpus", required=True)
    verify.add_argument("manifests", nargs="+")
    attest = sub.add_parser("attest")
    attest.add_argument("--model", required=True)
    attest.add_argument("--corpus", required=True)
    attest.add_argument("--output", required=True)
    attest.add_argument("--device", default="cpu")
    run = sub.add_parser("evaluate")
    run.add_argument("--model", required=True)
    run.add_argument("--corpus", required=True)
    run.add_argument("--output", required=True)
    run.add_argument("--device", default="cpu")
    run.add_argument("manifests", nargs="+")
    return cli


def main() -> None:
    args = parser().parse_args()
    if args.command == "seal":
        paths = seal_manifests(pathlib.Path(args.source_index), pathlib.Path(args.output_dir))
        print(json.dumps([str(path) for path in paths], indent=2))
    elif args.command == "verify":
        corpus = pathlib.Path(args.corpus)
        result = [validate_manifest(pathlib.Path(item), corpus) for item in args.manifests]
        print(json.dumps(result, indent=2, sort_keys=True))
    elif args.command == "attest":
        receipt = attest_inputs(
            pathlib.Path(args.model), pathlib.Path(args.corpus),
            pathlib.Path(args.output), args.device,
        )
        print(json.dumps(receipt, indent=2, sort_keys=True))
    else:
        receipt = evaluate(
            pathlib.Path(args.model), pathlib.Path(args.corpus),
            [pathlib.Path(item) for item in args.manifests],
            pathlib.Path(args.output), args.device,
        )
        print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
