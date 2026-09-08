#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

VERSION = "q0907-live/v1"
STARTED = time.time()
MACH_ROOT = Path(r"C:\Users\AwesomeKai\mach").resolve()
MAX_BODY = 2_000_000
MAX_OUTPUT = 400_000
RAW_PREFIX = "https://raw.githubusercontent.com/Pokitomas/theawesomehexapp/"

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
    return out[:MAX_OUTPUT]


def b64json(segment: str) -> dict:
    segment += "=" * ((4 - len(segment) % 4) % 4)
    raw = base64.urlsafe_b64decode(segment.encode("ascii"))
    if len(raw) > MAX_BODY:
        raise ValueError("payload too large")
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("payload must be object")
    return value


def under_mach(value: str | os.PathLike[str]) -> Path:
    p = Path(value)
    if not p.is_absolute():
        p = MACH_ROOT / p
    p = p.resolve()
    try:
        p.relative_to(MACH_ROOT)
    except ValueError:
        raise PermissionError(f"path outside Mach root: {p}")
    return p


def run(argv: list[str], cwd: Path | None = None, timeout: int = 90) -> dict:
    if not argv or not all(isinstance(x, str) and x for x in argv):
        raise ValueError("argv must be a non-empty string list")
    timeout = max(1, min(int(timeout), 300))
    p = subprocess.run(
        argv,
        cwd=str(cwd or MACH_ROOT),
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        shell=False,
    )
    return {"rc": p.returncode, "out": redact(p.stdout or "")}


def presence(payload: dict) -> dict:
    sys.path.insert(0, r"C:\Users\AwesomeKai")
    from mach.core.presence import Presence
    p = Presence()
    try:
        out: dict[str, object] = {}
        expr = payload.get("expr")
        if expr:
            out["do"] = p.do(str(expr), wait=min(int(payload.get("wait_s", 10)), 30))
        asks = payload.get("ask", [])
        if isinstance(asks, str):
            asks = [asks]
        for claim in asks:
            out.setdefault("ask", {})[str(claim)] = p.ask(str(claim), wait=min(int(payload.get("wait_s", 10)), 30))
        return out
    finally:
        p.close()


def status() -> dict:
    out: dict[str, object] = {
        "version": VERSION,
        "host": socket.gethostname(),
        "user": getpass.getuser(),
        "pid": os.getpid(),
        "uptime_s": round(time.time() - STARTED, 3),
        "mach_root": str(MACH_ROOT),
        "mach_present": MACH_ROOT.is_dir(),
    }
    try:
        out["mach"] = presence({"ask": ["mode", "gui/enabled", "gui/lens"], "wait_s": 3})
    except Exception as exc:
        out["mach_error"] = f"{type(exc).__name__}: {exc}"
    return out


def telemetry() -> dict:
    gpu = run([
        "nvidia-smi.exe",
        "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
        "--format=csv,noheader,nounits",
    ], timeout=20)
    ps = (
        "$os=Get-CimInstance Win32_OperatingSystem; "
        "$top=Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 12 Name,Id,@{n='MB';e={[math]::Round($_.WorkingSet64/1MB)}}; "
        "[pscustomobject]@{ram_used_mb=[math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/1024);ram_free_mb=[math]::Round($os.FreePhysicalMemory/1024);top=$top}|ConvertTo-Json -Compress -Depth 4"
    )
    mem = run(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ps], timeout=20)
    return {"gpu": gpu, "memory": mem}


def atomic_write(path: Path, data: bytes, expected_sha256: str | None) -> dict:
    old = None
    if path.exists():
        old = hashlib.sha256(path.read_bytes()).hexdigest()
    if expected_sha256 is not None and old != expected_sha256:
        raise RuntimeError(f"sha guard mismatch expected={expected_sha256} got={old}")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
        except OSError:
            pass
    new = hashlib.sha256(data).hexdigest()
    return {"path": str(path), "bytes": len(data), "old_sha256": old, "sha256": new}


