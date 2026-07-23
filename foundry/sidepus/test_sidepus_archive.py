#!/usr/bin/env python3
"""Adversarial contract tests for Sidepus v2 archive parity."""
from __future__ import annotations

import http.server
import pathlib
import tempfile
import threading
import unittest
import zipfile

from .acquisition import _download, discover_local_archives
from .capture import capture_template, load_capture_request
from .catalog import Catalog, atomic_json
from .cli import initial_plan
from .governance import (
    bind_pending_jobs,
    current_content_policy_digest,
    run_governed_worker,
)
from .warc import (
    extract_wacz_warcs,
    safe_wacz_members,
    validate_warc,
    write_replay_warc,
)


def policy() -> dict[str, object]:
    return {
        "schema": "sidepus-content-policy/v2",
        "approved_by_operator": True,
        "purposes": ["contract-test"],
        "historical_sources": ["local-test"],
        "fresh_capture": False,
        "languages": ["en"],
        "time_ranges": [{"from": "2000", "to": "2026"}],
        "subject_allocations": {"contract-test": 1.0},
        "exclusions": ["none"],
        "maximum_archive_bytes": 1 << 30,
    }


def make_warc(root: pathlib.Path, name: str = "sample.warc.gz") -> pathlib.Path:
    body = root / "body.bin"
    body.write_bytes(b"sidepus archive contract\n")
    output = root / name
    write_replay_warc(
        output,
        target_uri="https://example.com/archive-contract",
        capture_timestamp="20260722000000",
        status=200,
        reason="OK",
        response_headers={"Content-Type": "text/plain; charset=utf-8"},
        body_path=body,
        source_uri="https://example.com/archive-contract",
    )
    return output


class RangeHandler(http.server.BaseHTTPRequestHandler):
    payload = b""

    def do_GET(self) -> None:  # noqa: N802
        raw = self.headers.get("Range")
        if not raw or not raw.startswith("bytes="):
            self.send_response(200)
            self.send_header("Content-Length", str(len(self.payload)))
            self.end_headers()
            self.wfile.write(self.payload)
            return
        start_raw, end_raw = raw.removeprefix("bytes=").split("-", 1)
        start = int(start_raw)
        end = int(end_raw)
        selected = self.payload[start:end + 1]
        self.send_response(206)
        self.send_header("Content-Length", str(len(selected)))
        self.send_header("Content-Range", f"bytes {start}-{end}/{len(self.payload)}")
        self.end_headers()
        self.wfile.write(selected)

    def log_message(self, *_: object) -> None:
        return


