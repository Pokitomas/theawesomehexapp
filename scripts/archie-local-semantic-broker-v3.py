#!/usr/bin/env python3
"""Resident semantic broker v3: grounded projection + exact episodic exterior.

v2 prevented the tiny local LLM from promoting stale backend stories or pretty
formal prose into proof. v3 attacks the separate failure where a long user
object was acknowledged in chunks and then forgotten moments later.

The model's short rolling prompt remains bounded. Exact prior user text lives in
an external resident episode index, refreshed incrementally from the durable
wire. Only query-relevant episodes are projected into the current prompt. This
keeps arbitrary recall out of the model weights and avoids putting a full wire
scan or crawler call on the interactive path.

Delegated-choice turns use a deliberately rare buffered boundary. Normal turns
keep the original token streaming path. When the user explicitly says "you
choose", a whole draft is checked before any byte reaches the terminal. A
model-owned concrete choice is preserved while a trailing default-assistant
preference question is removed; drafts with no substantive choice are retried
once. This is a control invariant, not a hard-coded topic policy.
"""
from __future__ import annotations

import http.client
import importlib.util
import json
import os
import pathlib
import sys
import time
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
V2_PATH = HERE / "archie-local-semantic-broker-v2.py"
EPISODE_PATH = HERE / "archie-semantic-episodic-memory-v2.py"
INITIATIVE_PATH = HERE / "archie-resident-initiative.py"
MAX_EPISODIC_CHARS = int(os.environ.get("ARCHIE_EPISODIC_MAX_CHARS", "6500"))
MAX_EPISODIC_HITS = int(os.environ.get("ARCHIE_EPISODIC_MAX_HITS", "2"))


