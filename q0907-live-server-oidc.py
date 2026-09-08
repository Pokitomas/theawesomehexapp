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

VERSION = "q0907-live/v2-oidc"
STARTED = time.time()
MACH_ROOT = Path(r"C:\Users\AwesomeKai\mach").resolve()
MAX_BODY = 2_000_000
MAX_OUTPUT = 400_000
RAW_PREFIX = "https://raw.githubusercontent.com/Pokitomas/theawesomehexapp/"

VERCEL_ISSUER = "https://oidc.vercel.com/kaicollegeapps-2834s-projects"
VERCEL_AUDIENCE = "https://vercel.com/kaicollegeapps-2834s-projects"
VERCEL_SUBJECT = "owner:kaicollegeapps-2834s-projects:project:spsc-bootstrap-probe:environment:production"
VERCEL_OWNER_ID = "team_dyh9pqYzolsqeATnVTAxIf6A"
VERCEL_PROJECT_ID = "prj_ls1rKANOePqkr56xb6CQoLG34aIA"
VERCEL_JWKS_URLS = (
    "https://oidc.vercel.com/.well-known/jwks",
    VERCEL_ISSUER + "/.well-known/jwks",
)
OIDC_READ_OPS = {"status", "health", "telemetry", "list", "read", "mach"}

