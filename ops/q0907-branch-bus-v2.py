#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

VERSION = "q0907-branch-bus/v2"
REPO = "Pokitomas/theawesomehexapp"
BRANCH = "mach-live-bus"
API = f"https://api.github.com/repos/{REPO}/contents"
STABLE = Path.home() / ".q0907-live"
TOKEN_FILE = STABLE / "token"
SERVER_FILE = STABLE / "server.py"
BUS_FILE = STABLE / "bus.py"
STATE_FILE = STABLE / "bus-state.json"
LOG_FILE = STABLE / "bus.log"
RUN_KEY = "Q0907MachBus"
POLL_S = 0.45
MAX_BOX = 2_800_000


def b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def b64d(text: str) -> bytes:
    text += "=" * ((4 - len(text) % 4) % 4)
    return base64.urlsafe_b64decode(text.encode("ascii"))


def derive(master: bytes) -> tuple[bytes, bytes]:
    return (
        hmac.new(master, b"mach-live-bus/enc/v1", hashlib.sha256).digest(),
        hmac.new(master, b"mach-live-bus/mac/v1", hashlib.sha256).digest(),
    )


def keystream(key: bytes, nonce: bytes, n: int) -> bytes:
    out = bytearray()
    i = 0
    while len(out) < n:
        out.extend(hmac.new(key, nonce + i.to_bytes(8, "big"), hashlib.sha256).digest())
        i += 1
    return bytes(out[:n])


def seal(master: bytes, value: object) -> str:
    plain = json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
    if len(plain) > 2_000_000:
        raise ValueError("payload too large")
    enc, mac = derive(master)
    nonce = secrets.token_bytes(16)
    stream = keystream(enc, nonce, len(plain))
    cipher = bytes(a ^ b for a, b in zip(plain, stream))
    tag = hmac.new(mac, nonce + cipher, hashlib.sha256).digest()[:16]
    return b64e(nonce + cipher + tag)


def unseal(master: bytes, box: str) -> dict:
    raw = b64d(box)
    if len(raw) < 32 or len(raw) > MAX_BOX:
        raise ValueError("bad box size")
    nonce, cipher, tag = raw[:16], raw[16:-16], raw[-16:]
    enc, mac = derive(master)
    want = hmac.new(mac, nonce + cipher, hashlib.sha256).digest()[:16]
    if not hmac.compare_digest(tag, want):
        raise ValueError("bad box tag")
    stream = keystream(enc, nonce, len(cipher))
    plain = bytes(a ^ b for a, b in zip(cipher, stream))
    value = json.loads(plain.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("payload is not an object")
    return value


def run(argv: list[str], timeout: int = 30, check: bool = True) -> subprocess.CompletedProcess[str]:
    p = subprocess.run(argv, text=True, encoding="utf-8", errors="replace", stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, shell=False)
    if check and p.returncode != 0:
        raise RuntimeError(f"rc={p.returncode}: {p.stdout[-2000:]}")
    return p


def github_token() -> str:
    token = run(["gh.exe", "auth", "token"], timeout=15).stdout.strip()
    if len(token) < 20:
        raise RuntimeError("local GitHub auth unavailable")
    return token


def headers(token: str, etag: str | None = None) -> dict[str, str]:
    h = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": VERSION,
        "Cache-Control": "no-cache",
    }
    if etag:
        h["If-None-Match"] = etag
    return h


def api_get(token: str, path: str, etag: str | None = None) -> tuple[dict | None, str | None]:
    url = f"{API}/{quote(path)}?ref={quote(BRANCH)}"
    req = Request(url, headers=headers(token, etag))
    try:
        with urlopen(req, timeout=6) as r:
            body = json.loads(r.read().decode("utf-8"))
            return (body if isinstance(body, dict) else None, r.headers.get("ETag"))
    except HTTPError as exc:
        if exc.code == 304:
            return None, etag
        raise


def api_put(token: str, path: str, value: dict, current_sha: str | None, message: str) -> str:
    raw = (json.dumps(value, separators=(",", ":")) + "\n").encode("utf-8")
    body: dict[str, str] = {
        "message": message,
        "content": base64.b64encode(raw).decode("ascii"),
        "branch": BRANCH,
    }
    if current_sha:
        body["sha"] = current_sha
    req = Request(
        f"{API}/{quote(path)}",
        data=json.dumps(body, separators=(",", ":")).encode("utf-8"),
        method="PUT",
        headers={**headers(token), "Content-Type": "application/json"},
    )
    with urlopen(req, timeout=10) as r:
        result = json.loads(r.read().decode("utf-8"))
    return str(result["content"]["sha"])


def decode_contents(obj: dict) -> dict:
    data = base64.b64decode(str(obj.get("content", "")).replace("\n", ""))
    value = json.loads(data.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("branch register is not an object")
    return value


def load_dispatch():
    spec = importlib.util.spec_from_file_location("q0907_live_server", SERVER_FILE)
    if spec is None or spec.loader is None:
        raise RuntimeError("resident server unavailable")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.dispatch


def read_state() -> dict:
    try:
        x = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return x if isinstance(x, dict) else {}
    except Exception:
        return {}


def write_state(value: dict) -> None:
    fd, tmp = tempfile.mkstemp(prefix="bus-state-", suffix=".tmp", dir=str(STABLE))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(value, f, separators=(",", ":"))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, STATE_FILE)
    finally:
        try:
            if os.path.exists(tmp):
                os.unlink(tmp)
        except OSError:
            pass


