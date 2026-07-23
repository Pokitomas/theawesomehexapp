#!/usr/bin/env python3
"""Compile remote books, TV, audio, video, and other episode shards into Sidepus inventory refs.

The compiler downloads nothing. It validates operator authority, SHA-256 identities, channel
boundaries, remote byte ranges, modality training views, and explicit sequence order. The
pursuit stream later fetches only selected objects through its bounded verified cache.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import tempfile
import urllib.parse
from collections import Counter
from collections.abc import Mapping
from typing import Any

SOURCE_SCHEMA = "sidepus-remote-experience-record/v1"
INVENTORY_SCHEMA = "sidepus-developmental-inventory-record/v1"
RECEIPT_SCHEMA = "sidepus-remote-experience-compilation/v1"
CHANNELS = {
    "production_context", "observation", "utterance", "interpretation",
    "action_consequence", "evaluation_only",
}
VISIBLE_CHANNELS = {"production_context", "observation", "utterance", "action_consequence"}


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_file(path: pathlib.Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(chunk):
            digest.update(block)
    return digest.hexdigest()


def require_digest(value: Any, label: str) -> str:
    digest = str(value or "").lower().strip()
    if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
        raise ValueError(f"{label} must be a lowercase SHA-256 digest")
    return digest


def validate_fetch(raw: Mapping[str, Any], *, allow_file_urls: bool) -> dict[str, Any]:
    url = str(raw.get("url", "")).strip()
    parsed = urllib.parse.urlparse(url)
    allowed = {"http", "https"} | ({"file"} if allow_file_urls else set())
    if parsed.scheme not in allowed:
        raise ValueError(f"fetch URL must use {sorted(allowed)}")
    offset, length = raw.get("offset"), raw.get("length")
    if (offset is None) != (length is None):
        raise ValueError("remote range requires both offset and length")
    result: dict[str, Any] = {"url": url}
    if offset is not None:
        offset_value, length_value = int(offset), int(length)
        if offset_value < 0 or length_value < 1:
            raise ValueError("remote range is invalid")
        result.update(offset=offset_value, length=length_value)
    headers = raw.get("headers")
    if headers is not None:
        if not isinstance(headers, Mapping):
            raise ValueError("fetch headers must be an object")
        forbidden = {"authorization", "cookie", "proxy-authorization"}
        normalized = {str(key): str(value) for key, value in headers.items()}
        if forbidden & {key.lower() for key in normalized}:
            raise ValueError("credential-bearing headers cannot be sealed in a Sidepus manifest")
        result["headers"] = dict(sorted(normalized.items()))
    return result


def validate_item(raw: Mapping[str, Any], *, allow_file_urls: bool) -> dict[str, Any]:
    digest = require_digest(raw.get("sha256"), "channel object sha256")
    media_type = str(raw.get("media_type", "application/octet-stream")).strip()
    size = int(raw.get("bytes", 0))
    if size < 1:
        raise ValueError("channel object bytes must be positive")
    item: dict[str, Any] = {
        "sha256": digest,
        "media_type": media_type,
        "bytes": size,
        "fetch": validate_fetch(dict(raw.get("fetch") or {}), allow_file_urls=allow_file_urls),
    }
    for key in ("representation", "adapter", "shape", "layout", "sample_rate", "frame_rate"):
        if raw.get(key) is not None:
            item[key] = raw[key]
    training_view = raw.get("training_view")
    if training_view is not None:
        if not isinstance(training_view, Mapping):
            raise ValueError("training_view must be an object")
        item["training_view"] = validate_item(training_view, allow_file_urls=allow_file_urls)
    return item


def compile_row(raw: Mapping[str, Any], *, allow_file_urls: bool) -> dict[str, Any]:
    if raw.get("schema") != SOURCE_SCHEMA:
        raise ValueError(f"remote record must use {SOURCE_SCHEMA}")
    rights = raw.get("rights")
    if not isinstance(rights, Mapping) or rights.get("approved_by_operator") is not True:
        raise ValueError("remote record requires operator-approved rights")
    if rights.get("allow_training") is not True:
        raise ValueError("remote record is not authorized for training")
    sequence_id = str(raw.get("sequence_id", "")).strip()
    if not sequence_id:
        raise ValueError("remote experience requires sequence_id")
    sequence_index = int(raw.get("sequence_index", -1))
    if sequence_index < 0:
        raise ValueError("remote experience requires nonnegative sequence_index")
    channels_raw = raw.get("channels")
    if not isinstance(channels_raw, Mapping) or not channels_raw:
        raise ValueError("remote experience requires channel objects")
    unknown = set(map(str, channels_raw)) - CHANNELS
    if unknown:
        raise ValueError(f"unknown Sidepus channels: {sorted(unknown)}")
    channel_objects: dict[str, list[dict[str, Any]]] = {}
    total_bytes = 0
    for channel, items_raw in channels_raw.items():
        if not isinstance(items_raw, list) or not items_raw:
            raise ValueError(f"channel {channel} must contain objects")
        items = [validate_item(item, allow_file_urls=allow_file_urls) for item in items_raw]
        channel_objects[str(channel)] = items
        total_bytes += sum(int(item["bytes"]) for item in items)
    if not (set(channel_objects) & VISIBLE_CHANNELS):
        raise ValueError("remote experience exposes no model-visible source channel")
    first_visible = next(
        item
        for channel in sorted(set(channel_objects) & VISIBLE_CHANNELS)
        for item in channel_objects[channel]
    )
    record_id = str(raw.get("record_id", "")).strip() or (
        "remote_" + hashlib.sha256(f"{sequence_id}\x1f{sequence_index}".encode()).hexdigest()[:32]
    )
    quality = float(raw.get("quality_score", 0.5))
    if not 0.0 <= quality <= 1.0:
        raise ValueError("quality_score must be in [0,1]")
    flags = sorted(set(map(str, raw.get("flags", []))))
    return {
        "schema": INVENTORY_SCHEMA,
        "record_id": record_id,
        "object_sha256": first_visible["sha256"],
        "bytes": total_bytes,
        "estimated_tokens": int(raw.get("estimated_tokens", max(1, total_bytes))),
        "domain": str(raw.get("domain", "multimodal_episode")),
        "medium": str(raw.get("medium", "video")),
        "language": str(raw.get("language", "und")),
        "era": str(raw.get("era", "contemporary")),
        "channels": sorted(channel_objects),
        "channel_objects": channel_objects,
        "rights": dict(rights),
        "quality_score": quality,
        "flags": flags,
        "source_host": str(raw.get("source_host", "remote-experience.invalid")),
        "sequence_id": sequence_id,
        "episode_id": str(raw.get("episode_id", sequence_id)),
        "sequence_index": sequence_index,
        "sequence_length": int(raw["sequence_length"]) if raw.get("sequence_length") is not None else None,
        "capture_time": raw.get("capture_time"),
        "remote_manifest_metadata": dict(raw.get("metadata") or {}),
    }


def compile_manifest(
    source: pathlib.Path,
    output: pathlib.Path,
    *,
    allow_file_urls: bool = False,
) -> dict[str, Any]:
    source = source.expanduser().resolve()
    output = output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    identities: set[str] = set()
    sequence_positions: set[tuple[str, int]] = set()
    counts = Counter()
    with source.open("r", encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            raw = json.loads(line)
            if not isinstance(raw, Mapping):
                raise ValueError(f"{source}:{number} is not an object")
            row = compile_row(raw, allow_file_urls=allow_file_urls)
            if row["record_id"] in identities:
                raise ValueError(f"duplicate remote record_id: {row['record_id']}")
            position = (str(row["sequence_id"]), int(row["sequence_index"]))
            if position in sequence_positions:
                raise ValueError(f"duplicate remote sequence position: {position}")
            identities.add(row["record_id"])
            sequence_positions.add(position)
            rows.append(row)
            counts[f"medium:{row['medium']}"] += 1
            counts[f"domain:{row['domain']}"] += 1
    if not rows:
        raise ValueError("remote experience manifest is empty")
    rows.sort(key=lambda row: (str(row["sequence_id"]), int(row["sequence_index"]), str(row["record_id"])))
    hasher = hashlib.sha256()
    with tempfile.NamedTemporaryFile(dir=output.parent, mode="w", encoding="utf-8", delete=False) as handle:
        temporary = pathlib.Path(handle.name)
        try:
            for row in rows:
                encoded = stable_json(row)
                handle.write(encoded + "\n")
                hasher.update((encoded + "\n").encode())
            handle.flush(); os.fsync(handle.fileno()); os.replace(temporary, output)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "source": str(source),
        "source_sha256": sha256_file(source),
        "output": str(output),
        "output_sha256": sha256_file(output),
        "output_digest": hasher.hexdigest(),
        "records": len(rows),
        "sequences": len({str(row["sequence_id"]) for row in rows}),
        "counts": dict(sorted(counts.items())),
        "allow_file_urls": allow_file_urls,
        "claim_boundary": (
            "Compilation validates remote identities, sequence order, rights declarations, and channel boundaries without downloading payloads. "
            "It does not verify remote availability, semantic labels, or rights claims beyond the operator declaration."
        ),
    }
    receipt["receipt_digest"] = hashlib.sha256(stable_json(receipt).encode()).hexdigest()
    output.with_suffix(output.suffix + ".receipt.json").write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--allow-file-urls", action="store_true")
    args = parser.parse_args()
    compile_manifest(
        pathlib.Path(args.manifest), pathlib.Path(args.output),
        allow_file_urls=args.allow_file_urls,
    )


if __name__ == "__main__":
    main()