def load_module(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


V2 = load_module("archie_local_semantic_broker_v2_for_v3", V2_PATH)
E = load_module("archie_semantic_episodic_memory_v2_for_broker", EPISODE_PATH)
I = load_module("archie_resident_initiative_for_broker", INITIATIVE_PATH)
M = V2.M

_ORIGINAL_INIT = M.Broker.__init__
_V2_MESSAGES = M.Broker.messages
_ORIGINAL_GENERATE = M.Broker.generate


def broker_init_with_episodes(self, *args: Any, **kwargs: Any) -> None:
    _ORIGINAL_INIT(self, *args, **kwargs)
    started = time.monotonic_ns()
    self.episodic_exterior = E.EpisodicExterior(self.wire)
    elapsed_ms = (time.monotonic_ns() - started) / 1e6
    self.receipt(
        "episodic_resident",
        seed_ms=round(elapsed_ms, 3),
        episode_count=len(self.episodic_exterior.candidates()),
        wire_offset=self.episodic_exterior.offset,
    )


def render_hits(hits: list[dict[str, Any]]) -> str:
    if not hits:
        return ""
    lines = [
        "EPISODIC EVIDENCE: exact prior USER text for recall only. "
        "It proves what the user previously said, not that the content itself is true. "
        "Do not invent text outside these excerpts."
    ]
    for hit in hits:
        lines.append(
            f"--- episode {hit['episode_id']} score={hit['score']:.3f} "
            f"parts={hit['parts']} original_chars={hit['chars']} ---"
        )
        lines.append(str(hit["text"]))
    return "\n".join(lines)


def _history_without_current(self, current: str) -> list[dict[str, str]]:
    with self.lock:
        history = list(self.history)
    if (
        history
        and history[-1].get("role") == "user"
        and history[-1].get("content") == current
    ):
        history.pop()
    return history


def messages_with_exact_episodes(self, current: str):
    messages = _V2_MESSAGES(self, current)
    started = time.monotonic_ns()
    try:
        hits = self.episodic_exterior.retrieve(
            current,
            top_k=MAX_EPISODIC_HITS,
            max_chars=MAX_EPISODIC_CHARS,
        )
        recall = render_hits(hits)
        elapsed_ms = (time.monotonic_ns() - started) / 1e6
        self.receipt(
            "episodic_retrieval",
            query_sha256=M.sha(current),
            lookup_ms=round(elapsed_ms, 3),
            hit_count=len(hits),
            episode_ids=[int(hit["episode_id"]) for hit in hits],
            projected_chars=sum(len(str(hit["text"])) for hit in hits),
        )
    except Exception as exc:
        recall = ""
        self.receipt("episodic_error", error=f"{type(exc).__name__}: {exc}")

    initiative_history = _history_without_current(self, current)
    initiative = I.initiative_directive(current, initiative_history)
    if initiative:
        self.receipt(
            "initiative_transfer",
            query_sha256=M.sha(current),
            prior_failed_loops=I.trailing_failed_delegations(
                initiative_history, current
            ),
        )

    projections = [part for part in (recall, initiative) if part]
    if projections and messages and messages[0].get("role") == "system":
        messages[0] = {
            **messages[0],
            "content": f"{messages[0]['content']}\n\n" + "\n\n".join(projections),
        }
    return messages


def _buffered_completion(
    self,
    epoch: int,
    messages: list[dict[str, str]],
    *,
    temperature: float,
) -> str:
    conn = http.client.HTTPConnection(self.host, self.port, timeout=30)
    with self.lock:
        if epoch != self.epoch:
            return ""
        self.active_conn = conn
        self.active_epoch = epoch
    body = json.dumps(
        {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": self.max_tokens,
            "stream": False,
        }
    )
    try:
        conn.request(
            "POST",
            "/v1/chat/completions",
            body=body,
            headers={"Content-Type": "application/json"},
        )
        response = conn.getresponse()
        payload = response.read(1024 * 1024).decode("utf-8", "replace")
        if response.status != 200:
            raise RuntimeError(f"local semantic HTTP {response.status}: {payload[:4096]}")
        event = json.loads(payload)
        return str(event.get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
    finally:
        try:
            conn.close()
        except Exception:
            pass
        with self.lock:
            if self.active_epoch == epoch:
                self.active_conn = None
                self.active_epoch = None


def _retry_messages(self, text: str) -> list[dict[str, str]]:
    messages = self.messages(text)
    retry = (
        "DELEGATED-CHOICE RETRY: the previous private draft failed the initiative boundary. "
        "Return 1-3 declarative sentences that name one concrete safe topic/action and begin it. "
        "Do not ask the user to choose, state a preference, or say what interests them."
    )
    if messages and messages[0].get("role") == "system":
        messages[0] = {
            **messages[0],
            "content": f"{messages[0]['content']}\n\n{retry}",
        }
    return messages


def _commit_buffered_output(
    self,
    *,
    epoch: int,
    text: str,
    final: str,
    captured_ns: int,
    fragment_count: int,
    dispatch_mono: int,
    dispatch_wall: int,
    boundary_mode: str,
) -> None:
    with self.lock:
        if epoch != self.epoch:
            return
    first_output_mono = M.mono_ns()
    self.pty_write("\r\x1b[KARCHIE> ")
    self.pty_write(final)
    self.pty_write("\r\nYOU> ")
    done_mono = M.mono_ns()
    timing = {
        "input_to_first_delta_ms": round(
            (dispatch_wall + (first_output_mono - dispatch_mono) - captured_ns) / 1e6,
            3,
        ),
        "dispatch_to_first_delta_ms": round(
            (first_output_mono - dispatch_mono) / 1e6,
            3,
        ),
        "dispatch_to_done_ms": round((done_mono - dispatch_mono) / 1e6, 3),
    }
    event = {
        "from": M.ACTOR,
        "re": "presence-terminal",
        "type": "semantic_message",
        "source": "archie-local-semantic-broker-v3",
        "text": final,
        "t": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "epoch": epoch,
        "burst_fragment_count": fragment_count,
        "terminal_echo_suppressed": bool(self.pty),
        "initiative_boundary": boundary_mode,
        "timing": timing,
        "content_sha256": M.sha(final),
    }
    M.append_jsonl(self.wire, event)
    with self.lock:
        self.history.append({"role": "user", "content": text})
        self.history.append({"role": "assistant", "content": final})
        self.counters["completed"] += 1
    self.receipt(
        "done",
        epoch=epoch,
        output_sha256=event["content_sha256"],
        chars=len(final),
        timing=timing,
        initiative_boundary=boundary_mode,
    )
    self.persist("idle", last_timing=timing)


def generate_with_initiative_boundary(
    self,
    epoch: int,
    text: str,
    captured_ns: int,
    fragment_count: int,
) -> None:
    if not I.delegates_choice(text):
        return _ORIGINAL_GENERATE(self, epoch, text, captured_ns, fragment_count)

    dispatch_mono = M.mono_ns()
    dispatch_wall = M.now_ns()
    with self.lock:
        if epoch != self.epoch:
            return
    self.receipt(
        "dispatch",
        epoch=epoch,
        fragments=fragment_count,
        input_sha256=M.sha(text),
        initiative_buffered=True,
    )
    self.persist("dispatch", dispatch_epoch=epoch, initiative_buffered=True)
    history = _history_without_current(self, text)
    final = ""
    boundary_mode = ""

    for attempt in range(2):
        messages = self.messages(text) if attempt == 0 else _retry_messages(self, text)
        try:
            candidate = _buffered_completion(
                self,
                epoch,
                messages,
                temperature=0.45 if attempt == 0 else 0.25,
            )
        except (
            BrokenPipeError,
            ConnectionResetError,
            http.client.HTTPException,
            OSError,
            RuntimeError,
            ValueError,
            json.JSONDecodeError,
        ) as exc:
            with self.lock:
                cancelled = epoch != self.epoch
            if not cancelled:
                self.counters["errors"] += 1
                self.receipt(
                    "error",
                    epoch=epoch,
                    initiative_buffered=True,
                    attempt=attempt + 1,
                    error=f"{type(exc).__name__}: {exc}",
                )
            return

        with self.lock:
            if epoch != self.epoch:
                return
        gate = I.gate_candidate(text, candidate, history)
        self.receipt(
            "initiative_candidate",
            epoch=epoch,
            attempt=attempt + 1,
            candidate_sha256=M.sha(candidate),
            chars=len(candidate),
            allow=bool(gate["allow"]),
            reason=str(gate["reason"]),
        )
        if bool(gate["allow"]):
            final = candidate
            boundary_mode = "buffered-allow"
            break

        repaired = I.repair_delegated_candidate(candidate)
        if repaired and bool(I.gate_candidate(text, repaired, history)["allow"]):
            final = repaired
            boundary_mode = "buffered-repair"
            self.receipt(
                "initiative_repair",
                epoch=epoch,
                attempt=attempt + 1,
                original_sha256=M.sha(candidate),
                repaired_sha256=M.sha(repaired),
                removed_chars=max(0, len(candidate) - len(repaired)),
            )
            break

    if not final:
        self.receipt(
            "initiative_fail_closed",
            epoch=epoch,
            attempts=2,
            reason="no-substantive-self-chosen-output",
        )
        final = (
            "I couldn't produce a substantive self-chosen continuation without "
            "handing the choice back, so I stopped that loop instead of pretending progress."
        )
        boundary_mode = "buffered-fail-closed"

    _commit_buffered_output(
        self,
        epoch=epoch,
        text=text,
        final=final,
        captured_ns=captured_ns,
        fragment_count=fragment_count,
        dispatch_mono=dispatch_mono,
        dispatch_wall=dispatch_wall,
        boundary_mode=boundary_mode,
    )


M.Broker.__init__ = broker_init_with_episodes
M.Broker.messages = messages_with_exact_episodes
M.Broker.generate = generate_with_initiative_boundary


if __name__ == "__main__":
    M.main()
