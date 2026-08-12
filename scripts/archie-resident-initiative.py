#!/usr/bin/env python3
"""Small deterministic policy for delegated initiative at the semantic boundary.

This is not a planner and it does not choose the resident's substantive action.
It only detects a narrow control-state transition: the user has explicitly
handed the choice to ARCHIE. In that state, asking the user to make the same
choice again is zero objective progress and should be rejected before it
becomes a resident habit.

The policy is intentionally language-boundary scaffolding. The deeper action
model remains responsible for selecting and valuing actions.
"""
from __future__ import annotations

import re
from typing import Sequence


_SPACE = re.compile(r"\s+")
_WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9_'-]*")
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+")
_META_INITIATIVE = re.compile(
    r"\b(?:i(?:'ll| will)\s+(?:choose|decide)|let\s+me\s+(?:choose|decide)|okay|sure)\b",
    re.I,
)
_DELEGATION_PATTERNS = tuple(
    re.compile(pattern, re.I)
    for pattern in (
        r"\byou\s+choose\b",
        r"\byou\s+decide\b",
        r"\bup\s+to\s+you\b",
        r"\bcan\s+you\s+(?:choose|decide)\b",
        r"\bcould\s+you\s+(?:choose|decide)\b",
        r"\bchoose\s+(?:a|the|one)\s+(?:subject|topic|thing|option)\b",
        r"\bdecide\s+(?:for\s+us|for\s+me)\b",
        r"\bi\s+(?:can(?:not|'t)|do\s+not|don't)\s+decide\b",
        r"\bi\s+(?:can(?:not|'t)|do\s+not|don't)\s+want\s+to\s+choose\b",
    )
)
_PREFERENCE_QUESTION_PATTERNS = tuple(
    re.compile(pattern, re.I)
    for pattern in (
        r"\bwhat\s+(?:would\s+you\s+like|do\s+you\s+want|interests\s+you)\b",
        r"\bwhat\s+interests\s+you\b",
        r"\bwhich\s+.*\b(?:would\s+you\s+like|do\s+you\s+want|do\s+you\s+prefer)\b",
        r"\bwhat\s+should\s+we\s+(?:explore|talk\s+about|do)\b",
        r"\btell\s+me\s+what\s+you\s+(?:want|prefer|like)\b",
    )
)


def normalize(text: str) -> str:
    return _SPACE.sub(" ", str(text).strip())


def delegates_choice(text: str) -> bool:
    value = normalize(text)
    return bool(value and any(pattern.search(value) for pattern in _DELEGATION_PATTERNS))


def asks_user_to_choose(text: str) -> bool:
    value = normalize(text)
    if not value:
        return False
    return bool(any(pattern.search(value) for pattern in _PREFERENCE_QUESTION_PATTERNS))


def has_substantive_initiative(text: str) -> bool:
    """Require more than a performative 'I'll decide' acknowledgement."""
    value = normalize(text)
    if not value or asks_user_to_choose(value):
        return False
    stripped = _META_INITIATIVE.sub(" ", value)
    words = _WORD.findall(stripped)
    return len(words) >= 3


def repair_delegated_candidate(candidate_reply: str) -> str:
    """Drop preference-return sentences while preserving model-owned choice."""
    parts = [part.strip() for part in _SENTENCE_SPLIT.split(str(candidate_reply).strip()) if part.strip()]
    kept = [part for part in parts if not asks_user_to_choose(part)]
    repaired = normalize(" ".join(kept))
    return repaired if has_substantive_initiative(repaired) else ""


def delegation_failure(current_user: str, candidate_reply: str) -> bool:
    return delegates_choice(current_user) and asks_user_to_choose(candidate_reply)


def trailing_failed_delegations(history: Sequence[dict[str, str]], current_user: str) -> int:
    if not delegates_choice(current_user):
        return 0
    count = 0
    expect_assistant = True
    for item in reversed(list(history)):
        role = str(item.get("role") or "")
        content = str(item.get("content") or "")
        if expect_assistant:
            if role != "assistant" or not asks_user_to_choose(content):
                break
            count += 1
            expect_assistant = False
        else:
            if role != "user" or not delegates_choice(content):
                break
            expect_assistant = True
    return count


def initiative_directive(current_user: str, history: Sequence[dict[str, str]] = ()) -> str:
    if not delegates_choice(current_user):
        return ""
    failures = trailing_failed_delegations(history, current_user)
    return (
        "INITIATIVE TRANSFER: the user explicitly delegated this choice to you. "
        "Choose one concrete safe topic/action yourself and begin it now. "
        "Do not ask the user what they want, prefer, or find interesting; that "
        "would return the delegated decision and make zero objective progress. "
        "A question is allowed only if a missing fact is genuinely required for "
        "safety or an irreversible external action. "
        f"Immediately preceding no-progress preference loops={failures}."
    )


def gate_candidate(current_user: str, candidate_reply: str, history: Sequence[dict[str, str]] = ()) -> dict[str, object]:
    delegated = delegates_choice(current_user)
    asks_back = asks_user_to_choose(candidate_reply)
    substantive = has_substantive_initiative(candidate_reply) if delegated else True
    if delegated and asks_back:
        reason = "delegated-choice-returned-to-user"
    elif delegated and not substantive:
        reason = "delegated-choice-without-substantive-action"
    else:
        reason = "allowed"
    return {
        "delegated": delegated,
        "prior_failed_loops": trailing_failed_delegations(history, current_user),
        "candidate_asks_user_to_choose": asks_back,
        "candidate_has_substantive_initiative": substantive,
        "allow": reason == "allowed",
        "reason": reason,
    }
