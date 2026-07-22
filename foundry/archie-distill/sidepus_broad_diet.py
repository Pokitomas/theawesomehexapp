#!/usr/bin/env python3
"""Freeze broad public sources and compile deterministic Sidepus training exports."""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import io
import json
import math
import mimetypes
import os
import pathlib
import re
import struct
import tarfile
import tempfile
import time
import unicodedata
import urllib.parse
import urllib.request
import wave
import zipfile
from collections import Counter, defaultdict
from collections.abc import Iterable, Iterator
from typing import Any, BinaryIO


PLAN_SCHEMA = "sidepus-source-plan/v1"
LOCK_SCHEMA = "sidepus-source-lock/v1"
MANIFEST_SCHEMA = "sidepus-diet-manifest/v1"
RECEIPT_SCHEMA = "sidepus-export-receipt/v1"
DECISION_SCHEMA = "sidepus-diet-decision/v1"
HEX64 = re.compile(r"^[a-f0-9]{64}$")
HEX40 = re.compile(r"^[a-f0-9]{40}$")
TEXT_SUFFIXES = {
    ".txt", ".md", ".rst", ".adoc", ".tex", ".csv", ".tsv", ".py",
    ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html", ".css",
    ".scss", ".sql", ".java", ".kt", ".go", ".rs", ".c", ".h",
    ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".scala", ".lua",
    ".ex", ".exs", ".sh", ".bash", ".zsh", ".fish", ".json", ".jsonl",
    ".yaml", ".yml", ".toml", ".ini", ".cfg", ".xml", ".svg", ".asm",
    ".s", ".cmake", ".make", ".gradle", ".proto", ".graphql", ".r",
    ".pl", ".pm", ".tcl", ".vim", ".dts", ".dtsi", ".patch", ".diff",
}
CODE_SUFFIXES = {
    ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html",
    ".css", ".scss", ".sql", ".java", ".kt", ".go", ".rs", ".c",
    ".h", ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".scala",
    ".lua", ".ex", ".exs", ".sh", ".bash", ".zsh", ".fish", ".asm",
    ".s", ".cmake", ".make", ".gradle", ".proto", ".graphql", ".r",
    ".pl", ".pm", ".tcl", ".vim", ".dts", ".dtsi", ".patch", ".diff",
}
DATA_SUFFIXES = {
    ".json", ".jsonl", ".yaml", ".yml", ".toml", ".csv", ".tsv",
    ".xml", ".sql", ".ini", ".cfg",
}
ARCHIVE_SUFFIXES = (".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz")
SKIP_PARTS = {".git", "node_modules", ".venv", "venv", "dist", "build", "coverage", "__pycache__"}
SENSITIVE_PATTERNS = (
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{30,}\b"),
)


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def digest_value(value: Any) -> str:
    return digest_bytes(stable_json(value).encode("utf-8"))


