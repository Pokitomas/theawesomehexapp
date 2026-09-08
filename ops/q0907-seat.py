#!/usr/bin/env python3
from __future__ import annotations

import getpass
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time

VERSION = "q0907-seat/v2"
MAX_OUTPUT = 120_000

_SECRET_PATTERNS = [
    re.compile(r"(?i)(authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+"),
    re.compile(r"(?i)((?:token|secret|password|passwd|api[_-]?key)\s*[=:]\s*)[^\s]+"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
]


def redact(text: str) -> str:
    out = text
    for pat in _SECRET_PATTERNS:
        if pat.pattern.startswith("(?i)("):
            out = pat.sub(lambda m: m.group(1) + "[REDACTED]", out)
        else:
            out = pat.sub("[REDACTED]", out)
    return out


def emit(text: object = "") -> None:
    s = redact(str(text))
    if len(s) > MAX_OUTPUT:
        s = s[:MAX_OUTPUT] + "\n[OUTPUT_TRUNCATED]"
    print(s, flush=True)


def run_argv(argv: list[str], cwd: str | None, timeout: int) -> int:
    if not argv or not all(isinstance(x, str) and x for x in argv):
        raise ValueError("argv must be a non-empty string list")
    p = subprocess.run(
        argv,
        cwd=cwd,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        shell=False,
    )
    emit(p.stdout or "")
    emit(f"SEAT_RC={p.returncode}")
    return p.returncode


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: q0907-seat.py <inbox.json>")

    inbox = Path(sys.argv[1]).resolve()
    req = json.loads(inbox.read_text(encoding="utf-8"))
    if not isinstance(req, dict):
        raise ValueError("request must be a JSON object")

    nonce = str(req.get("nonce", ""))[:128]
    op = str(req.get("op", "ping")).lower()
    timeout = max(1, min(int(req.get("timeout_s", 90)), 600))
    cwd = req.get("cwd")
    if cwd is not None:
        cwd = str(Path(str(cwd)).expanduser().resolve())
        if not Path(cwd).is_dir():
            raise FileNotFoundError(f"cwd missing: {cwd}")

    emit(f"SEAT_VERSION={VERSION}")
    emit(f"SEAT_NONCE={nonce}")
    emit(f"SEAT_HOST={socket.gethostname()}")
    emit(f"SEAT_USER={getpass.getuser()}")
    emit(f"SEAT_RUNNER={os.environ.get('RUNNER_NAME', '')}")
    emit(f"SEAT_OP={op}")

    if socket.gethostname().upper() != "DESKTOP-6FN9B4M":
        raise RuntimeError("seat claimed by unexpected host")

    if op == "ping":
        mach = Path(r"C:\Users\AwesomeKai\mach")
        emit(f"MACH_PRESENT={mach.is_dir()}")
        emit("Q0907_SEAT_OK")
        return 0

    if op == "live_install":
        installer = Path(__file__).with_name("q0907-live-install.py")
        if not installer.is_file():
            raise FileNotFoundError(installer)
        return run_argv([sys.executable, str(installer)], str(installer.parent), min(timeout, 240))

    if op == "shell":
        return run_argv(req.get("argv", []), cwd, timeout)

    if op == "powershell":
        command = req.get("command")
        if not isinstance(command, str) or not command.strip():
            raise ValueError("powershell op requires command")
        return run_argv(
            ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
            cwd,
            timeout,
        )

    if op == "read":
        path = Path(str(req["path"])).expanduser().resolve()
        limit = max(1, min(int(req.get("max_bytes", 100_000)), 500_000))
        data = path.read_bytes()[:limit]
        emit(data.decode("utf-8", errors="replace"))
        emit(f"SEAT_READ_BYTES={len(data)}")
        return 0

    if op == "mach":
        expr = req.get("expr")
        if not isinstance(expr, str) or not expr.strip():
            raise ValueError("mach op requires expr")
        sys.path.insert(0, r"C:\Users\AwesomeKai")
        from mach.core.presence import Presence
        p = Presence()
        try:
            result = p.do(expr, wait=min(timeout, 30))
            emit("MACH_DO=" + json.dumps(result, ensure_ascii=False, default=str))
            for claim in req.get("ask", []):
                v = p.ask(str(claim), wait=min(timeout, 30))
                emit("MACH_ASK " + str(claim) + "=" + json.dumps(v, ensure_ascii=False, default=str))
        finally:
            p.close()
        emit("Q0907_MACH_OK")
        return 0

    if op == "telemetry":
        emit("=== GPU ===")
        run_argv([
            "nvidia-smi.exe",
            "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
            "--format=csv,noheader,nounits",
        ], cwd, min(timeout, 30))
        emit("=== MEMORY / TOP PROCESSES ===")
        ps = (
            "$os=Get-CimInstance Win32_OperatingSystem; "
            "'RAM_USED_MB=' + [math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/1024); "
            "'RAM_FREE_MB=' + [math]::Round($os.FreePhysicalMemory/1024); "
            "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 12 Name,Id,@{n='MB';e={[math]::Round($_.WorkingSet64/1MB)}} | Format-Table -AutoSize"
        )
        return run_argv(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ps], cwd, min(timeout, 30))

    raise ValueError(f"unknown op: {op}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.TimeoutExpired as exc:
        emit(f"SEAT_TIMEOUT={exc.timeout}")
        raise SystemExit(124)
    except Exception as exc:
        emit(f"SEAT_ERROR={type(exc).__name__}: {exc}")
        raise