def log_error(exc: Exception) -> None:
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"{time.time():.3f} {type(exc).__name__}: {exc}\n")
    except Exception:
        pass


def run_loop() -> int:
    master = TOKEN_FILE.read_text(encoding="utf-8").strip().encode("utf-8")
    if len(master) < 32:
        raise RuntimeError("private capability missing")
    token = github_token()
    dispatch = load_dispatch()
    last = int(read_state().get("ack", 0))
    inbox_etag: str | None = None
    out_obj, _ = api_get(token, "outbox.json")
    out_sha = str((out_obj or {}).get("sha", "")) or None
    last_heartbeat = time.time()
    failures = 0

    while True:
        try:
            obj, inbox_etag = api_get(token, "inbox.json", inbox_etag)
            if obj is not None:
                inbox = decode_contents(obj)
                seq = int(inbox.get("seq", 0))
                box = inbox.get("box")
                if seq > last and isinstance(box, str) and box:
                    started = time.perf_counter()
                    request = unseal(master, box)
                    try:
                        result = dispatch(request)
                        response = {"ok": True, "seq": seq, "ms": round((time.perf_counter()-started)*1000, 2), "result": result}
                    except Exception as exc:
                        response = {"ok": False, "seq": seq, "ms": round((time.perf_counter()-started)*1000, 2), "error": f"{type(exc).__name__}: {exc}"}
                    envelope = {
                        "schema": "mach-live-bus/v1",
                        "ack": seq,
                        "from": "mach",
                        "box": seal(master, response),
                        "heartbeat": int(time.time()),
                        "ts": time.time(),
                    }
                    for attempt in range(6):
                        try:
                            out_sha = api_put(token, "outbox.json", envelope, out_sha, f"bus ack {seq}")
                            break
                        except HTTPError as exc:
                            if exc.code not in (409, 422) or attempt == 5:
                                raise
                            latest, _ = api_get(token, "outbox.json")
                            out_sha = str((latest or {}).get("sha", "")) or None
                            time.sleep(0.1 * (attempt + 1))
                    last = seq
                    write_state({"ack": last, "ts": time.time()})
                    last_heartbeat = time.time()
            if time.time() - last_heartbeat > 60:
                envelope = {
                    "schema": "mach-live-bus/v1",
                    "ack": last,
                    "from": "mach",
                    "box": seal(master, {"ok": True, "seq": last, "heartbeat": True, "version": VERSION}),
                    "heartbeat": int(time.time()),
                    "ts": time.time(),
                }
                try:
                    out_sha = api_put(token, "outbox.json", envelope, out_sha, f"bus heartbeat {last}")
                except HTTPError as exc:
                    if exc.code not in (409, 422):
                        raise
                    latest, _ = api_get(token, "outbox.json")
                    out_sha = str((latest or {}).get("sha", "")) or None
                    out_sha = api_put(token, "outbox.json", envelope, out_sha, f"bus heartbeat {last}")
                last_heartbeat = time.time()
            failures = 0
        except Exception as exc:
            failures += 1
            log_error(exc)
            inbox_etag = None
        time.sleep(min(POLL_S + 0.15 * failures, 3.0))


def stop_old() -> None:
    ps = "$self=$PID; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self -and $_.CommandLine -like '*\\.q0907-live\\bus.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    run(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ps], check=False)


def persist() -> None:
    import winreg
    key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_SET_VALUE)
    try:
        winreg.SetValueEx(key, RUN_KEY, 0, winreg.REG_SZ, f'"{sys.executable}" "{BUS_FILE}" --run')
    finally:
        winreg.CloseKey(key)


def start_detached() -> None:
    env = os.environ.copy()
    env.pop("RUNNER_TRACKING_ID", None)
    flags = 0
    for name in ("DETACHED_PROCESS", "CREATE_NEW_PROCESS_GROUP", "CREATE_NO_WINDOW"):
        flags |= int(getattr(subprocess, name, 0))
    log = open(LOG_FILE, "ab", buffering=0)
    subprocess.Popen([sys.executable, str(BUS_FILE), "--run"], cwd=str(STABLE), stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env, creationflags=flags, close_fds=True)


def install() -> int:
    if not TOKEN_FILE.is_file() or not SERVER_FILE.is_file():
        raise RuntimeError("resident live seat missing")
    STABLE.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).resolve()
    if source != BUS_FILE:
        shutil.copy2(source, BUS_FILE)
    stop_old()
    persist()
    start_detached()
    time.sleep(1.5)
    ps = "$self=$PID; (Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self -and $_.CommandLine -like '*\\.q0907-live\\bus.py*' }).ProcessId -join ','"
    pids = run(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ps], check=False).stdout.strip()
    if not pids:
        raise RuntimeError("bus did not stay alive")
    print(f"Q0907_BRANCH_BUS_V2_OK pids={pids} branch={BRANCH} poll_s={POLL_S}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--install", action="store_true")
    ap.add_argument("--run", action="store_true")
    a = ap.parse_args()
    if a.install:
        return install()
    if a.run:
        return run_loop()
    ap.error("choose --install or --run")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
