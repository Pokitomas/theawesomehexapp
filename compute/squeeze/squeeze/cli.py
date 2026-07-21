from __future__ import annotations

import argparse
import dataclasses
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from .capsule import CapsuleError, JobCapsule
from .checkpoints import atomic_json
from .cuda import print_doctor
from .executor import ExecutionPlan, execute
from .policy import LocalPolicy
from .workspace import JobWorkspace

DEFAULT_ROOT = Path.home() / ".local/share/squeeze"


def _not_implemented(command: str) -> int:
    print(json.dumps({"command": command, "status": "not-implemented", "promotion": "research-only-not-admitted"}))
    return 2


def _load_approval(root: Path, job_id: str) -> dict[str, str]:
    path = root / "approvals" / f"{job_id}.json"
    if not path.is_file():
        raise PermissionError(f"job {job_id!r} lacks local approval")
    return json.loads(path.read_text(encoding="utf-8"))


def _verify(args: argparse.Namespace) -> int:
    try:
        capsule = JobCapsule.load(args.capsule)
        policy = LocalPolicy(
            approved_commits=frozenset(args.approved_commit),
            used_nonces=frozenset(args.used_nonce),
        )
        result = policy.verify(capsule)
    except CapsuleError as exc:
        print(json.dumps({"accepted": False, "error": str(exc)}, sort_keys=True))
        return 2
    print(
        json.dumps(
            {
                "accepted": result.accepted,
                "capsule_digest": result.capsule_digest,
                "violations": [dataclasses.asdict(v) for v in result.violations],
            },
            sort_keys=True,
        )
    )
    return 0 if result.accepted else 2


def _approve(args: argparse.Namespace) -> int:
    capsule = JobCapsule.load(args.capsule)
    policy = LocalPolicy(approved_commits=frozenset({capsule.source_commit}))
    result = policy.verify(capsule)
    result.require()
    root = args.root.expanduser().resolve()
    approvals_root = root / "approvals"
    if approvals_root.exists():
        for existing in approvals_root.glob("*.json"):
            record = json.loads(existing.read_text(encoding="utf-8"))
            if record.get("nonce") == capsule.nonce and record.get("job_id") != args.job_id:
                raise PermissionError("capsule nonce is already approved under another job")
    approval = {
        "schema": "squeeze-approval-v1",
        "job_id": args.job_id,
        "nonce": capsule.nonce,
        "source_commit": capsule.source_commit,
        "capsule_sha256": capsule.digest(),
        "approved_at": datetime.now(timezone.utc).isoformat(),
        "promotion": capsule.promotion,
    }
    atomic_json(root / "approvals" / f"{args.job_id}.json", approval)
    job = root / "jobs" / args.job_id
    job.mkdir(parents=True, exist_ok=True)
    (job / "capsule.json").write_bytes(capsule.canonical_bytes())
    print(json.dumps(approval, sort_keys=True))
    return 0


def _run_job(args: argparse.Namespace, *, resume: bool) -> int:
    root = args.root.expanduser().resolve()
    approval = _load_approval(root, args.job_id)
    workspace = JobWorkspace(root / "jobs" / args.job_id)
    capsule = JobCapsule.load(workspace.root / "capsule.json")
    if approval.get("capsule_sha256") != capsule.digest() or approval.get("source_commit") != capsule.source_commit:
        raise PermissionError("approval does not match the stored capsule")
    if not resume and (workspace.checkpoints / "relay-checkpoint.json").exists():
        raise PermissionError("checkpoint exists; use squeeze resume instead of launching duplicate training")
    if not resume and (workspace.result / "receipt.json").exists():
        raise PermissionError("job already completed; duplicate training is prohibited")
    campaign_root = args.campaign_root.expanduser().resolve()
    policy = LocalPolicy(approved_commits=frozenset({capsule.source_commit}))
    plan = ExecutionPlan(capsule=capsule, workspace=workspace, campaign_root=campaign_root)
    return execute(plan, policy, resume=resume)


def _jobs(args: argparse.Namespace) -> int:
    jobs_root = args.root.expanduser().resolve() / "jobs"
    rows = []
    if jobs_root.exists():
        for path in sorted(jobs_root.iterdir()):
            if path.is_dir():
                rows.append({"job_id": path.name, "checkpoint": (path / "checkpoints/relay-checkpoint.json").exists(), "result": (path / "result/receipt.json").exists()})
    print(json.dumps(rows, indent=2, sort_keys=True))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="squeeze")
    sub = parser.add_subparsers(dest="command", required=True)

    doctor = sub.add_parser("doctor")
    doctor.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    doctor.set_defaults(handler=lambda args: print_doctor(args.root.expanduser() / "checkpoints"))

    for name in ("register", "serve", "status"):
        child = sub.add_parser(name)
        child.set_defaults(handler=lambda _args, n=name: _not_implemented(n))

    jobs = sub.add_parser("jobs")
    jobs.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    jobs.set_defaults(handler=_jobs)

    approve = sub.add_parser("approve")
    approve.add_argument("job_id")
    approve.add_argument("--capsule", type=Path, required=True)
    approve.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    approve.set_defaults(handler=_approve)

    for name, resume in (("run", False), ("resume", True)):
        child = sub.add_parser(name)
        child.add_argument("job_id")
        child.add_argument("--campaign-root", type=Path, required=True)
        child.add_argument("--root", type=Path, default=DEFAULT_ROOT)
        child.set_defaults(handler=lambda args, r=resume: _run_job(args, resume=r))

    for name in ("pause", "cancel", "upload"):
        child = sub.add_parser(name)
        child.add_argument("job_id")
        child.set_defaults(handler=lambda _args, n=name: _not_implemented(n))

    verify = sub.add_parser("verify")
    verify.add_argument("capsule", type=Path)
    verify.add_argument("--approved-commit", action="append", default=[])
    verify.add_argument("--used-nonce", action="append", default=[])
    verify.set_defaults(handler=_verify)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.handler(args))
    except (CapsuleError, PermissionError, RuntimeError, OSError) as exc:
        print(json.dumps({"status": "rejected", "error": str(exc)}, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