def dispatch(payload: dict) -> dict:
    op = str(payload.get("op", "status")).lower()

    if op in {"status", "health"}:
        return status()

    if op == "telemetry":
        return telemetry()

    if op == "mach":
        return presence(payload)

    if op == "computer":
        request = payload.get("request")
        if not isinstance(request, dict):
            raise ValueError("computer requires request object")
        return run([
            sys.executable,
            str(MACH_ROOT / "say.py"),
            "--computer",
            json.dumps(request, ensure_ascii=False, separators=(",", ":")),
        ], timeout=int(payload.get("timeout_s", 60)))

    if op == "python":
        args = payload.get("args", [])
        if not isinstance(args, list) or not all(isinstance(x, str) for x in args):
            raise ValueError("python args must be string list")
        cwd = under_mach(payload.get("cwd", str(MACH_ROOT)))
        return run([sys.executable, *args], cwd=cwd, timeout=int(payload.get("timeout_s", 120)))

    if op == "local_exec":
        exe = under_mach(str(payload["exe"]))
        if not exe.is_file():
            raise FileNotFoundError(exe)
        args = payload.get("args", [])
        if not isinstance(args, list) or not all(isinstance(x, str) for x in args):
            raise ValueError("local_exec args must be string list")
        cwd = under_mach(payload.get("cwd", str(MACH_ROOT)))
        return run([str(exe), *args], cwd=cwd, timeout=int(payload.get("timeout_s", 120)))

    if op == "read":
        path = under_mach(str(payload["path"]))
        limit = max(1, min(int(payload.get("max_bytes", 300_000)), 1_000_000))
        data = path.read_bytes()[:limit]
        try:
            text = data.decode("utf-8")
            return {"path": str(path), "bytes": len(data), "text": text}
        except UnicodeDecodeError:
            return {"path": str(path), "bytes": len(data), "base64": base64.b64encode(data).decode("ascii")}

    if op == "list":
        path = under_mach(str(payload.get("path", ".")))
        if not path.is_dir():
            raise NotADirectoryError(path)
        items = []
        for p in sorted(path.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))[:1000]:
            st = p.stat()
            items.append({"name": p.name, "dir": p.is_dir(), "bytes": 0 if p.is_dir() else st.st_size, "mtime": st.st_mtime})
        return {"path": str(path), "items": items}

    if op == "write":
        path = under_mach(str(payload["path"]))
        encoding = str(payload.get("encoding", "utf-8"))
        content = payload.get("content", "")
        if not isinstance(content, str):
            raise ValueError("content must be string")
        data = base64.b64decode(content) if encoding == "base64" else content.encode("utf-8")
        if len(data) > MAX_BODY:
            raise ValueError("write too large")
        return atomic_write(path, data, payload.get("expected_sha256"))

    if op == "pull_write":
        source = str(payload["source_url"])
        if not source.startswith(RAW_PREFIX):
            raise PermissionError("source_url must be this repo raw content")
        path = under_mach(str(payload["path"]))
        req = Request(source, headers={"User-Agent": VERSION})
        with urlopen(req, timeout=30) as r:
            data = r.read(MAX_BODY + 1)
        if len(data) > MAX_BODY:
            raise ValueError("remote write too large")
        return atomic_write(path, data, payload.get("expected_sha256"))

    raise ValueError(f"unknown op: {op}")


class Handler(BaseHTTPRequestHandler):
    server_version = VERSION
    token = ""

    def log_message(self, fmt: str, *args: object) -> None:
        return

    def reply(self, code: int, value: dict) -> None:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        try:
            parts = [p for p in urlsplit(self.path).path.split("/") if p]
            if parts and parts[0] == "mach-live":
                parts = parts[1:]
            if len(parts) != 3 or parts[0] != "r":
                self.reply(404, {"ok": False, "error": "not found"})
                return
            if not hmac.compare_digest(parts[1], self.token):
                self.reply(404, {"ok": False, "error": "not found"})
                return
            payload = b64json(parts[2])
            started = time.perf_counter()
            result = dispatch(payload)
            self.reply(200, {"ok": True, "ms": round((time.perf_counter() - started) * 1000, 2), "result": result})
        except subprocess.TimeoutExpired as exc:
            self.reply(200, {"ok": False, "error": f"timeout {exc.timeout}"})
        except Exception as exc:
            self.reply(200, {"ok": False, "error": redact(f"{type(exc).__name__}: {exc}")})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--token-file", required=True)
    ap.add_argument("--port", type=int, default=8891)
    args = ap.parse_args()
    token = Path(args.token_file).read_text(encoding="utf-8").strip()
    if len(token) < 32:
        raise RuntimeError("bad token")
    Handler.token = token
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    httpd.daemon_threads = True
    print(f"{VERSION} listening 127.0.0.1:{args.port}", flush=True)
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
