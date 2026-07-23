#!/usr/bin/env python3
"""Streaming WARC/WACZ verification and construction for Sidepus."""
from __future__ import annotations

import base64
import contextlib
import email.utils
import gzip
import hashlib
import io
import os
import pathlib
import tempfile
import uuid
import zipfile
from collections.abc import Iterator
from typing import Any, BinaryIO

MAX_HEADER_BYTES = 1 << 20
MAX_RECORD_BYTES = 8 << 30
WARC_VERSIONS = {b"WARC/1.0", b"WARC/1.1"}


def _is_gzip(path: pathlib.Path) -> bool:
    with path.open("rb") as handle:
        return handle.read(2) == b"\x1f\x8b"


@contextlib.contextmanager
def open_warc_stream(path: pathlib.Path) -> Iterator[BinaryIO]:
    path = path.resolve()
    raw = path.open("rb")
    try:
        if _is_gzip(path):
            with gzip.GzipFile(fileobj=raw, mode="rb") as stream:
                yield stream
        else:
            yield raw
    finally:
        raw.close()


def _read_headers(stream: BinaryIO, first_line: bytes) -> dict[str, str]:
    if first_line.rstrip(b"\r\n") not in WARC_VERSIONS:
        raise ValueError(f"invalid WARC version line: {first_line[:80]!r}")
    headers: dict[str, str] = {}
    consumed = len(first_line)
    while True:
        line = stream.readline(MAX_HEADER_BYTES + 1)
        if not line:
            raise ValueError("truncated WARC header")
        consumed += len(line)
        if consumed > MAX_HEADER_BYTES:
            raise ValueError("WARC header exceeds maximum size")
        if line in {b"\n", b"\r\n"}:
            break
        if b":" not in line:
            raise ValueError(f"malformed WARC header line: {line[:80]!r}")
        name, value = line.split(b":", 1)
        key = name.decode("ascii", errors="strict").strip().lower()
        if key in headers:
            raise ValueError(f"duplicate WARC header: {key}")
        headers[key] = value.decode("utf-8", errors="replace").strip()
    return headers


def _digest_forms(name: str, digest: bytes) -> set[str]:
    return {
        digest.hex().lower(),
        base64.b32encode(digest).decode("ascii").rstrip("=").lower(),
    }


def _verify_declared_digest(declared: str | None, sha1: bytes, sha256: bytes, label: str) -> None:
    if not declared:
        return
    if ":" not in declared:
        raise ValueError(f"{label} has no algorithm prefix")
    algorithm, value = declared.split(":", 1)
    algorithm = algorithm.lower().strip()
    value = value.lower().strip()
    if algorithm == "sha1":
        valid = _digest_forms("sha1", sha1)
    elif algorithm == "sha256":
        valid = _digest_forms("sha256", sha256)
    else:
        return
    if value not in valid:
        raise ValueError(f"{label} mismatch")


def iter_warc_records(
    path: pathlib.Path, *, maximum_record_bytes: int = MAX_RECORD_BYTES,
) -> Iterator[dict[str, Any]]:
    """Yield verified WARC record metadata without loading record bodies into memory."""
    if maximum_record_bytes < 1:
        raise ValueError("maximum record bytes must be positive")
    with open_warc_stream(path) as stream:
        ordinal = 0
        while True:
            record_offset = int(stream.tell())
            first = stream.readline(MAX_HEADER_BYTES + 1)
            while first in {b"\n", b"\r\n"}:
                record_offset = int(stream.tell())
                first = stream.readline(MAX_HEADER_BYTES + 1)
            if not first:
                break
            if len(first) > MAX_HEADER_BYTES:
                raise ValueError("WARC version line exceeds maximum size")
            headers = _read_headers(stream, first)
            try:
                length = int(headers.get("content-length", ""))
            except ValueError as error:
                raise ValueError("WARC Content-Length is not an integer") from error
            if length < 0 or length > maximum_record_bytes:
                raise ValueError(f"WARC record length {length} exceeds policy")
            sha1 = hashlib.sha1()
            sha256 = hashlib.sha256()
            remaining = length
            while remaining:
                block = stream.read(min(1 << 20, remaining))
                if not block:
                    raise ValueError("truncated WARC record body")
                sha1.update(block)
                sha256.update(block)
                remaining -= len(block)
            _verify_declared_digest(
                headers.get("warc-block-digest"), sha1.digest(), sha256.digest(),
                "WARC-Block-Digest",
            )
            yield {
                "record_ordinal": ordinal,
                "decompressed_offset": record_offset,
                "warc_type": headers.get("warc-type"),
                "target_uri": headers.get("warc-target-uri"),
                "warc_date": headers.get("warc-date"),
                "record_id": headers.get("warc-record-id"),
                "payload_digest": headers.get("warc-payload-digest"),
                "block_digest": headers.get("warc-block-digest"),
                "computed_block_sha1": sha1.hexdigest(),
                "computed_block_sha256": sha256.hexdigest(),
                "content_type": headers.get("content-type"),
                "content_length": length,
            }
            ordinal += 1


def validate_warc(path: pathlib.Path, *, maximum_record_bytes: int = MAX_RECORD_BYTES) -> dict[str, Any]:
    records = list(iter_warc_records(path, maximum_record_bytes=maximum_record_bytes))
    if not records:
        raise ValueError("WARC contains no records")
    return {
        "records": records,
        "record_count": len(records),
        "warc_types": sorted({str(record["warc_type"]) for record in records}),
    }


