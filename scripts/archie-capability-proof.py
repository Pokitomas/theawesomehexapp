#!/usr/bin/env python3
"""Fail-closed machine proof of ARCHIE's *current* capability backends.

A historical file or successful experiment is not a live capability. This court
re-derives service PIDs, ExecStart source hashes, socket/listener ownership,
local semantic-server health, GPU state/lease metadata, PTYs, and git state at
call time. Missing evidence stays missing. Credential VALUES are never read
into the receipt.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import pathlib
import re
import stat
import subprocess
import time
from typing import Any

SCHEMA = "archie/capability-proof-v2"
HOME = pathlib.Path.home()

# Canonical/live names discovered empirically on the workstation. Keep known
# negative/legacy units in the court so absence/masking remains visible rather
# than being silently forgotten.
DEFAULT_SERVICES = (
    "archie-shell-sidecar.service",
    "archie-live-exec.service",
    "archie-presence-reactor.service",
    "archie-gpt56-terminal-wire.service",
    "archie-local-semantic-supervisor.service",
    "archie-gpt56-packed-stream-resident-v1.service",
    "archie-direct-control-guard.service",
    "archie-openai-sidecar.service",
    "archie-gpt56-packed-stream-v1.service",
)

SEMANTIC_HOST = os.environ.get("ARCHIE_LOCAL_SEMANTIC_HOST", "172.22.64.1")
SEMANTIC_PORT = int(os.environ.get("ARCHIE_LOCAL_SEMANTIC_PORT", "18767"))


def run(argv: list[str], timeout: float = 5.0) -> dict[str, Any]:
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
        return {
            "ok": p.returncode == 0,
            "returncode": p.returncode,
            "stdout": p.stdout,
            "stderr": p.stderr,
        }
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


def file_meta(path: pathlib.Path, *, hash_file: bool = True) -> dict[str, Any]:
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
            "sha256": sha256_file(path) if hash_file and path.is_file() else None,
        }
    except FileNotFoundError:
        return {"exists": False, "path": str(path)}
    except Exception as exc:
        return {"exists": False, "path": str(path), "error": f"{type(exc).__name__}: {exc}"}


def parse_show(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            out[key] = value
    return out


def source_candidates_from_exec(raw: str) -> list[pathlib.Path]:
    # `systemctl show ExecStart` renders absolute path-like argv values in one
    # line. Hash only existing regular files; never read their contents here.
    tokens = re.findall(r"/(?:[^ ;}\]\[]+)", raw)
    paths: list[pathlib.Path] = []
    for token in tokens:
        p = pathlib.Path(token.rstrip(";,}"))
        try:
            if p.exists() and p.is_file() and p not in paths:
                paths.append(p)
        except Exception:
            pass
    return paths


def service_proof(name: str) -> dict[str, Any]:
    res = run([
        "systemctl", "--user", "show", name,
        "-p", "LoadState", "-p", "UnitFileState", "-p", "ActiveState", "-p", "SubState",
        "-p", "MainPID", "-p", "NRestarts", "-p", "ExecStart",
    ])
    f = parse_show(res["stdout"])
    pid = int(f.get("MainPID", "0") or 0)
    return {
        "unit": name,
        "query_ok": res["ok"],
        "load_state": f.get("LoadState"),
        "unit_file_state": f.get("UnitFileState"),
        "active_state": f.get("ActiveState"),
        "sub_state": f.get("SubState"),
        "main_pid": pid,
        "pid_alive": pid > 0 and pathlib.Path(f"/proc/{pid}").exists(),
        "n_restarts": int(f.get("NRestarts", "0") or 0),
        "execstart": f.get("ExecStart", ""),
        "exec_files": [file_meta(p) for p in source_candidates_from_exec(f.get("ExecStart", ""))],
        "stderr": res["stderr"].strip()[:600],
    }


def credential_name_presence(pid: int) -> dict[str, bool | None]:
    names = ("OPENAI_API_KEY", "ARCHIE_OPENAI_KEY", "ARCHIE_SHELL_TOKEN")
    if pid <= 0:
        return {name: None for name in names}
    try:
        entries = pathlib.Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
        present = {item.split(b"=", 1)[0].decode("utf-8", "replace") for item in entries if b"=" in item}
        return {name: name in present for name in names}
    except Exception:
        return {name: None for name in names}


def listeners() -> dict[str, Any]:
    tcp = run(["ss", "-ltnp"], timeout=3)
    unix = run(["ss", "-lxnp"], timeout=3)
    return {
        "tcp_8788_8789": [line for line in tcp["stdout"].splitlines() if re.search(r":(?:8788|8789)\b", line)],
        "presence_socket_lines": [line for line in unix["stdout"].splitlines() if "presence.sock" in line],
        "presence_socket": file_meta(HOME / "archie-remote" / "presence" / "presence.sock", hash_file=False),
        "tcp_query_ok": tcp["ok"],
        "unix_query_ok": unix["ok"],
    }


def local_semantic_health() -> dict[str, Any]:
    started = time.perf_counter()
    connection = http.client.HTTPConnection(SEMANTIC_HOST, SEMANTIC_PORT, timeout=1.5)
    try:
        connection.request("GET", "/health")
        response = connection.getresponse()
        body = response.read(4096).decode("utf-8", "replace")
        try:
            decoded = json.loads(body)
        except Exception:
            decoded = None
        return {
            "probed": True,
            "host": SEMANTIC_HOST,
            "port": SEMANTIC_PORT,
            "http_status": response.status,
            "latency_ms": round((time.perf_counter() - started) * 1000, 3),
            "health_status": decoded.get("status") if isinstance(decoded, dict) else None,
            "ok": response.status == 200 and isinstance(decoded, dict) and decoded.get("status") == "ok",
            "body_sha256": hashlib.sha256(body.encode()).hexdigest(),
        }
    except Exception as exc:
        return {
            "probed": True,
            "host": SEMANTIC_HOST,
            "port": SEMANTIC_PORT,
            "ok": False,
            "latency_ms": round((time.perf_counter() - started) * 1000, 3),
            "error": f"{type(exc).__name__}: {exc}"[:500],
        }
    finally:
        connection.close()


def tty_processes(limit: int = 60) -> list[dict[str, Any]]:
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
        if any(key in args.lower() for key in ("archie", "presence", "semantic", "terminal_room", "room.py")):
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


def selected_json(path: pathlib.Path, allowed: tuple[str, ...]) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text("utf-8"))
        if not isinstance(raw, dict):
            return {"parsed": False}
        return {"parsed": True, **{key: raw.get(key) for key in allowed if key in raw}}
    except Exception as exc:
        return {"parsed": False, "error": f"{type(exc).__name__}: {exc}"[:400]}


def authority_artifacts() -> dict[str, Any]:
    lease = HOME / "maximal" / "ACTIVE_GPU_LEASE.json"
    direct = HOME / "archie-remote" / "DIRECT_HOST_CONTROL.json"
    return {
        "active_gpu_lease": {
            "file": file_meta(lease),
            "projection": selected_json(
                lease,
                (
                    "schema", "active", "owner", "unit", "script_path", "script_sha256",
                    "prereg_path", "prereg_sha256", "corpus_path", "corpus_sha256",
                    "purpose", "updated_unix", "workload", "resident_semantic_compatibility_court",
                ),
            ),
        },
        "direct_host_control": {
            "file": file_meta(direct),
            "projection": selected_json(direct, ("schema", "active", "owner", "single_gpu_owner", "updated_unix")),
        },
        "gpu_lock": file_meta(HOME / "archie-bench" / "GPU.lock", hash_file=False),
        "halt_candidates": [
            file_meta(HOME / "maximal" / "HALT.json"),
            file_meta(HOME / "maximal" / "scratch" / "packed-stream-resident-v1" / "HALT.json"),
        ],
    }


def git_proof(path: pathlib.Path) -> dict[str, Any]:
    dotgit = path / ".git"
    if not dotgit.exists():
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
    p = argparse.ArgumentParser()
    p.add_argument("--repo", default=str(HOME / "archie-gpt56sol-presence"))
    p.add_argument("--output", default=str(HOME / "archie-remote" / "receipts" / "capability-proof-latest.json"))
    args = p.parse_args()

    services = {name: service_proof(name) for name in DEFAULT_SERVICES}
    for item in services.values():
        item["credential_env_names"] = credential_name_presence(int(item.get("main_pid") or 0))

    receipt: dict[str, Any] = {
        "schema": SCHEMA,
        "generated_unix_ns": time.time_ns(),
        "generated_local": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "boot_id": boot_id(),
        "court_pid": os.getpid(),
        "services": services,
        "listeners": listeners(),
        "local_semantic_server": local_semantic_health(),
        # Metadata only. Never include the file contents/value.
        "shell_secret_file": file_meta(HOME / ".archie-shell-secret", hash_file=False),
        "tty_processes": tty_processes(),
        "gpu": gpu_proof(),
        "authority": authority_artifacts(),
        "git": git_proof(pathlib.Path(args.repo).expanduser().resolve()),
    }

    canonical = json.dumps(receipt, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    receipt["receipt_sha256"] = hashlib.sha256(canonical).hexdigest()
    output = pathlib.Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = output.with_name(output.name + f".tmp-{os.getpid()}")
    tmp.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(output)
    print(json.dumps({
        "ok": True,
        "schema": SCHEMA,
        "receipt": str(output),
        "receipt_sha256": receipt["receipt_sha256"],
        "services": {k: [v.get("active_state"), v.get("main_pid")] for k, v in services.items()},
        "semantic": receipt["local_semantic_server"],
        "gpu": receipt["gpu"],
        "git": receipt["git"],
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
