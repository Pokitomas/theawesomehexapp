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
from urllib.request import Request, urlopen

VERSION = "q0907-branch-bus/v1"
REPO = "Pokitomas/theawesomehexapp"
BRANCH = "mach-live-bus"
STABLE = Path.home() / ".q0907-live"
TOKEN_FILE = STABLE / "token"
SERVER_FILE = STABLE / "server.py"
BUS_FILE = STABLE / "bus.py"
STATE_FILE = STABLE / "bus-state.json"
LOG_FILE = STABLE / "bus.log"
RUN_KEY = "Q0907MachBus"
POLL_S = 0.85
RAW_INBOX = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/inbox.json"
MAX_BOX = 2_800_000


def b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def b64d(text: str) -> bytes:
    text += "=" * ((4 - len(text) % 4) % 4)
    return base64.urlsafe_b64decode(text.encode("ascii"))


def keys(master: bytes) -> tuple[bytes, bytes]:
    enc = hmac.new(master, b"mach-live-bus/enc/v1", hashlib.sha256).digest()
    mac = hmac.new(master, b"mach-live-bus/mac/v1", hashlib.sha256).digest()
    return enc, mac


def stream(enc_key: bytes, nonce: bytes, n: int) -> bytes:
    out = bytearray()
    counter = 0
    while len(out) < n:
        out.extend(hmac.new(enc_key, nonce + counter.to_bytes(8, "big"), hashlib.sha256).digest())
        counter += 1
    return bytes(out[:n])


def seal(master: bytes, value: object) -> str:
    plain = json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
    if len(plain) > 2_000_000:
        raise ValueError("sealed payload too large")
    enc_key, mac_key = keys(master)
    nonce = secrets.token_bytes(16)
    ks = stream(enc_key, nonce, len(plain))
    cipher = bytes(a ^ b for a, b in zip(plain, ks))
    tag = hmac.new(mac_key, nonce + cipher, hashlib.sha256).digest()[:16]
    return b64e(nonce + cipher + tag)


def open_box(master: bytes, box: str) -> dict:
    raw = b64d(box)
    if len(raw) < 32 or len(raw) > MAX_BOX:
        raise ValueError("bad box size")
    nonce, cipher, tag = raw[:16], raw[16:-16], raw[-16:]
    enc_key, mac_key = keys(master)
    want = hmac.new(mac_key, nonce + cipher, hashlib.sha256).digest()[:16]
    if not hmac.compare_digest(tag, want):
        raise ValueError("bad box tag")
    ks = stream(enc_key, nonce, len(cipher))
    plain = bytes(a ^ b for a, b in zip(cipher, ks))
    value = json.loads(plain.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("box payload must be object")
    return value


def run(argv: list[str], timeout: int = 30, check: bool = True) -> subprocess.CompletedProcess[str]:
    p = subprocess.run(argv, text=True, encoding="utf-8", errors="replace", stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, shell=False)
    if check and p.returncode != 0:
        raise RuntimeError(f"rc={p.returncode}: {p.stdout[-2500:]}")
    return p


def gh_json(endpoint: str, method: str = "GET", fields: dict[str, str] | None = None, timeout: int = 30) -> dict:
    argv = ["gh.exe", "api", endpoint, "-X", method]
    for k, v in (fields or {}).items():
        argv += ["-f", f"{k}={v}"]
    p = run(argv, timeout=timeout)
    value = json.loads(p.stdout or "{}")
    if not isinstance(value, dict):
        raise RuntimeError("unexpected gh response")
    return value


def fetch_inbox(cache_bust: int) -> dict | None:
    req = Request(f"{RAW_INBOX}?v={cache_bust}", headers={"User-Agent": VERSION, "Cache-Control": "no-cache"})
    try:
        with urlopen(req, timeout=5) as r:
            data = r.read(3_000_000)
    except Exception:
        return None
    try:
        value = json.loads(data.decode("utf-8"))
    except Exception:
        return None
    return value if isinstance(value, dict) else None


def load_dispatch():
    if not SERVER_FILE.is_file():
        raise FileNotFoundError(SERVER_FILE)
    spec = importlib.util.spec_from_file_location("q0907_live_server", SERVER_FILE)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load live server")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.dispatch


def read_state() -> dict:
    try:
        v = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return v if isinstance(v, dict) else {}
    except Exception:
        return {}


def write_state(value: dict) -> None:
    STABLE.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix="bus-state-", suffix=".tmp", dir=str(STABLE))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(value, f, separators=(",", ":"))
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, STATE_FILE)
    finally:
        try:
            if os.path.exists(name):
                os.unlink(name)
        except OSError:
            pass


