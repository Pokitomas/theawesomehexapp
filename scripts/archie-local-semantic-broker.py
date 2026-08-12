#!/usr/bin/env python3
"""Resident local semantic broker for ARCHIE's presence terminal.

Fast path:
    presence/events.jsonl -> this resident process -> local llama-server -> PTY

The durable room wire remains a ledger/coordination bus, but semantic dispatch
does not wait for room.py or a cloud turn.  New terminal input increments an
epoch and closes the active HTTP stream immediately; generation is therefore
preemptible even while the model is decoding.

This is intentionally a semantic scaffold, not the proposed long-term ARCHIE
core.  It consumes a normal local language model only at the boundary while
separate action/world-model courts can evolve underneath it.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import http.client
import json
import os
import pathlib
import socket
import threading
import time
from typing import Any

ROOT = pathlib.Path("/home/awesomekai/archie-remote")
DEFAULT_EVENTS = ROOT / "presence/events.jsonl"
DEFAULT_WIRE = ROOT / "roast.jsonl"
DEFAULT_STATE = ROOT / "presence/local_semantic_state.json"
DEFAULT_RECEIPTS = ROOT / "presence/local_semantic_receipts.jsonl"
DEFAULT_ENDPOINT_HOST = "172.22.64.1"
DEFAULT_ENDPOINT_PORT = 18767
ACTOR = "gpt56sol"
SCHEMA = "archie/local-semantic-broker-v1"

SYSTEM = (
    "You are ARCHIE's temporary local semantic cortex inside a persistent resident system. "
    "Reply directly, naturally, and compactly. Do not act servile. Do not narrate obvious system mechanics. "
    "Maintain continuity across turns, but treat the deeper local action/world model as the organism and this "
    "language model as a replaceable semantic boundary."
)


def now_ns() -> int:
    return time.time_ns()


def mono_ns() -> int:
    return time.monotonic_ns()


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


def atomic_json(path: pathlib.Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp-{os.getpid()}-{time.time_ns()}")
    tmp.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", "utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def append_jsonl(path: pathlib.Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(obj, ensure_ascii=False, sort_keys=True) + "\n")
        fh.flush()


def terminal_text(event: dict[str, Any]) -> str:
    if event.get("source") != "terminal" or event.get("kind") != "user_text":
        return ""
    return str((event.get("payload") or {}).get("text") or "").strip()


def room_text(event: dict[str, Any]) -> str:
    return str(event.get("text") or event.get("message") or "").strip()


def semantic_room_event(event: dict[str, Any]) -> bool:
    who = str(event.get("from") or event.get("actor") or "")
    text = room_text(event)
    if not text:
        return False
    if who == "kai":
        return True
    if who != ACTOR or text.startswith("@"):
        return False
    return event.get("type") == "semantic_message" or event.get("re") == "presence-terminal"


def seed_history(wire: pathlib.Path, turns: int) -> collections.deque[dict[str, str]]:
    history: collections.deque[dict[str, str]] = collections.deque(maxlen=max(2, turns * 2))
    try:
        lines = wire.read_text("utf-8", errors="replace").splitlines()[-400:]
    except Exception:
        return history
    for line in lines:
        try:
            event = json.loads(line)
        except Exception:
            continue
        if not semantic_room_event(event):
            continue
        who = str(event.get("from") or event.get("actor") or "")
        history.append({"role": "user" if who == "kai" else "assistant", "content": room_text(event)})
    return history


class Broker:
    def __init__(
        self,
        *,
        events: pathlib.Path,
        wire: pathlib.Path,
        state: pathlib.Path,
        receipts: pathlib.Path,
        pty: str,
        host: str,
        port: int,
        model: str,
        turns: int,
        burst_ms: float,
        max_tokens: int,
    ) -> None:
        self.events = events
        self.wire = wire
        self.state = state
        self.receipts = receipts
        self.pty = pty
        self.host = host
        self.port = port
        self.model = model
        self.turns = turns
        self.burst_ns = int(max(0.0, burst_ms) * 1e6)
        self.max_tokens = max_tokens
        self.history = seed_history(wire, turns)
        self.epoch = 0
        self.lock = threading.RLock()
        self.active_conn: http.client.HTTPConnection | None = None
        self.active_epoch: int | None = None
        self.pending: list[tuple[str, int]] = []
        self.pending_due_ns: int | None = None
        self.counters = {"inputs": 0, "dispatches": 0, "completed": 0, "cancelled": 0, "errors": 0}
        self.stop = threading.Event()

    def receipt(self, kind: str, **payload: Any) -> None:
        append_jsonl(self.receipts, {"schema": SCHEMA, "t_ns": now_ns(), "kind": kind, **payload})

    def persist(self, phase: str, **extra: Any) -> None:
        with self.lock:
            atomic_json(
                self.state,
                {
                    "schema": SCHEMA,
                    "t_ns": now_ns(),
                    "pid": os.getpid(),
                    "phase": phase,
                    "epoch": self.epoch,
                    "active_epoch": self.active_epoch,
                    "pending_fragments": len(self.pending),
                    "endpoint": f"http://{self.host}:{self.port}",
                    "model": self.model,
                    "pty": self.pty,
                    "history_messages": len(self.history),
                    "counters": dict(self.counters),
                    **extra,
                },
            )

    def pty_write(self, text: str) -> None:
        if not self.pty or not text:
            return
        try:
            fd = os.open(self.pty, os.O_WRONLY | os.O_NOCTTY | os.O_NONBLOCK)
            try:
                os.write(fd, text.encode("utf-8", "replace"))
            finally:
                os.close(fd)
        except Exception as exc:
            self.receipt("pty_error", error=f"{type(exc).__name__}: {exc}")

    def cancel_active(self, reason: str) -> None:
        with self.lock:
            conn = self.active_conn
            old_epoch = self.active_epoch
            if conn is None:
                return
            self.active_conn = None
            self.active_epoch = None
            self.counters["cancelled"] += 1
        try:
            conn.close()
        except Exception:
            pass
        self.receipt("cancel", epoch=old_epoch, reason=reason)

    def on_input(self, text: str, captured_wall_ns: int) -> None:
        with self.lock:
            self.epoch += 1
            epoch = self.epoch
            self.counters["inputs"] += 1
        self.cancel_active(f"superseded-by-epoch-{epoch}")
        with self.lock:
            self.pending.append((text, captured_wall_ns))
            self.pending_due_ns = mono_ns() + self.burst_ns
        self.receipt("input", epoch=epoch, text_sha256=sha(text), chars=len(text))
        self.persist("input")

    def maybe_dispatch(self) -> None:
        with self.lock:
            if not self.pending or self.pending_due_ns is None or mono_ns() < self.pending_due_ns:
                return
            fragments = self.pending
            self.pending = []
            self.pending_due_ns = None
            epoch = self.epoch
            self.counters["dispatches"] += 1
        text = "\n".join(fragment for fragment, _ in fragments if fragment).strip()
        captured_ns = min((stamp for _, stamp in fragments), default=now_ns())
        if not text:
            return
        thread = threading.Thread(
            target=self.generate,
            args=(epoch, text, captured_ns, len(fragments)),
            name=f"archie-local-semantic-{epoch}",
            daemon=True,
        )
        thread.start()

    def messages(self, current: str) -> list[dict[str, str]]:
        with self.lock:
            hist = list(self.history)
        # The room mirror may already contain the current user input. Avoid
        # duplicate semantic weight when that happens.
        if hist and hist[-1].get("role") == "user" and hist[-1].get("content") == current:
            hist.pop()
        return [{"role": "system", "content": SYSTEM}, *hist, {"role": "user", "content": current}]

    def generate(self, epoch: int, text: str, captured_ns: int, fragment_count: int) -> None:
        dispatch_mono = mono_ns()
        dispatch_wall = now_ns()
        conn = http.client.HTTPConnection(self.host, self.port, timeout=30)
        with self.lock:
            if epoch != self.epoch:
                return
            self.active_conn = conn
            self.active_epoch = epoch
        self.receipt("dispatch", epoch=epoch, fragments=fragment_count, input_sha256=sha(text))
        self.persist("dispatch", dispatch_epoch=epoch)
        body = json.dumps(
            {
                "model": self.model,
                "messages": self.messages(text),
                "temperature": 0.45,
                "max_tokens": self.max_tokens,
                "stream": True,
            }
        )
        first_delta_mono: int | None = None
        output: list[str] = []
        opened = False
        try:
            conn.request("POST", "/v1/chat/completions", body=body, headers={"Content-Type": "application/json"})
            response = conn.getresponse()
            if response.status != 200:
                detail = response.read(4096).decode("utf-8", "replace")
                raise RuntimeError(f"local semantic HTTP {response.status}: {detail}")
            while not self.stop.is_set():
                with self.lock:
                    if epoch != self.epoch:
                        return
                raw = response.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    event = json.loads(payload)
                    delta = str(event.get("choices", [{}])[0].get("delta", {}).get("content") or "")
                except Exception:
                    continue
                if not delta:
                    continue
                if first_delta_mono is None:
                    first_delta_mono = mono_ns()
                    opened = True
                    self.pty_write("\r\x1b[KARCHIE> ")
                    self.receipt(
                        "first_delta",
                        epoch=epoch,
                        input_to_first_delta_ms=round((now_ns() - captured_ns) / 1e6, 3),
                        dispatch_to_first_delta_ms=round((first_delta_mono - dispatch_mono) / 1e6, 3),
                    )
                output.append(delta)
                self.pty_write(delta)
        except (BrokenPipeError, ConnectionResetError, http.client.HTTPException, OSError) as exc:
            with self.lock:
                cancelled = epoch != self.epoch
            if not cancelled:
                self.counters["errors"] += 1
                self.receipt("error", epoch=epoch, error=f"{type(exc).__name__}: {exc}")
            return
        except Exception as exc:
            with self.lock:
                self.counters["errors"] += 1
            self.receipt("error", epoch=epoch, error=f"{type(exc).__name__}: {exc}")
            return
        finally:
            try:
                conn.close()
            except Exception:
                pass
            with self.lock:
                if self.active_epoch == epoch:
                    self.active_conn = None
                    self.active_epoch = None

        with self.lock:
            if epoch != self.epoch:
                return
        final = "".join(output).strip()
        if not final:
            return
        if opened:
            self.pty_write("\r\nYOU> ")
        done_mono = mono_ns()
        event = {
            "from": ACTOR,
            "re": "presence-terminal",
            "type": "semantic_message",
            "source": "archie-local-semantic-broker",
            "text": final,
            "t": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "epoch": epoch,
            "burst_fragment_count": fragment_count,
            "terminal_echo_suppressed": bool(self.pty),
            "timing": {
                "input_to_first_delta_ms": None if first_delta_mono is None else round((dispatch_wall + (first_delta_mono - dispatch_mono) - captured_ns) / 1e6, 3),
                "dispatch_to_first_delta_ms": None if first_delta_mono is None else round((first_delta_mono - dispatch_mono) / 1e6, 3),
                "dispatch_to_done_ms": round((done_mono - dispatch_mono) / 1e6, 3),
            },
            "content_sha256": sha(final),
        }
        append_jsonl(self.wire, event)
        with self.lock:
            self.history.append({"role": "user", "content": text})
            self.history.append({"role": "assistant", "content": final})
            self.counters["completed"] += 1
        self.receipt("done", epoch=epoch, output_sha256=event["content_sha256"], chars=len(final), timing=event["timing"])
        self.persist("idle", last_timing=event["timing"])

    def run(self) -> None:
        self.events.parent.mkdir(parents=True, exist_ok=True)
        self.events.touch(exist_ok=True)
        self.receipts.touch(exist_ok=True)
        self.persist("resident")
        self.receipt("start", pid=os.getpid(), endpoint=f"http://{self.host}:{self.port}", pty=self.pty)
        with self.events.open("r", encoding="utf-8", errors="replace") as fh:
            fh.seek(0, os.SEEK_END)
            while not self.stop.is_set():
                line = fh.readline()
                if line:
                    try:
                        event = json.loads(line)
                    except Exception:
                        continue
                    text = terminal_text(event)
                    if text:
                        payload = event.get("payload") or {}
                        captured = int(payload.get("captured_wall_ns") or event.get("wall_ns") or now_ns())
                        self.on_input(text, captured)
                else:
                    self.maybe_dispatch()
                    self.stop.wait(0.002)
                self.maybe_dispatch()

    def close(self) -> None:
        self.stop.set()
        self.cancel_active("shutdown")
        self.persist("shutdown")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--events", default=str(DEFAULT_EVENTS))
    p.add_argument("--wire", default=str(DEFAULT_WIRE))
    p.add_argument("--state", default=str(DEFAULT_STATE))
    p.add_argument("--receipts", default=str(DEFAULT_RECEIPTS))
    p.add_argument("--pty", default=os.environ.get("ARCHIE_PRESENCE_PTY", ""))
    p.add_argument("--host", default=os.environ.get("ARCHIE_LOCAL_SEMANTIC_HOST", DEFAULT_ENDPOINT_HOST))
    p.add_argument("--port", type=int, default=int(os.environ.get("ARCHIE_LOCAL_SEMANTIC_PORT", DEFAULT_ENDPOINT_PORT)))
    p.add_argument("--model", default=os.environ.get("ARCHIE_LOCAL_SEMANTIC_MODEL", "local"))
    p.add_argument("--turns", type=int, default=int(os.environ.get("ARCHIE_LOCAL_SEMANTIC_TURNS", "5")))
    p.add_argument("--burst-ms", type=float, default=float(os.environ.get("ARCHIE_LOCAL_SEMANTIC_BURST_MS", "15")))
    p.add_argument("--max-tokens", type=int, default=int(os.environ.get("ARCHIE_LOCAL_SEMANTIC_MAX_TOKENS", "160")))
    args = p.parse_args()
    broker = Broker(
        events=pathlib.Path(args.events), wire=pathlib.Path(args.wire), state=pathlib.Path(args.state),
        receipts=pathlib.Path(args.receipts), pty=args.pty, host=args.host, port=args.port,
        model=args.model, turns=args.turns, burst_ms=args.burst_ms, max_tokens=args.max_tokens,
    )
    try:
        broker.run()
    except KeyboardInterrupt:
        pass
    finally:
        broker.close()


if __name__ == "__main__":
    main()
