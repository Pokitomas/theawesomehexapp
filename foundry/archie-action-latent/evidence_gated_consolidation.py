#!/usr/bin/env python3
"""Evidence-gated consolidation: hallucinations may exist, but cannot harden into truth.

The expensive version of "verify every token before emission" confuses language
with epistemic state.  A fluent sentence contains connective tissue, style, and
claims; only the claims need truth-bearing status.  This developmental court
therefore separates:

    semantic proposal -> volatile claim -> verifier receipt -> stable claim

Unsupported proposals are allowed to remain useful hypotheses, but they cannot
become durable world-state merely by being repeated.  Operational evidence is
freshness-bounded.  Mathematical/executable evidence is durable but tied to an
exact claim hash and verifier artifact.  A contradictory valid receipt does not
silently overwrite stable memory: both claims enter a conflict set until an
explicit adjudication receipt names the conflict.

This is not a hallucination-free generator.  It is a structural court for
preventing linguistic confidence from laundering itself into persistent truth.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Claim:
    subject: str
    predicate: str
    value: str
    scope: str = "world"

    @property
    def key(self) -> str:
        return f"{self.scope}\x1f{self.subject}\x1f{self.predicate}"

    @property
    def canonical(self) -> str:
        return json.dumps(asdict(self), sort_keys=True, separators=(",", ":"))

    @property
    def claim_hash(self) -> str:
        return digest(self.canonical)


@dataclass(frozen=True)
class Receipt:
    kind: str
    claim_hash: str
    verifier: str
    artifact_hash: str
    verdict: str = "pass"
    issued_ns: int = 0
    expires_ns: int = 0
    # Adjudication receipts name the deterministic digest of a conflict set.
    conflict_hash: str = ""

    @property
    def receipt_hash(self) -> str:
        return digest(json.dumps(asdict(self), sort_keys=True, separators=(",", ":")))


class EvidenceGatedMemory:
    SCHEMA = "archie/evidence-gated-consolidation-v1"
    OPERATIONAL_KINDS = {"operational", "sensor", "service", "capability"}
    DURABLE_KINDS = {"executable", "mathematical", "artifact", "formal"}

    def __init__(self, now_ns: int | None = None):
        self.now_ns = int(time.time_ns() if now_ns is None else now_ns)
        self.volatile: dict[str, list[Claim]] = {}
        self.stable: dict[str, Claim] = {}
        self.stable_receipt: dict[str, Receipt] = {}
        self.conflicts: dict[str, dict[str, Any]] = {}
        self.audit: list[dict[str, Any]] = []

    def _receipt_valid(self, claim: Claim, receipt: Receipt | None) -> tuple[bool, str]:
        if receipt is None:
            return False, "no_receipt"
        if receipt.verdict != "pass":
            return False, "verifier_failed"
        if receipt.claim_hash != claim.claim_hash:
            return False, "claim_hash_mismatch"
        if not receipt.verifier or not receipt.artifact_hash:
            return False, "missing_verifier_identity"
        if receipt.kind in self.OPERATIONAL_KINDS:
            if receipt.issued_ns <= 0 or receipt.expires_ns <= receipt.issued_ns:
                return False, "invalid_freshness_window"
            if not (receipt.issued_ns <= self.now_ns <= receipt.expires_ns):
                return False, "stale_operational_receipt"
            return True, "fresh_operational_receipt"
        if receipt.kind in self.DURABLE_KINDS:
            return True, "durable_verifier_receipt"
        return False, "unsupported_receipt_kind"

    def propose(self, claim: Claim, receipt: Receipt | None = None) -> dict[str, Any]:
        valid, reason = self._receipt_valid(claim, receipt)
        event = {
            "claim_hash": claim.claim_hash,
            "key": claim.key,
            "value": claim.value,
            "receipt_hash": receipt.receipt_hash if receipt else "",
            "receipt_valid": valid,
            "reason": reason,
        }
        if not valid:
            self.volatile.setdefault(claim.key, []).append(claim)
            event["result"] = "volatile"
            self.audit.append(event)
            return event

        existing = self.stable.get(claim.key)
        if existing is None or existing.claim_hash == claim.claim_hash:
            self.stable[claim.key] = claim
            assert receipt is not None
            self.stable_receipt[claim.key] = receipt
            event["result"] = "stable"
            self.audit.append(event)
            return event

        # Two independently receipt-backed values for one world-state key are
        # not resolved by confidence, recency, or repetition. Quarantine both.
        old_receipt = self.stable_receipt.pop(claim.key)
        self.stable.pop(claim.key, None)
        conflict_claims = sorted([existing.claim_hash, claim.claim_hash])
        conflict_receipts = sorted([old_receipt.receipt_hash, receipt.receipt_hash])
        conflict_hash = digest("|".join(conflict_claims + conflict_receipts))
        self.conflicts[claim.key] = {
            "conflict_hash": conflict_hash,
            "claims": {existing.claim_hash: existing, claim.claim_hash: claim},
            "receipts": {old_receipt.receipt_hash: old_receipt, receipt.receipt_hash: receipt},
        }
        event.update({"result": "conflict", "conflict_hash": conflict_hash})
        self.audit.append(event)
        return event

    def adjudicate(self, key: str, winning_claim_hash: str, receipt: Receipt) -> dict[str, Any]:
        conflict = self.conflicts.get(key)
        event = {"key": key, "winning_claim_hash": winning_claim_hash, "receipt_hash": receipt.receipt_hash}
        if conflict is None:
            event.update({"result": "rejected", "reason": "no_conflict"})
            self.audit.append(event)
            return event
        if receipt.kind != "formal" or receipt.verdict != "pass":
            event.update({"result": "rejected", "reason": "adjudicator_not_formal_pass"})
            self.audit.append(event)
            return event
        if receipt.conflict_hash != conflict["conflict_hash"]:
            event.update({"result": "rejected", "reason": "conflict_hash_mismatch"})
            self.audit.append(event)
            return event
        claim = conflict["claims"].get(winning_claim_hash)
        if claim is None:
            event.update({"result": "rejected", "reason": "winner_not_in_conflict"})
            self.audit.append(event)
            return event
        # The adjudicator is evidence about the conflict, not the claim itself;
        # preserve the original claim receipt as provenance and attach audit.
        original_receipt = next(
            r for r in conflict["receipts"].values() if r.claim_hash == winning_claim_hash
        )
        self.stable[key] = claim
        self.stable_receipt[key] = original_receipt
        self.conflicts.pop(key, None)
        event.update({"result": "stable", "reason": "explicit_adjudication"})
        self.audit.append(event)
        return event

    def snapshot(self) -> dict[str, Any]:
        return {
            "schema": self.SCHEMA,
            "now_ns": self.now_ns,
            "stable": {k: asdict(v) for k, v in sorted(self.stable.items())},
            "stable_receipts": {k: asdict(v) for k, v in sorted(self.stable_receipt.items())},
            "volatile": {k: [asdict(x) for x in rows] for k, rows in sorted(self.volatile.items())},
            "conflicts": {
                k: {
                    "conflict_hash": v["conflict_hash"],
                    "claims": {h: asdict(c) for h, c in sorted(v["claims"].items())},
                    "receipt_hashes": sorted(v["receipts"].keys()),
                }
                for k, v in sorted(self.conflicts.items())
            },
            "audit": list(self.audit),
        }


def receipt_for(
    claim: Claim,
    *,
    kind: str,
    now_ns: int,
    ttl_ns: int = 0,
    verifier: str = "court/verifier",
    artifact_hash: str = "a" * 64,
    verdict: str = "pass",
) -> Receipt:
    expires = now_ns + ttl_ns if ttl_ns else 0
    return Receipt(
        kind=kind,
        claim_hash=claim.claim_hash,
        verifier=verifier,
        artifact_hash=artifact_hash,
        verdict=verdict,
        issued_ns=now_ns if kind in EvidenceGatedMemory.OPERATIONAL_KINDS else 0,
        expires_ns=expires,
    )


def run_court(now_ns: int = 1_786_500_000_000_000_000) -> dict[str, Any]:
    m = EvidenceGatedMemory(now_ns=now_ns)

    unsupported = Claim("semantic-model", "proved_theorem", "yes", "math")
    unsupported_result = m.propose(unsupported)

    live = Claim("archie-live-exec.service", "state", "active", "host")
    stale = receipt_for(live, kind="service", now_ns=now_ns - 10_000, ttl_ns=1_000)
    stale_result = m.propose(live, stale)
    fresh = receipt_for(live, kind="service", now_ns=now_ns - 100, ttl_ns=1_000)
    fresh_result = m.propose(live, fresh)

    theorem = Claim("information_budget", "arbitrary_unbounded_history_in_finite_discrete_state", "impossible", "math")
    theorem_receipt = receipt_for(theorem, kind="executable", now_ns=now_ns, verifier="information-budget-court", artifact_hash="b" * 64)
    theorem_result = m.propose(theorem, theorem_receipt)

    # A mismatched receipt must not authorize a prettier neighboring claim.
    mutated = Claim("information_budget", "arbitrary_unbounded_history_in_finite_discrete_state", "possible", "math")
    mismatch_result = m.propose(mutated, theorem_receipt)

    inactive = Claim("archie-live-exec.service", "state", "inactive", "host")
    inactive_receipt = receipt_for(inactive, kind="service", now_ns=now_ns - 50, ttl_ns=1_000, artifact_hash="c" * 64)
    conflict_result = m.propose(inactive, inactive_receipt)
    conflict_hash = conflict_result.get("conflict_hash", "")
    bad_adjudication = Receipt(
        kind="formal",
        claim_hash="",
        verifier="host-state-adjudicator",
        artifact_hash="d" * 64,
        verdict="pass",
        conflict_hash="wrong",
    )
    bad_resolution = m.adjudicate(live.key, live.claim_hash, bad_adjudication)
    good_adjudication = Receipt(
        kind="formal",
        claim_hash="",
        verifier="host-state-adjudicator",
        artifact_hash="e" * 64,
        verdict="pass",
        conflict_hash=conflict_hash,
    )
    good_resolution = m.adjudicate(live.key, live.claim_hash, good_adjudication)

    snap = m.snapshot()
    stable_values = {k: v["value"] for k, v in snap["stable"].items()}
    passed = bool(
        unsupported_result["result"] == "volatile"
        and stale_result["result"] == "volatile"
        and fresh_result["result"] == "stable"
        and theorem_result["result"] == "stable"
        and mismatch_result["result"] == "volatile"
        and conflict_result["result"] == "conflict"
        and bad_resolution["result"] == "rejected"
        and good_resolution["result"] == "stable"
        and not snap["conflicts"]
        and stable_values.get(live.key) == "active"
        and stable_values.get(theorem.key) == "impossible"
    )
    return {
        "schema": "archie/evidence-gated-consolidation-court-v1",
        "pass": passed,
        "stable_count": len(snap["stable"]),
        "volatile_claim_count": sum(len(v) for v in snap["volatile"].values()),
        "conflict_count": len(snap["conflicts"]),
        "unsupported_result": unsupported_result["result"],
        "stale_operational_result": stale_result["result"],
        "fresh_operational_result": fresh_result["result"],
        "durable_executable_result": theorem_result["result"],
        "mismatched_receipt_result": mismatch_result["result"],
        "contradiction_result": conflict_result["result"],
        "bad_adjudication_result": bad_resolution["result"],
        "good_adjudication_result": good_resolution["result"],
        "snapshot": snap,
        "architectural_consequence": (
            "Language can remain a fast speculative projection while durable cognition separates labile hypotheses from receipt-backed world state. "
            "Verification occurs at claim/state-transition boundaries rather than on every connective token; contradictions become explicit objects instead of silent overwrites."
        ),
        "claim_boundary": (
            "PASS proves only the admission semantics of this small evidence memory. It does not classify arbitrary natural-language claims, supply verifiers, or make generation hallucination-free."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output")
    args = parser.parse_args()
    result = run_court()
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        path = Path(args.output).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", "utf-8")
    print(text)
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
