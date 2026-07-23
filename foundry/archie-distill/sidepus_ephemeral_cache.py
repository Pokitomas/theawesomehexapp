#!/usr/bin/env python3
"""Bounded verified cache for Sidepus objects larger than local storage.

Objects are addressed by expected SHA-256. A record may point at a permanent local object,
a remote HTTP object, or an HTTP byte range. Cache eviction is LRU and never removes a
pinned object. The cache stores no authority: rights and curriculum decisions remain in the
sealed inventory and plan.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import pathlib
import sqlite3
import tempfile
import time
import urllib.request
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from typing import Any

CACHE_SCHEMA = "sidepus-ephemeral-object-cache/v1"


def _digest_file(path: pathlib.Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(chunk):
            digest.update(block)
    return digest.hexdigest()


def _validate_digest(value: str) -> str:
    digest = str(value).lower().strip()
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise ValueError(f"invalid SHA-256 digest: {value!r}")
    return digest


@dataclass(frozen=True)
class FetchSpec:
    url: str
    offset: int | None = None
    length: int | None = None
    headers: tuple[tuple[str, str], ...] = ()

    @classmethod
    def from_item(cls, item: Mapping[str, Any]) -> "FetchSpec | None":
        raw = item.get("fetch") or item.get("remote")
        if not isinstance(raw, Mapping) or not raw.get("url"):
            return None
        offset = raw.get("offset")
        length = raw.get("length")
        if (offset is None) != (length is None):
            raise ValueError("remote byte range requires both offset and length")
        if offset is not None and (int(offset) < 0 or int(length) < 1):
            raise ValueError("remote byte range is invalid")
        headers = raw.get("headers") if isinstance(raw.get("headers"), Mapping) else {}
        return cls(
            url=str(raw["url"]),
            offset=int(offset) if offset is not None else None,
            length=int(length) if length is not None else None,
            headers=tuple(sorted((str(k), str(v)) for k, v in headers.items())),
        )


class EphemeralObjectCache:
    """Read permanent objects or fetch verified objects into a bounded LRU cache."""

    def __init__(
        self,
        *,
        permanent_state_dir: pathlib.Path,
        cache_dir: pathlib.Path,
        maximum_bytes: int,
        maximum_object_bytes: int = 4 << 30,
        verify_permanent: bool = True,
        user_agent: str = "Sidepus-Ephemeral/1.0 (+https://github.com/Pokitomas/theawesomehexapp)",
    ) -> None:
        if maximum_bytes < 1 or maximum_object_bytes < 1:
            raise ValueError("cache byte limits must be positive")
        self.permanent_root = permanent_state_dir.expanduser().resolve() / "objects" / "sha256"
        self.cache_root = cache_dir.expanduser().resolve()
        self.object_root = self.cache_root / "objects" / "sha256"
        self.tmp_root = self.cache_root / "tmp"
        self.object_root.mkdir(parents=True, exist_ok=True)
        self.tmp_root.mkdir(parents=True, exist_ok=True)
        self.maximum_bytes = int(maximum_bytes)
        self.maximum_object_bytes = int(maximum_object_bytes)
        self.verify_permanent = verify_permanent
        self.user_agent = user_agent
        self._verified_permanent: set[str] = set()
        self._pins: dict[str, int] = {}
        self.db = sqlite3.connect(self.cache_root / "cache.sqlite3", timeout=60, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA busy_timeout=60000")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS objects(
              sha256 TEXT PRIMARY KEY,
              bytes INTEGER NOT NULL,
              relative_path TEXT NOT NULL,
              last_access REAL NOT NULL,
              fetch_json TEXT
            );
            CREATE INDEX IF NOT EXISTS objects_lru ON objects(last_access, sha256);
            CREATE TABLE IF NOT EXISTS events(
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              created_at REAL NOT NULL,
              kind TEXT NOT NULL,
              payload_json TEXT NOT NULL
            );
            """
        )
        self._reconcile()

    def close(self) -> None:
        self.db.close()

    def __enter__(self) -> "EphemeralObjectCache":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    @staticmethod
    def _relative(digest: str) -> pathlib.Path:
        value = _validate_digest(digest)
        return pathlib.Path(value[:2]) / value[2:]

    def permanent_path(self, digest: str) -> pathlib.Path:
        return self.permanent_root / self._relative(digest)

    def cache_path(self, digest: str) -> pathlib.Path:
        return self.object_root / self._relative(digest)

    def _event(self, kind: str, payload: Mapping[str, Any]) -> None:
        self.db.execute(
            "INSERT INTO events(created_at,kind,payload_json) VALUES(?,?,?)",
            (time.time(), kind, json.dumps(dict(payload), sort_keys=True, separators=(",", ":"))),
        )

    def _reconcile(self) -> None:
        rows = list(self.db.execute("SELECT sha256,relative_path,bytes FROM objects"))
        for row in rows:
            path = self.cache_root / str(row["relative_path"])
            if not path.is_file() or path.stat().st_size != int(row["bytes"]):
                self.db.execute("DELETE FROM objects WHERE sha256=?", (row["sha256"],))
        self._evict()

    def _touch(self, digest: str) -> None:
        self.db.execute("UPDATE objects SET last_access=? WHERE sha256=?", (time.time(), digest))

    def _cached_bytes(self) -> int:
        return int(self.db.execute("SELECT COALESCE(SUM(bytes),0) FROM objects").fetchone()[0])

    def _evict(self) -> None:
        current = self._cached_bytes()
        if current <= self.maximum_bytes:
            return
        for row in self.db.execute("SELECT sha256,bytes,relative_path FROM objects ORDER BY last_access,sha256"):
            digest = str(row["sha256"])
            if self._pins.get(digest, 0) > 0:
                continue
            path = self.cache_root / str(row["relative_path"])
            path.unlink(missing_ok=True)
            self.db.execute("DELETE FROM objects WHERE sha256=?", (digest,))
            current -= int(row["bytes"])
            self._event("evicted", {"sha256": digest, "bytes": int(row["bytes"])})
            if current <= self.maximum_bytes:
                break
        if current > self.maximum_bytes:
            raise RuntimeError("cache limit cannot be satisfied because all remaining objects are pinned")

    def _verify_permanent(self, digest: str, path: pathlib.Path) -> None:
        if self.verify_permanent and digest not in self._verified_permanent:
            observed = _digest_file(path)
            if observed != digest:
                raise RuntimeError(f"permanent Sidepus object digest mismatch: {digest} != {observed}")
            self._verified_permanent.add(digest)

    def _download(self, digest: str, spec: FetchSpec) -> pathlib.Path:
        headers = {"User-Agent": self.user_agent, "Accept-Encoding": "identity", **dict(spec.headers)}
        expected_bytes: int | None = None
        if spec.offset is not None and spec.length is not None:
            headers["Range"] = f"bytes={spec.offset}-{spec.offset + spec.length - 1}"
            expected_bytes = spec.length
        request = urllib.request.Request(spec.url, headers=headers)
        final = self.cache_path(digest)
        final.parent.mkdir(parents=True, exist_ok=True)
        sha = hashlib.sha256()
        total = 0
        with urllib.request.urlopen(request, timeout=180) as response, tempfile.NamedTemporaryFile(
            dir=self.tmp_root, delete=False
        ) as output:
            temporary = pathlib.Path(output.name)
            raw_status = getattr(response, "status", None) or response.getcode() or 200
            status = int(raw_status)
            if expected_bytes is not None and status != 206:
                temporary.unlink(missing_ok=True)
                raise RuntimeError(f"range request returned HTTP {status}, expected 206")
            try:
                while block := response.read(1 << 20):
                    total += len(block)
                    if total > self.maximum_object_bytes:
                        raise RuntimeError("remote object exceeded maximum_object_bytes")
                    output.write(block)
                    sha.update(block)
                output.flush()
                os.fsync(output.fileno())
            except Exception:
                temporary.unlink(missing_ok=True)
                raise
        if expected_bytes is not None and total != expected_bytes:
            temporary.unlink(missing_ok=True)
            raise RuntimeError(f"remote byte range length mismatch: {total} != {expected_bytes}")
        observed = sha.hexdigest()
        if observed != digest:
            temporary.unlink(missing_ok=True)
            raise RuntimeError(f"remote Sidepus object digest mismatch: {digest} != {observed}")
        os.replace(temporary, final)
        relative = final.relative_to(self.cache_root).as_posix()
        self.db.execute(
            "INSERT OR REPLACE INTO objects(sha256,bytes,relative_path,last_access,fetch_json) VALUES(?,?,?,?,?)",
            (digest, total, relative, time.time(), json.dumps(spec.__dict__, sort_keys=True)),
        )
        self._event("fetched", {"sha256": digest, "bytes": total, "url": spec.url})
        self._evict()
        return final

    def path_for(self, item: Mapping[str, Any]) -> pathlib.Path:
        digest = _validate_digest(str(item.get("sha256", "")))
        permanent = self.permanent_path(digest)
        if permanent.is_file():
            self._verify_permanent(digest, permanent)
            return permanent
        cached = self.cache_path(digest)
        if cached.is_file():
            if cached.stat().st_size > self.maximum_object_bytes or _digest_file(cached) != digest:
                cached.unlink(missing_ok=True)
                self.db.execute("DELETE FROM objects WHERE sha256=?", (digest,))
                raise RuntimeError(f"cached Sidepus object failed verification: {digest}")
            self._touch(digest)
            return cached
        spec = FetchSpec.from_item(item)
        if spec is None:
            raise FileNotFoundError(f"Sidepus object is absent and has no fetch descriptor: {digest}")
        return self._download(digest, spec)

    def read(self, item: Mapping[str, Any]) -> bytes:
        digest = _validate_digest(str(item.get("sha256", "")))
        path = self.path_for(item)
        payload = path.read_bytes()
        if hashlib.sha256(payload).hexdigest() != digest:
            raise RuntimeError(f"Sidepus object changed while being read: {digest}")
        return payload

    def pin(self, digest: str) -> None:
        value = _validate_digest(digest)
        self._pins[value] = self._pins.get(value, 0) + 1

    def unpin(self, digest: str) -> None:
        value = _validate_digest(digest)
        count = self._pins.get(value, 0)
        if count <= 1:
            self._pins.pop(value, None)
        else:
            self._pins[value] = count - 1
        self._evict()

    @contextlib.contextmanager
    def pinned(self, items: Iterable[Mapping[str, Any]]) -> Iterator[None]:
        digests = sorted({_validate_digest(str(item.get("sha256", ""))) for item in items})
        for digest in digests:
            self.pin(digest)
        try:
            yield
        finally:
            for digest in reversed(digests):
                self.unpin(digest)

    def snapshot(self) -> dict[str, Any]:
        return {
            "schema": CACHE_SCHEMA,
            "cache_dir": str(self.cache_root),
            "maximum_bytes": self.maximum_bytes,
            "cached_bytes": self._cached_bytes(),
            "cached_objects": int(self.db.execute("SELECT COUNT(*) FROM objects").fetchone()[0]),
            "pinned_objects": len(self._pins),
        }
