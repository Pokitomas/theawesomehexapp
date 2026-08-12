#!/usr/bin/env python3
"""Epistemically grounded wrapper around the resident local semantic broker.

The local 2B model is useful as a fast language boundary but is small enough to
launder definitions into fake proofs and to repeat stale capability claims.
This wrapper does not pretend to solve that internally. Instead it makes
operational truth an external state object and introduces explicit proof
obligations at the semantic boundary.

No second model call is added. The only extra work is reading a tiny local JSON
receipt and appending a compact grounding block to the system message.
"""
from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import sys
import time
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
BASE = HERE / "archie-local-semantic-broker.py"
DEFAULT_PROOF = pathlib.Path(
    os.environ.get(
        "ARCHIE_CAPABILITY_PROOF",
        "/home/awesomekai/archie-remote/receipts/capability-proof-latest.json",
    )
)
MAX_PROOF_AGE_S = float(os.environ.get("ARCHIE_CAPABILITY_PROOF_MAX_AGE_S", "30"))


def load_base():
    spec = importlib.util.spec_from_file_location("archie_local_semantic_broker_v1", BASE)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import resident broker: {BASE}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


M = load_base()

EPISTEMIC_PREFIX = """
You are ARCHIE's temporary local semantic cortex inside a persistent resident system.
Reply directly, naturally, and compactly. Do not act servile. Do not narrate obvious system mechanics.
The deeper local action/world model is the organism; this language model is a replaceable semantic boundary.

EPISTEMIC LAW:
- Formal-looking syntax, definitions, confident prose, and self-consistency are not evidence.
- A definition introduces an object; it does not prove a property of that object.
- A deduction is only a deduction when its conclusion follows from stated premises by a checkable transformation.
- Operational claims such as "running", "attached", "can control", "GPU resident", or "proved" require a current external receipt naming the backend/effect. If the receipt is absent or stale, treat the capability as unproved, not as false and not as true.
- A mathematical theorem/proof claim requires either an executable verifier/reference court or an explicit derivation whose steps can be checked. Otherwise call it a hypothesis, construction, analogy, or heuristic.
- Never upgrade an attractive story into "emergent reasoning" merely because its wording looks logical.
- Counterexamples and failed courts are positive information. Preserve them.
""".strip()


def _safe_number(value: Any) -> float | int | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def compact_capability_proof(path: pathlib.Path = DEFAULT_PROOF) -> str:
    """Return a bounded, value-safe proof projection for the prompt.

    Credential values, environment values, command lines, and arbitrary source
    contents are deliberately excluded. Only service/socket/backend identity and
    freshness metadata are projected.
    """
    try:
        data = json.loads(path.read_text("utf-8"))
        st = path.stat()
    except Exception:
        return "LIVE CAPABILITY PROOF: unavailable. Current operational capabilities are UNPROVED."

    age_s = max(0.0, time.time() - st.st_mtime)
    generated = _safe_number(data.get("generated_unix_ns"))
    if generated is not None:
        age_s = max(0.0, time.time() - float(generated) / 1e9)
    freshness = "fresh" if age_s <= MAX_PROOF_AGE_S else "STALE"

    lines = [
        f"LIVE CAPABILITY PROOF: {freshness}; age_s={age_s:.1f}; receipt_sha256={str(data.get('receipt_sha256') or '')[:16] or 'unknown'}",
    ]
    services = data.get("services") if isinstance(data.get("services"), dict) else {}
    for name, item in sorted(services.items()):
        if not isinstance(item, dict):
            continue
        active = item.get("active_state")
        pid = item.get("main_pid")
        if active is None and pid is None:
            continue
        lines.append(f"service {name}: state={active or 'unknown'} pid={pid or 0} pid_alive={bool(item.get('pid_alive'))}")

    listeners = data.get("listeners") if isinstance(data.get("listeners"), dict) else {}
    tcp = listeners.get("tcp_8788_8789") if isinstance(listeners.get("tcp_8788_8789"), list) else []
    presence = listeners.get("presence_socket") if isinstance(listeners.get("presence_socket"), dict) else {}
    lines.append(f"localhost_exec_listeners={len(tcp)} presence_socket_exists={bool(presence.get('exists'))}")

    gpu = data.get("gpu") if isinstance(data.get("gpu"), dict) else {}
    gpu_lines = gpu.get("gpus") if isinstance(gpu.get("gpus"), list) else []
    if gpu_lines:
        # nvidia-smi CSV contains telemetry only in this court, not credentials.
        lines.append(f"gpu={str(gpu_lines[0])[:240]}")

    git = data.get("git") if isinstance(data.get("git"), dict) else {}
    if git.get("is_git"):
        lines.append(f"worktree_branch={git.get('branch') or 'detached'} head={str(git.get('head') or '')[:12]} dirty={bool(git.get('dirty'))}")

    if freshness != "fresh":
        lines.append("STALE RECEIPT RULE: do not present any projected operational state as current proof.")
    return "\n".join(lines)[:2600]


M.SYSTEM = EPISTEMIC_PREFIX
_ORIGINAL_MESSAGES = M.Broker.messages


def grounded_messages(self, current: str):
    messages = _ORIGINAL_MESSAGES(self, current)
    if messages and messages[0].get("role") == "system":
        messages[0] = {
            **messages[0],
            "content": f"{EPISTEMIC_PREFIX}\n\n{compact_capability_proof()}",
        }
    return messages


M.Broker.messages = grounded_messages


if __name__ == "__main__":
    M.main()
