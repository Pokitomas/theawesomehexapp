#!/usr/bin/env python3
"""Historical archive discovery, ranged retrieval, and WARC ingestion for Sidepus."""
from __future__ import annotations

import fnmatch
import gzip
import hashlib
import json
import os
import pathlib
import socket
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections.abc import Iterable, Iterator
from typing import Any

from .catalog import Catalog, atomic_json, digest_json, sha256_file, stable_json, utc_now
from .warc import extract_wacz_warcs, validate_warc, write_replay_warc

COMMONCRAWL_INDEX_ROOT = "https://index.commoncrawl.org"
COMMONCRAWL_DATA_ROOT = "https://data.commoncrawl.org"
COMMONCRAWL_URL_INDEX_ROOT = "s3://commoncrawl/cc-index/table/cc-main/warc"
WAYBACK_CDX = "https://web.archive.org/cdx/search/cdx"
WAYBACK_REPLAY = "https://web.archive.org/web"
IA_METADATA = "https://archive.org/metadata"
IA_DOWNLOAD = "https://archive.org/download"
DEFAULT_USER_AGENT = "Sidepus-Archive/2.0 (+https://github.com/Pokitomas/theawesomehexapp)"
ARCHIVE_SUFFIXES = (".warc", ".warc.gz", ".arc", ".arc.gz", ".wacz")


def read_jsonl(path: pathlib.Path) -> Iterator[dict[str, Any]]:
    with path.resolve().open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{line_number} is not a JSON object")
            yield value


def _request(
    url: str, *, headers: dict[str, str] | None = None, timeout: int = 180,
    attempts: int = 6, minimum_delay: float = 1.0,
) -> urllib.response.addinfourl:
    last: Exception | None = None
    request_headers = {"User-Agent": DEFAULT_USER_AGENT, "Accept-Encoding": "identity"}
    request_headers.update(headers or {})
    for attempt in range(attempts):
        try:
            return urllib.request.urlopen(
                urllib.request.Request(url, headers=request_headers), timeout=timeout
            )
        except urllib.error.HTTPError as error:
            last = error
            if error.code not in {408, 425, 429, 500, 502, 503, 504}:
                raise
        except (urllib.error.URLError, TimeoutError, socket.timeout) as error:
            last = error
        if attempt + 1 < attempts:
            time.sleep(min(60.0, minimum_delay * (2 ** attempt)))
    raise RuntimeError(f"request failed after {attempts} attempts: {url}: {last}")


def _download(
    url: str, destination: pathlib.Path, *, byte_range: tuple[int, int] | None = None,
    expected_bytes: int | None = None, expected_sha256: str | None = None,
    expected_sha1: str | None = None, expected_md5: str | None = None,
    maximum_bytes: int = 64 << 30,
) -> dict[str, Any]:
    headers: dict[str, str] = {}
    if byte_range is not None:
        offset, length = byte_range
        if offset < 0 or length < 1:
            raise ValueError("HTTP byte range must be nonnegative and nonempty")
        headers["Range"] = f"bytes={offset}-{offset + length - 1}"
        expected_bytes = length
    destination.parent.mkdir(parents=True, exist_ok=True)
    sha256 = hashlib.sha256()
    sha1 = hashlib.sha1()
    md5 = hashlib.md5()
    total = 0
    with _request(url, headers=headers) as response, tempfile.NamedTemporaryFile(
        dir=destination.parent, delete=False
    ) as output:
        temporary = pathlib.Path(output.name)
        status = int(getattr(response, "status", response.getcode()))
        if byte_range is not None and status != 206:
            temporary.unlink(missing_ok=True)
            raise ValueError(f"range request returned HTTP {status}, expected 206")
        try:
            while block := response.read(1 << 20):
                total += len(block)
                if total > maximum_bytes:
                    raise ValueError(f"download exceeds maximum of {maximum_bytes} bytes")
                output.write(block)
                sha256.update(block)
                sha1.update(block)
                md5.update(block)
            output.flush()
            os.fsync(output.fileno())
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        response_headers = {key.lower(): value for key, value in response.headers.items()}
    checks = {
        "bytes": (expected_bytes, total),
        "sha256": (expected_sha256.lower() if expected_sha256 else None, sha256.hexdigest()),
        "sha1": (expected_sha1.lower() if expected_sha1 else None, sha1.hexdigest()),
        "md5": (expected_md5.lower() if expected_md5 else None, md5.hexdigest()),
    }
    for label, (expected, observed) in checks.items():
        if expected is not None and str(expected) != str(observed):
            temporary.unlink(missing_ok=True)
            raise ValueError(f"download {label} mismatch: expected {expected}, observed {observed}")
    os.replace(temporary, destination)
    return {
        "url": url,
        "status": status,
        "bytes": total,
        "sha256": sha256.hexdigest(),
        "sha1": sha1.hexdigest(),
        "md5": md5.hexdigest(),
        "headers": response_headers,
    }