def file_sha256(path: pathlib.Path, chunk_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(chunk_size):
            digest.update(block)
    return digest.hexdigest()


def atomic_bytes(path: pathlib.Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = pathlib.Path(handle.name)
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def atomic_json(path: pathlib.Path, value: Any) -> None:
    atomic_bytes(path, (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8"))


def attach_digest(value: dict[str, Any], field: str) -> dict[str, Any]:
    body = {key: item for key, item in value.items() if key != field}
    return {**body, field: digest_value(body)}


def verify_embedded_digest(value: dict[str, Any], field: str, label: str) -> str:
    claimed = str(value.get(field, "")).lower()
    if not HEX64.fullmatch(claimed):
        raise ValueError(f"{label}.{field} is not a SHA-256 digest")
    body = {key: item for key, item in value.items() if key != field}
    if digest_value(body) != claimed:
        raise ValueError(f"{label}.{field} mismatch")
    return claimed


def logical_suffix(value: str) -> str:
    lowered = value.lower()
    for suffix in sorted(ARCHIVE_SUFFIXES, key=len, reverse=True):
        if lowered.endswith(suffix):
            return suffix
    return pathlib.PurePosixPath(value).suffix.lower()


def clean_logical_path(value: str) -> str:
    normalized = str(value).replace("\\", "/").lstrip("/")
    parts = pathlib.PurePosixPath(normalized).parts
    if not normalized or any(part in {"", ".", ".."} for part in parts):
        raise ValueError(f"unsafe logical path: {value}")
    return "/".join(parts)


def source_limits(plan: dict[str, Any], source: dict[str, Any]) -> dict[str, int]:
    defaults = {
        "max_files": 100_000,
        "max_source_bytes": 8 << 30,
        "max_object_bytes": 2 << 30,
        "max_member_bytes": 64 << 20,
        "max_archive_members": 250_000,
        "max_archive_expanded_bytes": 16 << 30,
        "max_document_characters": 2 << 20,
        "max_documents_per_source": 100_000,
        "min_document_characters": 96,
        "near_duplicate_hamming": 3,
    }
    configured = plan.get("limits", {})
    resolved = {}
    for key, fallback in defaults.items():
        raw = source.get(key, configured.get(key, fallback))
        number = int(raw)
        if number < 0:
            raise ValueError(f"{key} cannot be negative")
        resolved[key] = number
    return resolved


def validate_plan_structure(plan: dict[str, Any]) -> None:
    if plan.get("schema") != PLAN_SCHEMA:
        raise ValueError("unsupported Sidepus source plan")
    sources = plan.get("sources")
    if not isinstance(sources, list) or not sources:
        raise ValueError("source plan requires at least one source")
    identifiers = set()
    for index, source in enumerate(sources):
        if not isinstance(source, dict):
            raise ValueError(f"sources[{index}] must be an object")
        identity = str(source.get("id", "")).strip()
        if not identity or identity in identifiers:
            raise ValueError("source ids must be nonempty and unique")
        identifiers.add(identity)
        if not str(source.get("license", "")).strip():
            raise ValueError(f"source {identity} requires an explicit license or rights label")
        if source.get("type") not in {"local", "url", "github", "internet_archive"}:
            raise ValueError(f"source {identity} has an unsupported adapter")
        source_limits(plan, source)


def load_plan(path: pathlib.Path) -> dict[str, Any]:
    plan = json.loads(path.read_text(encoding="utf-8"))
    validate_plan_structure(plan)
    verify_embedded_digest(plan, "plan_digest", "source plan")
    return plan


def seal_plan(path: pathlib.Path, output: pathlib.Path) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    body = {key: value for key, value in raw.items() if key != "plan_digest"}
    validate_plan_structure(body)
    sealed = attach_digest(body, "plan_digest")
    atomic_json(output, sealed)
    return sealed


def object_path(state: pathlib.Path, digest: str) -> pathlib.Path:
    return state / "objects" / digest[:2] / digest[2:]


def store_stream(state: pathlib.Path, handle: BinaryIO, maximum_bytes: int) -> tuple[str, int, pathlib.Path]:
    temporary_dir = state / "objects" / ".incoming"
    temporary_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    total = 0
    with tempfile.NamedTemporaryFile(dir=temporary_dir, delete=False) as output:
        temporary = pathlib.Path(output.name)
        try:
            while block := handle.read(1 << 20):
                total += len(block)
                if total > maximum_bytes:
                    raise ValueError(f"object exceeds maximum of {maximum_bytes} bytes")
                output.write(block)
                digest.update(block)
            output.flush()
            os.fsync(output.fileno())
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
    identity = digest.hexdigest()
    destination = object_path(state, identity)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        temporary.unlink()
        if destination.stat().st_size != total or file_sha256(destination) != identity:
            raise ValueError(f"object store collision for {identity}")
    else:
        os.replace(temporary, destination)
    return identity, total, destination


def store_local(state: pathlib.Path, path: pathlib.Path, maximum_bytes: int) -> tuple[str, int, pathlib.Path]:
    with path.open("rb") as handle:
        return store_stream(state, handle, maximum_bytes)


def fetch_url(state: pathlib.Path, url: str, maximum_bytes: int) -> tuple[str, int, pathlib.Path, dict[str, str]]:
    request = urllib.request.Request(url, headers={"User-Agent": "Archie-Sidepus/1.0 provenance compiler"})
    with urllib.request.urlopen(request, timeout=120) as response:
        headers = {
            key.lower(): value
            for key, value in response.headers.items()
            if key.lower() in {"content-type", "content-length", "etag", "last-modified"}
        }
        identity, size, path = store_stream(state, response, maximum_bytes)
    return identity, size, path, headers


def match_path(path: str, includes: list[str], excludes: list[str]) -> bool:
    included = any(fnmatch.fnmatch(path, pattern) for pattern in includes)
    excluded = any(fnmatch.fnmatch(path, pattern) for pattern in excludes)
    return included and not excluded


def common_descriptor(
    source: dict[str, Any], *, logical_path: str, object_digest: str, size: int,
    adapter: str, retrieved_at: str, origin: dict[str, Any], headers: dict[str, Any] | None = None,
    limits: dict[str, int] | None = None,
) -> dict[str, Any]:
    media_type = mimetypes.guess_type(logical_path)[0] or "application/octet-stream"
    return {
        "source_id": str(source["id"]),
        "adapter": adapter,
        "logical_path": clean_logical_path(logical_path),
        "object_sha256": object_digest,
        "bytes": size,
        "media_type": media_type,
        "license": str(source["license"]),
        "rights": str(source.get("rights", "")),
        "retrieved_at": retrieved_at,
        "origin": origin,
        "response_headers": headers or {},
        "limits": limits or {},
        "trainable": True,
    }


def freeze_local(plan: dict[str, Any], source: dict[str, Any], state: pathlib.Path, retrieved_at: str) -> list[dict[str, Any]]:
    root = pathlib.Path(str(source.get("path", ""))).expanduser().resolve()
    if not root.exists():
        raise ValueError(f"local source does not exist: {root}")
    limits = source_limits(plan, source)
    includes = [str(value) for value in source.get("include", ["*", "**/*"])]
    excludes = [str(value) for value in source.get("exclude", [])]
    candidates = [root] if root.is_file() else sorted(path for path in root.rglob("*") if path.is_file())
    descriptors = []
    total = 0
    for path in candidates:
        if path.is_symlink() or any(part in SKIP_PARTS for part in path.parts):
            continue
        relative = path.name if root.is_file() else path.relative_to(root).as_posix()
        if not match_path(relative, includes, excludes):
            continue
        size = path.stat().st_size
        if not 0 < size <= limits["max_object_bytes"]:
            continue
        if len(descriptors) >= limits["max_files"] or total + size > limits["max_source_bytes"]:
            raise ValueError(f"local source {source['id']} exceeds its frozen source budget")
        identity, stored_size, _ = store_local(state, path, limits["max_object_bytes"])
        total += stored_size
        descriptors.append(common_descriptor(
            source, logical_path=relative, object_digest=identity, size=stored_size,
            adapter="local", retrieved_at=retrieved_at,
            origin={"kind": "local-snapshot", "root_label": str(source.get("root_label", source["id"]))},
            limits=limits,
        ))
    return descriptors


def freeze_url(plan: dict[str, Any], source: dict[str, Any], state: pathlib.Path, retrieved_at: str) -> list[dict[str, Any]]:
    url = str(source.get("url", ""))
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError(f"source {source['id']} requires an HTTP(S) URL")
    logical_path = str(source.get("logical_path") or pathlib.PurePosixPath(parsed.path).name or "download.bin")
    limits = source_limits(plan, source)
    identity, size, _, headers = fetch_url(state, url, limits["max_object_bytes"])
    expected = str(source.get("expected_sha256", "")).lower()
    if expected and (not HEX64.fullmatch(expected) or expected != identity):
        raise ValueError(f"source {source['id']} did not match expected_sha256")
    return [common_descriptor(
        source, logical_path=logical_path, object_digest=identity, size=size,
        adapter="url", retrieved_at=retrieved_at, origin={"kind": "url", "url": url},
        headers=headers, limits=limits,
    )]


def freeze_github(plan: dict[str, Any], source: dict[str, Any], state: pathlib.Path, retrieved_at: str) -> list[dict[str, Any]]:
    repository = str(source.get("repository", "")).strip("/")
    revision = str(source.get("revision", "")).lower()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError(f"source {source['id']} has an invalid GitHub repository")
    if not HEX40.fullmatch(revision):
        raise ValueError(f"source {source['id']} must pin an exact 40-character Git revision")
    url = f"https://codeload.github.com/{repository}/tar.gz/{revision}"
    limits = source_limits(plan, source)
    identity, size, _, headers = fetch_url(state, url, limits["max_object_bytes"])
    expected = str(source.get("expected_sha256", "")).lower()
    if expected and (not HEX64.fullmatch(expected) or expected != identity):
        raise ValueError(f"source {source['id']} GitHub archive did not match expected_sha256")
    logical_path = f"{repository.replace('/', '--')}@{revision}.tar.gz"
    return [common_descriptor(
        source, logical_path=logical_path, object_digest=identity, size=size,
        adapter="github", retrieved_at=retrieved_at,
        origin={"kind": "github", "repository": repository, "revision": revision, "url": url},
        headers=headers, limits=limits,
    )]


def download_json(url: str, maximum_bytes: int = 16 << 20) -> tuple[dict[str, Any], bytes, dict[str, str]]:
    request = urllib.request.Request(url, headers={"User-Agent": "Archie-Sidepus/1.0 provenance compiler"})
    with urllib.request.urlopen(request, timeout=120) as response:
        raw = response.read(maximum_bytes + 1)
        headers = {
            key.lower(): value for key, value in response.headers.items()
            if key.lower() in {"content-type", "content-length", "etag", "last-modified"}
        }
    if len(raw) > maximum_bytes:
        raise ValueError("metadata response exceeded its limit")
    return json.loads(raw.decode("utf-8")), raw, headers


def freeze_internet_archive(
    plan: dict[str, Any], source: dict[str, Any], state: pathlib.Path, retrieved_at: str,
) -> list[dict[str, Any]]:
    item = str(source.get("item", "")).strip()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", item):
        raise ValueError(f"source {source['id']} has an invalid Internet Archive item id")
    metadata_url = f"https://archive.org/metadata/{urllib.parse.quote(item, safe='')}"
    metadata, raw_metadata, metadata_headers = download_json(metadata_url)
    metadata_digest, metadata_size, _ = store_stream(state, io.BytesIO(raw_metadata), len(raw_metadata))
    files = [entry for entry in metadata.get("files", []) if isinstance(entry, dict) and entry.get("name")]
    exact = {clean_logical_path(str(value)) for value in source.get("files", [])}
    patterns = [str(value) for value in source.get("globs", [])]
    selected = []
    for entry in sorted(files, key=lambda value: str(value["name"])):
        name = clean_logical_path(str(entry["name"]))
        if name in exact or any(fnmatch.fnmatch(name, pattern) for pattern in patterns):
            selected.append((name, entry))
    found_exact = {name for name, _ in selected if name in exact}
    if found_exact != exact:
        missing = sorted(exact - found_exact)
        raise ValueError(f"source {source['id']} is missing requested files: {missing}")
    if not selected:
        raise ValueError(f"source {source['id']} selected no Internet Archive files")
    limits = source_limits(plan, source)
    if len(selected) > limits["max_files"]:
        raise ValueError(f"source {source['id']} selected too many Internet Archive files")
    metadata_descriptor = common_descriptor(
        source, logical_path=f"_authority/{item}.metadata.json",
        object_digest=metadata_digest, size=metadata_size,
        adapter="internet_archive_metadata", retrieved_at=retrieved_at,
        origin={"kind": "internet-archive-metadata", "item": item, "url": metadata_url},
        headers=metadata_headers, limits=limits,
    )
    metadata_descriptor["trainable"] = False
    descriptors = [metadata_descriptor]
    total = 0
    for name, entry in selected:
        url = f"https://archive.org/download/{urllib.parse.quote(item, safe='')}/{urllib.parse.quote(name, safe='/')}"
        identity, size, _, headers = fetch_url(state, url, limits["max_object_bytes"])
        total += size
        if total > limits["max_source_bytes"]:
            raise ValueError(f"source {source['id']} exceeds its frozen source budget")
        descriptor = common_descriptor(
            source, logical_path=name, object_digest=identity, size=size,
            adapter="internet_archive", retrieved_at=retrieved_at,
            origin={
                "kind": "internet-archive", "item": item, "file": name, "url": url,
                "metadata_sha256": metadata_digest, "metadata_bytes": metadata_size,
                "upstream_md5": str(entry.get("md5", "")),
                "upstream_sha1": str(entry.get("sha1", "")),
            },
            headers=headers, limits=limits,
        )
        descriptors.append(descriptor)
    return descriptors


def verify_lock(lock: dict[str, Any], state: pathlib.Path) -> str:
    if lock.get("schema") != LOCK_SCHEMA:
        raise ValueError("unsupported Sidepus source lock")
    lock_digest = verify_embedded_digest(lock, "lock_digest", "source lock")
    for descriptor in lock.get("objects", []):
        identity = str(descriptor.get("object_sha256", ""))
        if not HEX64.fullmatch(identity):
            raise ValueError("source lock contains an invalid object digest")
        path = object_path(state, identity)
        if not path.is_file() or path.stat().st_size != int(descriptor.get("bytes", -1)):
            raise ValueError(f"frozen object is missing or has the wrong size: {identity}")
        if file_sha256(path) != identity:
            raise ValueError(f"frozen object digest mismatch: {identity}")
    return lock_digest


def freeze_plan(plan_path: pathlib.Path, state: pathlib.Path, reuse: bool = False) -> dict[str, Any]:
    plan_path = plan_path.resolve()
    state = state.resolve()
    plan = load_plan(plan_path)
    lock_path = state / "source-lock.json"
    if lock_path.exists():
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
        if not reuse:
            raise ValueError(f"source lock already exists: {lock_path}; pass --reuse to verify it")
        verify_lock(lock, state)
        if lock.get("plan_digest") != plan["plan_digest"]:
            raise ValueError("the existing source lock belongs to a different source plan")
        return lock
    retrieved_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    objects = []
    for source in sorted(plan["sources"], key=lambda value: str(value["id"])):
        adapter = source["type"]
        if adapter == "local":
            frozen = freeze_local(plan, source, state, retrieved_at)
        elif adapter == "url":
            frozen = freeze_url(plan, source, state, retrieved_at)
        elif adapter == "github":
            frozen = freeze_github(plan, source, state, retrieved_at)
        else:
            frozen = freeze_internet_archive(plan, source, state, retrieved_at)
        if not frozen:
            raise ValueError(f"source {source['id']} froze no objects")
        objects.extend(frozen)
    objects.sort(key=lambda value: (value["source_id"], value["logical_path"], value["object_sha256"]))
    lock = attach_digest({
        "schema": LOCK_SCHEMA,
        "plan_digest": plan["plan_digest"],
        "plan_file_sha256": file_sha256(plan_path),
        "retrieved_at": retrieved_at,
        "objects": objects,
        "totals": {
            "objects": len(objects),
            "bytes": sum(int(value["bytes"]) for value in objects),
            "sources": len({value["source_id"] for value in objects}),
        },
        "claim_boundary": "Remote bytes are frozen, not trusted; compilation applies independent filtering and deduplication.",
    }, "lock_digest")
    atomic_json(lock_path, lock)
    return lock


def entropy_bits_per_byte(data: bytes) -> float:
    if not data:
        return 0.0
    counts = Counter(data)
    total = len(data)
    return -sum((count / total) * math.log2(count / total) for count in counts.values())


def bytefield(data: bytes, windows: int = 12, width: int = 32) -> dict[str, Any]:
    if not data:
        return {"sampled_bytes": 0, "entropy_bits_per_byte": 0.0, "histogram_16": [0] * 16, "windows": []}
    maximum = max(0, len(data) - width)
    positions = sorted({round(maximum * index / max(windows - 1, 1)) for index in range(windows)})
    samples = [{"offset": position, "hex": data[position:position + width].hex()} for position in positions]
    histogram = [0] * 16
    for value in data:
        histogram[value >> 4] += 1
    return {
        "sampled_bytes": sum(len(bytes.fromhex(item["hex"])) for item in samples),
        "entropy_bits_per_byte": round(entropy_bits_per_byte(data), 6),
        "histogram_16": histogram,
        "windows": samples,
    }


def jpeg_dimensions(data: bytes) -> tuple[int, int] | None:
    if not data.startswith(b"\xff\xd8"):
        return None
    offset = 2
    while offset + 9 <= len(data):
        if data[offset] != 0xFF:
            offset += 1
            continue
        marker = data[offset + 1]
        offset += 2
        if marker in {0xD8, 0xD9}:
            continue
        if offset + 2 > len(data):
            break
        length = int.from_bytes(data[offset:offset + 2], "big")
        if length < 2 or offset + length > len(data):
            break
        if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
            height = int.from_bytes(data[offset + 3:offset + 5], "big")
            width = int.from_bytes(data[offset + 5:offset + 7], "big")
            return width, height
        offset += length
    return None


def image_measurements(data: bytes) -> dict[str, Any]:
    if len(data) >= 24 and data.startswith(b"\x89PNG\r\n\x1a\n"):
        width, height = struct.unpack(">II", data[16:24])
        return {"format": "png", "width": width, "height": height}
    if len(data) >= 10 and data[:6] in {b"GIF87a", b"GIF89a"}:
        width, height = struct.unpack("<HH", data[6:10])
        return {"format": "gif", "width": width, "height": height}
    if len(data) >= 26 and data.startswith(b"BM"):
        width, height = struct.unpack("<ii", data[18:26])
        return {"format": "bmp", "width": abs(width), "height": abs(height)}
    dimensions = jpeg_dimensions(data)
    if dimensions:
        return {"format": "jpeg", "width": dimensions[0], "height": dimensions[1]}
    return {}


def audio_measurements(data: bytes) -> dict[str, Any]:
    try:
        with wave.open(io.BytesIO(data), "rb") as handle:
            frames = handle.getnframes()
            rate = handle.getframerate()
            return {
                "format": "wav", "channels": handle.getnchannels(),
                "sample_rate_hz": rate, "sample_width_bytes": handle.getsampwidth(),
                "frames": frames, "duration_seconds": round(frames / max(rate, 1), 6),
            }
    except (wave.Error, EOFError):
        return {}


def modality_for(path: str, media_type: str) -> str:
    suffix = logical_suffix(path)
    basename = pathlib.PurePosixPath(path).name.lower()
    if basename in {"makefile", "kconfig", "meson.build", "cmakelists.txt"}:
        return "code"
    if suffix in CODE_SUFFIXES:
        return "code"
    if suffix in DATA_SUFFIXES:
        return "data"
    if media_type.startswith("image/"):
        return "image"
    if media_type.startswith("audio/"):
        return "audio"
    if media_type.startswith("video/"):
        return "video"
    if suffix in ARCHIVE_SUFFIXES:
        return "archive"
    if suffix in TEXT_SUFFIXES or media_type.startswith("text/"):
        return "text"
    return "binary"


def spectral_hints(path: str) -> list[dict[str, str]]:
    lowered = path.lower()
    hints = []
    terms = {
        "infrared": ("infrared", "near-ir", "nir", "thermal"),
        "ultraviolet": ("ultraviolet", "uv-a", "uv-b", "uvc"),
        "xray": ("x-ray", "xray"),
        "radio": ("radio", "rf", "radar"),
    }
    for modality, aliases in terms.items():
        if any(re.search(rf"(?:^|[^a-z0-9]){re.escape(alias)}(?:[^a-z0-9]|$)", lowered) for alias in aliases):
            hints.append({"modality": modality, "evidence": "logical-path-label"})
    return hints


def decode_text(data: bytes, path: str, media_type: str) -> tuple[str | None, str | None]:
    suffix = logical_suffix(path)
    likely = suffix in TEXT_SUFFIXES or media_type.startswith("text/")
    if not likely and b"\x00" in data[:4096]:
        return None, None
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        try:
            return data.decode("utf-16").replace("\r\n", "\n").strip(), "utf-16"
        except UnicodeDecodeError:
            return None, None
    try:
        return data.decode("utf-8").replace("\r\n", "\n").strip(), "utf-8"
    except UnicodeDecodeError:
        decoded = data.decode("utf-8", errors="replace").replace("\r\n", "\n").strip()
        if decoded.count("\ufffd") / max(len(decoded), 1) <= 0.005 and likely:
            return decoded, "utf-8-replacement"
        return None, None


def quality_rejection(text: str, minimum_characters: int) -> str | None:
    if len(text) < minimum_characters:
        return "too-short"
    if text.lstrip().startswith("{"):
        try:
            declared = json.loads(text)
        except json.JSONDecodeError:
            declared = None
        if isinstance(declared, dict) and declared.get("training_excluded") is True:
            return "declared-training-excluded"
    if any(pattern.search(text) for pattern in SENSITIVE_PATTERNS):
        return "sensitive-secret-pattern"
    controls = sum(ord(character) < 32 and character not in "\n\r\t" for character in text)
    if controls / max(len(text), 1) > 0.002:
        return "control-character-density"
    visible = sum(character.isalnum() or character.isspace() or character in "_{}[]()<>=+-*/.,:;#@!?'\"\\|&%$~`^" for character in text)
    if visible / max(len(text), 1) < 0.85:
        return "low-textual-density"
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) >= 20 and 1.0 - len(set(lines)) / len(lines) > 0.75:
        return "repeated-line-boilerplate"
    tokens = re.findall(r"\w+|[^\w\s]", text[:200_000], flags=re.UNICODE)
    if len(tokens) >= 200 and len(set(tokens)) / len(tokens) < 0.01:
        return "low-token-diversity"
    return None


def normalized_text(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def simhash64(text: str) -> int:
    tokens = re.findall(r"\w+|[^\w\s]", text[:500_000], flags=re.UNICODE)
    if not tokens:
        return 0
    width = 5
    shingles = ["\x1f".join(tokens[index:index + width]) for index in range(max(1, len(tokens) - width + 1))]
    weights = [0] * 64
    for shingle in shingles:
        fingerprint = int.from_bytes(hashlib.blake2b(shingle.encode("utf-8"), digest_size=8).digest(), "big")
        for bit in range(64):
            weights[bit] += 1 if fingerprint & (1 << bit) else -1
    result = 0
    for bit, weight in enumerate(weights):
        if weight >= 0:
            result |= 1 << bit
    return result


def chunks(text: str, maximum_characters: int) -> Iterator[tuple[int, str]]:
    if len(text) <= maximum_characters:
        yield 0, text
        return
    start = 0
    index = 0
    while start < len(text):
        end = min(len(text), start + maximum_characters)
        if end < len(text):
            newline = text.rfind("\n", start + maximum_characters // 2, end)
            if newline > start:
                end = newline
        value = text[start:end].strip()
        if value:
            yield index, value
            index += 1
        start = max(end, start + 1)


def archive_members(path: pathlib.Path, descriptor: dict[str, Any], limits: dict[str, int]) -> Iterator[tuple[str, bytes]]:
    suffix = logical_suffix(descriptor["logical_path"])
    member_count = expanded = 0
    if suffix == ".zip":
        with zipfile.ZipFile(path) as archive:
            for member in sorted(archive.infolist(), key=lambda value: value.filename):
                if member.is_dir():
                    continue
                name = clean_logical_path(member.filename)
                if not 0 < member.file_size <= limits["max_member_bytes"]:
                    continue
                member_count += 1
                expanded += member.file_size
                if member_count > limits["max_archive_members"] or expanded > limits["max_archive_expanded_bytes"]:
                    raise ValueError(f"archive {descriptor['logical_path']} exceeds expansion limits")
                with archive.open(member) as handle:
                    data = handle.read(limits["max_member_bytes"] + 1)
                if len(data) <= limits["max_member_bytes"]:
                    yield name, data
        return
    with tarfile.open(path, "r:*") as archive:
        for member in sorted(archive.getmembers(), key=lambda value: value.name):
            if not member.isfile() or member.issym() or member.islnk():
                continue
            name = clean_logical_path(member.name)
            if not 0 < member.size <= limits["max_member_bytes"]:
                continue
            member_count += 1
            expanded += member.size
            if member_count > limits["max_archive_members"] or expanded > limits["max_archive_expanded_bytes"]:
                raise ValueError(f"archive {descriptor['logical_path']} exceeds expansion limits")
            handle = archive.extractfile(member)
            if handle is None:
                continue
            data = handle.read(limits["max_member_bytes"] + 1)
            if len(data) <= limits["max_member_bytes"]:
                yield name, data


def observation_text(
    *, descriptor: dict[str, Any], logical_path: str, member_path: str | None,
    raw_digest: str, data: bytes, modality: str, measurements: dict[str, Any],
    content: str | None, encoding: str | None, chunk_index: int | None,
) -> tuple[str, dict[str, Any]]:
    provenance = {
        "source_id": descriptor["source_id"],
        "adapter": descriptor["adapter"],
        "logical_path": logical_path,
        "member_path": member_path,
        "frozen_object_sha256": descriptor["object_sha256"],
        "raw_content_sha256": raw_digest,
        "license": descriptor["license"],
        "rights": descriptor.get("rights", ""),
        "origin": descriptor["origin"],
        "retrieved_at": descriptor["retrieved_at"],
    }
    measured = {
        "modality": modality,
        "media_type": mimetypes.guess_type(member_path or logical_path)[0] or descriptor["media_type"],
        "bytes": len(data),
        "encoding": encoding,
        "chunk_index": chunk_index,
        "spectral_hints": spectral_hints(member_path or logical_path),
        **measurements,
    }
    envelope = stable_json({"provenance": provenance, "measurements": measured})
    if content is None:
        text = f"<archie:observation>\n{envelope}\n</archie:observation>"
    else:
        text = f"<archie:observation>\n{envelope}\n<archie:content>\n{content}\n</archie:content>\n</archie:observation>"
    return text, {"provenance": provenance, "measurements": measured}


def candidate_records(
    descriptor: dict[str, Any], logical_path: str, member_path: str | None,
    data: bytes, limits: dict[str, int],
) -> Iterator[dict[str, Any]]:
    raw_digest = digest_bytes(data)
    effective_path = member_path or logical_path
    media_type = mimetypes.guess_type(effective_path)[0] or descriptor["media_type"]
    modality = modality_for(effective_path, media_type)
    decoded, encoding = decode_text(data, effective_path, media_type)
    if decoded is not None:
        if modality == "binary":
            modality = "text"
        for chunk_index, content in chunks(decoded, limits["max_document_characters"]):
            rejection = quality_rejection(content, limits["min_document_characters"])
            text, metadata = observation_text(
                descriptor=descriptor, logical_path=logical_path, member_path=member_path,
                raw_digest=raw_digest, data=data, modality=modality, measurements={
                    "characters": len(content), "lines": content.count("\n") + 1,
                }, content=content, encoding=encoding, chunk_index=chunk_index,
            )
            yield {
                "key": (descriptor["source_id"], logical_path, member_path or "", chunk_index),
                "text": text, "content": content, "metadata": metadata,
                "raw_digest": raw_digest, "rejection": rejection,
            }
        return
    measurements = {"bytefield": bytefield(data)}
    if modality == "image":
        measurements.update(image_measurements(data))
    elif modality == "audio":
        measurements.update(audio_measurements(data))
    text, metadata = observation_text(
        descriptor=descriptor, logical_path=logical_path, member_path=member_path,
        raw_digest=raw_digest, data=data, modality=modality, measurements=measurements,
        content=None, encoding=None, chunk_index=None,
    )
    yield {
        "key": (descriptor["source_id"], logical_path, member_path or "", -1),
        "text": text, "content": text, "metadata": metadata,
        "raw_digest": raw_digest, "rejection": None,
    }


def decision_row(candidate: dict[str, Any], status: str, reason: str | None, document_id: str | None) -> dict[str, Any]:
    metadata = candidate["metadata"]
    return {
        "schema": DECISION_SCHEMA,
        "status": status,
        "reason": reason,
        "document_id": document_id,
        "source_id": metadata["provenance"]["source_id"],
        "logical_path": metadata["provenance"]["logical_path"],
        "member_path": metadata["provenance"]["member_path"],
        "raw_content_sha256": candidate["raw_digest"],
        "modality": metadata["measurements"]["modality"],
    }


def compile_lock(lock_path: pathlib.Path, output: pathlib.Path) -> dict[str, Any]:
    lock_path = lock_path.resolve()
    state = lock_path.parent
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    lock_digest = verify_lock(lock, state)
    default_limits = source_limits({"limits": {}}, {})
    descriptors = []
    source_caps: dict[str, int] = {}
    near_thresholds = []
    for descriptor in sorted(
        lock["objects"],
        key=lambda value: (
            value["source_id"], value["logical_path"], value["object_sha256"]
        ),
    ):
        if not descriptor.get("trainable", True):
            continue
        limits = {**default_limits, **{
            key: int(value) for key, value in descriptor.get("limits", {}).items()
            if key in default_limits
        }}
        source_caps[descriptor["source_id"]] = min(
            source_caps.get(descriptor["source_id"], limits["max_documents_per_source"]),
            limits["max_documents_per_source"],
        )
        near_thresholds.append(limits["near_duplicate_hamming"])
        descriptors.append((descriptor, limits))

    def iter_candidates() -> Iterator[dict[str, Any]]:
        for descriptor, limits in descriptors:
            path = object_path(state, descriptor["object_sha256"])
            suffix = logical_suffix(descriptor["logical_path"])
            if suffix in ARCHIVE_SUFFIXES:
                for member_path, data in archive_members(path, descriptor, limits):
                    yield from candidate_records(
                        descriptor, descriptor["logical_path"], member_path, data, limits
                    )
            else:
                data = path.read_bytes()
                yield from candidate_records(
                    descriptor, descriptor["logical_path"], None, data, limits
                )

    exact_seen: dict[str, str] = {}
    normalized_seen: dict[str, str] = {}
    raw_seen: dict[str, str] = {}
    simhash_buckets: dict[tuple[int, int], list[tuple[int, int, str]]] = defaultdict(list)
    selected = []
    source_counts = Counter()
    modality_counts = Counter()
    reason_counts = Counter()
    near_threshold = min(near_thresholds or [default_limits["near_duplicate_hamming"]])
    candidate_count = 0
    export_digest = hashlib.sha256()
    decision_digest = hashlib.sha256()
    export_size = 0
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output, delete=False) as export_handle, tempfile.NamedTemporaryFile(dir=output, delete=False) as decision_handle:
        export_temporary = pathlib.Path(export_handle.name)
        decision_temporary = pathlib.Path(decision_handle.name)
        try:
            for candidate in iter_candidates():
                candidate_count += 1
                reason = candidate["rejection"]
                text_digest = digest_bytes(candidate["text"].encode("utf-8"))
                normalized = normalized_text(candidate["content"])
                normalized_digest = digest_bytes(normalized.encode("utf-8"))
                fingerprint = simhash64(normalized)
                source_id = candidate["metadata"]["provenance"]["source_id"]
                if reason is None and source_counts[source_id] >= source_caps[source_id]:
                    reason = "source-document-cap"
                if reason is None and text_digest in exact_seen:
                    reason = "exact-duplicate"
                if reason is None and candidate["raw_digest"] in raw_seen:
                    reason = "raw-object-duplicate"
                if reason is None and normalized_digest in normalized_seen:
                    reason = "normalized-duplicate"
                if reason is None:
                    comparisons: set[tuple[int, int, str]] = set()
                    for band in range(4):
                        comparisons.update(
                            simhash_buckets[(band, (fingerprint >> (band * 16)) & 0xFFFF)]
                        )
                    for previous_fingerprint, previous_length, _ in comparisons:
                        length_ratio = len(normalized) / max(previous_length, 1)
                        if (
                            0.75 <= length_ratio <= 1.34
                            and (fingerprint ^ previous_fingerprint).bit_count()
                            <= near_threshold
                        ):
                            reason = "near-duplicate"
                            break
                if reason is not None:
                    reason_counts[reason] += 1
                    decision = decision_row(candidate, "rejected", reason, None)
                else:
                    identity_body = {
                        "source_id": source_id,
                        "logical_path": candidate["metadata"]["provenance"]["logical_path"],
                        "member_path": candidate["metadata"]["provenance"]["member_path"],
                        "raw_content_sha256": candidate["raw_digest"],
                        "object_digest": text_digest,
                        "chunk_index": candidate["metadata"]["measurements"]["chunk_index"],
                    }
                    document_id = f"sidepus_{digest_value(identity_body)[:32]}"
                    measurement = {
                        "raw_content_sha256": candidate["raw_digest"],
                        "normalized_text_sha256": normalized_digest,
                        "simhash64": f"{fingerprint:016x}",
                        "provenance": candidate["metadata"]["provenance"],
                        "measurements": candidate["metadata"]["measurements"],
                    }
                    selection = {
                        "document_id": document_id,
                        "object_digest": text_digest,
                        "measurement_digest": digest_value(measurement),
                        "source_id": source_id,
                        "modality": candidate["metadata"]["measurements"]["modality"],
                        "raw_content_sha256": candidate["raw_digest"],
                        "normalized_text_sha256": normalized_digest,
                        "simhash64": f"{fingerprint:016x}",
                    }
                    row = {
                        "document_id": document_id,
                        "object_digest": text_digest,
                        "text": candidate["text"],
                        "source": {
                            "source_id": source_id,
                            "adapter": candidate["metadata"]["provenance"]["adapter"],
                            "logical_path": candidate["metadata"]["provenance"]["logical_path"],
                            "member_path": candidate["metadata"]["provenance"]["member_path"],
                            "license": candidate["metadata"]["provenance"]["license"],
                            "modality": candidate["metadata"]["measurements"]["modality"],
                        },
                        "selection": selection,
                    }
                    row_bytes = (stable_json(row) + "\n").encode("utf-8")
                    export_handle.write(row_bytes)
                    export_digest.update(row_bytes)
                    export_size += len(row_bytes)
                    selected.append(selection)
                    source_counts[source_id] += 1
                    modality_counts[selection["modality"]] += 1
                    exact_seen[text_digest] = document_id
                    normalized_seen[normalized_digest] = document_id
                    raw_seen[candidate["raw_digest"]] = document_id
                    for band in range(4):
                        simhash_buckets[
                            (band, (fingerprint >> (band * 16)) & 0xFFFF)
                        ].append((fingerprint, len(normalized), document_id))
                    decision = decision_row(candidate, "selected", None, document_id)
                decision_bytes = (stable_json(decision) + "\n").encode("utf-8")
                decision_handle.write(decision_bytes)
                decision_digest.update(decision_bytes)
            export_handle.flush()
            decision_handle.flush()
            os.fsync(export_handle.fileno())
            os.fsync(decision_handle.fileno())
        except Exception:
            export_temporary.unlink(missing_ok=True)
            decision_temporary.unlink(missing_ok=True)
            raise
    if not selected:
        export_temporary.unlink(missing_ok=True)
        decision_temporary.unlink(missing_ok=True)
        raise ValueError("Sidepus compilation selected no documents")
    export_sha256 = export_digest.hexdigest()
    decision_sha256 = decision_digest.hexdigest()
    manifest = attach_digest({
        "schema": MANIFEST_SCHEMA,
        "source_lock_digest": lock_digest,
        "source_lock_file_sha256": file_sha256(lock_path),
        "selected": selected,
        "selection": {
            "mode": "broad-observational-pretraining",
            "instructions_generated": 0,
            "exact_deduplication": True,
            "normalized_deduplication": True,
            "near_duplicate_fingerprint": "simhash64-token-5gram",
            "near_duplicate_hamming": near_threshold,
            "quality_filters": [
                "raw-object-deduplication", "minimum-length", "secret-pattern", "control-density",
                "declared-training-excluded", "textual-density",
                "repeated-line-boilerplate", "token-diversity",
            ],
        },
        "counts": {
            "candidates": candidate_count,
            "selected": len(selected),
            "rejected": candidate_count - len(selected),
            "rejected_by_reason": dict(sorted(reason_counts.items())),
            "modalities": dict(sorted(modality_counts.items())),
            "sources": dict(sorted(source_counts.items())),
        },
        "decision_ledger_sha256": decision_sha256,
        "claim_boundary": (
            "The export teaches provenance-bound text and deterministic metadata/bytefield observations. "
            "Binary observations do not claim learned pixel, waveform, infrared, or ultraviolet perception."
        ),
    }, "manifest_digest")
    receipt = attach_digest({
        "schema": RECEIPT_SCHEMA,
        "manifest_digest": manifest["manifest_digest"],
        "sha256": export_sha256,
        "bytes": export_size,
        "documents": len(selected),
        "decision_ledger_sha256": decision_sha256,
    }, "receipt_digest")
    os.replace(export_temporary, output / "train.jsonl")
    os.replace(decision_temporary, output / "dedupe-decisions.jsonl")
    atomic_json(output / "diet-manifest.json", manifest)
    atomic_json(output / "export-receipt.json", receipt)
    return {"manifest": manifest, "receipt": receipt, "output": str(output)}


def load_sidepus_export(export_dir: pathlib.Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    export_dir = export_dir.resolve()
    manifest_path = export_dir / "diet-manifest.json"
    receipt_path = export_dir / "export-receipt.json"
    export_path = export_dir / "train.jsonl"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if manifest.get("schema") != MANIFEST_SCHEMA or receipt.get("schema") != RECEIPT_SCHEMA:
        raise ValueError(f"unsupported Sidepus export in {export_dir}")
    manifest_digest = verify_embedded_digest(manifest, "manifest_digest", "diet manifest")
    receipt_digest = verify_embedded_digest(receipt, "receipt_digest", "export receipt")
    if receipt.get("manifest_digest") != manifest_digest:
        raise ValueError("Sidepus export receipt names a different manifest")
    if (
        file_sha256(export_path) != receipt.get("sha256")
        or export_path.stat().st_size != int(receipt.get("bytes", -1))
    ):
        raise ValueError("Sidepus export bytes do not match their receipt")
    selected = {item["document_id"]: item for item in manifest.get("selected", [])}
    rows = []
    seen = set()
    with export_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            identity = row.get("document_id")
            selection = selected.get(identity)
            if selection is None or identity in seen or row.get("selection") != selection:
                raise ValueError(
                    "Sidepus export contains an unknown, duplicate, or altered selection"
                )
            seen.add(identity)
            text = str(row.get("text", ""))
            if not text or digest_bytes(text.encode("utf-8")) != selection.get("object_digest"):
                raise ValueError(f"Sidepus text digest mismatch for {identity}")
            rows.append(row)
    if len(rows) != len(selected) or len(rows) != int(receipt.get("documents", -1)):
        raise ValueError("Sidepus export does not exactly cover its selected manifest")
    evidence = {
        "path": str(export_dir),
        "manifest_digest": manifest_digest,
        "manifest_file_sha256": file_sha256(manifest_path),
        "export_receipt_digest": receipt_digest,
        "export_receipt_file_sha256": file_sha256(receipt_path),
        "export_sha256": receipt["sha256"],
        "documents": len(rows),
    }
    return rows, evidence


def verify_export(export_dir: pathlib.Path) -> dict[str, Any]:
    export_dir = export_dir.resolve()
    manifest_path = export_dir / "diet-manifest.json"
    receipt_path = export_dir / "export-receipt.json"
    export_path = export_dir / "train.jsonl"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if manifest.get("schema") != MANIFEST_SCHEMA or receipt.get("schema") != RECEIPT_SCHEMA:
        raise ValueError(f"unsupported Sidepus export in {export_dir}")
    manifest_digest = verify_embedded_digest(manifest, "manifest_digest", "diet manifest")
    receipt_digest = verify_embedded_digest(receipt, "receipt_digest", "export receipt")
    if receipt.get("manifest_digest") != manifest_digest:
        raise ValueError("Sidepus export receipt names a different manifest")
    if (
        file_sha256(export_path) != receipt.get("sha256")
        or export_path.stat().st_size != int(receipt.get("bytes", -1))
    ):
        raise ValueError("Sidepus export bytes do not match their receipt")
    selected = {item["document_id"]: item for item in manifest.get("selected", [])}
    seen = set()
    modalities = Counter()
    with export_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            identity = row.get("document_id")
            selection = selected.get(identity)
            if selection is None or identity in seen or row.get("selection") != selection:
                raise ValueError(
                    "Sidepus export contains an unknown, duplicate, or altered selection"
                )
            seen.add(identity)
            text = str(row.get("text", ""))
            if not text or digest_bytes(text.encode("utf-8")) != selection.get("object_digest"):
                raise ValueError(f"Sidepus text digest mismatch for {identity}")
            modalities[row.get("source", {}).get("modality", "unknown")] += 1
    if len(seen) != len(selected) or len(seen) != int(receipt.get("documents", -1)):
        raise ValueError("Sidepus export does not exactly cover its selected manifest")
    evidence = {
        "path": str(export_dir),
        "manifest_digest": manifest_digest,
        "manifest_file_sha256": file_sha256(manifest_path),
        "export_receipt_digest": receipt_digest,
        "export_receipt_file_sha256": file_sha256(receipt_path),
        "export_sha256": receipt["sha256"],
        "documents": len(seen),
    }
    evidence["modalities"] = dict(sorted(modalities.items()))
    return evidence


def initial_plan(local_source: pathlib.Path) -> dict[str, Any]:
    return attach_digest({
        "schema": PLAN_SCHEMA,
        "sources": [{
            "id": "archie-local-foundry",
            "type": "local",
            "path": str(local_source.resolve()),
            "root_label": "archie-local-foundry",
            "license": "repository-governed",
            "exclude": ["returns/**", "**/__pycache__/**", "**/*.pt", "**/*.u16"],
        }],
        "limits": {
            "max_files": 100_000,
            "max_source_bytes": 8 << 30,
            "max_object_bytes": 2 << 30,
            "max_member_bytes": 64 << 20,
            "max_archive_members": 250_000,
            "max_archive_expanded_bytes": 16 << 30,
            "max_document_characters": 2 << 20,
            "max_documents_per_source": 100_000,
            "min_document_characters": 96,
            "near_duplicate_hamming": 3,
        },
    }, "plan_digest")


def selftest() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = pathlib.Path(temporary)
        source = root / "source"
        source.mkdir()
        repeated = "Provenance makes broad observational training reproducible and inspectable.\n" * 8
        (source / "alpha.md").write_text(repeated, encoding="utf-8")
        (source / "duplicate.md").write_text(repeated.upper(), encoding="utf-8")
        (source / "kernel.c").write_text(
            "int verify_receipt(const char *digest) { return digest && digest[0]; }\n" * 8,
            encoding="utf-8",
        )
        png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8 + struct.pack(">II", 16, 8) + b"\x00" * 64
        (source / "infrared-frame.png").write_bytes(png)
        (source / "infrared-frame-copy.png").write_bytes(png)
        wav_path = source / "field-recording.wav"
        with wave.open(str(wav_path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(8000)
            handle.writeframes(b"\x00\x00" * 800)
        archive = source / "source.zip"
        with zipfile.ZipFile(archive, "w") as handle:
            handle.writestr("nested/readme.txt", "Archive observation with deterministic member provenance.\n" * 8)
        plan_path = root / "source-plan.json"
        atomic_json(plan_path, initial_plan(source))
        state = root / "state"
        lock = freeze_plan(plan_path, state)
        assert lock["totals"]["objects"] == 7
        first = compile_lock(state / "source-lock.json", root / "export-a")
        second = compile_lock(state / "source-lock.json", root / "export-b")
        assert first["manifest"]["manifest_digest"] == second["manifest"]["manifest_digest"]
        assert (root / "export-a" / "train.jsonl").read_bytes() == (root / "export-b" / "train.jsonl").read_bytes()
        evidence = verify_export(root / "export-a")
        assert evidence["documents"] >= 5
        assert first["manifest"]["counts"]["rejected_by_reason"]["normalized-duplicate"] == 1
        assert first["manifest"]["counts"]["rejected_by_reason"]["raw-object-duplicate"] == 1
        assert first["manifest"]["selection"]["instructions_generated"] == 0
        print(json.dumps({"selftest": "passed", **evidence}, indent=2, sort_keys=True))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selftest", action="store_true")
    subparsers = parser.add_subparsers(dest="command")
    init_parser = subparsers.add_parser("init")
    init_parser.add_argument("--output", required=True)
    init_parser.add_argument("--local-source", default=str(pathlib.Path(__file__).resolve().parents[2]))
    fetch_parser = subparsers.add_parser("fetch")
    fetch_parser.add_argument("--plan", required=True)
    fetch_parser.add_argument("--state-dir", required=True)
    fetch_parser.add_argument("--reuse", action="store_true")
    seal_parser = subparsers.add_parser("seal")
    seal_parser.add_argument("--plan", required=True)
    seal_parser.add_argument("--output")
    compile_parser = subparsers.add_parser("compile")
    compile_parser.add_argument("--lock", required=True)
    compile_parser.add_argument("--output-dir", required=True)
    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("--export-dir", required=True)
    args = parser.parse_args()
    if args.selftest:
        selftest()
    elif args.command == "init":
        output = pathlib.Path(args.output).resolve()
        if output.exists():
            parser.error(f"refusing to overwrite {output}")
        atomic_json(output, initial_plan(pathlib.Path(args.local_source)))
        print(output)
    elif args.command == "fetch":
        lock = freeze_plan(pathlib.Path(args.plan), pathlib.Path(args.state_dir), args.reuse)
        print(json.dumps(lock, indent=2, sort_keys=True))
    elif args.command == "seal":
        plan = pathlib.Path(args.plan).resolve()
        output = pathlib.Path(args.output).resolve() if args.output else plan
        sealed = seal_plan(plan, output)
        print(json.dumps(sealed, indent=2, sort_keys=True))
    elif args.command == "compile":
        result = compile_lock(pathlib.Path(args.lock), pathlib.Path(args.output_dir))
        print(json.dumps(result, indent=2, sort_keys=True))
    elif args.command == "verify":
        print(json.dumps(verify_export(pathlib.Path(args.export_dir)), indent=2, sort_keys=True))
    else:
        parser.error("choose init, seal, fetch, compile, or verify, or pass --selftest")


if __name__ == "__main__":
    main()