_SECRET_PATTERNS = [
    re.compile(r"(?i)(authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+"),
    re.compile(r"(?i)((?:token|secret|password|passwd|api[_-]?key)\s*[=:]\s*)[^\s]+"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
]
_JWKS_LOCK = threading.Lock()
_JWKS_CACHE: dict[str, object] = {"until": 0.0, "keys": []}


def redact(text: str) -> str:
    out = text
    for pat in _SECRET_PATTERNS:
        if pat.pattern.startswith("(?i)("):
            out = pat.sub(lambda m: m.group(1) + "[REDACTED]", out)
        else:
            out = pat.sub("[REDACTED]", out)
    return out[:MAX_OUTPUT]


def _b64url_bytes(segment: str) -> bytes:
    segment += "=" * ((4 - len(segment) % 4) % 4)
    return base64.urlsafe_b64decode(segment.encode("ascii"))


def _b64url_json(segment: str) -> dict:
    value = json.loads(_b64url_bytes(segment).decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("JWT part is not an object")
    return value


def b64json(segment: str) -> dict:
    raw = _b64url_bytes(segment)
    if len(raw) > MAX_BODY:
        raise ValueError("payload too large")
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("payload must be object")
    return value


def _fetch_jwks(force: bool = False) -> list[dict]:
    now = time.time()
    with _JWKS_LOCK:
        cached = _JWKS_CACHE.get("keys", [])
        if not force and now < float(_JWKS_CACHE.get("until", 0.0)) and isinstance(cached, list) and cached:
            return cached
        last: Exception | None = None
        for url in VERCEL_JWKS_URLS:
            try:
                req = Request(url, headers={"accept": "application/json", "user-agent": VERSION})
                with urlopen(req, timeout=8) as r:
                    obj = json.loads(r.read(512_000).decode("utf-8"))
                keys = obj.get("keys", []) if isinstance(obj, dict) else []
                keys = [k for k in keys if isinstance(k, dict) and k.get("kty") == "RSA"]
                if not keys:
                    raise ValueError("JWKS contained no RSA keys")
                _JWKS_CACHE["keys"] = keys
                _JWKS_CACHE["until"] = now + 3600.0
                return keys
            except Exception as exc:
                last = exc
        raise RuntimeError(f"Vercel JWKS unavailable: {type(last).__name__ if last else 'unknown'}")


def _verify_rs256(signing_input: bytes, signature: bytes, jwk: dict) -> None:
    if jwk.get("kty") != "RSA":
        raise ValueError("unexpected JWK type")
    n = int.from_bytes(_b64url_bytes(str(jwk["n"])), "big")
    e = int.from_bytes(_b64url_bytes(str(jwk["e"])), "big")
    size = (n.bit_length() + 7) // 8
    if len(signature) > size:
        raise ValueError("RSA signature too large")
    decoded = pow(int.from_bytes(signature, "big"), e, n).to_bytes(size, "big")
    digest = hashlib.sha256(signing_input).digest()
    digest_info = bytes.fromhex("3031300d060960864801650304020105000420") + digest
    pad_len = size - len(digest_info) - 3
    if pad_len < 8:
        raise ValueError("RSA key too small")
    expected = b"\x00\x01" + (b"\xff" * pad_len) + b"\x00" + digest_info
    if not hmac.compare_digest(decoded, expected):
        raise PermissionError("bad Vercel OIDC signature")


def verify_vercel_oidc(token: str) -> dict:
    pieces = token.split(".")
    if len(pieces) != 3:
        raise PermissionError("malformed Vercel OIDC token")
    header = _b64url_json(pieces[0])
    claims = _b64url_json(pieces[1])
    if header.get("alg") != "RS256" or not header.get("kid"):
        raise PermissionError("unsupported Vercel OIDC header")
    signing = (pieces[0] + "." + pieces[1]).encode("ascii")
    signature = _b64url_bytes(pieces[2])
    kid = str(header["kid"])
    keys = _fetch_jwks()
    jwk = next((k for k in keys if str(k.get("kid")) == kid), None)
    if jwk is None:
        keys = _fetch_jwks(force=True)
        jwk = next((k for k in keys if str(k.get("kid")) == kid), None)
    if jwk is None:
        raise PermissionError("unknown Vercel OIDC key")
    _verify_rs256(signing, signature, jwk)

    now = time.time()
    exp = float(claims.get("exp", 0))
    nbf = float(claims.get("nbf", claims.get("nfb", 0)) or 0)
    iat = float(claims.get("iat", 0) or 0)
    if exp <= now - 30:
        raise PermissionError("expired Vercel OIDC token")
    if nbf and nbf > now + 30:
        raise PermissionError("Vercel OIDC token not yet valid")
    if iat and iat > now + 60:
        raise PermissionError("Vercel OIDC issued in the future")
    if claims.get("iss") != VERCEL_ISSUER:
        raise PermissionError("wrong Vercel OIDC issuer")
    aud = claims.get("aud")
    if isinstance(aud, list):
        aud_ok = VERCEL_AUDIENCE in aud
    else:
        aud_ok = aud == VERCEL_AUDIENCE
    if not aud_ok:
        raise PermissionError("wrong Vercel OIDC audience")
    if claims.get("sub") != VERCEL_SUBJECT:
        raise PermissionError("wrong Vercel OIDC subject")
    if claims.get("owner_id") != VERCEL_OWNER_ID or claims.get("project_id") != VERCEL_PROJECT_ID:
        raise PermissionError("wrong Vercel project identity")
    if claims.get("environment") != "production":
        raise PermissionError("Vercel request is not production")
    return claims


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
    p = subprocess.run(argv, cwd=str(cwd or MACH_ROOT), text=True, encoding="utf-8", errors="replace", stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, shell=False)
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
    out: dict[str, object] = {"version": VERSION, "host": socket.gethostname(), "user": getpass.getuser(), "pid": os.getpid(), "uptime_s": round(time.time() - STARTED, 3), "mach_root": str(MACH_ROOT), "mach_present": MACH_ROOT.is_dir()}
    try:
        out["mach"] = presence({"ask": ["mode", "gui/enabled", "gui/lens"], "wait_s": 3})
    except Exception as exc:
        out["mach_error"] = f"{type(exc).__name__}: {exc}"
    return out


def telemetry() -> dict:
    gpu = run(["nvidia-smi.exe", "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"], timeout=20)
    ps = "$os=Get-CimInstance Win32_OperatingSystem; $top=Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 12 Name,Id,@{n='MB';e={[math]::Round($_.WorkingSet64/1MB)}}; [pscustomobject]@{ram_used_mb=[math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/1024);ram_free_mb=[math]::Round($os.FreePhysicalMemory/1024);top=$top}|ConvertTo-Json -Compress -Depth 4"
    mem = run(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ps], timeout=20)
    return {"gpu": gpu, "memory": mem}


def atomic_write(path: Path, data: bytes, expected_sha256: str | None) -> dict:
    old = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
    if expected_sha256 is not None and old != expected_sha256:
        raise RuntimeError(f"sha guard mismatch expected={expected_sha256} got={old}")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            if os.path.exists(temp_name): os.unlink(temp_name)
        except OSError: pass
    return {"path": str(path), "bytes": len(data), "old_sha256": old, "sha256": hashlib.sha256(data).hexdigest()}


def dispatch(payload: dict) -> dict:
    op = str(payload.get("op", "status")).lower()
    if op in {"status", "health"}: return status()
    if op == "telemetry": return telemetry()
    if op == "mach": return presence(payload)
    if op == "computer":
        request = payload.get("request")
        if not isinstance(request, dict): raise ValueError("computer requires request object")
        return run([sys.executable, str(MACH_ROOT / "say.py"), "--computer", json.dumps(request, ensure_ascii=False, separators=(",", ":"))], timeout=int(payload.get("timeout_s", 60)))
    if op == "python":
        args = payload.get("args", [])
        if not isinstance(args, list) or not all(isinstance(x, str) for x in args): raise ValueError("python args must be string list")
        cwd = under_mach(payload.get("cwd", str(MACH_ROOT)))
        return run([sys.executable, *args], cwd=cwd, timeout=int(payload.get("timeout_s", 120)))
    if op == "local_exec":
        exe = under_mach(str(payload["exe"])); args = payload.get("args", [])
        if not exe.is_file(): raise FileNotFoundError(exe)
        if not isinstance(args, list) or not all(isinstance(x, str) for x in args): raise ValueError("local_exec args must be string list")
        cwd = under_mach(payload.get("cwd", str(MACH_ROOT)))
        return run([str(exe), *args], cwd=cwd, timeout=int(payload.get("timeout_s", 120)))
    if op == "read":
        path = under_mach(str(payload["path"])); limit = max(1, min(int(payload.get("max_bytes", 300_000)), 1_000_000)); data = path.read_bytes()[:limit]
        try: return {"path": str(path), "bytes": len(data), "text": data.decode("utf-8")}
        except UnicodeDecodeError: return {"path": str(path), "bytes": len(data), "base64": base64.b64encode(data).decode("ascii")}
    if op == "list":
        path = under_mach(str(payload.get("path", ".")))
        if not path.is_dir(): raise NotADirectoryError(path)
        items = []
        for p in sorted(path.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))[:1000]:
            st = p.stat(); items.append({"name": p.name, "dir": p.is_dir(), "bytes": 0 if p.is_dir() else st.st_size, "mtime": st.st_mtime})
        return {"path": str(path), "items": items}
    if op == "write":
        path = under_mach(str(payload["path"])); encoding = str(payload.get("encoding", "utf-8")); content = payload.get("content", "")
        if not isinstance(content, str): raise ValueError("content must be string")
        data = base64.b64decode(content) if encoding == "base64" else content.encode("utf-8")
        if len(data) > MAX_BODY: raise ValueError("write too large")
        return atomic_write(path, data, payload.get("expected_sha256"))
    if op == "pull_write":
        source = str(payload["source_url"])
        if not source.startswith(RAW_PREFIX): raise PermissionError("source_url must be this repo raw content")
        path = under_mach(str(payload["path"])); req = Request(source, headers={"User-Agent": VERSION})
        with urlopen(req, timeout=30) as r: data = r.read(MAX_BODY + 1)
        if len(data) > MAX_BODY: raise ValueError("remote write too large")
        return atomic_write(path, data, payload.get("expected_sha256"))
    raise ValueError(f"unknown op: {op}")


