#!/usr/bin/env python3
"""Minimal adapter contract. Replace its observation logic with any provider CLI or API."""
import json
import sys

envelope = json.load(sys.stdin)
print(json.dumps({
    "handoff_digest": envelope["state_digest"],
    "observations": [f"Consumed {envelope['command']} barrier {envelope['barrier_id']}"],
    "proposed_next_capsule": None,
}))