def _write_jobs_receipt(path: pathlib.Path, adapter: str, jobs: list[dict[str, Any]], source: Any) -> None:
    receipt = {
        "schema": "sidepus-discovery-receipt/v2",
        "adapter": adapter,
        "source": source,
        "jobs": len(jobs),
        "job_ids_digest": digest_json(sorted(job["job_id"] for job in jobs)),
        "created_at": utc_now(),
    }
    receipt["receipt_digest"] = digest_json(receipt)
    atomic_json(path, receipt)


def discover_commoncrawl_cdx(
    catalog: Catalog, query_manifest: pathlib.Path, *, delay_seconds: float = 1.0,
    output_receipt: pathlib.Path | None = None,
) -> dict[str, Any]:
    """Discover precise Common Crawl WARC byte ranges through the CDXJ API.

    This path is for bounded URL/domain queries. Broad scans must use the Parquet
    URL Index path below; the public CDX service is deliberately rate limited.
    """
    jobs: list[dict[str, Any]] = []
    for query_index, query in enumerate(read_jsonl(query_manifest)):
        crawl = str(query.get("crawl", "")).strip()
        pattern = str(query.get("url", "")).strip()
        if not crawl.startswith("CC-MAIN-") or not pattern:
            raise ValueError("Common Crawl query requires crawl=CC-MAIN-* and url")
        params: list[tuple[str, str]] = [("url", pattern), ("output", "json")]
        for source_name, target_name in (
            ("match_type", "matchType"), ("filter", "filter"),
            ("collapse", "collapse"), ("from", "from"), ("to", "to"),
            ("page", "page"), ("page_size", "pageSize"), ("limit", "limit"),
        ):
            value = query.get(source_name)
            if value is None:
                continue
            if isinstance(value, list):
                params.extend((target_name, str(item)) for item in value)
            else:
                params.append((target_name, str(value)))
        endpoint = f"{COMMONCRAWL_INDEX_ROOT}/{urllib.parse.quote(crawl)}-index?{urllib.parse.urlencode(params)}"
        with _request(endpoint, minimum_delay=max(delay_seconds, 1.0)) as response:
            for line_number, raw in enumerate(response, 1):
                if not raw.strip():
                    continue
                row = json.loads(raw)
                required = {"filename", "offset", "length", "url"}
                if not required.issubset(row):
                    raise ValueError(f"Common Crawl result lacks {sorted(required - row.keys())}")
                locator = {
                    "url": f"{COMMONCRAWL_DATA_ROOT}/{str(row['filename']).lstrip('/')}",
                    "warc_filename": row["filename"],
                    "offset": int(row["offset"]),
                    "length": int(row["length"]),
                    "target_uri": row["url"],
                    "timestamp": row.get("timestamp"),
                    "payload_digest": row.get("digest"),
                    "mime": row.get("mime") or row.get("mime-detected"),
                    "status": row.get("status"),
                    "languages": row.get("languages"),
                    "crawl": crawl,
                    "discovery": {"query_index": query_index, "result_line": line_number},
                }
                jobs.append(Catalog.canonical_job({
                    "source_id": f"commoncrawl:{crawl}",
                    "adapter": "commoncrawl-cdx",
                    "kind": "commoncrawl-warc-range",
                    "locator": locator,
                    "expected_bytes": int(row["length"]),
                }))
        if delay_seconds > 0:
            time.sleep(delay_seconds)
    inserted, reused = catalog.enqueue_jobs(jobs)
    result = {"adapter": "commoncrawl-cdx", "discovered": len(jobs), "inserted": inserted, "reused": reused}
    if output_receipt:
        _write_jobs_receipt(output_receipt, "commoncrawl-cdx", jobs, str(query_manifest.resolve()))
    return result