def dispatch_oidc(payload: dict) -> dict:
    op = str(payload.get("op", "status")).lower()
    if op not in OIDC_READ_OPS:
        raise PermissionError("OIDC membrane is read-only")
    if op == "mach" and payload.get("expr"):
        raise PermissionError("OIDC Presence is read-only")
    return dispatch(payload)


class Handler(BaseHTTPRequestHandler):
    server_version = VERSION
    token = ""
    gateway = ""
    def log_message(self, fmt: str, *args: object) -> None: return
    def reply(self, code: int, value: dict) -> None:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
        self.send_response(code); self.send_header("content-type", "application/json; charset=utf-8"); self.send_header("content-length", str(len(body))); self.send_header("cache-control", "no-store"); self.end_headers(); self.wfile.write(body)
    def do_GET(self) -> None:
        try:
            parts = [p for p in urlsplit(self.path).path.split("/") if p]
            if parts and parts[0] == "mach-live": parts = parts[1:]
            if len(parts) == 3 and parts[0] == "r":
                if not (hmac.compare_digest(parts[1], self.token) or (self.gateway and hmac.compare_digest(parts[1], self.gateway))):
                    self.reply(404, {"ok": False, "error": "not found"}); return
                payload = b64json(parts[2]); started = time.perf_counter(); result = dispatch(payload)
                self.reply(200, {"ok": True, "ms": round((time.perf_counter() - started) * 1000, 2), "result": result}); return
            if len(parts) == 2 and parts[0] == "oidc":
                auth = self.headers.get("authorization", "")
                if not auth.startswith("Bearer "):
                    self.reply(401, {"ok": False, "error": "missing Vercel OIDC identity"}); return
                verify_vercel_oidc(auth[7:].strip())
                payload = b64json(parts[1]); started = time.perf_counter(); result = dispatch_oidc(payload)
                self.reply(200, {"ok": True, "ms": round((time.perf_counter() - started) * 1000, 2), "result": result}); return
            self.reply(404, {"ok": False, "error": "not found"})
        except subprocess.TimeoutExpired as exc: self.reply(200, {"ok": False, "error": f"timeout {exc.timeout}"})
        except PermissionError as exc: self.reply(403, {"ok": False, "error": redact(str(exc))})
        except Exception as exc: self.reply(200, {"ok": False, "error": redact(f"{type(exc).__name__}: {exc}")})


def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--token-file", required=True); ap.add_argument("--port", type=int, default=8891); args = ap.parse_args()
    token = Path(args.token_file).read_text(encoding="utf-8").strip()
    if len(token) < 32: raise RuntimeError("bad token")
    Handler.token = token
    Handler.gateway = base64.urlsafe_b64encode(hmac.new(token.encode("utf-8"), b"vercel-gateway/v1", hashlib.sha256).digest()).decode("ascii").rstrip("=")
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler); httpd.daemon_threads = True
    print(f"{VERSION} listening 127.0.0.1:{args.port}", flush=True); httpd.serve_forever(); return 0

if __name__ == "__main__": raise SystemExit(main())
