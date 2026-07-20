"""HTTP, caching, and Kimi request construction for Archie distillation."""
from __future__ import annotations

import hashlib
import json
import time
import urllib.request
from pathlib import Path
from typing import Any

from kimi_distill_common import digest, endpoint, response_format


class Cache:
    def __init__(self, path: str | None):
        self.path = Path(path) if path else None
        self.data: dict[str, dict[str, Any]] = {}
        self.hits = 0
        self.misses = 0
        self.loaded_entries = 0
        if self.path and self.path.exists():
            for line_number, line in enumerate(self.path.read_text().splitlines(), start=1):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as exception:
                    raise ValueError(f"invalid cache JSON at line {line_number}: {exception}") from exception
                if (
                    not isinstance(row, dict)
                    or set(row) != {"key", "value"}
                    or not isinstance(row.get("key"), str)
                    or len(row["key"]) != 64
                    or any(character not in "0123456789abcdef" for character in row["key"])
                    or not isinstance(row.get("value"), dict)
                ):
                    raise ValueError(f"invalid cache record at line {line_number}")
                key = row["key"]
                if key in self.data and self.data[key] != row["value"]:
                    raise ValueError(f"conflicting cache values for key {key} at line {line_number}")
                self.data[key] = row["value"]
                self.loaded_entries += 1

    def call(self, key: str, function):
        if key in self.data:
            self.hits += 1
            return self.data[key]
        self.misses += 1
        value = function()
        if not isinstance(value, dict):
            raise ValueError("cacheable teacher value must be a JSON object")
        self.data[key] = value
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as file:
                file.write(json.dumps({"key": key, "value": value}, ensure_ascii=False, sort_keys=True) + "\n")
        return value

    def snapshot(self) -> dict[str, Any]:
        sha256 = None
        if self.path and self.path.exists():
            sha256 = hashlib.sha256(self.path.read_bytes()).hexdigest()
        return {
            "enabled": self.path is not None,
            "loaded_entries": self.loaded_entries,
            "entries": len(self.data),
            "sha256": sha256,
        }


class ApiStats:
    def __init__(self):
        self.logical_generation = 0
        self.logical_verification = 0
        self.http_attempts = 0
        self.http_responses = 0
        self.http_successes = 0
        self.usage_responses = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.total_tokens = 0

    def record_usage(self, usage: Any) -> None:
        if not isinstance(usage, dict):
            return
        values = {}
        for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
            value = usage.get(key)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                return
            values[key] = value
        self.usage_responses += 1
        self.prompt_tokens += values["prompt_tokens"]
        self.completion_tokens += values["completion_tokens"]
        self.total_tokens += values["total_tokens"]


def request_body(args, messages, temperature, max_completion_tokens, schema_name, schema):
    body = {
        "model": args.model,
        "messages": messages,
        "response_format": response_format(args.structured_output, schema_name, schema),
        "max_completion_tokens": max_completion_tokens,
    }
    model = args.model.lower()
    is_k3 = (
        "kimi-k3" in model
        or "kimi_k3" in model
        or model in {"k3", "kimi/k3"}
        or model.endswith("/k3")
    )
    if is_k3:
        body["reasoning_effort"] = args.reasoning_effort or ("max" if args.thinking else "low")
    else:
        body["temperature"] = temperature
        if "kimi" in model:
            body["thinking"] = {"type": "enabled" if args.thinking else "disabled"}
    return body


def teacher(args, cache, stats, messages, temperature, max_completion_tokens, schema_name, schema):
    body = request_body(args, messages, temperature, max_completion_tokens, schema_name, schema)
    key = digest({"endpoint": endpoint(args.endpoint), **body})

    def request():
        req = urllib.request.Request(
            endpoint(args.endpoint),
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {args.api_key}"},
        )
        error = None
        for attempt in range(args.retries + 1):
            stats.http_attempts += 1
            try:
                with urllib.request.urlopen(req, timeout=args.timeout) as response:
                    payload = json.load(response)
                stats.http_responses += 1
                if not isinstance(payload, dict):
                    raise ValueError("teacher response is not a JSON object")
                stats.record_usage(payload.get("usage"))
                choices = payload.get("choices")
                if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
                    raise ValueError("teacher response must contain exactly one choice")
                message = choices[0].get("message")
                if not isinstance(message, dict):
                    raise ValueError("teacher choice.message is not an object")
                content = message.get("content")
                if not isinstance(content, str):
                    raise ValueError("teacher message.content is not a string")
                parsed = json.loads(content)
                if not isinstance(parsed, dict):
                    raise ValueError("teacher final content is not a JSON object")
                stats.http_successes += 1
                return parsed
            except Exception as exception:
                error = exception
                if attempt < args.retries:
                    time.sleep(min(16, 0.75 * (2**attempt)))
        raise RuntimeError(f"teacher failed: {error}")

    return cache.call(key, request)