def safe_wacz_members(path: pathlib.Path) -> list[str]:
    path = path.resolve()
    members: list[str] = []
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            pure = pathlib.PurePosixPath(info.filename)
            if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
                raise ValueError(f"unsafe WACZ member path: {info.filename}")
            lowered = info.filename.lower()
            if lowered.endswith((".warc", ".warc.gz")):
                members.append(info.filename)
    if not members:
        raise ValueError("WACZ contains no WARC members")
    return sorted(members)


def extract_wacz_warcs(
    path: pathlib.Path, output_dir: pathlib.Path, *, maximum_member_bytes: int = 32 << 30,
) -> list[pathlib.Path]:
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    extracted: list[pathlib.Path] = []
    with zipfile.ZipFile(path.resolve()) as archive:
        for member in safe_wacz_members(path):
            info = archive.getinfo(member)
            if info.file_size < 1 or info.file_size > maximum_member_bytes:
                raise ValueError(f"WACZ WARC member exceeds policy: {member}")
            suffix = ".warc.gz" if member.lower().endswith(".warc.gz") else ".warc"
            destination = output_dir / f"{hashlib.sha256(member.encode()).hexdigest()}{suffix}"
            with archive.open(info) as source, tempfile.NamedTemporaryFile(
                dir=output_dir, delete=False
            ) as target:
                temporary = pathlib.Path(target.name)
                total = 0
                while block := source.read(1 << 20):
                    total += len(block)
                    if total > maximum_member_bytes:
                        temporary.unlink(missing_ok=True)
                        raise ValueError(f"WACZ WARC member exceeds policy: {member}")
                    target.write(block)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, destination)
            extracted.append(destination)
    return extracted


def _http_header_bytes(status: int, reason: str, headers: dict[str, str], body_size: int) -> bytes:
    filtered = {
        key: value for key, value in headers.items()
        if key.lower() not in {"transfer-encoding", "content-length", "connection"}
    }
    filtered["Content-Length"] = str(body_size)
    lines = [f"HTTP/1.1 {status} {reason or ''}".rstrip()]
    lines.extend(f"{key}: {value}" for key, value in filtered.items())
    return ("\r\n".join(lines) + "\r\n\r\n").encode("utf-8", errors="replace")


def write_replay_warc(
    output: pathlib.Path, *, target_uri: str, capture_timestamp: str,
    status: int, reason: str, response_headers: dict[str, str], body_path: pathlib.Path,
    source_uri: str,
) -> dict[str, Any]:
    """Wrap a Wayback replay derivative in a standards-shaped WARC response record."""
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    body_path = body_path.resolve()
    body_size = body_path.stat().st_size
    http_headers = _http_header_bytes(status, reason, response_headers, body_size)
    payload_sha1 = hashlib.sha1()
    with body_path.open("rb") as body:
        while block := body.read(1 << 20):
            payload_sha1.update(block)
    payload_digest = base64.b32encode(payload_sha1.digest()).decode("ascii").rstrip("=")

    with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as message:
        message_path = pathlib.Path(message.name)
        message.write(http_headers)
        with body_path.open("rb") as body:
            while block := body.read(1 << 20):
                message.write(block)
        message.flush()
        os.fsync(message.fileno())
    message_size = message_path.stat().st_size
    block_sha1 = hashlib.sha1()
    with message_path.open("rb") as message:
        while block := message.read(1 << 20):
            block_sha1.update(block)
    block_digest = base64.b32encode(block_sha1.digest()).decode("ascii").rstrip("=")
    warc_date = capture_timestamp
    if len(capture_timestamp) == 14 and capture_timestamp.isdigit():
        warc_date = (
            f"{capture_timestamp[0:4]}-{capture_timestamp[4:6]}-{capture_timestamp[6:8]}T"
            f"{capture_timestamp[8:10]}:{capture_timestamp[10:12]}:{capture_timestamp[12:14]}Z"
        )
    elif not capture_timestamp.endswith("Z"):
        warc_date = email.utils.formatdate(usegmt=True)
    warc_headers = [
        "WARC/1.1",
        "WARC-Type: response",
        f"WARC-Record-ID: <urn:uuid:{uuid.uuid4()}>",
        f"WARC-Date: {warc_date}",
        f"WARC-Target-URI: {target_uri}",
        f"WARC-Source-URI: {source_uri}",
        "WARC-Profile: https://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/",
        f"WARC-Payload-Digest: sha1:{payload_digest}",
        f"WARC-Block-Digest: sha1:{block_digest}",
        "Content-Type: application/http; msgtype=response",
        f"Content-Length: {message_size}",
        "",
        "",
    ]
    with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as raw:
        raw_path = pathlib.Path(raw.name)
    try:
        with raw_path.open("wb") as raw_file:
            with gzip.GzipFile(fileobj=raw_file, mode="wb", compresslevel=6, mtime=0) as compressed:
                compressed.write("\r\n".join(warc_headers).encode("utf-8"))
                with message_path.open("rb") as message:
                    while block := message.read(1 << 20):
                        compressed.write(block)
                compressed.write(b"\r\n\r\n")
        os.replace(raw_path, output)
    finally:
        raw_path.unlink(missing_ok=True)
        message_path.unlink(missing_ok=True)
    return validate_warc(output)
