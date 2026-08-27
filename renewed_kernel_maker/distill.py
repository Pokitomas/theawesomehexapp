from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Iterable

from core import available_accelerators, receipt

TEACHER_REPO = "zai-org/GLM-5.3-Flash"
TEACHER_ALIAS = "ox-alpha"
TEACHER_TOTAL_PARAMS_B = 320
TEACHER_ACTIVE_PARAMS_B = 18


@dataclass(frozen=True)
class TeacherSpec:
    alias: str = TEACHER_ALIAS
    repo: str = TEACHER_REPO
    total_params_b: int = TEACHER_TOTAL_PARAMS_B
    active_params_b: int = TEACHER_ACTIVE_PARAMS_B
    architecture: str = "MoE/hybrid sparse+linear attention with mHC"
    open_weights: bool = True


@dataclass(frozen=True)
class StudentSpec:
    name: str = "archie-kernel-maker-student"
    parameter_budget_m: int = 24
    context_target: int = 8192
    objective: str = "maker/tool-use behavior plus representation transfer where observable"


def _nvidia() -> dict[str, Any]:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return {"available": False, "reason": "nvidia-smi-missing"}
    q = "memory.total,memory.free,name"
    try:
        p = subprocess.run([exe, f"--query-gpu={q}", "--format=csv,noheader,nounits"], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=5)
        rows = []
        for line in p.stdout.splitlines():
            bits = [x.strip() for x in line.split(",", 2)]
            if len(bits) == 3:
                rows.append({"memory_total_mib": int(bits[0]), "memory_free_mib": int(bits[1]), "name": bits[2]})
        return {"available": p.returncode == 0 and bool(rows), "gpus": rows, "stdout": p.stdout[-2000:]}
    except Exception as exc:
        return {"available": False, "reason": f"{type(exc).__name__}: {exc}"}


def resource_probe() -> dict[str, Any]:
    gpu = _nvidia()
    disk = shutil.disk_usage(Path.cwd())
    return receipt("distill.resource_probe", {
        "teacher": asdict(TeacherSpec()),
        "student": asdict(StudentSpec()),
        "gpu": gpu,
        "disk_free_gib": disk.free / (1024 ** 3),
        "accelerators": available_accelerators(),
    })


def full_teacher_local_admissible(probe: dict[str, Any]) -> tuple[bool, list[str]]:
    p = probe["payload"]
    reasons: list[str] = []
    gpus = (p.get("gpu") or {}).get("gpus") or []
    total_free = sum(int(x.get("memory_free_mib") or 0) for x in gpus)
    # This is intentionally conservative: even aggressive low-bit quantization
    # of 320B weights plus runtime state is far above a single consumer 6 GB GPU.
    if total_free < 96 * 1024:
        reasons.append(f"gpu_free_mib={total_free}<98304")
    if float(p.get("disk_free_gib") or 0.0) < 220.0:
        reasons.append("disk_free_gib<220")
    return (not reasons), reasons


def architecture_gap() -> dict[str, Any]:
    teacher = TeacherSpec()
    student = StudentSpec()
    return receipt("distill.architecture_gap", {
        "teacher": asdict(teacher),
        "student": asdict(student),
        "mismatch": [
            "parameter-scale",
            "mixture-of-experts-routing",
            "hybrid-sparse-and-linear-attention",
            "multimodal-encoder-path",
            "million-token-serving-state",
            "mHC-residual-connectivity",
        ],
        "match_definition": {
            "not": "parameter-by-parameter or topology identity",
            "behavior": "held-out maker success and tool trajectory agreement",
            "distribution": "teacher/student token KL where teacher logits are available",
            "representation": "CKA/procrustes probes where open-weight hidden states can be sampled",
            "state": "long-horizon task-state consistency under perturbation",
        },
    })


def kl_divergence(teacher_probs: Iterable[float], student_probs: Iterable[float], eps: float = 1e-9) -> float:
    t = [max(eps, float(x)) for x in teacher_probs]
    s = [max(eps, float(x)) for x in student_probs]
    if len(t) != len(s) or not t:
        raise ValueError("distribution shape mismatch")
    tz, sz = sum(t), sum(s)
    t = [x / tz for x in t]
    s = [x / sz for x in s]
    return sum(a * math.log(a / b) for a, b in zip(t, s))