def discover_commoncrawl_url_index(
    catalog: Catalog, *, crawl: str, sql_file: pathlib.Path, max_records: int,
    url_index_root: str = COMMONCRAWL_URL_INDEX_ROOT,
    output_receipt: pathlib.Path | None = None,
) -> dict[str, Any]:
    """Run a bounded SQL selection against Common Crawl's Parquet URL Index.

    The SQL file is intentionally user-supplied and is the future curriculum/content
    decision surface. This function provides infrastructure but no default subject mix.
    It must query the `cc_url_index` view and return the required locator columns.
    """
    if not crawl.startswith("CC-MAIN-"):
        raise ValueError("crawl must be an exact CC-MAIN-* release")
    if max_records < 1:
        raise ValueError("max_records must be positive")
    try:
        import duckdb  # type: ignore
    except ImportError as error:
        raise RuntimeError("DuckDB is required for Common Crawl bulk URL Index queries") from error
    sql = sql_file.resolve().read_text(encoding="utf-8").strip().rstrip(";")
    if not sql:
        raise ValueError("Common Crawl URL Index SQL is empty")
    source = f"{url_index_root.rstrip('/')}/crawl={crawl}/subset=warc/*.parquet"
    connection = duckdb.connect(database=":memory:")
    try:
        try:
            connection.execute("INSTALL httpfs")
        except Exception:
            pass
        try:
            connection.execute("LOAD httpfs")
        except Exception:
            pass
        connection.execute("SET s3_region='us-east-1'")
        escaped = source.replace("'", "''")
        connection.execute(
            f"CREATE VIEW cc_url_index AS SELECT * FROM read_parquet('{escaped}', hive_partitioning=true)"
        )
        cursor = connection.execute(f"SELECT * FROM ({sql}) AS sidepus_selection LIMIT {max_records + 1}")
        names = [str(item[0]) for item in cursor.description]
        required = {"url", "warc_filename", "warc_record_offset", "warc_record_length"}
        if not required.issubset(names):
            raise ValueError(f"URL Index SQL must return columns {sorted(required)}")
        rows = cursor.fetchall()
        if len(rows) > max_records:
            raise ValueError("URL Index query exceeded max_records; narrow or explicitly raise the bound")
    finally:
        connection.close()
    jobs = []
    for values in rows:
        row = dict(zip(names, values, strict=True))
        filename = str(row["warc_filename"])
        locator = {
            "url": f"{COMMONCRAWL_DATA_ROOT}/{filename.lstrip('/')}",
            "warc_filename": filename,
            "offset": int(row["warc_record_offset"]),
            "length": int(row["warc_record_length"]),
            "target_uri": str(row["url"]),
            "timestamp": row.get("fetch_time") or row.get("warc_date"),
            "payload_digest": row.get("content_digest") or row.get("payload_digest"),
            "mime": row.get("content_mime_detected") or row.get("content_mime_type"),
            "status": row.get("fetch_status"),
            "languages": row.get("content_languages"),
            "crawl": crawl,
            "url_index_sql_sha256": hashlib.sha256(sql.encode()).hexdigest(),
        }
        jobs.append(Catalog.canonical_job({
            "source_id": f"commoncrawl:{crawl}",
            "adapter": "commoncrawl-url-index",
            "kind": "commoncrawl-warc-range",
            "locator": locator,
            "expected_bytes": int(row["warc_record_length"]),
        }))
    inserted, reused = catalog.enqueue_jobs(jobs)
    result = {"adapter": "commoncrawl-url-index", "discovered": len(jobs), "inserted": inserted, "reused": reused}
    if output_receipt:
        _write_jobs_receipt(output_receipt, "commoncrawl-url-index", jobs, {
            "crawl": crawl, "sql_sha256": hashlib.sha256(sql.encode()).hexdigest(), "root": url_index_root,
        })
    return result


