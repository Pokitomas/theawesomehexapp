from __future__ import annotations

import dataclasses
import os
import shutil
import subprocess
from pathlib import Path


class WorkspaceError(RuntimeError):
    pass


@dataclasses.dataclass(frozen=True, slots=True)
class JobWorkspace:
    root: Path

    @property
    def source(self) -> Path:
        return self.root / "source"

    @property
    def checkpoints(self) -> Path:
        return self.root / "checkpoints"

    @property
    def logs(self) -> Path:
        return self.root / "logs"

    @property
    def result(self) -> Path:
        return self.root / "result"

    @property
    def home(self) -> Path:
        return self.root / "home"

    def create(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        for path in (self.checkpoints, self.logs, self.result, self.home):
            path.mkdir(parents=True, exist_ok=True)


def _run(command: list[str], *, cwd: Path | None = None) -> str:
    proc = subprocess.run(command, cwd=cwd, check=True, capture_output=True, text=True, timeout=120)
    return proc.stdout.strip()


def checkout_exact(workspace: JobWorkspace, repository: str, commit: str) -> None:
    workspace.create()
    if workspace.source.exists():
        shutil.rmtree(workspace.source)
    workspace.source.mkdir(parents=True)
    remote = f"https://github.com/{repository}.git"
    _run(["git", "init", "--quiet"], cwd=workspace.source)
    _run(["git", "config", "core.hooksPath", "/dev/null"], cwd=workspace.source)
    _run(["git", "remote", "add", "origin", remote], cwd=workspace.source)
    _run(["git", "-c", "protocol.version=2", "fetch", "--depth=1", "origin", commit], cwd=workspace.source)
    _run(["git", "checkout", "--detach", "--quiet", "FETCH_HEAD"], cwd=workspace.source)
    actual = _run(["git", "rev-parse", "HEAD"], cwd=workspace.source)
    if actual != commit:
        raise WorkspaceError(f"detached checkout mismatch: {actual}")
    status = _run(["git", "status", "--porcelain=v1", "--untracked-files=all"], cwd=workspace.source)
    if status:
        raise WorkspaceError("checkout is not clean")


def build_bwrap_command(
    executable: Path,
    arguments: list[str],
    *,
    workspace: JobWorkspace,
    cwd: Path,
    python_prefix: Path,
    environment: dict[str, str],
    read_only_paths: tuple[Path, ...] = (),
) -> list[str]:
    bwrap = shutil.which("bwrap")
    if not bwrap:
        raise WorkspaceError("bubblewrap is required")
    if not cwd.resolve().is_relative_to(workspace.root.resolve()):
        raise WorkspaceError("sandbox cwd must be inside the job workspace")
    command = [
        bwrap,
        "--die-with-parent",
        "--new-session",
        "--unshare-net",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--bind",
        str(workspace.root),
        str(workspace.root),
        "--chdir",
        str(cwd),
    ]
    for device in (Path("/dev/dxg"), Path("/dev/nvidia0"), Path("/dev/nvidiactl"), Path("/dev/nvidia-uvm"), Path("/dev/nvidia-uvm-tools")):
        if device.exists():
            command.extend(["--dev-bind", str(device), str(device)])
    seen: set[Path] = set()
    for host_path in (Path("/usr"), Path("/bin"), Path("/lib"), Path("/lib64"), Path("/etc"), python_prefix):
        host_path = host_path.resolve()
        if host_path in seen:
            continue
        seen.add(host_path)
        if host_path.exists() and not host_path.resolve().is_relative_to(workspace.root.resolve()):
            command.extend(["--ro-bind", str(host_path), str(host_path)])
    for path in read_only_paths:
        resolved = path.resolve()
        if not resolved.is_relative_to(workspace.root.resolve()):
            raise WorkspaceError("read-only overlay must be inside the job workspace")
        command.extend(["--ro-bind", str(resolved), str(resolved)])
    for key, value in sorted(environment.items()):
        command.extend(["--setenv", key, value])
    command.extend(["--", str(executable), *arguments])
    return command
