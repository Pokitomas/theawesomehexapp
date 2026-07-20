from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

from diversity_training_io import file_sha256, sha256_bytes

def read_audit_evidence(audit_root: Path | None) -> dict:
    if audit_root is None:
        return {"available": False}
    receipt_path = audit_root / "artifacts/admissions/core-v1-repair/admission-receipt.json"
    cases_path = audit_root / "artifacts/admissions/core-v1-repair/evaluation-cases.jsonl"
    if not receipt_path.exists() or not cases_path.exists():
        return {"available": False, "requested_root": str(audit_root)}
    admission = json.loads(receipt_path.read_text(encoding="utf-8"))
    failures = Counter()
    failed_ids: list[str] = []
    for line in cases_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        case = json.loads(line)
        case_failed = False
        for key in ["strict_json", "protocol_valid", "route_correct", "tool_match", "mutating_confirmation_ok", "abstention_ok", "trace_success"]:
            if case.get(key) is False:
                failures[key] += 1
                case_failed = True
        if case_failed:
            failed_ids.append(str(case.get("id")))
    return {
        "available": True,
        "admission": admission.get("admission"),
        "model_sha256": admission.get("model", {}).get("sha256"),
        "source_receipt_sha256": file_sha256(receipt_path),
        "source_cases_sha256": file_sha256(cases_path),
        "source_metrics": admission.get("metrics"),
        "failed_gate_names": sorted(name for name, passed in admission.get("gates", {}).items() if not passed),
        "failure_counts": dict(sorted(failures.items())),
        "failed_case_count": len(failed_ids),
        "failed_case_ids_digest": sha256_bytes("\n".join(sorted(failed_ids)).encode()),
        "weight_shards_present": any((audit_root / "artifacts/training/archie-core-v1-repair").glob("**/*.safetensors")),
    }
