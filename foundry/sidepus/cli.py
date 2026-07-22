#!/usr/bin/env python3
"""Sidepus v2 WARC-native archive acquisition CLI."""
from __future__ import annotations

import argparse
import importlib.util
import json
import pathlib
import shutil
import subprocess
from typing import Any

from .acquisition import (
    COMMONCRAWL_INDEX_ROOT,
    IA_METADATA,
    WAYBACK_CDX,
    _request,
    discover_commoncrawl_cdx,
    discover_commoncrawl_url_index,
    discover_internet_archive_items,
    discover_local_archives,
    discover_wayback_cdx,
    run_worker,
)
from .capture import SUPPORTED_ENGINES, capture_template, run_capture
from .catalog import Catalog, atomic_json, digest_json, sha256_file, utc_now
from .warc import validate_warc

PLAN_SCHEMA = "sidepus-archive-plan/v2"
CONTENT_POLICY_SCHEMA = "sidepus-content-policy/v2"


def print_json(value: Any) -> None:
    print(json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False))


def initial_plan(state_dir: pathlib.Path) -> dict[str, Any]:
    body = {
        "schema": PLAN_SCHEMA,
        "state_dir": str(state_dir.resolve()),
        "archive_contract": {
            "historical": [
                "commoncrawl-cdx-ranged-warc",
                "commoncrawl-parquet-url-index",
                "wayback-cdx-replay-derivative",
                "internet-archive-warc-arc-wacz",
            ],
            "fresh_capture": [
                "gnu-wget-warc",
                "browsertrix-command",
                "heritrix-or-external-warc-import",
            ],
            "storage": "sha256-content-addressed",
            "catalog": "sqlite-wal-per-worker-with-verified-set-union",
            "record_format": "warc-1.0-or-1.1",
        },
        "content_policy": None,
        "content_policy_status": "operator-decision-required",
        "claim_boundary": (
            "This plan installs acquisition infrastructure only. It chooses no subjects, "
            "domains, languages, time periods, source ratios, crawl depths, or training curriculum."
        ),
        "created_at": utc_now(),
    }
    body["plan_digest"] = digest_json(body)
    return body


def load_json_object(path: pathlib.Path) -> dict[str, Any]:
    value = json.loads(path.resolve().read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} is not a JSON object")
    return value


def install_content_policy(catalog: Catalog, path: pathlib.Path) -> dict[str, Any]:
    policy = load_json_object(path)
    if policy.get("schema") != CONTENT_POLICY_SCHEMA:
        raise ValueError(f"content policy must use {CONTENT_POLICY_SCHEMA}")
    required = {
        "approved_by_operator",
        "purposes",
        "historical_sources",
        "fresh_capture",
        "languages",
        "time_ranges",
        "subject_allocations",
        "exclusions",
        "maximum_archive_bytes",
    }
    missing = sorted(required - policy.keys())
    if missing:
        raise ValueError(f"content policy is missing fields: {missing}")
    if policy.get("approved_by_operator") is not True:
        raise ValueError("content policy must record approved_by_operator=true")
    digest = catalog.install_policy("content", policy)
    return {
        "schema": "sidepus-content-policy-installation/v2",
        "path": str(path.resolve()),
        "file_sha256": sha256_file(path.resolve()),
        "policy_digest": digest,
        "catalog": catalog.snapshot(),
    }


def _check_module(name: str) -> dict[str, Any]:
    return {
        "kind": "python-module",
        "name": name,
        "passed": importlib.util.find_spec(name) is not None,
    }


def _check_executable(name: str) -> dict[str, Any]:
    path = shutil.which(name)
    return {
        "kind": "executable",
        "name": name,
        "passed": path is not None,
        "path": path,
    }


