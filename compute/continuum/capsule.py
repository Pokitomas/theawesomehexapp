from __future__ import annotations

import dataclasses
import datetime as dt
import hashlib
import hmac
from typing import Any, Mapping, Sequence

from .common import ID_RE, PROMOTION, PROTOCOL, SHA_RE, ContinuumError, canonical_json, parse_time, sha256_bytes


@dataclasses.dataclass(frozen=True)
class Capsule:
    raw: dict[str, Any]

    @property
    def job_id(self) -> str: return self.raw["job_id"]
    @property
    def source_sha(self) -> str: return self.raw["source"]["sha"]
    @property
    def repo(self) -> str: return self.raw["source"]["repo"]
    @property
    def task_name(self) -> str: return self.raw["task"]["name"]
    @property
    def task_args(self) -> dict[str, Any]: return dict(self.raw["task"].get("args", {}))
    @property
    def digest(self) -> str:
        unsigned = dict(self.raw); unsigned.pop("signature", None)
        return sha256_bytes(canonical_json(unsigned))


def validate_capsule_shape(raw: Any) -> None:
    if not isinstance(raw, dict): raise ContinuumError("capsule must be a JSON object")
    required = {"protocol","job_id","issued_at","expires_at","source","task","nodes","shards","promotion","signature"}
    missing = sorted(required - raw.keys())
    if missing: raise ContinuumError(f"capsule missing fields: {', '.join(missing)}")
    if raw["protocol"] != PROTOCOL: raise ContinuumError(f"unsupported capsule protocol: {raw['protocol']!r}")
    if not isinstance(raw["job_id"], str) or not ID_RE.fullmatch(raw["job_id"]):
        raise ContinuumError("invalid job_id")
    source = raw["source"]
    if not isinstance(source, dict) or not isinstance(source.get("repo"), str) or not SHA_RE.fullmatch(str(source.get("sha", ""))):
        raise ContinuumError("source must contain repo and exact lowercase SHA")
    task = raw["task"]
    if not isinstance(task, dict) or not isinstance(task.get("name"), str) or not isinstance(task.get("args", {}), dict):
        raise ContinuumError("task must contain name and object args")
    if not isinstance(raw["nodes"], list) or not raw["nodes"] or any(not isinstance(x,str) or not ID_RE.fullmatch(x) for x in raw["nodes"]):
        raise ContinuumError("nodes must be a non-empty list of bounded IDs")
    if not isinstance(raw["shards"], int) or isinstance(raw["shards"], bool) or not 1 <= raw["shards"] <= 4096:
        raise ContinuumError("shards must be between 1 and 4096")
    if raw["promotion"] != PROMOTION: raise ContinuumError(f"promotion must be {PROMOTION}")
    sig = raw["signature"]
    if not isinstance(sig, dict) or sig.get("algorithm") != "hmac-sha256" or not isinstance(sig.get("value"), str):
        raise ContinuumError("signature must use hmac-sha256")
    issued, expires = parse_time(raw["issued_at"]), parse_time(raw["expires_at"])
    now = dt.datetime.now(dt.timezone.utc)
    if issued > now + dt.timedelta(minutes=5): raise ContinuumError("capsule issued_at is in the future")
    if expires <= now: raise ContinuumError("capsule has expired")
    if expires - issued > dt.timedelta(days=7): raise ContinuumError("capsule lifetime may not exceed seven days")


def sign_capsule(raw: dict[str, Any], key: str, key_id: str = "continuum-v1") -> dict[str, Any]:
    unsigned = dict(raw); unsigned.pop("signature", None)
    validate_capsule_shape({**unsigned, "signature":{"algorithm":"hmac-sha256","value":"0"*64}})
    value = hmac.new(key.encode(), canonical_json(unsigned), hashlib.sha256).hexdigest()
    return {**unsigned, "signature":{"algorithm":"hmac-sha256","key_id":key_id,"value":value}}


def verify_capsule(raw: dict[str, Any], key: str, config: Mapping[str, Any]) -> Capsule:
    validate_capsule_shape(raw)
    unsigned = dict(raw); signature = unsigned.pop("signature")
    expected = hmac.new(key.encode(), canonical_json(unsigned), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature["value"]): raise ContinuumError("capsule signature mismatch")
    security = config.get("security", {})
    if raw["source"]["repo"] not in security.get("allowed_repos", []): raise ContinuumError("repository not allowlisted")
    if raw["task"]["name"] not in config.get("tasks", {}) or raw["task"]["name"] not in security.get("allowed_tasks", []):
        raise ContinuumError("task not locally allowlisted")
    if config.get("node_id") not in raw["nodes"]: raise ContinuumError("capsule does not designate this node")
    return Capsule(raw)


def assigned_shards(job_id: str, nodes: Sequence[str], count: int, node_id: str) -> list[int]:
    result = []
    for shard in range(count):
        winner = max((hashlib.sha256(f"{job_id}\0{shard}\0{node}".encode()).digest(), node) for node in nodes)[1]
        if winner == node_id: result.append(shard)
    return result


def validate_task_args(task: Mapping[str, Any], supplied: Mapping[str, Any]) -> dict[str, Any]:
    schema = task.get("allowed_args", {})
    unknown = sorted(set(supplied) - set(schema))
    if unknown: raise ContinuumError(f"unknown task args: {', '.join(unknown)}")
    result = dict(task.get("defaults", {})); result.update(supplied)
    for name, rule in schema.items():
        if name not in result: continue
        value = result[name]
        if isinstance(rule, list) and value not in rule: raise ContinuumError(f"{name} must be one of {rule}")
        if rule == "bool" and not isinstance(value, bool): raise ContinuumError(f"{name} must be boolean")
        if rule == "id" and (not isinstance(value, str) or not ID_RE.fullmatch(value)): raise ContinuumError(f"invalid {name}")
        if rule == "str" and (not isinstance(value, str) or len(value) > 4096): raise ContinuumError(f"invalid {name}")
        if rule == "path" and (not isinstance(value, str) or "\x00" in value): raise ContinuumError(f"invalid {name}")
        if rule == "int" and (not isinstance(value, int) or isinstance(value, bool)): raise ContinuumError(f"{name} must be integer")
        if isinstance(rule, dict) and rule.get("type") == "int":
            if not isinstance(value, int) or isinstance(value, bool): raise ContinuumError(f"{name} must be integer")
            if "min" in rule and value < int(rule["min"]): raise ContinuumError(f"{name} below minimum")
            if "max" in rule and value > int(rule["max"]): raise ContinuumError(f"{name} above maximum")
    ordered = task.get("strictly_increasing_args", [])
    values = [result.get(name) for name in ordered]
    if ordered and (any(v is None for v in values) or any(a >= b for a,b in zip(values, values[1:]))):
        raise ContinuumError(f"task args must be strictly increasing: {ordered}")
    return result
