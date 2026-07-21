from __future__ import annotations

import dataclasses
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


class CudaUnavailable(RuntimeError):
    pass


@dataclasses.dataclass(frozen=True, slots=True)
class CudaReport:
    available: bool
    gpu_name: str | None
    total_vram_bytes: int | None
    free_vram_bytes: int | None
    cuda_runtime: str | None
    torch_version: str | None
    python: str
    nvidia_smi: str | None
    bwrap: str | None
    git: str | None
    disk_free_bytes: int
    failures: tuple[str, ...]

    def as_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)

    def require(self) -> None:
        if not self.available:
            raise CudaUnavailable("; ".join(self.failures))


def _nvidia_query(executable: str) -> tuple[str, int, int]:
    command = [
        executable,
        "--query-gpu=name,memory.total,memory.free",
        "--format=csv,noheader,nounits",
        "--id=0",
    ]
    proc = subprocess.run(command, check=True, capture_output=True, text=True, timeout=15)
    name, total_mib, free_mib = [part.strip() for part in proc.stdout.splitlines()[0].split(",", 2)]
    return name, int(total_mib) * 1024 * 1024, int(free_mib) * 1024 * 1024


def doctor(checkpoint_root: Path) -> CudaReport:
    failures: list[str] = []
    checkpoint_root.mkdir(parents=True, exist_ok=True)
    disk_free = shutil.disk_usage(checkpoint_root).free
    nvidia_smi = shutil.which("nvidia-smi")
    bwrap = shutil.which("bwrap")
    git = shutil.which("git")
    if not nvidia_smi:
        failures.append("nvidia-smi is unavailable")
    if not bwrap:
        failures.append("bubblewrap is required for network and filesystem isolation")
    if not git:
        failures.append("git is unavailable")

    gpu_name = None
    total_vram = None
    free_vram = None
    if nvidia_smi:
        try:
            gpu_name, total_vram, free_vram = _nvidia_query(nvidia_smi)
        except (subprocess.SubprocessError, ValueError, IndexError) as exc:
            failures.append(f"nvidia-smi probe failed: {exc}")

    torch_version = None
    cuda_runtime = None
    try:
        import torch

        torch_version = torch.__version__
        cuda_runtime = torch.version.cuda
        if not torch.cuda.is_available():
            failures.append("torch.cuda.is_available() is false")
        elif torch.cuda.device_count() < 1:
            failures.append("no CUDA device is visible")
        else:
            torch_name = torch.cuda.get_device_name(0)
            if gpu_name and torch_name not in gpu_name and gpu_name not in torch_name:
                failures.append("nvidia-smi and PyTorch report different GPU identities")
    except Exception as exc:
        failures.append(f"PyTorch CUDA probe failed: {exc}")

    if disk_free < 20 * 1024**3:
        failures.append("less than 20 GiB free in checkpoint storage")

    return CudaReport(
        available=not failures,
        gpu_name=gpu_name,
        total_vram_bytes=total_vram,
        free_vram_bytes=free_vram,
        cuda_runtime=cuda_runtime,
        torch_version=torch_version,
        python=sys.executable,
        nvidia_smi=nvidia_smi,
        bwrap=bwrap,
        git=git,
        disk_free_bytes=disk_free,
        failures=tuple(failures),
    )


def print_doctor(checkpoint_root: Path) -> int:
    report = doctor(checkpoint_root)
    print(json.dumps(report.as_dict(), indent=2, sort_keys=True))
    return 0 if report.available else 2
