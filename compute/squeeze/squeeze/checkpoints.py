from __future__ import annotations

import dataclasses
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Mapping


class ResumeIdentityError(RuntimeError):
    pass


@dataclasses.dataclass(frozen=True, slots=True)
class RunIdentity:
    source_commit: str
    entrypoint_sha256: str
    evaluator_sha256: str
    job_capsule_sha256: str
    training_config_sha256: str
    campaign_manifest_sha256: str
    environment_profile: str
    output_contract: str
    promotion: str

    def as_dict(self) -> dict[str, str]:
        return dataclasses.asdict(self)

    def digest(self) -> str:
        payload = json.dumps(self.as_dict(), sort_keys=True, separators=(",", ":")).encode()
        return hashlib.sha256(payload).hexdigest()


def atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def require_identity(expected: RunIdentity, observed: Mapping[str, Any]) -> None:
    expected_dict = expected.as_dict()
    mismatches = {
        key: {"expected": value, "observed": observed.get(key)}
        for key, value in expected_dict.items()
        if observed.get(key) != value
    }
    if mismatches:
        raise ResumeIdentityError(f"resume identity mismatch: {json.dumps(mismatches, sort_keys=True)}")


def checkpoint_metadata_path(checkpoint_root: Path) -> Path:
    return checkpoint_root / "relay-checkpoint.json"


def write_checkpoint_metadata(
    checkpoint_root: Path,
    identity: RunIdentity,
    *,
    optimizer_steps: int,
    event_tokens: int,
    allocation_rung: int,
    resume_count: int,
    state_file: str,
) -> Path:
    path = checkpoint_metadata_path(checkpoint_root)
    atomic_json(
        path,
        {
            "schema": "squeeze-checkpoint-v1",
            "identity": identity.as_dict(),
            "identity_sha256": identity.digest(),
            "optimizer_steps": optimizer_steps,
            "event_tokens": event_tokens,
            "allocation_rung": allocation_rung,
            "resume_count": resume_count,
            "state_file": state_file,
            "promotion": "research-only-not-admitted",
        },
    )
    return path


def read_checkpoint_metadata(checkpoint_root: Path, identity: RunIdentity) -> dict[str, Any] | None:
    path = checkpoint_metadata_path(checkpoint_root)
    if not path.exists():
        return None
    raw = json.loads(path.read_text(encoding="utf-8"))
    if raw.get("schema") != "squeeze-checkpoint-v1":
        raise ResumeIdentityError("unknown checkpoint metadata schema")
    require_identity(identity, raw.get("identity", {}))
    if raw.get("promotion") != "research-only-not-admitted":
        raise ResumeIdentityError("checkpoint promotion boundary changed")
    return raw
