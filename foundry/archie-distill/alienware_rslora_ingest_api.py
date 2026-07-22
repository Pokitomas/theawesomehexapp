#!/usr/bin/env python3
"""Dependency-free HTTP ingest for Alienware-produced RSLoRA bundles.

POST /v1/rslora/nativize
Content-Type: application/x-tar
X-Archie-Request-ID: <immutable request id>
X-Archie-SHA256: <sha256 of request body>

The response is the native receipt JSON. The service is CPU-only and never loads a
model. Authentication and TLS should be provided by the surrounding reverse proxy.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import tarfile
import tempfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

MODULE_PATH = pathlib.Path(__file__).with_name("nativize_alienware_rslora.py")
spec = importlib.util.spec_from_file_location("nativize_alienware_rslora", MODULE_PATH)
assert spec and spec.loader
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

MAX_BODY_DEFAULT = 8 * 1024 * 1024 * 1024


def safe_extract(archive: tarfile.TarFile, destination: pathlib.Path) -> None:
    for member in archive.getmembers():
        name = pathlib.PurePosixPath(member.name)
        if name.is_absolute() or ".." in name.parts:
            raise ValueError(f"Unsafe archive member: {member.name}")
        if member.issym() or member.islnk() or member.isdev():
            raise ValueError(f"Unsupported archive member type: {member.name}")
    archive.extractall(destination, filter="data")


def bundle_root(extracted: pathlib.Path) -> pathlib.Path:
    direct = extracted / "elastic-rung-receipt.json"
    if direct.is_file():
        return extracted
    candidates = [path.parent for path in extracted.rglob("elastic-rung-receipt.json")]
    if len(candidates) != 1:
        raise ValueError("Archive must contain exactly one elastic-rung-receipt.json.")
    return candidates[0]


class Handler(BaseHTTPRequestHandler):
    server_version = "ArchieAlienwareIngest/1"

    def send_json(self, status: int, body: dict[str, Any]) -> None:
        raw = json.dumps(body, sort_keys=True).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self.send_json(HTTPStatus.OK, {"ok": True, "cuda_required": False, "dependencies": ["python-standard-library"]})
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/v1/rslora/nativize":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        request_id = self.headers.get("X-Archie-Request-ID", "").strip()
        expected = self.headers.get("X-Archie-SHA256", "").strip().lower()
        content_type = self.headers.get_content_type()
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        maximum = int(getattr(self.server, "max_body", MAX_BODY_DEFAULT))
        if not request_id or len(expected) != 64 or content_type not in {"application/x-tar", "application/octet-stream"}:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "missing_or_invalid_contract_headers"})
            return
        if length < 1 or length > maximum:
            self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "invalid_body_size", "max_bytes": maximum})
            return

        output_root = pathlib.Path(getattr(self.server, "output_root"))
        with tempfile.TemporaryDirectory(prefix="archie-alienware-ingest-") as raw:
            work = pathlib.Path(raw)
            tar_path = work / "bundle.tar"
            hasher = hashlib.sha256()
            remaining = length
            with tar_path.open("wb") as stream:
                while remaining:
                    block = self.rfile.read(min(1024 * 1024, remaining))
                    if not block:
                        raise ConnectionError("Request body ended early.")
                    stream.write(block)
                    hasher.update(block)
                    remaining -= len(block)
            observed = hasher.hexdigest()
            if observed != expected:
                self.send_json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": "body_digest_mismatch", "observed_sha256": observed})
                return
            extracted = work / "extracted"
            extracted.mkdir()
            try:
                with tarfile.open(tar_path, mode="r:*") as archive:
                    safe_extract(archive, extracted)
                source = bundle_root(extracted)
                destination = output_root / request_id / expected
                receipt = native.nativize(source, destination, request_id)
            except (ValueError, tarfile.TarError, SystemExit, OSError, json.JSONDecodeError) as exc:
                self.send_json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": "bundle_rejected", "detail": str(exc)})
                return
        self.send_json(HTTPStatus.CREATED, receipt)

    def log_message(self, fmt: str, *args: Any) -> None:
        print(json.dumps({"remote": self.client_address[0], "message": fmt % args}, sort_keys=True), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--output-root", required=True)
    parser.add_argument("--max-body-bytes", type=int, default=MAX_BODY_DEFAULT)
    args = parser.parse_args()
    root = pathlib.Path(args.output_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((args.bind, args.port), Handler)
    server.output_root = str(root)
    server.max_body = args.max_body_bytes
    print(json.dumps({"listening": f"http://{args.bind}:{args.port}", "output_root": str(root), "cuda_required": False}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
