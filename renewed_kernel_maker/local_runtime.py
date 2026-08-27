from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from core import receipt
from local_model_maker import RuntimeConfig, probe
from model_sourcing import inspect_ggufs

SCHEMA = "archie-local-runtime/v1"


@dataclass(frozen=True)
class RuntimeLaunch:
    engine: str
    executable: str
    model_path: str
    host: str = "127.0.0.1"
    port: int = 8080
    ctx: int = 8192
    gpu_layers: int = 999
    threads: int = 0


def discover_executables() -> dict[str, str]:
    names = {
        "llama-server": ("llama-server", "llama-server.exe"),
        "llama-cpp-server": ("server", "server.exe"),
    }
    out: dict[str, str] = {}
    for key, options in names.items():
        for name in options:
            p = shutil.which(name)
            if p:
                out[key] = p
                break
    return out


def discover_model_roots(extra: list[Path] | None = None) -> list[Path]:
    roots = []
    for value in (
        os.environ.get("ARCHIE_MODEL_DIR"),
        str(Path.home() / "models"),
        str(Path.home() / ".cache" / "huggingface"),
        "/mnt/c/Users/AwesomeKai/models",
        "/mnt/c/Users/AwesomeKai/Downloads",
    ):
        if value:
            p = Path(value)
            if p not in roots:
                roots.append(p)
    for p in extra or []:
        if p not in roots:
            roots.append(p)
    return roots


def discover(extra_roots: list[Path] | None = None) -> dict[str, Any]:
    roots = discover_model_roots(extra_roots)
    return receipt("local_runtime.discover", {
        "schema": SCHEMA,
        "executables": discover_executables(),
        "roots": [str(p) for p in roots],
        "ggufs": inspect_ggufs(roots),
    })


def choose_gguf(ggufs: list[dict[str, Any]], *, max_gib: float = 6.0) -> dict[str, Any] | None:
    candidates = [x for x in ggufs if 0.3 <= float(x.get("gib") or 0) <= max_gib]
    if not candidates:
        return None
    def score(x: dict[str, Any]) -> tuple[float, float, str]:
        path = str(x.get("path") or "").lower()
        coding = 1.0 if any(k in path for k in ("coder", "qwen3", "qwen2.5", "instruct")) else 0.0
        quant = 0.5 if any(k in path for k in ("q4_k_m", "q5_k_m", "q4")) else 0.0
        return (coding + quant, float(x.get("gib") or 0), path)
    return sorted(candidates, key=score, reverse=True)[0]


def port_open(host: str, port: int, timeout: float = 0.3) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def build_argv(spec: RuntimeLaunch) -> list[str]:
    exe = spec.executable
    name = Path(exe).name.lower()
    if "llama" not in name and name not in {"server", "server.exe"}:
        raise ValueError("unsupported runtime executable")
    argv = [exe, "-m", spec.model_path, "--host", spec.host, "--port", str(spec.port), "-c", str(spec.ctx)]
    if spec.gpu_layers >= 0:
        argv += ["-ngl", str(spec.gpu_layers)]
    if spec.threads > 0:
        argv += ["-t", str(spec.threads)]
    return argv


def launch(spec: RuntimeLaunch, log_path: Path, *, ready_timeout_s: float = 120.0) -> dict[str, Any]:
    model = Path(spec.model_path)
    if not model.is_file():
        return receipt("local_runtime.launch", {"status": "BLOCKED", "reason": "model-file-missing", "model": spec.model_path})
    if port_open(spec.host, spec.port):
        cfg = RuntimeConfig(endpoint=f"http://{spec.host}:{spec.port}/v1/chat/completions", model=model.stem)
        p = probe(cfg)
        return receipt("local_runtime.launch", {"status": "REUSED" if p["payload"]["status"] == "READY" else "BLOCKED", "probe": p["payload"], "endpoint": cfg.endpoint})
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log = log_path.open("ab", buffering=0)
    argv = build_argv(spec)
    creationflags = 0
    kwargs: dict[str, Any] = {}
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        kwargs["start_new_session"] = True
    proc = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT, cwd=str(model.parent), creationflags=creationflags, **kwargs)
    endpoint = f"http://{spec.host}:{spec.port}/v1/chat/completions"
    cfg = RuntimeConfig(endpoint=endpoint, model=model.stem)
    deadline = time.monotonic() + max(1.0, ready_timeout_s)
    last_probe = None
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            log.close()
            tail = log_path.read_bytes()[-12000:].decode("utf-8", "replace") if log_path.exists() else ""
            return receipt("local_runtime.launch", {"status": "FAILED", "returncode": proc.returncode, "argv": argv, "log_tail": tail})
        if port_open(spec.host, spec.port, 0.2):
            last_probe = probe(cfg)
            if last_probe["payload"]["status"] == "READY":
                state = {"schema": SCHEMA, "pid": proc.pid, "argv": argv, "endpoint": endpoint, "model": model.stem, "log": str(log_path)}
                state_path = log_path.with_suffix(log_path.suffix + ".state.json")
                state_path.write_text(json.dumps(state, indent=2), encoding="utf-8")
                log.close()
                return receipt("local_runtime.launch", {"status": "READY", **state, "probe": last_probe["payload"]})
        time.sleep(1.0)
    log.close()
    return receipt("local_runtime.launch", {"status": "TIMEOUT", "pid": proc.pid, "endpoint": endpoint, "last_probe": last_probe["payload"] if last_probe else None, "argv": argv})


def stop_state(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return receipt("local_runtime.stop", {"status": "BLOCKED", "reason": "state-file-missing"})
    state = json.loads(path.read_text(encoding="utf-8"))
    pid = int(state.get("pid") or 0)
    if pid <= 0:
        return receipt("local_runtime.stop", {"status": "BLOCKED", "reason": "bad-pid"})
    try:
        if os.name == "nt":
            os.kill(pid, signal.SIGTERM)
        else:
            os.killpg(pid, signal.SIGTERM)
        return receipt("local_runtime.stop", {"status": "SENT", "pid": pid})
    except ProcessLookupError:
        return receipt("local_runtime.stop", {"status": "ALREADY_STOPPED", "pid": pid})


def court() -> dict[str, Any]:
    fake = RuntimeLaunch("llama.cpp", "/usr/bin/llama-server", "/tmp/model.gguf", ctx=4096, gpu_layers=40, threads=8)
    argv = build_argv(fake)
    good = argv[-2:] == ["-t", "8"] and "-ngl" in argv and "4096" in argv and fake.host == "127.0.0.1"
    return receipt("local_runtime.court", {"passes": good, "loopback_default": fake.host == "127.0.0.1", "argv": argv})


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("discover"); d.add_argument("roots", nargs="*", type=Path)
    l = sub.add_parser("launch"); l.add_argument("--exe", required=True); l.add_argument("--model", required=True); l.add_argument("--port", type=int, default=8080); l.add_argument("--ctx", type=int, default=8192); l.add_argument("--ngl", type=int, default=999); l.add_argument("--threads", type=int, default=0); l.add_argument("--log", type=Path, required=True)
    s = sub.add_parser("stop"); s.add_argument("state", type=Path)
    ns = ap.parse_args()
    if ns.cmd == "discover": out = discover(ns.roots)
    elif ns.cmd == "launch": out = launch(RuntimeLaunch("llama.cpp", ns.exe, ns.model, port=ns.port, ctx=ns.ctx, gpu_layers=ns.ngl, threads=ns.threads), ns.log)
    else: out = stop_state(ns.state)
    print(json.dumps(out, indent=2)); return 0

if __name__ == "__main__": raise SystemExit(main())