class SidepusArchiveContractTest(unittest.TestCase):
    def test_plan_refuses_to_choose_content(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state = pathlib.Path(temporary)
            plan = initial_plan(state)
            self.assertIsNone(plan["content_policy"])
            self.assertEqual(plan["content_policy_status"], "operator-decision-required")

    def test_capture_template_is_not_approval(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            request = root / "capture.json"
            atomic_json(request, capture_template("wget", root / "capture"))
            with self.assertRaises(ValueError):
                load_capture_request(request)

    def test_warc_and_wacz_validation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            warc = make_warc(root)
            validation = validate_warc(warc)
            self.assertEqual(validation["record_count"], 1)
            self.assertEqual(
                validation["records"][0]["target_uri"],
                "https://example.com/archive-contract",
            )
            wacz = root / "sample.wacz"
            with zipfile.ZipFile(wacz, "w", compression=zipfile.ZIP_STORED) as archive:
                archive.write(warc, "archive/data.warc.gz")
            self.assertEqual(safe_wacz_members(wacz), ["archive/data.warc.gz"])
            extracted = extract_wacz_warcs(wacz, root / "extracted")
            self.assertEqual(len(extracted), 1)
            self.assertEqual(validate_warc(extracted[0])["record_count"], 1)

    def test_wacz_path_traversal_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            warc = make_warc(root)
            wacz = root / "unsafe.wacz"
            with zipfile.ZipFile(wacz, "w", compression=zipfile.ZIP_STORED) as archive:
                archive.write(warc, "../escape.warc.gz")
            with self.assertRaises(ValueError):
                safe_wacz_members(wacz)

    def test_http_range_download_preserves_warc(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            warc = make_warc(root)
            RangeHandler.payload = warc.read_bytes()
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), RangeHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                destination = root / "range.warc.gz"
                result = _download(
                    f"http://127.0.0.1:{server.server_port}/record",
                    destination,
                    byte_range=(0, len(RangeHandler.payload)),
                    expected_bytes=len(RangeHandler.payload),
                    maximum_bytes=len(RangeHandler.payload),
                )
            finally:
                server.shutdown()
                thread.join(timeout=5)
                server.server_close()
            self.assertEqual(result["status"], 206)
            self.assertEqual(validate_warc(destination)["record_count"], 1)

    def test_unbound_job_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            warc = make_warc(root)
            with Catalog(root / "state") as catalog:
                catalog.install_policy("content", policy())
                discover_local_archives(catalog, [warc])
                result = run_governed_worker(
                    catalog, owner="test", limit=1, quarantine_after_attempts=1
                )
                self.assertEqual(result["complete"], 0)
                self.assertEqual(result["quarantined"], 1)
                self.assertIn("not bound", result["failures"][0]["error"])

    def test_bound_warc_ingests_and_verifies(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            warc = make_warc(root)
            with Catalog(root / "state") as catalog:
                digest = catalog.install_policy("content", policy())
                discovery = discover_local_archives(catalog, [warc])
                self.assertEqual(discovery["discovered"], 1)
                self.assertEqual(bind_pending_jobs(catalog, digest), 1)
                result = run_governed_worker(
                    catalog, owner="test", limit=1, quarantine_after_attempts=1
                )
                self.assertEqual(result["complete"], 1)
                snapshot = catalog.snapshot()
                self.assertEqual(snapshot["objects"], 1)
                self.assertEqual(snapshot["warc_records"], 1)
                self.assertTrue(catalog.verify(deep=True)["passed"])

    def test_expired_lease_returns_to_pending(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with Catalog(pathlib.Path(temporary) / "state") as catalog:
                catalog.install_policy("content", policy())
                catalog.enqueue_jobs([{
                    "source_id": "test",
                    "adapter": "test",
                    "kind": "local-archive-object",
                    "locator": {"path": "/not-used"},
                }])
                digest = current_content_policy_digest(catalog)
                bind_pending_jobs(catalog, digest)
                leased = catalog.lease_jobs("worker", 1, 10)
                self.assertEqual(len(leased), 1)
                catalog.connection.execute(
                    "UPDATE jobs SET lease_until=0 WHERE job_id=?",
                    (leased[0]["job_id"],),
                )
                self.assertEqual(catalog.release_expired_leases(), 1)
                self.assertEqual(len(catalog.pending_jobs()), 1)

    def test_verified_worker_merge_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            warc = make_warc(root)
            source_state = root / "worker"
            destination_state = root / "authority"
            with Catalog(source_state) as source:
                digest = source.install_policy("content", policy())
                discover_local_archives(source, [warc])
                bind_pending_jobs(source, digest)
                result = run_governed_worker(
                    source, owner="worker", limit=1, quarantine_after_attempts=1
                )
                self.assertEqual(result["complete"], 1)
            with Catalog(destination_state) as destination:
                destination.install_policy("content", policy())
                first = destination.merge_from(source_state)
                second = destination.merge_from(source_state)
                self.assertEqual(first["objects_copied"], 1)
                self.assertEqual(second["objects_reused"], 1)
                self.assertEqual(destination.snapshot()["warc_records"], 1)
                self.assertTrue(destination.verify(deep=True)["passed"])

    def test_malformed_warc_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "bad.warc"
            path.write_bytes(
                b"WARC/1.1\r\nWARC-Type: response\r\nContent-Length: 100\r\n\r\nshort"
            )
            with self.assertRaises(ValueError):
                validate_warc(path)


if __name__ == "__main__":
    unittest.main()