def _check_wget_warc() -> dict[str, Any]:
    path = shutil.which("wget")
    if path is None:
        return {"kind": "feature", "name": "gnu-wget-warc", "passed": False, "detail": "wget missing"}
    result = subprocess.run(
        [path, "--help"], text=True, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, check=False,
    )
    return {
        "kind": "feature",
        "name": "gnu-wget-warc",
        "passed": result.returncode == 0 and "--warc-file" in result.stdout,
        "path": path,
    }


def _check_browser_capture() -> dict[str, Any]:
    crawl = shutil.which("crawl")
    docker = shutil.which("docker")
    return {
        "kind": "feature",
        "name": "browser-grade-capture",
        "passed": crawl is not None or docker is not None,
        "crawl": crawl,
        "docker": docker,
        "detail": "requires Browsertrix crawl CLI or a configured container command",
    }


def _check_network(name: str, url: str) -> dict[str, Any]:
    try:
        with _request(url, attempts=2, timeout=30, minimum_delay=0.5) as response:
            status = int(getattr(response, "status", response.getcode()))
            response.read(1)
        return {
            "kind": "network",
            "name": name,
            "url": url,
            "passed": 200 <= status < 400,
            "status": status,
        }
    except Exception as error:
        return {
            "kind": "network",
            "name": name,
            "url": url,
            "passed": False,
            "error": f"{type(error).__name__}: {error}",
        }


