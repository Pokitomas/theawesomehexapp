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
"""
from __future__ import annotations

import importlib.util
import os
import pathlib
import sys
import time
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
V2_PATH = HERE / "archie-local-semantic-broker-v2.py"
EPISODE_PATH = HERE / "archie-semantic-episodic-memory-v2.py"
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
M = V2.M

_ORIGINAL_INIT = M.Broker.__init__
_V2_MESSAGES = M.Broker.messages


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

    if recall and messages and messages[0].get("role") == "system":
        messages[0] = {
            **messages[0],
            "content": f"{messages[0]['content']}\n\n{recall}",
        }
    return messages


M.Broker.__init__ = broker_init_with_episodes
M.Broker.messages = messages_with_exact_episodes


if __name__ == "__main__":
    M.main()
