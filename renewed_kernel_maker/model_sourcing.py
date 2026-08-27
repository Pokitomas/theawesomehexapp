from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from core import canonical, receipt


@dataclass(frozen=True)
class ModelCandidate:
    name: str
    source: str
    license: str
    weights: str
    params_b: float
    active_b: float | None
    context: int
    tool_use: bool
    q4_gib_estimate: float
    role: str
    notes: str = ""


# Concrete upstream model IDs. Memory estimates are admission heuristics only;
# actual local files and benchmarked context KV determine whether a model runs.
DEFAULTS = (
    ModelCandidate(
        "GLM-5.3-Flash", "zai-org/GLM-5.3-Flash", "upstream-open", "HF/native",
        320, 18, 1_000_000, True, 180.0, "teacher",
        "ox-alpha identity; teacher/offline-large-host lane",
    ),
    ModelCandidate(
        "GLM-4.7-Flash", "zai-org/GLM-4.7-Flash", "MIT", "HF/native-or-quantized",
        30, 3, 128_000, True, 18.0, "teacher_or_large_local",
        "30B total / 3B active; total weights still exceed small VRAM",
    ),
    ModelCandidate(
        "gpt-oss-20b", "openai/gpt-oss-20b", "Apache-2.0", "MXFP4/native",
        20, None, 131_072, True, 12.0, "large_local",
        "open-weight reasoning/tool candidate; benchmark only when memory admits",
    ),
    ModelCandidate(
        "Qwen3-8B-Q4_K_M", "Qwen/Qwen3-8B-GGUF", "Apache-2.0", "GGUF/Q4_K_M",
        8, None, 32_768, True, 5.2, "small_local",
        "official Qwen GGUF exists; strong tool-capable baseline for ~6-8 GiB tier",
    ),
    ModelCandidate(
        "Qwen2.5-Coder-7B-Instruct-Q4", "Qwen/Qwen2.5-Coder-7B-Instruct", "Apache-2.0", "GGUF/Q4",
        7, None, 32_768, True, 4.8, "small_local",
        "code-specialized fallback; compare on heldout maker tasks rather than reputation",
    ),
    ModelCandidate(
        "small-maker-student", "local-training", "derived-from-approved-corpus", "trainer-checkpoint",
        0.024, None, 8192, True, 0.5, "student",
        "mechanism/student lane; not expected to match 7-8B capability without evidence",
    ),
)


def weight_fit(c: ModelCandidate, *, vram_gib: float, reserve_gib: float = 0.8) -> float:
    usable = max(0.0, float(vram_gib) - max(0.0, float(reserve_gib)))
    if c.q4_gib_estimate <= usable:
        return 1.0
    return max(0.0, usable / max(0.1, c.q4_gib_estimate))


def rank(c: ModelCandidate, *, vram_gib: float, needs_training: bool = False) -> float:
    fit = weight_fit(c, vram_gib=vram_gib)
    role_penalty = 3.0 if c.role == "teacher" else (1.2 if c.role == "teacher_or_large_local" else 0.0)
    if needs_training and c.role in {"teacher", "teacher_or_large_local"}:
        role_penalty += 1.0
    context_score = min(1.5, c.context / 65536)
    score = 6 * fit + 2 * int(c.tool_use) + context_score - role_penalty
    if fit < 0.92:
        score -= 4.0
    return round(score, 6)


def inspect_ggufs(search_roots: list[Path]) -> list[dict[str, Any]]:
    found = []
    seen = set()
    for root in search_roots:
        if not root.exists():
            continue
        for p in root.rglob("*.gguf"):
            try:
                rp = p.resolve()
                if rp in seen:
                    continue
                seen.add(rp)
                size = p.stat().st_size
                found.append({"path": str(p), "bytes": size, "gib": size / (1024 ** 3)})
            except OSError:
                continue
    return sorted(found, key=lambda x: (x["gib"], x["path"]))


def plan(*, vram_gib: float, disk_gib: float, candidates=DEFAULTS, local_ggufs: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    ranked = sorted(
        ({"candidate": asdict(c), "fit": weight_fit(c, vram_gib=vram_gib), "score": rank(c, vram_gib=vram_gib)} for c in candidates),
        key=lambda x: (-x["score"], x["candidate"]["name"]),
    )
    admitted = [x for x in ranked if x["fit"] >= 0.92 and x["candidate"]["role"] != "teacher"]
    teachers = [x for x in ranked if x["candidate"]["role"] in {"teacher", "teacher_or_large_local"}]
    local = admitted[0] if admitted else None
    teacher = teachers[0] if teachers else None
    strategy = {
        "local_runtime": local["candidate"]["name"] if local else "smaller-or-more-offload-required",
        "teacher": teacher["candidate"]["name"] if teacher else None,
        "selection_rule": "run heldout voxel/app-maker tournament among every admitted local candidate; measured success outranks static score",
        "distillation": [
            "successful-and-failed-tool-trajectories",
            "repair-trajectories",
            "preference-pairs-from-deterministic-graders",
            "teacher-token-distributions-if-observable",
            "teacher-hidden-state-probes-if-observable",
        ],
        "triton": "only after reference numerical equivalence and measured end-to-end speedup",
        "full_teacher_local": bool(teacher and teacher["fit"] >= 0.92 and disk_gib >= 220),
    }
    body = {
        "vram_gib": vram_gib,
        "disk_gib": disk_gib,
        "ranked": ranked,
        "local_ggufs": local_ggufs or [],
        "strategy": strategy,
    }
    body["sha256"] = hashlib.sha256(canonical(body)).hexdigest()
    return body


def court() -> dict[str, Any]:
    p6 = plan(vram_gib=6, disk_gib=100)
    p24 = plan(vram_gib=24, disk_gib=300)
    passes = (
        p6["strategy"]["full_teacher_local"] is False
        and p6["strategy"]["local_runtime"] in {"Qwen3-8B-Q4_K_M", "Qwen2.5-Coder-7B-Instruct-Q4", "small-maker-student"}
        and p24["strategy"]["local_runtime"] != "GLM-5.3-Flash"
    )
    return receipt("model_sourcing.court", {"passes": passes, "six_gib": p6["strategy"], "twenty_four_gib": p24["strategy"], "sha256": p6["sha256"]})


if __name__ == "__main__":
    print(json.dumps(court(), indent=2))
