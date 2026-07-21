from __future__ import annotations

import dataclasses
import re
from datetime import datetime, timezone
from typing import Iterable

from .capsule import (
    FULL_SHA_RE,
    NONCE_RE,
    PROMOTION,
    SCHEMA,
    SHA256_RE,
    JobCapsule,
)

REPOSITORY = "Pokitomas/theawesomehexapp"
ENTRYPOINT = "foundry/archie-protocol/latent_world_benchmark/research/efficient_terminal_training.py"
ENVIRONMENT_PROFILE = "archie-cuda-v1"
OUTPUT_CONTRACT = "terminal-efficiency-v3"
ALLOWED_ARGUMENTS = ("--scale", "base")

_SECRET_PATTERNS = (
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
)


@dataclasses.dataclass(frozen=True, slots=True)
class PolicyViolation:
    code: str
    message: str


@dataclasses.dataclass(frozen=True, slots=True)
class VerificationResult:
    accepted: bool
    capsule_digest: str
    violations: tuple[PolicyViolation, ...]

    def require(self) -> None:
        if not self.accepted:
            details = "; ".join(f"{v.code}: {v.message}" for v in self.violations)
            raise PermissionError(details)


@dataclasses.dataclass(frozen=True, slots=True)
class LocalPolicy:
    approved_commits: frozenset[str]
    used_nonces: frozenset[str] = frozenset()
    repository: str = REPOSITORY
    entrypoint: str = ENTRYPOINT
    environment_profile: str = ENVIRONMENT_PROFILE
    output_contract: str = OUTPUT_CONTRACT
    allowed_arguments: tuple[str, ...] = ALLOWED_ARGUMENTS
    max_future_seconds: int = 7 * 24 * 60 * 60

    def verify(self, capsule: JobCapsule, *, now: datetime | None = None) -> VerificationResult:
        now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        violations: list[PolicyViolation] = []

        def reject(code: str, message: str) -> None:
            violations.append(PolicyViolation(code, message))

        if capsule.schema != SCHEMA:
            reject("schema", f"expected {SCHEMA!r}")
        if capsule.repository != self.repository:
            reject("repository", "repository is not allowlisted")
        if not FULL_SHA_RE.fullmatch(capsule.source_commit):
            reject("source_commit", "source_commit must be a full lowercase SHA")
        elif capsule.source_commit not in self.approved_commits:
            reject("approval", "exact source commit lacks local approval")
        if capsule.entrypoint != self.entrypoint:
            reject("entrypoint", "entrypoint is not allowlisted")
        if not SHA256_RE.fullmatch(capsule.entrypoint_sha256):
            reject("entrypoint_digest", "entrypoint_sha256 must be lowercase SHA-256")
        if not SHA256_RE.fullmatch(capsule.required_evaluator_sha256):
            reject("evaluator_digest", "required_evaluator_sha256 must be lowercase SHA-256")
        if capsule.arguments != self.allowed_arguments:
            reject("arguments", "arguments exceed the bounded allowlist")
        if capsule.environment_profile != self.environment_profile:
            reject("environment", "environment profile is not allowlisted")
        if capsule.output_contract != self.output_contract:
            reject("output_contract", "output contract is not allowlisted")
        if capsule.promotion != PROMOTION:
            reject("promotion", "promotion must remain research-only-not-admitted")
        if not NONCE_RE.fullmatch(capsule.nonce):
            reject("nonce", "nonce format is invalid")
        elif capsule.nonce in self.used_nonces:
            reject("nonce_reuse", "nonce has already been consumed")
        if capsule.expires_at <= now:
            reject("expired", "capsule has expired")
        elif (capsule.expires_at - now).total_seconds() > self.max_future_seconds:
            reject("expiration_window", "capsule expiration exceeds local policy")

        for value in _all_text(capsule):
            if any(pattern.search(value) for pattern in _SECRET_PATTERNS):
                reject("embedded_secret", "capsule appears to contain a credential")
                break
            if "\x00" in value or "\n" in value or "\r" in value:
                reject("control_character", "capsule strings may not contain control lines")
                break

        return VerificationResult(not violations, capsule.digest(), tuple(violations))


def _all_text(capsule: JobCapsule) -> Iterable[str]:
    mapping = capsule.as_canonical_mapping()
    for value in mapping.values():
        if isinstance(value, str):
            yield value
        elif isinstance(value, list):
            yield from value
