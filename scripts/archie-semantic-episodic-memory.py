#!/usr/bin/env python3
"""Exact, resident episodic exterior for ARCHIE's tiny semantic adapter.

The local semantic model has a deliberately short rolling prompt and can forget
a long user object even seconds after acknowledging it.  This module does not
ask the model to compress that object into weights or a fixed hidden vector.
It keeps exact user text outside the model, assembles acknowledgement-bridged
multi-turn pastes into episodes, and retrieves only relevant prior episodes.

This is adapter memory, not the proposed cognitive core.  It implements the
same truth-preserving principle as the action-latent information-budget courts:
bounded active state may stay small; arbitrary exact content lives in an
exterior whose storage grows when information actually needs to be retained.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import pathlib
import re
from dataclasses import dataclass, field
from typing import Any

TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9_'-]*", re.I)
STOP = {
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "for", "from",
    "have", "i", "if", "in", "is", "it", "me", "my", "of", "on", "or", "so", "that", "the",
    "this", "to", "u", "you", "your", "was", "we", "what", "with", "would",
}
ACK_RE = re.compile(
    r"^\s*(?:ack(?:nowledged)?|okay|ok|got it|noted|received|continue|go ahead|done|yep|yes|sure)"
    r"(?:[.!,:;\s].*)?$",
    re.I | re.S,
)
CONTROL_PREFIX_RE = re.compile(r"^@(all|gpt|archie|claude|peer|codex)\b", re.I)


def tokens(text: str) -> set[str]:
    return {m.group(0).lower() for m in TOKEN_RE.finditer(text) if m.group(0).lower() not in STOP}


def trigrams(text: str) -> set[str]:
    clean = re.sub(r"\s+", " ", text.lower().strip())
    if len(clean) < 3:
        return {clean} if clean else set()
    return {clean[i : i + 3] for i in range(len(clean) - 2)}


def is_ack(text: str) -> bool:
    text = text.strip()
    if not text or len(text) > 140:
        return False
    return bool(ACK_RE.match(text))


def event_role_text(event: dict[str, Any]) -> tuple[str, str] | None:
    who = str(event.get("from") or event.get("actor") or "").strip().lower()
    text = str(event.get("text") or event.get("message") or "").strip()
    if not text or CONTROL_PREFIX_RE.match(text):
        return None
    if who == "kai":
        return "user", text
    if who == "gpt56sol" and (event.get("type") == "semantic_message" or event.get("re") == "presence-terminal"):
        return "assistant", text
    return None


@dataclass
class Episode:
    episode_id: int
    user_parts: list[str] = field(default_factory=list)
    start_event: int = 0
    end_event: int = 0

    @property
    def text(self) -> str:
        return "\n".join(part.strip() for part in self.user_parts if part.strip()).strip()

    @property
    def token_set(self) -> set[str]:
        return tokens(self.text)

    def public(self) -> dict[str, Any]:
        return {
            "episode_id": self.episode_id,
            "start_event": self.start_event,
            "end_event": self.end_event,
            "parts": len(self.user_parts),
            "chars": len(self.text),
            "text": self.text,
        }


class EpisodicExterior:
    def __init__(self, wire: pathlib.Path, *, max_seed_bytes: int = 16 << 20) -> None:
        self.wire = wire
        self.max_seed_bytes = max_seed_bytes
        self.offset = 0
        self.event_index = 0
        self.episodes: list[Episode] = []
        self.current: Episode | None = None
        self._next_id = 1
        self._seed()

    def _new_episode(self) -> Episode:
        episode = Episode(self._next_id, start_event=self.event_index, end_event=self.event_index)
        self._next_id += 1
        self.current = episode
        return episode

    def _close(self) -> None:
        if self.current is not None and self.current.text:
            self.episodes.append(self.current)
        self.current = None

    def _consume(self, event: dict[str, Any]) -> None:
        self.event_index += 1
        item = event_role_text(event)
        if item is None:
            return
        role, text = item
        if role == "user":
            episode = self.current or self._new_episode()
            episode.user_parts.append(text)
            episode.end_event = self.event_index
            return
        # A terse acknowledgement is a transparent bridge between user chunks.
        if is_ack(text):
            if self.current is not None:
                self.current.end_event = self.event_index
            return
        self._close()

    def _seed(self) -> None:
        try:
            size = self.wire.stat().st_size
        except FileNotFoundError:
            self.wire.parent.mkdir(parents=True, exist_ok=True)
            self.wire.touch()
            self.offset = 0
            return
        start = max(0, size - self.max_seed_bytes)
        with self.wire.open("rb") as fh:
            if start:
                fh.seek(start)
                fh.readline()  # discard partial JSONL record
            while True:
                raw = fh.readline()
                if not raw:
                    break
                try:
                    event = json.loads(raw.decode("utf-8", "replace"))
                except Exception:
                    continue
                if isinstance(event, dict):
                    self._consume(event)
            self.offset = fh.tell()

    def refresh(self) -> int:
        """Consume only bytes appended since the previous refresh."""
        consumed = 0
        try:
            size = self.wire.stat().st_size
        except FileNotFoundError:
            return 0
        if size < self.offset:
            # Wire rotated/truncated. Rebuild from the bounded tail instead of
            # trusting stale offsets.
            self.offset = 0
            self.event_index = 0
            self.episodes.clear()
            self.current = None
            self._next_id = 1
            self._seed()
            return 0
        with self.wire.open("rb") as fh:
            fh.seek(self.offset)
            while True:
                raw = fh.readline()
                if not raw:
                    break
                consumed += 1
                try:
                    event = json.loads(raw.decode("utf-8", "replace"))
                except Exception:
                    continue
                if isinstance(event, dict):
                    self._consume(event)
            self.offset = fh.tell()
        return consumed

    def candidates(self) -> list[Episode]:
        result = list(self.episodes)
        if self.current is not None and self.current.text:
            result.append(self.current)
        return result

    def score(self, query: str, episode: Episode, rank_from_end: int) -> float:
        q = tokens(query)
        e = episode.token_set
        if not q or not e:
            return 0.0
        overlap = q & e
        # Query coverage dominates because short referential requests such as
        # "recite the big prompt" should recover a long episode containing the
        # named anchor without being diluted by the episode's length.
        coverage = len(overlap) / len(q)
        specificity = sum(min(2.0, 0.6 + len(word) / 7.0) for word in overlap) / max(1.0, len(q))
        qtri, etri = trigrams(query), trigrams(episode.text[:12000])
        char_sim = len(qtri & etri) / max(1, len(qtri))
        phrase_bonus = 0.0
        lowered = episode.text.lower()
        meaningful = [word for word in TOKEN_RE.findall(query.lower()) if word not in STOP and len(word) >= 3]
        if len(meaningful) >= 2 and " ".join(meaningful[-2:]) in lowered:
            phrase_bonus = 0.35
        recency = 0.08 / (1.0 + max(0, rank_from_end))
        return 1.45 * coverage + 0.45 * specificity + 0.25 * char_sim + phrase_bonus + recency

    def retrieve(self, query: str, *, top_k: int = 2, min_score: float = 0.72, max_chars: int = 7000) -> list[dict[str, Any]]:
        self.refresh()
        candidates = self.candidates()
        scored: list[tuple[float, Episode]] = []
        total = len(candidates)
        for i, episode in enumerate(candidates):
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

    def render(self, query: str, *, max_chars: int = 7000) -> str:
        hits = self.retrieve(query, max_chars=max_chars)
        if not hits:
            return ""
        lines = [
            "EPISODIC EVIDENCE (exact prior user text; use for recall, do not invent omitted material):"
        ]
        for hit in hits:
            lines.append(
                f"--- episode {hit['episode_id']} score={hit['score']:.3f} parts={hit['parts']} original_chars={hit['chars']} ---"
            )
            lines.append(hit["text"])
        return "\n".join(lines)


def _append(path: pathlib.Path, actor: str, text: str, **extra: Any) -> None:
    event = {"from": actor, "text": text, **extra}
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(event, ensure_ascii=False) + "\n")


def run_failure_replay_court(tmp: pathlib.Path) -> dict[str, Any]:
    wire = tmp / "wire.jsonl"
    wire.touch()
    intro = "I'm gonna paste it in bits and pieces, since your memory is short. Intermittently just say acknowledged UNTIL i say done ok? The thing is the big prompt."
    chunks = [
        "To replicate true, unconstrained frontier intelligence locally on consumer hardware—meaning absolute peak capability with zero latency, zero memory footprint bloat, and zero hallucinations—you would have to completely rewrite the physics of computing and information theory.",
        "1. Demolishing the von Neumann Memory Wall: reduce data motion or move compute into memory rather than shuttling weights continuously.",
        "2. Eliminating discrete floating-point inefficiencies: search for representations and physical computation whose primitive operations match the dynamics rather than default dense matrix multiplication.",
        "3. Solving grounding and hallucination: combine associative neural state with verifiable evidence or symbolic execution instead of treating formal-looking text as proof.",
        "4. Infinitely scaling context without quadratic attention decay: seek sub-linear recurrent state, while confronting whether arbitrary exact history can actually fit losslessly in fixed state.",
    ]
    _append(wire, "kai", intro)
    _append(wire, "gpt56sol", "Acknowledged.", type="semantic_message")
    for chunk in chunks:
        _append(wire, "kai", chunk)
        _append(wire, "gpt56sol", "Acknowledged.", type="semantic_message")
    _append(wire, "kai", "Done.")
    _append(wire, "gpt56sol", "Done.", type="semantic_message")
    # A real answer closes the paste episode.
    _append(wire, "kai", "That's the whole big prompt. Waddaya think?")
    _append(wire, "gpt56sol", "It is ambitious; I should falsify the absolutes instead of merely paraphrasing them.", type="semantic_message")

    memory = EpisodicExterior(wire)
    hits = memory.retrieve("Alright, recite the big prompt as well as you can recall", top_k=1, max_chars=10000)
    top = hits[0] if hits else None
    recovered = top["text"] if top else ""
    all_chunks = all(chunk in recovered for chunk in chunks)

    # Prove incremental append handling without rebuilding the index.
    before_offset = memory.offset
    _append(wire, "kai", "A separate note about jury parking.")
    _append(wire, "gpt56sol", "Understood; separate topic.", type="semantic_message")
    consumed = memory.refresh()
    after_offset = memory.offset
    second = memory.retrieve("recite the big prompt", top_k=1, max_chars=10000)
    stable = bool(second and all(chunk in second[0]["text"] for chunk in chunks))

    result = {
        "schema": "archie/semantic-episodic-memory-court-v1",
        "episode_count": len(memory.candidates()),
        "top_score": None if top is None else top["score"],
        "top_parts": None if top is None else top["parts"],
        "all_prompt_chunks_recovered": all_chunks,
        "incremental_records_consumed": consumed,
        "offset_advanced": after_offset > before_offset,
        "retrieval_stable_after_unrelated_append": stable,
        "wrong_memory_string_present": "Describe a moment when you felt truly inspired" in recovered,
    }
    result["pass"] = bool(
        top
        and all_chunks
        and stable
        and consumed == 2
        and after_offset > before_offset
        and not result["wrong_memory_string_present"]
    )
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--court", action="store_true")
    parser.add_argument("--wire")
    parser.add_argument("--query")
    args = parser.parse_args()
    if args.court:
        import tempfile
        with tempfile.TemporaryDirectory(prefix="archie-episode-court-") as name:
            result = run_failure_replay_court(pathlib.Path(name))
        print(json.dumps(result, indent=2, sort_keys=True))
        raise SystemExit(0 if result["pass"] else 1)
    if not args.wire or not args.query:
        raise SystemExit("provide --court or --wire PATH --query TEXT")
    memory = EpisodicExterior(pathlib.Path(args.wire).expanduser().resolve())
    print(memory.render(args.query))


if __name__ == "__main__":
    main()
