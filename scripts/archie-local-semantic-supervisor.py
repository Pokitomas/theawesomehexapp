#!/usr/bin/env python3
"""Keep the local semantic broker attached to the live ARCHIE terminal PTY.

The terminal is intentionally allowed to die/reopen without resetting the
presence reactor or local model.  This supervisor treats the PTY as a movable
projection: it discovers the newest live `presence_terminal.py`, starts the
semantic broker against that PTY, and restarts only the projection process when
the terminal changes.  The model server and durable state remain resident.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import signal
import subprocess
import sys
import time
from typing import Any

SCHEMA = "archie/local-semantic-supervisor-v1"
DEFAULT_STATE = pathlib.Path("/home/awesomekai/archie-remote/presence/local_semantic_supervisor.json")
TERMINAL_MARKER = "/home/awesomekai/archie-remote/presence_terminal.py"


def atomic_json(path: pathlib.Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    tmp.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", "utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def proc_start_ticks(pid: int) -> int:
    try:
        # /proc/PID/stat field 22; command field may contain spaces in parens,
        # so split only after the final ') '.
        rest = pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
        return int(rest[19])
    except Exception:
        return -1


def terminal_candidates() -> list[tuple[int, int, str]]:
    rows: list[tuple[int, int, str]] = []
    for proc in pathlib.Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        pid = int(proc.name)
        try:
            cmd = (proc / "cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
            if TERMINAL_MARKER not in cmd:
                continue
            tty = os.path.realpath(proc / "fd/1")
            if not tty.startswith("/dev/pts/"):
                continue
            rows.append((proc_start_ticks(pid), pid, tty))
        except Exception:
            continue
    rows.sort(reverse=True)
    return rows


def current_terminal() -> tuple[int, str] | None:
    rows = terminal_candidates()
    return (rows[0][1], rows[0][2]) if rows else None


class Supervisor:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.child: subprocess.Popen[str] | None = None
        self.attached: tuple[int, str] | None = None
        self.stop = False
        self.restarts = 0

    def persist(self, phase: str, **extra: Any) -> None:
        atomic_json(
            pathlib.Path(self.args.state),
            {
                "schema": SCHEMA,
                "t_ns": time.time_ns(),
                "pid": os.getpid(),
                "phase": phase,
                "attached_terminal_pid": self.attached[0] if self.attached else None,
                "attached_pty": self.attached[1] if self.attached else None,
                "broker_pid": self.child.pid if self.child and self.child.poll() is None else None,
                "restarts": self.restarts,
                **extra,
            },
        )

    def terminate_child(self, reason: str) -> None:
        child = self.child
        self.child = None
        if child is None or child.poll() is not None:
            return
        child.terminate()
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=2)
        self.persist("broker-stopped", reason=reason, returncode=child.returncode)

    def start_child(self, terminal: tuple[int, str]) -> None:
        pid, tty = terminal
        argv = [
            sys.executable,
            self.args.broker,
            "--pty", tty,
            "--host", self.args.host,
            "--port", str(self.args.port),
            "--model", self.args.model,
            "--turns", str(self.args.turns),
            "--burst-ms", str(self.args.burst_ms),
            "--max-tokens", str(self.args.max_tokens),
        ]
        self.child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=None, text=True)
        self.attached = terminal
        self.restarts += 1
        self.persist("broker-started")

    def run(self) -> None:
        self.persist("resident-no-terminal")
        while not self.stop:
            terminal = current_terminal()
            child_dead = self.child is not None and self.child.poll() is not None
            if terminal != self.attached or child_dead:
                self.terminate_child("terminal-changed" if terminal != self.attached else "broker-exited")
                self.attached = None
                if terminal is not None:
                    self.start_child(terminal)
                else:
                    self.persist("resident-no-terminal")
            time.sleep(self.args.poll_ms / 1000.0)
        self.terminate_child("supervisor-shutdown")
        self.persist("shutdown")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--broker", default="/home/awesomekai/archie-remote/local_semantic_broker.py")
    p.add_argument("--state", default=str(DEFAULT_STATE))
    p.add_argument("--host", default="172.22.64.1")
    p.add_argument("--port", type=int, default=18767)
    p.add_argument("--model", default="local")
    p.add_argument("--turns", type=int, default=5)
    p.add_argument("--burst-ms", type=float, default=15.0)
    p.add_argument("--max-tokens", type=int, default=160)
    p.add_argument("--poll-ms", type=float, default=250.0)
    args = p.parse_args()
    supervisor = Supervisor(args)

    def stop(_sig: int, _frame: Any) -> None:
        supervisor.stop = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    supervisor.run()


if __name__ == "__main__":
    main()
