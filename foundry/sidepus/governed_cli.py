#!/usr/bin/env python3
"""Canonical fail-closed Sidepus CLI.

The lower-level ``cli`` module is an execution engine. This wrapper is the public
entrypoint: every operation that can select or acquire bytes requires one sealed
operator-approved content policy, and every resulting job is bound to its digest.
"""
from __future__ import annotations

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


def main() -> None:
    args = engine.parser().parse_args()
    if args.command == "import-shard":
        _handle_import_shard(args)
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
