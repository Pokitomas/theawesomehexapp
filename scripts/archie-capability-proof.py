#!/usr/bin/env python3
"""Machine-derived ARCHIE capability proof.

This court proves backends, not aspirations.  It intentionally never prints
credential values.  Missing evidence is recorded as unproven rather than being
inferred from historical state.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import shlex
import stat
import subprocess
import time
from typing import Any

SCHEMA = "archie/capability-proof-v1"
HOME = pathlib.Path.home()
DEFAULT_SERVICES = (
    "archie-shell-sidecar.service",
    "archie-live-exec.service",
    "archie-presence.service",
    "archie-openai-sidecar.service",
    "archie-presence-brain-broker.service",
)


def run(argv: list[str], timeout: float = 5.0) -> dict[str, Any]:
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
        return {"ok": p.returncode == 0, "returncode": p.returncode, "stdout": p.stdout, "stderr": p.stderr}
    except Exception as exc:
        return {"ok": False, "returncode": None, "stdout": "", "stderr": f"{type(exc).__name__}: {exc}"}


def sha256_file(path: pathlib.Path) -> str | None:
    try:
        h = hashlib.sha256()
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None


def file_meta(path: pathlib.Path) -> dict[str, Any]:
    try:
        st = path.stat()
        return {
            "exists": True,
            "path": str(path),
            "mode": stat.filemode(st.st_mode),
            "uid": st.st_uid,
            "gid": st.st_gid,
            "size": st.st_size,
            "mtime_ns": st.st_mtime_ns,
            "sha256": sha256_file(path) if path.is_file() else None,
        }
    except FileNotFoundError:
        return {"exists": False, "path": str(path)}
    except Exception as exc:
        return {"exists": False, "path": str(path), "error": f"{type(exc).__name__}: {exc}"}


def parse_show(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k] = v
    return out


def execstart_program(raw: str) -> pathlib.Path | None:
    # systemd show renders ExecStart as { path ; argv[]=/path ... ; ... }
    m = re.search(r"path=([^ ;}]+)", raw)
    if m:
        return pathlib.Path(m.group(1))
    m = re.search(r"argv\[\]=([^ ;}]+)", raw)
    if m:
        return pathlib.Path(m.group(1))
    return None


def source_candidates_from_exec(raw: str) -> list[pathlib.Path]:
    # Collect absolute argv entries and retain regular files, preferring source-like suffixes.
    tokens = re.findall(r"/(?:[^ ;}\]\[]+)", raw)
    paths: list[pathlib.Path] = []
    for token in tokens:
        token = token.rstrip(";,}")
        p = pathlib.Path(token)
        if p.exists() and p.is_file() and p not in paths:
            paths.append(p)
    return paths


def service_proof(name: str) -> dict[str, Any]:
    res = run([
        "systemctl", "--user", "show", name,
        "-p", "LoadState", "-p", "ActiveState", "-p", "SubState",
        "-p", "MainPID", "-p", "NRestarts", "-p", "ExecStart",
    ])
    fields = parse_show(res["stdout"])
    pid = int(fields.get("MainPID", "0") or 0)
    candidates = source_candidates_from_exec(fields.get("ExecStart", ""))
    return {
        "unit": name,
        "query_ok": res["ok"],
        "load_state": fields.get("LoadState"),
        "active_state": fields.get("ActiveState"),
        "sub_state": fields.get("SubState"),
        "main_pid": pid,
        "pid_alive": pid > 0 and pathlib.Path(f"/proc/{pid}").exists(),
        "n_restarts": fields.get("NRestarts"),
        "execstart": fields.get("ExecStart", ""),
        "exec_files": [file_meta(p) for p in candidates],
        "stderr": res["stderr"].strip()[:1000],
    }


def env_name_presence(pid: int, names: tuple[str, ...]) -> dict[str, bool | None]:
    answer: dict[str, bool | None] = {name: None for name in names}
    if pid <= 0:
        return answer
    try:
        raw = pathlib.Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
        present = {entry.split(b"=", 1)[0].decode("utf-8", "replace") for entry in raw if b"=" in entry}
        return {name: name in present for name in names}
    except Exception:
        return answer


def listener_proof() -> dict[str, Any]:
    tcp = run(["ss", "-ltnp"], timeout=3)
    unix = run(["ss", "-lxnp"], timeout=3)
    tcp_lines = [line for line in tcp["stdout"].splitlines() if re.search(r":(?:8788|8789)\b", line)]
    unix_lines = [line for line in unix["stdout"].splitlines() if "presence.sock" in line]
    sock = HOME / "archie-remote" / "presence" / "presence.sock"
    return {
        "tcp_8788_8789": tcp_lines,
        "presence_socket_lines": unix_lines,
        "presence_socket": file_meta(sock),
        "tcp_query_ok": tcp["ok"],
        "unix_query_ok": unix["ok"],
    }


def tty_processes(limit: int = 40) -> list[dict[str, Any]]:
    ps = run(["ps", "-eo", "pid=,ppid=,tty=,lstart=,args="], timeout=3)
    rows: list[dict[str, Any]] = []
    for line in ps["stdout"].splitlines():
        parts = line.strip().split(None, 8)
        if len(parts) < 9:
            continue
        pid, ppid, tty = parts[0], parts[1], parts[2]
        args = parts[8]
        if tty == "?":
            continue
        if any(key in args.lower() for key in ("archie", "presence", "terminal_room", "room.py")):
            rows.append({"pid": int(pid), "ppid": int(ppid), "tty": tty, "args": args[:1000]})
    return rows[:limit]


def gpu_proof() -> dict[str, Any]:
    gpu = run([
        "nvidia-smi",
        "--query-gpu=index,name,uuid,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw",
        "--format=csv,noheader,nounits",
    ], timeout=5)
    apps = run([
        "nvidia-smi",
        "--query-compute-apps=pid,process_name,used_gpu_memory",
        "--format=csv,noheader,nounits",
    ], timeout=5)
    return {
        "query_ok": gpu["ok"],
        "gpus": [line.strip() for line in gpu["stdout"].splitlines() if line.strip()],
        "compute_apps": [line.strip() for line in apps["stdout"].splitlines() if line.strip()],
        "errors": (gpu["stderr"] + apps["stderr"]).strip()[:1000],
    }


def artifact_candidates() -> dict[str, Any]:
    candidates = {
        "active_gpu_lease": [
            HOME / "ACTIVE_GPU_LEASE.json",
            HOME / "archie-remote" / "ACTIVE_GPU_LEASE.json",
            HOME / "maximal" / "ACTIVE_GPU_LEASE.json",
        ],
        "gpu_lock": [HOME / "GPU.lock", HOME / "archie-remote" / "GPU.lock", HOME / "maximal" / "GPU.lock"],
        "halt": [HOME / "HALT.json", HOME / "archie-remote" / "HALT.json", HOME / "maximal" / "HALT.json"],
    }
    return {key: [file_meta(path) for path in paths] for key, paths in candidates.items()}


def git_proof(path: pathlib.Path) -> dict[str, Any]:
    if not (path / ".git").exists() and not (path / ".git").is_file():
        return {"path": str(path), "exists": path.exists(), "is_git": False}
    head = run(["git", "-C", str(path), "rev-parse", "HEAD"])
    branch = run(["git", "-C", str(path), "branch", "--show-current"])
    status_res = run(["git", "-C", str(path), "status", "--porcelain=v1", "--untracked-files=normal"])
    return {
        "path": str(path),
        "exists": True,
        "is_git": head["ok"],
        "head": head["stdout"].strip(),
        "branch": branch["stdout"].strip(),
        "dirty": bool(status_res["stdout"].strip()),
        "status_lines": status_res["stdout"].splitlines()[:200],
    }


def boot_id() -> str | None:
    try:
        return pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    except Exception:
        return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=str(HOME / "theawesomehexapp-pr730"))
    parser.add_argument("--output", default=str(HOME / "archie-remote" / "receipts" / "capability-proof-latest.json"))
    args = parser.parse_args()

    services = {name: service_proof(name) for name in DEFAULT_SERVICES}
    for value in services.values():
        value["credential_env_names"] = env_name_presence(
            int(value.get("main_pid") or 0),
            ("OPENAI_API_KEY", "ARCHIE_OPENAI_KEY", "ARCHIE_SHELL_TOKEN"),
        )

    receipt: dict[str, Any] = {
        "schema": SCHEMA,
        "generated_unix_ns": time.time_ns(),
        "generated_local": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "boot_id": boot_id(),
        "pid": os.getpid(),
        "services": services,
        "listeners": listener_proof(),
        "shell_secret_file": file_meta(HOME / ".archie-shell-secret"),
        "tty_processes": tty_processes(),
        "gpu": gpu_proof(),
        "gpu_authority_artifacts": artifact_candidates(),
        "git": git_proof(pathlib.Path(args.repo).expanduser().resolve()),
    }

    # The proof's own digest excludes the digest field itself.
    canonical = json.dumps(receipt, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    receipt["receipt_sha256"] = hashlib.sha256(canonical).hexdigest()
    output = pathlib.Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = output.with_name(output.name + f".tmp-{os.getpid()}")
    tmp.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(output)
    print(json.dumps({
        "ok": True,
        "receipt": str(output),
        "receipt_sha256": receipt["receipt_sha256"],
        "service_states": {k: [v.get("active_state"), v.get("main_pid")] for k, v in services.items()},
        "gpu": receipt["gpu"],
        "git": receipt["git"],
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
