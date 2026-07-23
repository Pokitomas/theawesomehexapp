#!/usr/bin/env python3
"""Fresh web capture adapters and validated archive ingestion for Sidepus."""
from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time
from collections.abc import Iterable
from typing import Any

from .acquisition import discover_local_archives
from .catalog import Catalog, atomic_json, digest_json, sha256_file, utc_now
from .governance import (
    bind_pending_jobs,
    current_content_policy_digest,
    run_governed_worker,
)

CAPTURE_SCHEMA = "sidepus-fresh-capture-request/v2"
SUPPORTED_ENGINES = {"wget", "browsertrix", "external"}
ARCHIVE_SUFFIXES = (".warc", ".warc.gz", ".arc", ".arc.gz", ".wacz")


def load_capture_request(path: pathlib.Path) -> dict[str, Any]:
    request = json.loads(path.resolve().read_text(encoding="utf-8"))
    if request.get("schema") != CAPTURE_SCHEMA:
        raise ValueError(f"capture request must use {CAPTURE_SCHEMA}")
    engine = str(request.get("engine", ""))
    if engine not in SUPPORTED_ENGINES:
        raise ValueError(f"unsupported capture engine: {engine}")
    seeds = request.get("seeds")
    if not isinstance(seeds, list) or not seeds or not all(
        isinstance(value, str) and value.startswith(("http://", "https://"))
        for value in seeds
    ):
        raise ValueError("capture request requires explicit HTTP(S) seeds")
    output_dir = str(request.get("output_dir", "")).strip()
    if not output_dir:
        raise ValueError("capture request requires output_dir")
    policy_digest = str(request.get("content_policy_digest", ""))
    if len(policy_digest) != 64 or any(
        character not in "0123456789abcdef" for character in policy_digest
    ):
        raise ValueError(
            "fresh capture requires the exact lowercase SHA-256 content_policy_digest"
        )
    arguments = request.get("arguments", [])
    if not isinstance(arguments, list) or not all(isinstance(item, str) for item in arguments):
        raise ValueError("capture arguments must be a list of strings")
    return request


def _archive_files(root: pathlib.Path) -> list[pathlib.Path]:
    root = root.resolve()
    if not root.exists():
        return []
    candidates = [root] if root.is_file() else sorted(
        path for path in root.rglob("*") if path.is_file()
    )
    return [
        path for path in candidates
        if path.name.lower().endswith(ARCHIVE_SUFFIXES)
    ]


