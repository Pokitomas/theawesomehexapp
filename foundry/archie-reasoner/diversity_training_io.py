from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

def stable_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def file_sha256(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def write_json(path: Path, value: object, *, compact: bool = False) -> str:
    text = stable_json(value) if compact else json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2)
    payload = (text + "\n").encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return sha256_bytes(payload)


def write_chunked_json(directory: Path, value: object, *, chunk_bytes: int = 6000) -> dict:
    payload = (stable_json(value) + "\n").encode("utf-8")
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True, exist_ok=True)
    parts = []
    cursor = 0
    index = 0
    while cursor < len(payload):
        end = min(len(payload), cursor + chunk_bytes)
        while end < len(payload) and (payload[end] & 0b11000000) == 0b10000000:
            end -= 1
        chunk = payload[cursor:end]
        name = f"part-{index:02d}.json.fragment"
        (directory / name).write_bytes(chunk)
        parts.append({"path": name, "bytes": len(chunk), "sha256": sha256_bytes(chunk)})
        cursor = end
        index += 1
    manifest = {
        "schema": "archie-chunked-json/v1",
        "media_type": "application/json",
        "logical_bytes": len(payload),
        "logical_sha256": sha256_bytes(payload),
        "parts": parts,
    }
    write_json(directory / "manifest.json", manifest)
    return manifest
