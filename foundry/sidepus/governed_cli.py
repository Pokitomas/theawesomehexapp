#!/usr/bin/env python3
"""Canonical fail-closed Sidepus CLI.

The lower-level ``cli`` module is an execution engine. This wrapper is the public
entrypoint: every operation that can select or acquire bytes requires one sealed
operator-approved content policy, and every resulting job is bound to its digest.
"""
from __future__ import annotations

import json
import pathlib
from typing import Any, Callable

from . import cli as engine
from .governance import (
    bind_pending_jobs,
    current_content_policy_digest,
    discover_and_bind,
    run_governed_worker,
)


def _governed(discovery: Callable[..., dict[str, Any]]) -> Callable[..., dict[str, Any]]:
    def wrapper(catalog: Any, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return discover_and_bind(catalog, discovery, *args, **kwargs)
    return wrapper


def _handle_import_shard(args: Any) -> None:
    state = pathlib.Path(args.state_dir).expanduser().resolve()
    with engine.Catalog(state) as catalog:
        policy_digest = current_content_policy_digest(catalog)
        inserted, reused = catalog.import_job_manifest(pathlib.Path(args.manifest))
        bound = bind_pending_jobs(catalog, policy_digest)
        result = {
            "inserted": inserted,
            "reused": reused,
            "jobs_bound": bound,
            "content_policy_digest": policy_digest,
            "catalog": catalog.snapshot(),
        }
    engine.print_json(result)


def _handle_export_shards(args: Any) -> None:
    state = pathlib.Path(args.state_dir).expanduser().resolve()
    with engine.Catalog(state) as catalog:
        policy_digest = current_content_policy_digest(catalog)
        bound = bind_pending_jobs(catalog, policy_digest)
        result = catalog.export_pending_shards(
            pathlib.Path(args.output_dir), args.shards
        )
        result["content_policy_digest"] = policy_digest
        result["jobs_bound"] = bound
    engine.print_json(result)


def _verify_worker_policy(worker_state: pathlib.Path, expected_digest: str) -> None:
    with engine.Catalog(worker_state) as worker:
        observed = current_content_policy_digest(worker)
        if observed != expected_digest:
            raise ValueError("worker content policy does not match authority policy")
        rows = worker.connection.execute(
            "SELECT job_id, locator_json FROM jobs ORDER BY job_id"
        ).fetchall()
        for row in rows:
            locator = json.loads(row["locator_json"])
            if locator.get("content_policy_digest") != expected_digest:
                raise ValueError(
                    f"worker job {row['job_id']} is not bound to the authority content policy"
                )


def _handle_merge_worker(args: Any) -> None:
    state = pathlib.Path(args.state_dir).expanduser().resolve()
    worker_state = pathlib.Path(args.worker_state).expanduser().resolve()
    with engine.Catalog(state) as catalog:
        policy_digest = current_content_policy_digest(catalog)
        _verify_worker_policy(worker_state, policy_digest)
        result = catalog.merge_from(worker_state)
        result["content_policy_digest"] = policy_digest
    engine.print_json(result)


def main() -> None:
    args = engine.parser().parse_args()
    if args.command == "import-shard":
        _handle_import_shard(args)
        return
    if args.command == "export-shards":
        _handle_export_shards(args)
        return
    if args.command == "merge-worker":
        _handle_merge_worker(args)
        return

    engine.discover_commoncrawl_cdx = _governed(
        engine.discover_commoncrawl_cdx
    )
    engine.discover_commoncrawl_url_index = _governed(
        engine.discover_commoncrawl_url_index
    )
    engine.discover_wayback_cdx = _governed(
        engine.discover_wayback_cdx
    )
    engine.discover_internet_archive_items = _governed(
        engine.discover_internet_archive_items
    )
    engine.discover_local_archives = _governed(
        engine.discover_local_archives
    )
    engine.run_worker = run_governed_worker
    engine.main()


if __name__ == "__main__":
    main()
