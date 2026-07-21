from __future__ import annotations

import dataclasses
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = "squeeze-job-v1"
PROMOTION = "research-only-not-admitted"
FULL_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
NONCE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$")

FIELDS = frozenset(
    {
        "schema",
        "repository",
        "source_commit",
        "entrypoint",
        "entrypoint_sha256",
        "arguments",
        "environment_profile",
        "required_evaluator_sha256",
        "output_contract",
        "promotion",
        "expires_at",
        "nonce",
    }
)


class CapsuleError(ValueError):
    """Raised when a job capsule is malformed before policy evaluation."""


def _parse_expiration(value: str) -> datetime:
    if not isinstance(value, str):
        raise CapsuleError("expires_at must be an RFC3339 string")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise CapsuleError("expires_at is not valid RFC3339") from exc
    if parsed.tzinfo is None:
        raise CapsuleError("expires_at must include a timezone")
    return parsed.astimezone(timezone.utc)


@dataclasses.dataclass(frozen=True, slots=True)
class JobCapsule:
    schema: str
    repository: str
    source_commit: str
    entrypoint: str
    entrypoint_sha256: str
    arguments: tuple[str, ...]
    environment_profile: str
    required_evaluator_sha256: str
    output_contract: str
    promotion: str
    expires_at: datetime
    nonce: str

    @classmethod
    def from_mapping(cls, raw: dict[str, Any]) -> "JobCapsule":
        if not isinstance(raw, dict):
            raise CapsuleError("capsule root must be an object")
        unknown = set(raw) - FIELDS
        missing = FIELDS - set(raw)
        if unknown:
            raise CapsuleError(f"unknown capsule fields: {sorted(unknown)}")
        if missing:
            raise CapsuleError(f"missing capsule fields: {sorted(missing)}")
        arguments = raw["arguments"]
        if not isinstance(arguments, list) or not all(isinstance(v, str) for v in arguments):
            raise CapsuleError("arguments must be an array of strings")
        string_fields = FIELDS - {"arguments", "expires_at"}
        for field in string_fields:
            if not isinstance(raw[field], str):
                raise CapsuleError(f"{field} must be a string")
        return cls(
            schema=raw["schema"],
            repository=raw["repository"],
            source_commit=raw["source_commit"],
            entrypoint=raw["entrypoint"],
            entrypoint_sha256=raw["entrypoint_sha256"],
            arguments=tuple(arguments),
            environment_profile=raw["environment_profile"],
            required_evaluator_sha256=raw["required_evaluator_sha256"],
            output_contract=raw["output_contract"],
            promotion=raw["promotion"],
            expires_at=_parse_expiration(raw["expires_at"]),
            nonce=raw["nonce"],
        )

    @classmethod
    def load(cls, path: Path) -> "JobCapsule":
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise CapsuleError(f"cannot read capsule: {exc}") from exc
        return cls.from_mapping(raw)

    def as_canonical_mapping(self) -> dict[str, Any]:
        return {
            "arguments": list(self.arguments),
            "entrypoint": self.entrypoint,
            "entrypoint_sha256": self.entrypoint_sha256,
            "environment_profile": self.environment_profile,
            "expires_at": self.expires_at.isoformat().replace("+00:00", "Z"),
            "nonce": self.nonce,
            "output_contract": self.output_contract,
            "promotion": self.promotion,
            "repository": self.repository,
            "required_evaluator_sha256": self.required_evaluator_sha256,
            "schema": self.schema,
            "source_commit": self.source_commit,
        }

    def canonical_bytes(self) -> bytes:
        return (
            json.dumps(self.as_canonical_mapping(), sort_keys=True, separators=(",", ":")) + "\n"
        ).encode("utf-8")

    def digest(self) -> str:
        return hashlib.sha256(self.canonical_bytes()).hexdigest()