def doctor(*, network: bool, require_parity: bool) -> dict[str, Any]:
    checks = [
        {"kind": "builtin", "name": "warc-stream-parser", "passed": True},
        {"kind": "builtin", "name": "wacz-safe-extraction", "passed": True},
        {"kind": "builtin", "name": "content-addressed-catalog", "passed": True},
        {"kind": "builtin", "name": "resumable-job-leasing", "passed": True},
        {"kind": "builtin", "name": "verified-worker-merge", "passed": True},
        _check_module("duckdb"),
        _check_module("warcio"),
        _check_wget_warc(),
        _check_browser_capture(),
    ]
    java = _check_executable("java")
    java["required"] = False
    java["detail"] = "optional for running Heritrix; Heritrix WARC output can be ingested without Java"
    checks.append(java)
    if network:
        checks.extend([
            _check_network(
                "commoncrawl-index",
                f"{COMMONCRAWL_INDEX_ROOT}/collinfo.json",
            ),
            _check_network(
                "wayback-cdx",
                f"{WAYBACK_CDX}?url=example.com&output=json&limit=1",
            ),
            _check_network(
                "internet-archive-metadata",
                f"{IA_METADATA}/opensource",
            ),
        ])
    required_names = {
        "warc-stream-parser",
        "wacz-safe-extraction",
        "content-addressed-catalog",
        "resumable-job-leasing",
        "verified-worker-merge",
        "duckdb",
        "warcio",
        "gnu-wget-warc",
        "browser-grade-capture",
    }
    if network:
        required_names.update({
            "commoncrawl-index",
            "wayback-cdx",
            "internet-archive-metadata",
        })
    for check in checks:
        check["required"] = check.get("required", check["name"] in required_names)
    failures = [
        check["name"] for check in checks
        if check["required"] and not check["passed"]
    ]
    result = {
        "schema": "sidepus-parity-doctor/v2",
        "require_parity": require_parity,
        "network_checked": network,
        "checks": checks,
        "passed": not failures,
        "failures": failures,
        "claim_boundary": (
            "A passing doctor proves adapters and local dependencies are available. It does not "
            "prove corpus completeness, Internet Archive equivalence in holdings, or a good curriculum."
        ),
    }
    result["receipt_digest"] = digest_json(result)
    return result


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__)
    sub = cli.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init")
    init.add_argument("--state-dir", required=True)

    doc = sub.add_parser("doctor")
    doc.add_argument("--network", action="store_true")
    doc.add_argument("--require-parity", action="store_true")

    status = sub.add_parser("status")
    status.add_argument("--state-dir", required=True)

    verify = sub.add_parser("verify")
    verify.add_argument("--state-dir", required=True)
    verify.add_argument("--deep", action="store_true")

    policy = sub.add_parser("install-content-policy")
    policy.add_argument("--state-dir", required=True)
    policy.add_argument("--policy", required=True)

    cc_cdx = sub.add_parser("discover-commoncrawl-cdx")
    cc_cdx.add_argument("--state-dir", required=True)
    cc_cdx.add_argument("--queries", required=True)
    cc_cdx.add_argument("--delay-seconds", type=float, default=1.0)
    cc_cdx.add_argument("--receipt")

    cc_index = sub.add_parser("discover-commoncrawl-index")
    cc_index.add_argument("--state-dir", required=True)
    cc_index.add_argument("--crawl", required=True)
    cc_index.add_argument("--sql", required=True)
    cc_index.add_argument("--max-records", type=int, required=True)
    cc_index.add_argument("--url-index-root")
    cc_index.add_argument("--receipt")

    wb = sub.add_parser("discover-wayback")
    wb.add_argument("--state-dir", required=True)
    wb.add_argument("--queries", required=True)
    wb.add_argument("--delay-seconds", type=float, default=1.0)
    wb.add_argument("--receipt")

    ia = sub.add_parser("discover-internet-archive")
    ia.add_argument("--state-dir", required=True)
    ia.add_argument("--items", required=True)
    ia.add_argument("--receipt")

    local = sub.add_parser("discover-local")
    local.add_argument("--state-dir", required=True)
    local.add_argument("--path", action="append", required=True)
    local.add_argument("--source-id", default="local-web-archives")

    worker = sub.add_parser("worker")
    worker.add_argument("--state-dir", required=True)
    worker.add_argument("--owner", required=True)
    worker.add_argument("--limit", type=int, default=100)
    worker.add_argument("--lease-seconds", type=int, default=3600)
    worker.add_argument("--quarantine-after-attempts", type=int, default=5)

    retry = sub.add_parser("retry-failed")
    retry.add_argument("--state-dir", required=True)

    shards = sub.add_parser("export-shards")
    shards.add_argument("--state-dir", required=True)
    shards.add_argument("--output-dir", required=True)
    shards.add_argument("--shards", type=int, required=True)

    import_shard = sub.add_parser("import-shard")
    import_shard.add_argument("--state-dir", required=True)
    import_shard.add_argument("--manifest", required=True)

    merge = sub.add_parser("merge-worker")
    merge.add_argument("--state-dir", required=True)
    merge.add_argument("--worker-state", required=True)

    ingest = sub.add_parser("ingest-warc")
    ingest.add_argument("--state-dir", required=True)
    ingest.add_argument("--path", action="append", required=True)
    ingest.add_argument("--owner", default="local-ingest")

    template = sub.add_parser("capture-template")
    template.add_argument("--engine", choices=sorted(SUPPORTED_ENGINES), required=True)
    template.add_argument("--output", required=True)
    template.add_argument("--capture-output-dir", required=True)

    capture = sub.add_parser("capture")
    capture.add_argument("--state-dir", required=True)
    capture.add_argument("--request", required=True)
    capture.add_argument("--owner", default="capture-import")

    validate = sub.add_parser("validate-warc")
    validate.add_argument("--path", required=True)

    return cli


