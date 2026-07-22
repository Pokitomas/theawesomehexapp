#!/usr/bin/env python3
"""Durable content-addressed catalog for Sidepus web archives."""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import pathlib
import shutil
import sqlite3
import tempfile
import time
from collections.abc import Iterable, Iterator
from typing import Any

SCHEMA = "sidepus-archive-catalog/v2"
SCHEMA_VERSION = 2
JOB_STATES = {"pending", "leased", "complete", "failed", "quarantined"}


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest_json(value: Any) -> str:
    return hashlib.sha256(stable_json(value).encode("utf-8")).hexdigest()


def sha256_file(path: pathlib.Path, chunk_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(chunk_size):
            digest.update(block)
    return digest.hexdigest()


def atomic_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = pathlib.Path(handle.name)
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


class Catalog:
    """SQLite ledger plus immutable SHA-256 object store.

    SQLite is the authority for one worker/state directory. Horizontal workers use
    immutable job shards and merge content-addressed outputs; they do not share one
    SQLite file over a network filesystem.
    """

    def __init__(self, state_dir: pathlib.Path) -> None:
        self.root = state_dir.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.objects = self.root / "objects" / "sha256"
        self.objects.mkdir(parents=True, exist_ok=True)
        self.temporary = self.root / "tmp"
        self.temporary.mkdir(parents=True, exist_ok=True)
        self.database_path = self.root / "catalog.sqlite3"
        self.connection = sqlite3.connect(self.database_path, timeout=60, isolation_level=None)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=FULL")
        self.connection.execute("PRAGMA foreign_keys=ON")
        self.connection.execute("PRAGMA busy_timeout=60000")
        self._create_schema()

    def close(self) -> None:
        self.connection.close()

    def __enter__(self) -> "Catalog":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    @contextlib.contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            yield self.connection
        except Exception:
            self.connection.execute("ROLLBACK")
            raise
        else:
            self.connection.execute("COMMIT")

    def _create_schema(self) -> None:
        db = self.connection
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS jobs (
                job_id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL,
                adapter TEXT NOT NULL,
                kind TEXT NOT NULL,
                locator_json TEXT NOT NULL,
                expected_sha256 TEXT,
                expected_bytes INTEGER,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                lease_owner TEXT,
                lease_until REAL,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status, job_id);
            CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs(lease_until);
            CREATE TABLE IF NOT EXISTS objects (
                sha256 TEXT PRIMARY KEY,
                bytes INTEGER NOT NULL,
                relative_path TEXT NOT NULL,
                media_type TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS job_objects (
                job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
                sha256 TEXT NOT NULL REFERENCES objects(sha256),
                role TEXT NOT NULL,
                PRIMARY KEY(job_id, sha256, role)
            );
            CREATE TABLE IF NOT EXISTS warc_records (
                object_sha256 TEXT NOT NULL REFERENCES objects(sha256) ON DELETE CASCADE,
                record_ordinal INTEGER NOT NULL,
                warc_type TEXT,
                target_uri TEXT,
                warc_date TEXT,
                record_id TEXT,
                payload_digest TEXT,
                block_digest TEXT,
                content_type TEXT,
                content_length INTEGER NOT NULL,
                decompressed_offset INTEGER NOT NULL,
                source_json TEXT NOT NULL,
                PRIMARY KEY(object_sha256, record_ordinal)
            );
            CREATE INDEX IF NOT EXISTS warc_target_idx ON warc_records(target_uri);
            CREATE INDEX IF NOT EXISTS warc_payload_idx ON warc_records(payload_digest);
            CREATE TABLE IF NOT EXISTS policies (
                kind TEXT PRIMARY KEY,
                schema TEXT NOT NULL,
                digest TEXT NOT NULL,
                value_json TEXT NOT NULL,
                installed_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                kind TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                previous_digest TEXT,
                event_digest TEXT NOT NULL UNIQUE
            );
            """
        )
        current = db.execute("SELECT value_json FROM metadata WHERE key='schema_version'").fetchone()
        if current is None:
            db.execute(
                "INSERT INTO metadata(key, value_json) VALUES(?, ?)",
                ("schema_version", json.dumps(SCHEMA_VERSION)),
            )
        elif json.loads(current[0]) != SCHEMA_VERSION:
            raise RuntimeError("Sidepus catalog schema version mismatch")
        db.execute(
            "INSERT OR REPLACE INTO metadata(key, value_json) VALUES(?, ?)",
            ("schema", json.dumps(SCHEMA)),
        )

    def append_event(self, kind: str, payload: dict[str, Any]) -> str:
        row = self.connection.execute(
            "SELECT event_digest FROM events ORDER BY sequence DESC LIMIT 1"
        ).fetchone()
        previous = str(row[0]) if row else None
        body = {"created_at": utc_now(), "kind": kind, "payload": payload, "previous_digest": previous}
        event_digest = digest_json(body)
        self.connection.execute(
            "INSERT INTO events(created_at, kind, payload_json, previous_digest, event_digest) "
            "VALUES(?, ?, ?, ?, ?)",
            (body["created_at"], kind, stable_json(payload), previous, event_digest),
        )
        return event_digest

    def install_policy(self, kind: str, value: dict[str, Any]) -> str:
        schema = str(value.get("schema", ""))
        if not schema:
            raise ValueError("policy requires a schema")
        digest = digest_json(value)
        with self.transaction() as db:
            existing = db.execute("SELECT digest FROM policies WHERE kind=?", (kind,)).fetchone()
            if existing is not None and str(existing[0]) != digest:
                raise ValueError(f"policy {kind!r} is already sealed with a different digest")
            db.execute(
                "INSERT OR REPLACE INTO policies(kind, schema, digest, value_json, installed_at) "
                "VALUES(?, ?, ?, ?, ?)",
                (kind, schema, digest, stable_json(value), utc_now()),
            )
        self.append_event("policy-installed", {"kind": kind, "schema": schema, "digest": digest})
        return digest

    def policy(self, kind: str) -> dict[str, Any] | None:
        row = self.connection.execute("SELECT value_json FROM policies WHERE kind=?", (kind,)).fetchone()
        return json.loads(row[0]) if row else None

    @staticmethod
    def canonical_job(job: dict[str, Any]) -> dict[str, Any]:
        required = {"source_id", "adapter", "kind", "locator"}
        missing = sorted(required - job.keys())
        if missing:
            raise ValueError(f"job is missing fields: {missing}")
        body = {
            "source_id": str(job["source_id"]),
            "adapter": str(job["adapter"]),
            "kind": str(job["kind"]),
            "locator": job["locator"],
            "expected_sha256": job.get("expected_sha256"),
            "expected_bytes": job.get("expected_bytes"),
        }
        body["job_id"] = str(job.get("job_id") or f"sidepus_job_{digest_json(body)[:32]}")
        return body

    def enqueue_jobs(self, jobs: Iterable[dict[str, Any]]) -> tuple[int, int]:
        inserted = reused = 0
        now = utc_now()
        with self.transaction() as db:
            for raw in jobs:
                job = self.canonical_job(raw)
                existing = db.execute("SELECT * FROM jobs WHERE job_id=?", (job["job_id"],)).fetchone()
                if existing is not None:
                    expected = {
                        "source_id": existing["source_id"],
                        "adapter": existing["adapter"],
                        "kind": existing["kind"],
                        "locator": json.loads(existing["locator_json"]),
                        "expected_sha256": existing["expected_sha256"],
                        "expected_bytes": existing["expected_bytes"],
                        "job_id": existing["job_id"],
                    }
                    if expected != job:
                        raise ValueError(f"job identity collision: {job['job_id']}")
                    reused += 1
                    continue
                db.execute(
                    "INSERT INTO jobs(job_id, source_id, adapter, kind, locator_json, "
                    "expected_sha256, expected_bytes, status, created_at, updated_at) "
                    "VALUES(?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
                    (
                        job["job_id"], job["source_id"], job["adapter"], job["kind"],
                        stable_json(job["locator"]), job["expected_sha256"],
                        job["expected_bytes"], now, now,
                    ),
                )
                inserted += 1
        self.append_event("jobs-enqueued", {"inserted": inserted, "reused": reused})
        return inserted, reused

    def release_expired_leases(self) -> int:
        now_epoch = time.time()
        with self.transaction() as db:
            cursor = db.execute(
                "UPDATE jobs SET status='pending', lease_owner=NULL, lease_until=NULL, updated_at=? "
                "WHERE status='leased' AND lease_until IS NOT NULL AND lease_until < ?",
                (utc_now(), now_epoch),
            )
        return int(cursor.rowcount)

    def lease_jobs(self, owner: str, limit: int, lease_seconds: int) -> list[dict[str, Any]]:
        if limit < 1 or lease_seconds < 1:
            raise ValueError("lease limit and duration must be positive")
        self.release_expired_leases()
        now_epoch = time.time()
        with self.transaction() as db:
            rows = db.execute(
                "SELECT * FROM jobs WHERE status='pending' ORDER BY job_id LIMIT ?", (limit,)
            ).fetchall()
            leased = []
            for row in rows:
                db.execute(
                    "UPDATE jobs SET status='leased', attempts=attempts+1, lease_owner=?, "
                    "lease_until=?, updated_at=? WHERE job_id=? AND status='pending'",
                    (owner, now_epoch + lease_seconds, utc_now(), row["job_id"]),
                )
                leased.append(self._job_from_row(row, status="leased", owner=owner))
        return leased

    @staticmethod
    def _job_from_row(
        row: sqlite3.Row, *, status: str | None = None, owner: str | None = None
    ) -> dict[str, Any]:
        return {
            "job_id": row["job_id"],
            "source_id": row["source_id"],
            "adapter": row["adapter"],
            "kind": row["kind"],
            "locator": json.loads(row["locator_json"]),
            "expected_sha256": row["expected_sha256"],
            "expected_bytes": row["expected_bytes"],
            "status": status or row["status"],
            "attempts": row["attempts"],
            "lease_owner": owner if owner is not None else row["lease_owner"],
        }

    def pending_jobs(self) -> list[dict[str, Any]]:
        rows = self.connection.execute("SELECT * FROM jobs WHERE status='pending' ORDER BY job_id").fetchall()
        return [self._job_from_row(row) for row in rows]

    def complete_job(self, job_id: str, owner: str, objects: list[tuple[str, str]]) -> None:
        with self.transaction() as db:
            row = db.execute("SELECT status, lease_owner FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            if row is None:
                raise ValueError(f"unknown job: {job_id}")
            if row["status"] != "leased" or row["lease_owner"] != owner:
                raise ValueError(f"job {job_id} is not leased by {owner}")
            for digest, role in objects:
                if db.execute("SELECT 1 FROM objects WHERE sha256=?", (digest,)).fetchone() is None:
                    raise ValueError(f"job output object is unregistered: {digest}")
                db.execute(
                    "INSERT OR IGNORE INTO job_objects(job_id, sha256, role) VALUES(?, ?, ?)",
                    (job_id, digest, role),
                )
            db.execute(
                "UPDATE jobs SET status='complete', lease_owner=NULL, lease_until=NULL, "
                "error=NULL, updated_at=? WHERE job_id=?",
                (utc_now(), job_id),
            )
        self.append_event("job-complete", {"job_id": job_id, "objects": objects})

    def fail_job(self, job_id: str, owner: str, error: str, *, quarantine: bool = False) -> None:
        status = "quarantined" if quarantine else "failed"
        with self.transaction() as db:
            row = db.execute("SELECT status, lease_owner FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            if row is None:
                raise ValueError(f"unknown job: {job_id}")
            if row["status"] != "leased" or row["lease_owner"] != owner:
                raise ValueError(f"job {job_id} is not leased by {owner}")
            db.execute(
                "UPDATE jobs SET status=?, lease_owner=NULL, lease_until=NULL, error=?, "
                "updated_at=? WHERE job_id=?",
                (status, error[-4000:], utc_now(), job_id),
            )
        self.append_event("job-failed", {"job_id": job_id, "status": status, "error": error[-1000:]})

    def retry_failed(self) -> int:
        with self.transaction() as db:
            cursor = db.execute(
                "UPDATE jobs SET status='pending', error=NULL, updated_at=? WHERE status='failed'",
                (utc_now(),),
            )
        count = int(cursor.rowcount)
        self.append_event("jobs-retried", {"count": count})
        return count

    def object_path(self, digest: str) -> pathlib.Path:
        if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
            raise ValueError("object digest must be lowercase SHA-256")
        return self.objects / digest[:2] / digest[2:]

    def import_object(
        self, source: pathlib.Path, *, media_type: str | None = None, move: bool = False
    ) -> tuple[str, int, pathlib.Path]:
        source = source.resolve()
        if not source.is_file():
            raise ValueError(f"object source does not exist: {source}")
        digest = sha256_file(source)
        size = source.stat().st_size
        destination = self.object_path(digest)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            if destination.stat().st_size != size or sha256_file(destination) != digest:
                raise RuntimeError(f"content-addressed object collision: {digest}")
            if move and source != destination:
                source.unlink()
        else:
            temporary = destination.with_suffix(".incoming")
            temporary.unlink(missing_ok=True)
            if move:
                os.replace(source, temporary)
            else:
                shutil.copyfile(source, temporary)
            with temporary.open("rb") as handle:
                os.fsync(handle.fileno())
            os.replace(temporary, destination)
        self.connection.execute(
            "INSERT OR IGNORE INTO objects(sha256, bytes, relative_path, media_type, created_at) "
            "VALUES(?, ?, ?, ?, ?)",
            (digest, size, destination.relative_to(self.root).as_posix(), media_type, utc_now()),
        )
        row = self.connection.execute("SELECT bytes, relative_path FROM objects WHERE sha256=?", (digest,)).fetchone()
        if row is None or int(row["bytes"]) != size or row["relative_path"] != destination.relative_to(self.root).as_posix():
            raise RuntimeError(f"catalog object mismatch: {digest}")
        return digest, size, destination

    def register_warc_records(
        self, object_sha256: str, records: Iterable[dict[str, Any]], source: dict[str, Any]
    ) -> int:
        count = 0
        with self.transaction() as db:
            if db.execute("SELECT 1 FROM objects WHERE sha256=?", (object_sha256,)).fetchone() is None:
                raise ValueError("WARC object must be registered before its records")
            for record in records:
                db.execute(
                    "INSERT OR REPLACE INTO warc_records(object_sha256, record_ordinal, warc_type, "
                    "target_uri, warc_date, record_id, payload_digest, block_digest, content_type, "
                    "content_length, decompressed_offset, source_json) "
                    "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        object_sha256, int(record["record_ordinal"]), record.get("warc_type"),
                        record.get("target_uri"), record.get("warc_date"), record.get("record_id"),
                        record.get("payload_digest"), record.get("block_digest"),
                        record.get("content_type"), int(record["content_length"]),
                        int(record["decompressed_offset"]), stable_json(source),
                    ),
                )
                count += 1
        self.append_event("warc-indexed", {"object_sha256": object_sha256, "records": count})
        return count

    def export_pending_shards(self, output_dir: pathlib.Path, shard_count: int) -> dict[str, Any]:
        if shard_count < 1:
            raise ValueError("shard count must be positive")
        output_dir = output_dir.resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        jobs = self.pending_jobs()
        handles = []
        paths = []
        try:
            for index in range(shard_count):
                path = output_dir / f"jobs-{index:05d}-of-{shard_count:05d}.jsonl"
                paths.append(path)
                handles.append(path.open("w", encoding="utf-8", newline="\n"))
            for job in jobs:
                index = int(hashlib.sha256(job["job_id"].encode()).hexdigest(), 16) % shard_count
                handles[index].write(stable_json(job) + "\n")
        finally:
            for handle in handles:
                handle.close()
        shards = [
            {"path": path.name, "sha256": sha256_file(path), "bytes": path.stat().st_size}
            for path in paths
        ]
        receipt = {
            "schema": "sidepus-job-shards/v2",
            "catalog": str(self.database_path),
            "jobs": len(jobs),
            "shards": shards,
            "created_at": utc_now(),
        }
        receipt["receipt_digest"] = digest_json(receipt)
        atomic_json(output_dir / "shards-receipt.json", receipt)
        return receipt

    def import_job_manifest(self, path: pathlib.Path) -> tuple[int, int]:
        jobs = []
        with path.resolve().open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                value = json.loads(line)
                if not isinstance(value, dict):
                    raise ValueError(f"job manifest line {line_number} is not an object")
                value.pop("status", None)
                value.pop("attempts", None)
                value.pop("lease_owner", None)
                jobs.append(value)
        return self.enqueue_jobs(jobs)

    def merge_from(self, source_state: pathlib.Path) -> dict[str, Any]:
        """Verify and merge one worker catalog as a content-addressed set union."""
        source_state = source_state.resolve()
        if source_state == self.root:
            raise ValueError("cannot merge a catalog into itself")
        copied = reused = records = jobs = links = 0
        with Catalog(source_state) as source:
            verification = source.verify(deep=True)
            if not verification["passed"]:
                raise ValueError(f"source catalog failed verification: {verification['failures']}")
            for row in source.connection.execute(
                "SELECT sha256, bytes, relative_path, media_type FROM objects ORDER BY sha256"
            ):
                source_path = source.root / row["relative_path"]
                existed = self.object_path(row["sha256"]).exists()
                digest, size, _ = self.import_object(
                    source_path, media_type=row["media_type"], move=False
                )
                if digest != row["sha256"] or size != int(row["bytes"]):
                    raise RuntimeError(f"merged object identity changed: {row['sha256']}")
                reused += int(existed)
                copied += int(not existed)

            source_jobs = source.connection.execute("SELECT * FROM jobs ORDER BY job_id").fetchall()
            canonical = [
                {
                    "job_id": row["job_id"],
                    "source_id": row["source_id"],
                    "adapter": row["adapter"],
                    "kind": row["kind"],
                    "locator": json.loads(row["locator_json"]),
                    "expected_sha256": row["expected_sha256"],
                    "expected_bytes": row["expected_bytes"],
                }
                for row in source_jobs
            ]
            inserted_jobs, _ = self.enqueue_jobs(canonical)
            jobs += inserted_jobs
            with self.transaction() as db:
                for row in source_jobs:
                    if row["status"] in {"complete", "failed", "quarantined"}:
                        db.execute(
                            "UPDATE jobs SET status=?, attempts=MAX(attempts, ?), error=?, "
                            "lease_owner=NULL, lease_until=NULL, updated_at=? WHERE job_id=?",
                            (row["status"], row["attempts"], row["error"], utc_now(), row["job_id"]),
                        )
                for row in source.connection.execute(
                    "SELECT job_id, sha256, role FROM job_objects ORDER BY job_id, sha256, role"
                ):
                    db.execute(
                        "INSERT OR IGNORE INTO job_objects(job_id, sha256, role) VALUES(?, ?, ?)",
                        (row["job_id"], row["sha256"], row["role"]),
                    )
                    links += 1
                for row in source.connection.execute(
                    "SELECT * FROM warc_records ORDER BY object_sha256, record_ordinal"
                ):
                    db.execute(
                        "INSERT OR IGNORE INTO warc_records(object_sha256, record_ordinal, warc_type, "
                        "target_uri, warc_date, record_id, payload_digest, block_digest, content_type, "
                        "content_length, decompressed_offset, source_json) "
                        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            row["object_sha256"], row["record_ordinal"], row["warc_type"],
                            row["target_uri"], row["warc_date"], row["record_id"],
                            row["payload_digest"], row["block_digest"], row["content_type"],
                            row["content_length"], row["decompressed_offset"], row["source_json"],
                        ),
                    )
                    records += 1
                for row in source.connection.execute(
                    "SELECT kind, schema, digest, value_json FROM policies ORDER BY kind"
                ):
                    existing = db.execute(
                        "SELECT digest FROM policies WHERE kind=?", (row["kind"],)
                    ).fetchone()
                    if existing is not None and existing["digest"] != row["digest"]:
                        raise ValueError(f"worker policy differs for {row['kind']}")
                    db.execute(
                        "INSERT OR IGNORE INTO policies(kind, schema, digest, value_json, installed_at) "
                        "VALUES(?, ?, ?, ?, ?)",
                        (row["kind"], row["schema"], row["digest"], row["value_json"], utc_now()),
                    )
            source_snapshot = source.snapshot()
        receipt = {
            "schema": "sidepus-catalog-merge/v2",
            "source_state": str(source_state),
            "source_snapshot": source_snapshot,
            "source_verification_digest": verification["verification_digest"],
            "objects_copied": copied,
            "objects_reused": reused,
            "jobs_inserted": jobs,
            "job_object_links_seen": links,
            "warc_records_seen": records,
            "destination_snapshot": self.snapshot(),
            "created_at": utc_now(),
        }
        receipt["receipt_digest"] = digest_json(receipt)
        self.append_event("catalog-merged", receipt)
        atomic_json(
            self.root / "merges" / f"{receipt['receipt_digest']}.json", receipt
        )
        return receipt

    def snapshot(self) -> dict[str, Any]:
        statuses = {
            row["status"]: int(row["count"])
            for row in self.connection.execute(
                "SELECT status, COUNT(*) AS count FROM jobs GROUP BY status ORDER BY status"
            )
        }
        objects = self.connection.execute(
            "SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM objects"
        ).fetchone()
        records = self.connection.execute("SELECT COUNT(*) AS count FROM warc_records").fetchone()
        policies = {
            row["kind"]: {"schema": row["schema"], "digest": row["digest"]}
            for row in self.connection.execute("SELECT kind, schema, digest FROM policies ORDER BY kind")
        }
        result = {
            "schema": SCHEMA,
            "state_dir": str(self.root),
            "jobs": statuses,
            "objects": int(objects["count"]),
            "object_bytes": int(objects["bytes"]),
            "warc_records": int(records["count"]),
            "policies": policies,
        }
        result["snapshot_digest"] = digest_json(result)
        return result

    def verify(self, *, deep: bool = False) -> dict[str, Any]:
        failures: list[str] = []
        for row in self.connection.execute("SELECT sha256, bytes, relative_path FROM objects ORDER BY sha256"):
            path = self.root / row["relative_path"]
            if not path.is_file() or path.stat().st_size != int(row["bytes"]):
                failures.append(f"missing-or-size:{row['sha256']}")
            elif deep and sha256_file(path) != row["sha256"]:
                failures.append(f"digest:{row['sha256']}")
        event_rows = self.connection.execute(
            "SELECT created_at, kind, payload_json, previous_digest, event_digest "
            "FROM events ORDER BY sequence"
        ).fetchall()
        previous = None
        for row in event_rows:
            body = {
                "created_at": row["created_at"],
                "kind": row["kind"],
                "payload": json.loads(row["payload_json"]),
                "previous_digest": previous,
            }
            if row["previous_digest"] != previous or digest_json(body) != row["event_digest"]:
                failures.append(f"event-chain:{row['event_digest']}")
                break
            previous = row["event_digest"]
        result = {**self.snapshot(), "deep": deep, "passed": not failures, "failures": failures}
        result["verification_digest"] = digest_json(result)
        return result