def discover_wayback_cdx(
    catalog: Catalog, query_manifest: pathlib.Path, *, delay_seconds: float = 1.0,
    output_receipt: pathlib.Path | None = None,
) -> dict[str, Any]:
    jobs: list[dict[str, Any]] = []
    for query_index, query in enumerate(read_jsonl(query_manifest)):
        pattern = str(query.get("url", "")).strip()
        if not pattern:
            raise ValueError("Wayback CDX query requires url")
        params: list[tuple[str, str]] = [
            ("url", pattern), ("output", "json"),
            ("fl", "timestamp,original,mimetype,statuscode,digest,length"),
        ]
        for source_name, target_name in (
            ("match_type", "matchType"), ("filter", "filter"),
            ("collapse", "collapse"), ("from", "from"), ("to", "to"),
            ("page", "page"), ("limit", "limit"),
        ):
            value = query.get(source_name)
            if value is None:
                continue
            if isinstance(value, list):
                params.extend((target_name, str(item)) for item in value)
            else:
                params.append((target_name, str(value)))
        endpoint = f"{WAYBACK_CDX}?{urllib.parse.urlencode(params)}"
        with _request(endpoint, minimum_delay=max(delay_seconds, 1.0)) as response:
            result = json.load(response)
        if not result:
            continue
        header = [str(value) for value in result[0]]
        for row_index, values in enumerate(result[1:], 1):
            row = dict(zip(header, values, strict=False))
            timestamp = str(row.get("timestamp", ""))
            original = str(row.get("original", ""))
            if len(timestamp) != 14 or not timestamp.isdigit() or not original:
                continue
            locator = {
                "url": f"{WAYBACK_REPLAY}/{timestamp}id_/{original}",
                "target_uri": original,
                "timestamp": timestamp,
                "mime": row.get("mimetype"),
                "status": row.get("statuscode"),
                "payload_digest": row.get("digest"),
                "reported_length": row.get("length"),
                "discovery": {"query_index": query_index, "result_row": row_index},
                "derivative_boundary": (
                    "Wayback CDX replay does not expose the original WARC byte range; Sidepus "
                    "wraps the public replay response into a new provenance-bound WARC record."
                ),
            }
            jobs.append(Catalog.canonical_job({
                "source_id": "internet-archive:wayback",
                "adapter": "wayback-cdx",
                "kind": "wayback-replay-warc",
                "locator": locator,
            }))
        if delay_seconds > 0:
            time.sleep(delay_seconds)
    inserted, reused = catalog.enqueue_jobs(jobs)
    result = {"adapter": "wayback-cdx", "discovered": len(jobs), "inserted": inserted, "reused": reused}
    if output_receipt:
        _write_jobs_receipt(output_receipt, "wayback-cdx", jobs, str(query_manifest.resolve()))
    return result


def discover_internet_archive_items(
    catalog: Catalog, item_manifest: pathlib.Path, *, output_receipt: pathlib.Path | None = None,
) -> dict[str, Any]:
    jobs: list[dict[str, Any]] = []
    for request in read_jsonl(item_manifest):
        item = str(request.get("item", "")).strip()
        if not item or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-" for character in item):
            raise ValueError(f"invalid Internet Archive item: {item!r}")
        includes = [str(value) for value in request.get("include", ["*.warc", "*.warc.gz", "*.arc", "*.arc.gz", "*.wacz"])]
        endpoint = f"{IA_METADATA}/{urllib.parse.quote(item, safe='')}"
        with _request(endpoint) as response:
            metadata = json.load(response)
        selected = []
        for entry in metadata.get("files", []):
            if not isinstance(entry, dict) or not entry.get("name"):
                continue
            name = str(entry["name"])
            if any(fnmatch.fnmatch(name, pattern) for pattern in includes):
                selected.append(entry)
        if not selected:
            raise ValueError(f"Internet Archive item {item} selected no archive files")
        for entry in selected:
            name = str(entry["name"])
            locator = {
                "url": f"{IA_DOWNLOAD}/{urllib.parse.quote(item, safe='')}/{urllib.parse.quote(name, safe='/')}",
                "item": item,
                "name": name,
                "format": entry.get("format"),
                "upstream_sha1": entry.get("sha1"),
                "upstream_md5": entry.get("md5"),
                "mtime": entry.get("mtime"),
            }
            size = int(entry["size"]) if str(entry.get("size", "")).isdigit() else None
            jobs.append(Catalog.canonical_job({
                "source_id": f"internet-archive-item:{item}",
                "adapter": "internet-archive-item",
                "kind": "http-archive-object",
                "locator": locator,
                "expected_bytes": size,
            }))
    inserted, reused = catalog.enqueue_jobs(jobs)
    result = {"adapter": "internet-archive-item", "discovered": len(jobs), "inserted": inserted, "reused": reused}
    if output_receipt:
        _write_jobs_receipt(output_receipt, "internet-archive-item", jobs, str(item_manifest.resolve()))
    return result