def main() -> None:
    args = parser().parse_args()
    if args.command == "doctor":
        result = doctor(network=args.network, require_parity=args.require_parity)
        print_json(result)
        if args.require_parity and not result["passed"]:
            raise SystemExit(1)
        return
    if args.command == "init":
        state = pathlib.Path(args.state_dir).expanduser().resolve()
        state.mkdir(parents=True, exist_ok=True)
        plan = state / "archive-plan.json"
        if plan.exists():
            raise SystemExit(f"refusing to overwrite {plan}")
        atomic_json(plan, initial_plan(state))
        with Catalog(state) as catalog:
            catalog.append_event("archive-plan-created", {
                "path": str(plan),
                "sha256": sha256_file(plan),
                "content_policy_status": "operator-decision-required",
            })
            result = {"plan": str(plan), "catalog": catalog.snapshot()}
        print_json(result)
        return
    if args.command == "capture-template":
        output = pathlib.Path(args.output).expanduser().resolve()
        if output.exists():
            raise SystemExit(f"refusing to overwrite {output}")
        atomic_json(
            output,
            capture_template(
                args.engine,
                pathlib.Path(args.capture_output_dir),
            ),
        )
        print(output)
        return
    if args.command == "validate-warc":
        print_json(validate_warc(pathlib.Path(args.path)))
        return

    state = pathlib.Path(args.state_dir).expanduser().resolve()
    with Catalog(state) as catalog:
        if args.command == "status":
            result = catalog.snapshot()
        elif args.command == "verify":
            result = catalog.verify(deep=args.deep)
            if not result["passed"]:
                print_json(result)
                raise SystemExit(1)
        elif args.command == "install-content-policy":
            result = install_content_policy(catalog, pathlib.Path(args.policy))
        elif args.command == "discover-commoncrawl-cdx":
            result = discover_commoncrawl_cdx(
                catalog, pathlib.Path(args.queries),
                delay_seconds=args.delay_seconds,
                output_receipt=pathlib.Path(args.receipt) if args.receipt else None,
            )
        elif args.command == "discover-commoncrawl-index":
            kwargs: dict[str, Any] = {}
            if args.url_index_root:
                kwargs["url_index_root"] = args.url_index_root
            result = discover_commoncrawl_url_index(
                catalog, crawl=args.crawl, sql_file=pathlib.Path(args.sql),
                max_records=args.max_records,
                output_receipt=pathlib.Path(args.receipt) if args.receipt else None,
                **kwargs,
            )
        elif args.command == "discover-wayback":
            result = discover_wayback_cdx(
                catalog, pathlib.Path(args.queries),
                delay_seconds=args.delay_seconds,
                output_receipt=pathlib.Path(args.receipt) if args.receipt else None,
            )
        elif args.command == "discover-internet-archive":
            result = discover_internet_archive_items(
                catalog, pathlib.Path(args.items),
                output_receipt=pathlib.Path(args.receipt) if args.receipt else None,
            )
        elif args.command == "discover-local":
            result = discover_local_archives(
                catalog, [pathlib.Path(value) for value in args.path],
                source_id=args.source_id,
            )
        elif args.command == "worker":
            result = run_worker(
                catalog, owner=args.owner, limit=args.limit,
                lease_seconds=args.lease_seconds,
                quarantine_after_attempts=args.quarantine_after_attempts,
            )
        elif args.command == "retry-failed":
            result = {"retried": catalog.retry_failed(), "catalog": catalog.snapshot()}
        elif args.command == "export-shards":
            result = catalog.export_pending_shards(
                pathlib.Path(args.output_dir), args.shards
            )
        elif args.command == "import-shard":
            inserted, reused = catalog.import_job_manifest(pathlib.Path(args.manifest))
            result = {"inserted": inserted, "reused": reused, "catalog": catalog.snapshot()}
        elif args.command == "merge-worker":
            result = catalog.merge_from(pathlib.Path(args.worker_state))
        elif args.command == "ingest-warc":
            discovery = discover_local_archives(
                catalog, [pathlib.Path(value) for value in args.path],
                source_id="explicit-local-warc",
            )
            worker = run_worker(
                catalog, owner=args.owner, limit=max(discovery["discovered"], 1),
                quarantine_after_attempts=1,
            )
            result = {"discovery": discovery, "worker": worker}
        elif args.command == "capture":
            result = run_capture(catalog, pathlib.Path(args.request), owner=args.owner)
        else:
            raise AssertionError(args.command)
    print_json(result)


if __name__ == "__main__":
    main()
