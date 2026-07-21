from __future__ import annotations

import argparse
import dataclasses
import json
from pathlib import Path

from .capsule import CapsuleError, JobCapsule
from .policy import LocalPolicy


def _not_implemented(command: str) -> int:
    print(json.dumps({"command": command, "status": "not-implemented", "promotion": "research-only-not-admitted"}))
    return 2


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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="squeeze")
    sub = parser.add_subparsers(dest="command", required=True)

    for name in ("doctor", "register", "serve", "status", "jobs"):
        sub.add_parser(name).set_defaults(handler=lambda _args, n=name: _not_implemented(n))

    for name in ("approve", "run", "pause", "resume", "cancel", "upload"):
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
    return int(args.handler(args))


if __name__ == "__main__":
    raise SystemExit(main())
