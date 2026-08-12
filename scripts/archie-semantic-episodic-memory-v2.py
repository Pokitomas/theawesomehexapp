#!/usr/bin/env python3
"""Current-turn-safe wrapper for ARCHIE's exact semantic episodic exterior.

The terminal wire can mirror the current user line before the semantic broker
builds its prompt. A retrieval system that simply ranks the newest matching
episode can therefore "remember" the query itself and crowd out the actual
referent. This wrapper preserves the v1 exact exterior but rejects any episode
whose final user fragment is exactly the current query.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import pathlib
import re
import sys
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
BASE_PATH = HERE / "archie-semantic-episodic-memory.py"


def load_base():
    spec = importlib.util.spec_from_file_location("archie_semantic_episodic_memory_v1", BASE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {BASE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


B = load_base()


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


class EpisodicExterior(B.EpisodicExterior):
    def retrieve(
        self,
        query: str,
        *,
        top_k: int = 2,
        min_score: float = 0.72,
        max_chars: int = 7000,
    ) -> list[dict[str, Any]]:
        self.refresh()
        qnorm = normalize(query)
        candidates = self.candidates()
        scored: list[tuple[float, Any]] = []
        total = len(candidates)
        for i, episode in enumerate(candidates):
            if episode.user_parts and normalize(episode.user_parts[-1]) == qnorm:
                # Current-turn mirror, not memory.
                continue
            score = self.score(query, episode, total - 1 - i)
            if score >= min_score:
                scored.append((score, episode))
        scored.sort(key=lambda pair: (pair[0], pair[1].end_event), reverse=True)
        result: list[dict[str, Any]] = []
        budget = max_chars
        for score, episode in scored[:top_k]:
            text = episode.text
            if len(text) > budget:
                text = text[:budget]
            if not text:
                continue
            result.append({
                "episode_id": episode.episode_id,
                "score": round(score, 6),
                "parts": len(episode.user_parts),
                "chars": len(episode.text),
                "text": text,
            })
            budget -= len(text)
            if budget <= 0:
                break
        return result


# Rebind the base court so its internal constructor exercises this wrapper.
B.EpisodicExterior = EpisodicExterior


def run_failure_replay_court(tmp: pathlib.Path) -> dict[str, Any]:
    result = B.run_failure_replay_court(tmp)

    # Add a sharper self-mirror court: the current query is already on the wire,
    # but retrieval must still return the earlier long prompt episode.
    wire = tmp / "self-mirror.jsonl"
    wire.touch()
    B._append(wire, "kai", "The named object BIGPROMPT contains alpha beta gamma delta epsilon and must be retained exactly.")
    B._append(wire, "gpt56sol", "Acknowledged.", type="semantic_message")
    B._append(wire, "kai", "Done.")
    B._append(wire, "gpt56sol", "I have the object.", type="semantic_message")
    query = "recite BIGPROMPT"
    B._append(wire, "kai", query)
    memory = EpisodicExterior(wire)
    hits = memory.retrieve(query, top_k=1, max_chars=4000)
    hit = hits[0]["text"] if hits else ""
    result["current_turn_self_mirror_excluded"] = bool(
        hits and "alpha beta gamma delta epsilon" in hit and normalize(hit) != normalize(query)
    )
    result["pass"] = bool(result.get("pass") and result["current_turn_self_mirror_excluded"])
    result["schema"] = "archie/semantic-episodic-memory-court-v2"
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--court", action="store_true")
    parser.add_argument("--wire")
    parser.add_argument("--query")
    args = parser.parse_args()
    if args.court:
        import tempfile
        with tempfile.TemporaryDirectory(prefix="archie-episode-v2-court-") as name:
            result = run_failure_replay_court(pathlib.Path(name))
        print(json.dumps(result, indent=2, sort_keys=True))
        raise SystemExit(0 if result["pass"] else 1)
    if not args.wire or not args.query:
        raise SystemExit("provide --court or --wire PATH --query TEXT")
    memory = EpisodicExterior(pathlib.Path(args.wire).expanduser().resolve())
    print(memory.render(args.query))


if __name__ == "__main__":
    main()