def update_outbox(master: bytes, ack: int, payload: dict) -> None:
    value = {
        "schema": "mach-live-bus/v1",
        "ack": ack,
        "from": "mach",
        "box": seal(master, payload),
        "heartbeat": int(time.time()),
        "ts": time.time(),
    }
    content = base64.b64encode((json.dumps(value, separators=(",", ":")) + "\n").encode("utf-8")).decode("ascii")
    for attempt in range(8):
        try:
            cur = gh_json(f"repos/{REPO}/contents/outbox.json?ref={BRANCH}")
            sha = str(cur.get("sha", ""))
            fields = {
                "message": f"bus ack {ack}",
                "content": content,
                "branch": BRANCH,
            }
            if sha:
                fields["sha"] = sha
            gh_json(f"repos/{REPO}/contents/outbox.json", method="PUT", fields=fields)
            return
        except Exception:
            if attempt == 7:
                raise
            time.sleep(0.25 * (attempt + 1))


def loop() -> int:
    master = TOKEN_FILE.read_text(encoding="utf-8").strip().encode("utf-8")
    if len(master) < 32:
        raise RuntimeError("missing private bus capability")
    dispatch = load_dispatch()
    state = read_state()
    last = int(state.get("ack", 0))
    last_heartbeat = 0.0
    errors = 0
    while True:
        now = time.time()
        inbox = fetch_inbox(int(now * 1000))
        if inbox is not None:
            try:
                seq = int(inbox.get("seq", 0))
                box = inbox.get("box")
                if seq > last and isinstance(box, str) and box:
                    started = time.perf_counter()
                    request = open_box(master, box)
                    try:
                        result = dispatch(request)
                        response = {
                            "ok": True,
                            "seq": seq,
                            "ms": round((time.perf_counter() - started) * 1000, 2),
                            "result": result,
                        }
                    except Exception as exc:
                        response = {
                            "ok": False,
                            "seq": seq,
                            "ms": round((time.perf_counter() - started) * 1000, 2),
                            "error": f"{type(exc).__name__}: {exc}",
                        }
                    update_outbox(master, seq, response)
                    last = seq
                    write_state({"ack": last, "ts": time.time()})
                    last_heartbeat = time.time()
                    errors = 0
                elif now - last_heartbeat > 30:
                    update_outbox(master, last, {"ok": True, "seq": last, "heartbeat": True, "version": VERSION})
                    last_heartbeat = time.time()
                    errors = 0
            except Exception as exc:
                errors += 1
                try:
                    with open(LOG_FILE, "a", encoding="utf-8") as f:
                        f.write(f"{time.time():.3f} {type(exc).__name__}: {exc}\n")
                except Exception:
                    pass
        time.sleep(min(POLL_S + errors * 0.2, 5.0))


def kill_old() -> None:
    ps = (
        "$p=Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*\\.q0907-live\\bus.py*' }; "
        "$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    )
    run(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ps], check=False)


def persist() -> None:
    import winreg
    key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_SET_VALUE)
    try:
        command = f'"{sys.executable}" "{BUS_FILE}" --run'
        winreg.SetValueEx(key, RUN_KEY, 0, winreg.REG_SZ, command)
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
        raise RuntimeError("resident live seat must be installed first")
    STABLE.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).resolve()
    if source != BUS_FILE:
        shutil.copy2(source, BUS_FILE)
    kill_old()
    persist()
    start_detached()
    time.sleep(1.2)
    ps = run(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*\\.q0907-live\\bus.py*' }).ProcessId -join ','"], check=False)
    pids = ps.stdout.strip()
    if not pids:
        raise RuntimeError("bus process did not stay alive")
    print(f"Q0907_BRANCH_BUS_OK pids={pids} branch={BRANCH} poll_s={POLL_S}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--install", action="store_true")
    ap.add_argument("--run", action="store_true")
    args = ap.parse_args()
    if args.install:
        return install()
    if args.run:
        return loop()
    ap.error("choose --install or --run")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
