#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time
from urllib.request import urlopen

VERSION = "q0907-live-install/v1"
PORT = 8891
TASK_NAME = "Q0907MachLive"
STABLE = Path.home() / ".q0907-live"
SERVER = STABLE / "server.py"
TOKEN_FILE = STABLE / "token"
LOG = STABLE / "server.log"
MACH_ROOT = Path(r"C:\Users\AwesomeKai\mach")


def run(argv: list[str], timeout: int = 40, check: bool = True) -> subprocess.CompletedProcess[str]:
    p = subprocess.run(argv, text=True, encoding="utf-8", errors="replace", stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, shell=False)
    if check and p.returncode != 0:
        raise RuntimeError(f"command failed rc={p.returncode}: {' '.join(argv[:3])}\n{p.stdout[-4000:]}")
    return p


def kill_old() -> None:
    ps = (
        "$p=Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*\\.q0907-live\\server.py*' }; "
        "$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    )
    run(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ps], check=False)


def start_detached() -> None:
    env = os.environ.copy()
    env.pop("RUNNER_TRACKING_ID", None)
    flags = 0
    for name in ("DETACHED_PROCESS", "CREATE_NEW_PROCESS_GROUP", "CREATE_NO_WINDOW"):
        flags |= int(getattr(subprocess, name, 0))
    log = open(LOG, "ab", buffering=0)
    subprocess.Popen(
        [sys.executable, str(SERVER), "--token-file", str(TOKEN_FILE), "--port", str(PORT)],
        cwd=str(STABLE),
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        env=env,
        creationflags=flags,
        close_fds=True,
    )


def persist() -> None:
    # User-context persistence without requiring a service password or admin token.
    import winreg
    key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_SET_VALUE)
    try:
        command = f'"{sys.executable}" "{SERVER}" --token-file "{TOKEN_FILE}" --port {PORT}'
        winreg.SetValueEx(key, TASK_NAME, 0, winreg.REG_SZ, command)
    finally:
        winreg.CloseKey(key)


def wait_local(token: str) -> None:
    import base64
    payload = base64.urlsafe_b64encode(json.dumps({"op": "status"}, separators=(",", ":")).encode()).decode().rstrip("=")
    url = f"http://127.0.0.1:{PORT}/r/{token}/{payload}"
    last = None
    for _ in range(60):
        try:
            with urlopen(url, timeout=1.5) as r:
                body = json.loads(r.read().decode("utf-8"))
            if body.get("ok"):
                return
            last = body
        except Exception as exc:
            last = exc
        time.sleep(0.25)
    raise RuntimeError(f"live server failed health: {last}")


def funnel() -> str:
    tailscale = shutil.which("tailscale.exe") or shutil.which("tailscale")
    if not tailscale:
        raise RuntimeError("tailscale missing")
    run([tailscale, "funnel", "--bg", "--yes", "--set-path=/mach-live", f"http://127.0.0.1:{PORT}"], timeout=45)
    status = json.loads(run([tailscale, "status", "--json"], timeout=20).stdout)
    host = str(status["Self"]["DNSName"]).rstrip(".")
    if not host:
        raise RuntimeError("tailscale DNS name missing")
    return f"https://{host}/mach-live"


def main() -> int:
    if socket.gethostname().upper() != "DESKTOP-6FN9B4M":
        raise RuntimeError("wrong host")
    if os.environ.get("USERNAME", "").lower() != "awesomekai":
        raise RuntimeError("wrong user context")
    if not MACH_ROOT.is_dir():
        raise RuntimeError("Mach root missing")

    source = Path(__file__).with_name("q0907-live-server.py")
    if not source.is_file():
        raise RuntimeError("server source missing")

    STABLE.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, SERVER)
    token = secrets.token_urlsafe(48)
    TOKEN_FILE.write_text(token, encoding="utf-8")
    try:
        os.chmod(TOKEN_FILE, 0o600)
    except OSError:
        pass

    kill_old()
    persist()
    start_detached()
    wait_local(token)
    base_url = funnel()

    receipt_dir = Path(os.environ.get("RUNNER_TEMP", str(STABLE)))
    receipt_dir.mkdir(parents=True, exist_ok=True)
    receipt = receipt_dir / "q0907-live-seat.json"
    receipt.write_text(json.dumps({
        "schema": "q0907-live-seat/v1",
        "base_url": base_url,
        "token": token,
        "host": socket.gethostname(),
        "user": os.environ.get("USERNAME", ""),
        "port": PORT,
        "installed_at": time.time(),
        "server": str(SERVER),
    }, separators=(",", ":")), encoding="utf-8")

    # Never print the capability token.
    print(f"Q0907_LIVE_INSTALLED base={base_url} root={MACH_ROOT}")
    print(f"Q0907_LIVE_RECEIPT={receipt}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