def discover_local_archives(
    catalog: Catalog, paths: Iterable[pathlib.Path], *, source_id: str = "local-web-archives",
) -> dict[str, Any]:
    jobs = []
    for root in paths:
        root = root.expanduser().resolve()
        candidates = [root] if root.is_file() else sorted(path for path in root.rglob("*") if path.is_file())
        for path in candidates:
            lowered = path.name.lower()
            if not lowered.endswith(ARCHIVE_SUFFIXES):
                continue
            jobs.append(Catalog.canonical_job({
                "source_id": source_id,
                "adapter": "local-archive",
                "kind": "local-archive-object",
                "locator": {"path": str(path), "bytes": path.stat().st_size},
                "expected_bytes": path.stat().st_size,
                "expected_sha256": sha256_file(path),
            }))
    inserted, reused = catalog.enqueue_jobs(jobs)
    return {"adapter": "local-archive", "discovered": len(jobs), "inserted": inserted, "reused": reused}


def _digest_equivalent(expected: Any, observed: Any) -> bool:
    if not expected or not observed:
        return True
    left = str(expected).lower().replace("sha1:", "").strip()
    right = str(observed).lower().replace("sha1:", "").strip()
    return left == right


def _index_warc_object(
    catalog: Catalog, object_sha256: str, path: pathlib.Path, source: dict[str, Any],
    logical_name: str | None = None,
) -> list[tuple[str, str]]:
    lowered = (logical_name or path.name).lower()
    outputs: list[tuple[str, str]] = [(object_sha256, "archive-object")]
    if lowered.endswith(".wacz") or zipfile.is_zipfile(path):
        members = extract_wacz_warcs(path, catalog.temporary / f"wacz-{object_sha256[:16]}")
        for member in members:
            digest, _, stored = catalog.import_object(member, media_type="application/warc", move=True)
            validation = validate_warc(stored)
            catalog.register_warc_records(digest, validation["records"], {**source, "wacz_sha256": object_sha256})
            outputs.append((digest, "wacz-warc-member"))
        return outputs
    if lowered.endswith((".warc", ".warc.gz")):
        validation = validate_warc(path)
        catalog.register_warc_records(object_sha256, validation["records"], source)
        return outputs
    if lowered.endswith((".arc", ".arc.gz")):
        try:
            from warcio.archiveiterator import ArchiveIterator  # type: ignore
        except ImportError as error:
            raise RuntimeError("warcio is required to index legacy ARC files") from error
        records = []
        opener = gzip.open if lowered.endswith(".gz") else open
        with opener(path, "rb") as stream:
            for ordinal, record in enumerate(ArchiveIterator(stream, arc2warc=True)):
                headers = record.rec_headers
                records.append({
                    "record_ordinal": ordinal,
                    "decompressed_offset": ordinal,
                    "warc_type": record.rec_type,
                    "target_uri": headers.get_header("WARC-Target-URI"),
                    "warc_date": headers.get_header("WARC-Date"),
                    "record_id": headers.get_header("WARC-Record-ID"),
                    "payload_digest": headers.get_header("WARC-Payload-Digest"),
                    "block_digest": headers.get_header("WARC-Block-Digest"),
                    "content_type": headers.get_header("Content-Type"),
                    "content_length": int(headers.get_header("Content-Length") or 0),
                })
        catalog.register_warc_records(object_sha256, records, {**source, "arc_converted_in_memory": True})
        return outputs
    raise ValueError(f"unsupported archive object: {path}")