def _write_seed_file(seeds: Iterable[str], destination: pathlib.Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = "".join(f"{seed}\n" for seed in seeds)
    destination.write_text(payload, encoding="utf-8", newline="\n")


def _wget_command(request: dict[str, Any], work_dir: pathlib.Path) -> list[str]:
    executable = shutil.which(str(request.get("executable") or "wget"))
    if executable is None:
        raise RuntimeError("GNU Wget is required for the wget capture engine")
    help_result = subprocess.run(
        [executable, "--help"], text=True, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, check=False,
    )
    if "--warc-file" not in help_result.stdout:
        raise RuntimeError("installed wget does not expose WARC capture support")
    seeds = work_dir / "seeds.txt"
    _write_seed_file(request["seeds"], seeds)
    output = pathlib.Path(str(request["output_dir"])).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    prefix = output / str(request.get("collection") or "sidepus-capture")
    command = [
        executable,
        "--warc-file", str(prefix),
        "--warc-cdx",
        "--input-file", str(seeds),
        "--directory-prefix", str(output / "replay"),
        "--no-verbose",
    ]
    if bool(request.get("page_requisites", True)):
        command.append("--page-requisites")
    if bool(request.get("adjust_extension", True)):
        command.append("--adjust-extension")
    if bool(request.get("convert_links", False)):
        command.append("--convert-links")
    command.extend(request.get("arguments", []))
    return command


def _browsertrix_command(request: dict[str, Any], work_dir: pathlib.Path) -> list[str]:
    seeds = work_dir / "seeds.txt"
    _write_seed_file(request["seeds"], seeds)
    output = pathlib.Path(str(request["output_dir"])).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    collection = str(request.get("collection") or "sidepus-capture")
    explicit = request.get("command")
    if explicit is not None:
        if not isinstance(explicit, list) or not explicit or not all(
            isinstance(item, str) for item in explicit
        ):
            raise ValueError("browsertrix command must be a nonempty string list")
        replacements = {
            "{seeds}": str(seeds),
            "{output}": str(output),
            "{collection}": collection,
        }
        return [
            replacements.get(item, item)
            .replace("{seeds}", str(seeds))
            .replace("{output}", str(output))
            .replace("{collection}", collection)
            for item in explicit
        ]
    executable = shutil.which(str(request.get("executable") or "crawl"))
    if executable is None:
        raise RuntimeError(
            "Browsertrix capture requires the crawl CLI or an explicit container command"
        )
    return [
        executable,
        "--urlFile", str(seeds),
        "--collection", collection,
        "--cwd", str(output),
        *request.get("arguments", []),
    ]


def _external_command(request: dict[str, Any], work_dir: pathlib.Path) -> list[str]:
    command = request.get("command")
    if not isinstance(command, list) or not command or not all(
        isinstance(item, str) for item in command
    ):
        raise ValueError("external capture requires an explicit command string list")
    seeds = work_dir / "seeds.txt"
    _write_seed_file(request["seeds"], seeds)
    output = pathlib.Path(str(request["output_dir"])).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    replacements = {"{seeds}": str(seeds), "{output}": str(output)}
    return [
        replacements.get(item, item)
        .replace("{seeds}", str(seeds))
        .replace("{output}", str(output))
        for item in command
    ]


def command_for_capture(request: dict[str, Any], work_dir: pathlib.Path) -> list[str]:
    engine = str(request["engine"])
    if engine == "wget":
        return _wget_command(request, work_dir)
    if engine == "browsertrix":
        return _browsertrix_command(request, work_dir)
    return _external_command(request, work_dir)


def run_capture(
    catalog: Catalog, request_path: pathlib.Path, *, owner: str = "capture-import",
    worker_limit: int = 100_000,
) -> dict[str, Any]:
    request_path = request_path.resolve()
    request = load_capture_request(request_path)
    installed_policy_digest = current_content_policy_digest(catalog)
    if request["content_policy_digest"] != installed_policy_digest:
        raise ValueError("capture request does not match the installed content policy")
    request_digest = digest_json(request)
    output = pathlib.Path(str(request["output_dir"])).expanduser().resolve()
    before = {
        path.resolve(): sha256_file(path)
        for path in _archive_files(output)
    }
    with tempfile.TemporaryDirectory(prefix="sidepus-capture-") as temporary:
        work_dir = pathlib.Path(temporary)
        command = command_for_capture(request, work_dir)
        started = time.monotonic()
        process = subprocess.run(
            command,
            cwd=str(work_dir),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=int(request.get("timeout_seconds", 86_400)),
            check=False,
        )
        seconds = time.monotonic() - started
    log_dir = catalog.root / "capture-logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{request_digest}.log"
    log_path.write_text(process.stdout, encoding="utf-8", errors="replace")
    if process.returncode != 0:
        receipt = {
            "schema": "sidepus-fresh-capture-receipt/v2",
            "request_digest": request_digest,
            "engine": request["engine"],
            "command": command,
            "returncode": process.returncode,
            "seconds": seconds,
            "log_sha256": sha256_file(log_path),
            "status": "failed",
            "created_at": utc_now(),
        }
        receipt["receipt_digest"] = digest_json(receipt)
        atomic_json(catalog.root / "captures" / f"{request_digest}.json", receipt)
        raise RuntimeError(
            f"capture engine failed with status {process.returncode}; see {log_path}"
        )
    archives = _archive_files(output)
    if not archives:
        raise RuntimeError("capture command succeeded but produced no WARC, ARC, or WACZ")
    changed = [
        path for path in archives
        if before.get(path.resolve()) != sha256_file(path)
    ]
    if not changed:
        raise RuntimeError("capture produced no new or changed archive object")
    discovery = discover_local_archives(
        catalog, changed, source_id=f"fresh-capture:{request_digest}"
    )
    bound = bind_pending_jobs(catalog, installed_policy_digest)
    worker = run_governed_worker(
        catalog, owner=owner, limit=max(worker_limit, len(changed)),
        quarantine_after_attempts=1,
    )
    if worker["failed"] or worker["quarantined"]:
        raise RuntimeError("capture archives were produced but failed WARC/WACZ ingestion")
    receipt = {
        "schema": "sidepus-fresh-capture-receipt/v2",
        "request_digest": request_digest,
        "request_file_sha256": sha256_file(request_path),
        "content_policy_digest": request["content_policy_digest"],
        "engine": request["engine"],
        "command": command,
        "returncode": process.returncode,
        "seconds": seconds,
        "log_sha256": sha256_file(log_path),
        "archives": [
            {
                "path": str(path),
                "sha256": sha256_file(path),
                "bytes": path.stat().st_size,
            }
            for path in changed
        ],
        "discovery": {**discovery, "jobs_bound": bound},
        "worker": worker,
        "catalog": catalog.snapshot(),
        "status": "complete",
        "created_at": utc_now(),
    }
    receipt["receipt_digest"] = digest_json(receipt)
    atomic_json(catalog.root / "captures" / f"{request_digest}.json", receipt)
    catalog.append_event("fresh-capture-complete", {
        "request_digest": request_digest,
        "receipt_digest": receipt["receipt_digest"],
        "archives": len(changed),
    })
    return receipt


def capture_template(engine: str, output_dir: pathlib.Path) -> dict[str, Any]:
    if engine not in SUPPORTED_ENGINES:
        raise ValueError(f"unsupported capture engine: {engine}")
    return {
        "schema": CAPTURE_SCHEMA,
        "engine": engine,
        "seeds": ["REPLACE_WITH_EXPLICIT_SEED_URL"],
        "output_dir": str(output_dir.expanduser().resolve()),
        "collection": "sidepus-capture",
        "content_policy_digest": "REPLACE_WITH_64_HEX_POLICY_DIGEST",
        "arguments": [],
        "timeout_seconds": 86_400,
        "claim_boundary": (
            "This request captures only explicitly approved scope. Sidepus infrastructure "
            "does not choose subjects, domains, languages, eras, or crawl depth."
        ),
    }