def triton_equivalence_court() -> dict[str, Any]:
    acc = available_accelerators()
    if not (acc.get("triton") or {}).get("available"):
        return receipt("distill.triton_court", {"status": "SKIP", "reason": "triton-unavailable", "accelerators": acc})
    try:
        import torch  # type: ignore
        import triton  # type: ignore
        import triton.language as tl  # type: ignore
    except Exception as exc:
        return receipt("distill.triton_court", {"status": "SKIP", "reason": f"imports:{type(exc).__name__}", "accelerators": acc})
    if not torch.cuda.is_available():
        return receipt("distill.triton_court", {"status": "SKIP", "reason": "cuda-unavailable", "accelerators": acc})

    # Compile the smallest useful distillation primitive: row-wise squared-error
    # accumulation. Promotion requires exact reference agreement within fp32
    # tolerance; timing is reported but never substitutes for correctness.
    try:
        @triton.jit
        def sqerr_kernel(x, y, out, n: tl.constexpr, BLOCK: tl.constexpr):
            offs = tl.arange(0, BLOCK)
            mask = offs < n
            dx = tl.load(x + offs, mask=mask, other=0.0).to(tl.float32)
            dy = tl.load(y + offs, mask=mask, other=0.0).to(tl.float32)
            v = (dx - dy) * (dx - dy)
            s = tl.sum(v, axis=0)
            tl.store(out, s)

        n = 4096
        x = torch.linspace(-1, 1, n, device="cuda", dtype=torch.float32)
        y = torch.flip(x, dims=[0])
        out = torch.empty(1, device="cuda", dtype=torch.float32)
        sqerr_kernel[(1,)](x, y, out, n=n, BLOCK=4096)
        torch.cuda.synchronize()
        ref = torch.sum((x - y) ** 2)
        abs_error = float(torch.abs(out[0] - ref).item())
        ok = abs_error <= max(1e-4, float(abs(ref.item())) * 2e-6)
        return receipt("distill.triton_court", {
            "status": "PASS" if ok else "FAIL",
            "abs_error": abs_error,
            "reference": float(ref.item()),
            "kernel": float(out[0].item()),
            "promotable": ok,
            "triton_version": getattr(triton, "__version__", "unknown"),
        })
    except Exception as exc:
        return receipt("distill.triton_court", {"status": "FAIL", "reason": f"{type(exc).__name__}: {exc}", "promotable": False})


def teacher_import_attempt() -> dict[str, Any]:
    probe = resource_probe()
    admissible, reasons = full_teacher_local_admissible(probe)
    if not admissible:
        return receipt("distill.teacher_import", {
            "status": "BLOCKED",
            "teacher": TEACHER_REPO,
            "reason": "full-open-weight-teacher-exceeds-local-resource-court",
            "details": reasons,
            "fallbacks": [
                "remote-teacher-behavior-traces-with-held-out-eval",
                "sharded/offline-teacher-on-larger-host",
                "selective-open-weight-layer-probes-on-capable-host",
            ],
        })
    try:
        import huggingface_hub  # type: ignore
        api = huggingface_hub.HfApi()
        info = api.model_info(TEACHER_REPO, files_metadata=False)
        return receipt("distill.teacher_import", {
            "status": "READY_TO_MATERIALIZE",
            "teacher": TEACHER_REPO,
            "revision": getattr(info, "sha", None),
            "note": "metadata resolved; weight download remains an explicit resource-consuming action",
        })
    except Exception as exc:
        return receipt("distill.teacher_import", {
            "status": "BLOCKED",
            "teacher": TEACHER_REPO,
            "reason": f"metadata-resolution:{type(exc).__name__}: {exc}",
        })


def court() -> dict[str, Any]:
    probe = resource_probe()
    gap = architecture_gap()
    teacher = teacher_import_attempt()
    triton = triton_equivalence_court()
    # A tiny hand-checkable KL sanity oracle prevents silently inverted teacher/
    # student scoring before any expensive training is admitted.
    same = kl_divergence([0.2, 0.8], [0.2, 0.8])
    shifted = kl_divergence([0.2, 0.8], [0.8, 0.2])
    return receipt("distill.court", {
        "teacher": TEACHER_REPO,
        "teacher_alias": TEACHER_ALIAS,
        "resource_probe": probe["payload"],
        "architecture_gap": gap["payload"],
        "import_attempt": teacher["payload"],
        "triton": triton["payload"],
        "kl_oracle": {"identity": same, "shifted": shifted, "passes": abs(same) < 1e-12 and shifted > 0.0},
    })


if __name__ == "__main__":
    print(json.dumps(court(), indent=2, default=str))