def _process_job(catalog: Catalog, job: dict[str, Any]) -> list[tuple[str, str]]:
    locator = job["locator"]
    kind = job["kind"]
    suffix = ".warc.gz"
    temporary = catalog.temporary / f"{job['job_id']}{suffix}"
    temporary.unlink(missing_ok=True)
    if kind == "commoncrawl-warc-range":
        download = _download(
            str(locator["url"]), temporary,
            byte_range=(int(locator["offset"]), int(locator["length"])),
            expected_bytes=int(job["expected_bytes"]),
            maximum_bytes=max(int(locator["length"]), 1),
        )
        validation = validate_warc(temporary)
        if len(validation["records"]) != 1:
            raise ValueError("Common Crawl byte range did not contain exactly one WARC record")
        record = validation["records"][0]
        if not _digest_equivalent(locator.get("payload_digest"), record.get("payload_digest")):
            raise ValueError("Common Crawl index payload digest differs from WARC record")
        digest, _, stored = catalog.import_object(temporary, media_type="application/warc", move=True)
        catalog.register_warc_records(digest, validation["records"], {
            "adapter": job["adapter"], "job_id": job["job_id"], "download": download,
            "locator": locator,
        })
        return [(digest, "commoncrawl-warc-record")]
    if kind == "http-archive-object":
        name = str(locator.get("name", "archive.warc.gz"))
        suffix = ".wacz" if name.lower().endswith(".wacz") else (
            ".arc.gz" if name.lower().endswith(".arc.gz") else
            ".arc" if name.lower().endswith(".arc") else
            ".warc" if name.lower().endswith(".warc") else ".warc.gz"
        )
        temporary = catalog.temporary / f"{job['job_id']}{suffix}"
        download = _download(
            str(locator["url"]), temporary,
            expected_bytes=job.get("expected_bytes"), expected_sha256=job.get("expected_sha256"),
            expected_sha1=locator.get("upstream_sha1"), expected_md5=locator.get("upstream_md5"),
        )
        media = "application/wacz" if suffix == ".wacz" else "application/warc"
        digest, _, stored = catalog.import_object(temporary, media_type=media, move=True)
        return _index_warc_object(catalog, digest, stored, {
            "adapter": job["adapter"], "job_id": job["job_id"], "download": download,
            "locator": locator,
        }, logical_name=name)
    if kind == "local-archive-object":
        source = pathlib.Path(str(locator["path"])).resolve()
        if sha256_file(source) != job.get("expected_sha256"):
            raise ValueError("local archive changed after discovery")
        media = "application/wacz" if source.name.lower().endswith(".wacz") else "application/warc"
        digest, _, stored = catalog.import_object(source, media_type=media, move=False)
        return _index_warc_object(catalog, digest, stored, {
            "adapter": job["adapter"], "job_id": job["job_id"], "locator": locator,
        }, logical_name=source.name)
    if kind == "wayback-replay-warc":
        body = catalog.temporary / f"{job['job_id']}.body"
        body.unlink(missing_ok=True)
        with _request(str(locator["url"])) as response, body.open("wb") as output:
            total = 0
            while block := response.read(1 << 20):
                total += len(block)
                if total > 2 << 30:
                    raise ValueError("Wayback replay body exceeds 2 GiB policy")
                output.write(block)
            output.flush()
            os.fsync(output.fileno())
            status = int(getattr(response, "status", response.getcode()))
            reason = str(getattr(response, "reason", ""))
            headers = {key: value for key, value in response.headers.items()}
        validation = write_replay_warc(
            temporary, target_uri=str(locator["target_uri"]),
            capture_timestamp=str(locator["timestamp"]), status=status, reason=reason,
            response_headers=headers, body_path=body, source_uri=str(locator["url"]),
        )
        body.unlink(missing_ok=True)
        digest, _, stored = catalog.import_object(temporary, media_type="application/warc", move=True)
        catalog.register_warc_records(digest, validation["records"], {
            "adapter": job["adapter"], "job_id": job["job_id"], "locator": locator,
            "derivative": True,
        })
        return [(digest, "wayback-replay-derivative-warc")]
    raise ValueError(f"unsupported Sidepus job kind: {kind}")


def run_worker(
    catalog: Catalog, *, owner: str, limit: int, lease_seconds: int = 3600,
    quarantine_after_attempts: int = 5,
) -> dict[str, Any]:
    leased = catalog.lease_jobs(owner, limit, lease_seconds)
    complete = failed = quarantined = 0
    failures: list[dict[str, Any]] = []
    for job in leased:
        try:
            outputs = _process_job(catalog, job)
            catalog.complete_job(job["job_id"], owner, outputs)
            complete += 1
        except Exception as error:
            quarantine = int(job.get("attempts", 0)) >= quarantine_after_attempts
            catalog.fail_job(job["job_id"], owner, f"{type(error).__name__}: {error}", quarantine=quarantine)
            quarantined += int(quarantine)
            failed += int(not quarantine)
            failures.append({"job_id": job["job_id"], "error": f"{type(error).__name__}: {error}"})
    return {
        "schema": "sidepus-worker-receipt/v2",
        "owner": owner,
        "leased": len(leased),
        "complete": complete,
        "failed": failed,
        "quarantined": quarantined,
        "failures": failures,
        "catalog": catalog.snapshot(),
        "created_at": utc_now(),
    }
