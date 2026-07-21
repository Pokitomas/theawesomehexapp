from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
from datetime import datetime, timezone
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .capsule import JobCapsule
from .checkpoints import RunIdentity, read_checkpoint_metadata
from .cuda import CudaReport, doctor
from .policy import LocalPolicy
from .receipts import ensure_identity_key, file_manifest, sha256_file, sign_receipt, write_sha256s
from .workspace import JobWorkspace, build_bwrap_command, checkout_exact

BENCHMARK_ROOT = Path("foundry/archie-protocol/latent_world_benchmark")
MATERIALIZERS = (Path("materialize.py"), Path("campaign_v2/materialize.py"))
EVALUATOR = Path("latent_world_benchmark.py")


class ExecutionRejected(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ExecutionPlan:
    capsule: JobCapsule
    workspace: JobWorkspace
    campaign_root: Path
    python: Path = Path(sys.executable)
    checkpoint_interval: int = 64


def _run(command: list[str], *, cwd: Path, log: Path) -> None:
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("ab") as handle:
        subprocess.run(command, cwd=cwd, check=True, stdout=handle, stderr=subprocess.STDOUT)


def _config_digest(capsule: JobCapsule, interval: int) -> str:
    payload = {
        "arguments": list(capsule.arguments),
        "checkpoint_interval": interval,
        "rungs": [192, 640, 1536],
        "seeds": [30260721, 30360724],
        "batch_size": 64,
        "eval_batch_size": 32,
        "mixed_precision": False,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def prepare(plan: ExecutionPlan, policy: LocalPolicy) -> tuple[CudaReport, RunIdentity]:
    if not plan.campaign_root.resolve().is_relative_to(plan.workspace.root.resolve()):
        raise ExecutionRejected("campaign artifact must be materialized inside the job workspace")
    result = policy.verify(plan.capsule)
    result.require()
    report = doctor(plan.workspace.checkpoints)
    report.require()
    checkout_exact(plan.workspace, plan.capsule.repository, plan.capsule.source_commit)

    entrypoint = plan.workspace.source / plan.capsule.entrypoint
    if sha256_file(entrypoint) != plan.capsule.entrypoint_sha256:
        raise ExecutionRejected("entrypoint digest mismatch")

    benchmark = plan.workspace.source / BENCHMARK_ROOT
    env = {
        "HOME": str(plan.workspace.home),
        "PYTHONNOUSERSITE": "1",
        "PYTHONUNBUFFERED": "1",
        "OMP_NUM_THREADS": "4",
        "MKL_NUM_THREADS": "4",
        "OPENBLAS_NUM_THREADS": "4",
    }
    for materializer in MATERIALIZERS:
        command = build_bwrap_command(
            plan.python,
            [str(materializer)],
            workspace=plan.workspace,
            cwd=benchmark,
            python_prefix=Path(sys.prefix),
            environment=env,
        )
        _run(command, cwd=benchmark, log=plan.workspace.logs / "materialize.log")

    verify_command = build_bwrap_command(
        plan.python,
        ["full_budget_campaign.py", "verify", "--output", str(plan.campaign_root.resolve())],
        workspace=plan.workspace,
        cwd=benchmark,
        python_prefix=Path(sys.prefix),
        environment=env,
        read_only_paths=(plan.workspace.source, plan.campaign_root),
    )
    _run(verify_command, cwd=benchmark, log=plan.workspace.logs / "verify-campaign.log")

    evaluator = benchmark / EVALUATOR
    evaluator_sha = sha256_file(evaluator)
    if evaluator_sha != plan.capsule.required_evaluator_sha256:
        raise ExecutionRejected("materialized evaluator digest mismatch")

    campaign_manifest = plan.campaign_root / "campaign-manifest.json"
    if not campaign_manifest.is_file():
        raise ExecutionRejected("campaign-manifest.json is absent")
    campaign_sha = sha256_file(campaign_manifest)
    identity = RunIdentity(
        source_commit=plan.capsule.source_commit,
        entrypoint_sha256=plan.capsule.entrypoint_sha256,
        evaluator_sha256=evaluator_sha,
        job_capsule_sha256=plan.capsule.digest(),
        training_config_sha256=_config_digest(plan.capsule, plan.checkpoint_interval),
        campaign_manifest_sha256=campaign_sha,
        environment_profile=plan.capsule.environment_profile,
        output_contract=plan.capsule.output_contract,
        promotion=plan.capsule.promotion,
    )
    read_checkpoint_metadata(plan.workspace.checkpoints, identity)
    return report, identity


def execute(plan: ExecutionPlan, policy: LocalPolicy, *, resume: bool = False) -> int:
    report, identity = prepare(plan, policy)
    benchmark = plan.workspace.source / BENCHMARK_ROOT
    adapter = [
        "-m",
        "squeeze.terminal_adapter",
        "--source-root",
        str(plan.workspace.source),
        "--campaign-root",
        str(plan.campaign_root.resolve()),
        "--output",
        str(plan.workspace.result),
        "--checkpoint-root",
        str(plan.workspace.checkpoints),
        "--identity-json",
        json.dumps(identity.as_dict(), sort_keys=True),
        "--checkpoint-interval",
        str(plan.checkpoint_interval),
        "--scale",
        "base",
    ]
    if resume:
        adapter.append("--resume")
    env = {
        "HOME": str(plan.workspace.home),
        "PYTHONNOUSERSITE": "1",
        "PYTHONUNBUFFERED": "1",
        "PYTHONPATH": f"{plan.workspace.source / 'compute/squeeze'}:{benchmark}",
        "CUDA_VISIBLE_DEVICES": "0",
        "SQUEEZE_EXPECTED_GPU": report.gpu_name or "",
    }
    command = build_bwrap_command(
        plan.python,
        adapter,
        workspace=plan.workspace,
        cwd=benchmark,
        python_prefix=Path(sys.prefix),
        environment=env,
        read_only_paths=(plan.workspace.source, plan.campaign_root),
    )
    command_receipt = {
        "schema": "squeeze-command-v1",
        "argv": adapter,
        "cwd": str(benchmark),
        "shell": False,
        "network_namespace": "unshared",
        "source_commit": plan.capsule.source_commit,
        "promotion": plan.capsule.promotion,
    }
    started_at = datetime.now(timezone.utc)
    plan.workspace.result.mkdir(parents=True, exist_ok=True)
    (plan.workspace.result / "command.json").write_text(json.dumps(command_receipt, indent=2, sort_keys=True) + "\n")
    (plan.workspace.result / "environment.json").write_text(json.dumps(report.as_dict(), indent=2, sort_keys=True) + "\n")
    (plan.workspace.result / "source-identity.json").write_text(json.dumps(identity.as_dict(), indent=2, sort_keys=True) + "\n")
    shutil.copy2(plan.workspace.source / plan.capsule.entrypoint, plan.workspace.result / "efficient_terminal_training.py")
    _run(command, cwd=benchmark, log=plan.workspace.logs / "training.log")
    finished_at = datetime.now(timezone.utc)
    logs_out = plan.workspace.result / "logs"
    logs_out.mkdir(exist_ok=True)
    shutil.copy2(plan.workspace.logs / "training.log", logs_out / "training.log")
    report_json = json.loads((plan.workspace.result / "terminal-efficiency-report.json").read_text(encoding="utf-8"))
    manifest = file_manifest(plan.workspace.result)
    receipt_body = {
        "schema": "squeeze-receipt-v1",
        "promotion": plan.capsule.promotion,
        "node": re.sub(r"[^A-Za-z0-9._-]", "-", os.environ.get("SQUEEZE_NODE", socket.gethostname()))[:64],
        "source_commit": plan.capsule.source_commit,
        "job_capsule_sha256": plan.capsule.digest(),
        "entrypoint_sha256": plan.capsule.entrypoint_sha256,
        "evaluator_sha256": plan.capsule.required_evaluator_sha256,
        "started_at": started_at.isoformat(),
        "finished_at": finished_at.isoformat(),
        "resume_count": int(report_json.get("resume_count", 0)),
        "environment": report.as_dict(),
        "result": {
            "winner": report_json.get("winner"),
            "records": report_json.get("records"),
            "elapsed_seconds": report_json.get("elapsed_seconds"),
            "device": report_json.get("device"),
            "gpu_name": report_json.get("gpu_name"),
        },
        "files": manifest,
    }
    key = ensure_identity_key(plan.workspace.root.parent.parent / "identity")
    signed = sign_receipt(receipt_body, key)
    (plan.workspace.result / "receipt.json").write_text(json.dumps(signed, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    sums = file_manifest(plan.workspace.result)
    sums["receipt.json"] = sha256_file(plan.workspace.result / "receipt.json")
    write_sha256s(plan.workspace.result, sums)
    shutil.make_archive(str(plan.workspace.root / "squeeze-result"), "zip", plan.workspace.result)
    return 0
