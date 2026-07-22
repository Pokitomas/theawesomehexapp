#!/usr/bin/env python3
"""Content-policy binding and governed worker execution for Sidepus."""
from __future__ import annotations

import json
from typing import Any, Callable

from .acquisition import _process_job
from .catalog import Catalog, stable_json, utc_now


def current_content_policy_digest(catalog: Catalog) -> str:
    row = catalog.connection.execute(
        "SELECT digest FROM policies WHERE kind='content'"
    ).fetchone()
    if row is None:
        raise ValueError(
            "Sidepus content policy is not installed; acquisition must stop for operator approval"
        )
    digest = str(row["digest"])
    if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
        raise ValueError("installed content policy digest is invalid")
    return digest


def bind_pending_jobs(catalog: Catalog, policy_digest: str) -> int:
    """Bind every pending job to the one sealed content policy, rejecting conflicts."""
    count = 0
    with catalog.transaction() as db:
        rows = db.execute(
            "SELECT job_id, locator_json FROM jobs WHERE status='pending' ORDER BY job_id"
        ).fetchall()
        for row in rows:
            locator = json.loads(row["locator_json"])
            existing = locator.get("content_policy_digest")
            if existing not in {None, policy_digest}:
                raise ValueError(
                    f"job {row['job_id']} belongs to a different content policy"
                )
            if existing == policy_digest:
                continue
            locator["content_policy_digest"] = policy_digest
            db.execute(
                "UPDATE jobs SET locator_json=?, updated_at=? WHERE job_id=?",
                (stable_json(locator), utc_now(), row["job_id"]),
            )
            count += 1
    if count:
        catalog.append_event(
            "jobs-bound-to-content-policy",
            {"content_policy_digest": policy_digest, "jobs": count},
        )
    return count


def verify_job_policy(job: dict[str, Any], policy_digest: str) -> None:
    observed = job.get("locator", {}).get("content_policy_digest")
    if observed != policy_digest:
        raise ValueError(
            f"job {job.get('job_id')} is not bound to the installed content policy"
        )


def run_governed_worker(
    catalog: Catalog, *, owner: str, limit: int, lease_seconds: int = 3600,
    quarantine_after_attempts: int = 5,
) -> dict[str, Any]:
    policy_digest = current_content_policy_digest(catalog)
    leased = catalog.lease_jobs(owner, limit, lease_seconds)
    complete = failed = quarantined = 0
    failures: list[dict[str, Any]] = []
    for job in leased:
        try:
            verify_job_policy(job, policy_digest)
            outputs = _process_job(catalog, job)
            catalog.complete_job(job["job_id"], owner, outputs)
            complete += 1
        except Exception as error:
            quarantine = int(job.get("attempts", 0)) >= quarantine_after_attempts
            catalog.fail_job(
                job["job_id"], owner, f"{type(error).__name__}: {error}",
                quarantine=quarantine,
            )
            quarantined += int(quarantine)
            failed += int(not quarantine)
            failures.append({
                "job_id": job["job_id"],
                "error": f"{type(error).__name__}: {error}",
            })
    return {
        "schema": "sidepus-governed-worker-receipt/v2",
        "owner": owner,
        "content_policy_digest": policy_digest,
        "leased": len(leased),
        "complete": complete,
        "failed": failed,
        "quarantined": quarantined,
        "failures": failures,
        "catalog": catalog.snapshot(),
        "created_at": utc_now(),
    }


def discover_and_bind(
    catalog: Catalog, discovery: Callable[..., dict[str, Any]], *args: Any, **kwargs: Any
) -> dict[str, Any]:
    policy_digest = current_content_policy_digest(catalog)
    result = discovery(catalog, *args, **kwargs)
    bound = bind_pending_jobs(catalog, policy_digest)
    return {
        **result,
        "content_policy_digest": policy_digest,
        "jobs_bound": bound,
    }
