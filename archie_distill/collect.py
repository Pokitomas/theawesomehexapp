from __future__ import annotations

import concurrent.futures
import json
import os
import pathlib
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from .core import (
    SCHEMA_COLLECTION,
    SCHEMA_CONFIG,
    choose_consensus,
    estimated_tokens,
    extract_final,
    read_json,
    read_jsonl,
    sha256_file,
    sha256_text,
    should_verify,
    stable_json,
    write_json,
    write_jsonl,
)

_FINAL_ONLY_SYSTEM = (
    "Return only the final answer needed to train a smaller model. "
    "Do not provide analysis, hidden reasoning, scratch work, or a rationale. "
    "Be correct, compact, and directly usable."
)


@dataclass(frozen=True)
class Teacher:
    identifier: str
    base_url: str
    model: str
    priority: int
    api_key_env: str | None
    timeout_seconds: float
    extra_body: dict[str, Any]

    @classmethod
    def from_config(cls, value: dict[str, Any]) -> "Teacher":
        identifier = str(value.get("id") or "").strip()
        base_url = str(value.get("base_url") or "").strip().rstrip("/")
        model = str(value.get("model") or "").strip()
        if not identifier or not base_url or not model:
            raise ValueError("Every teacher requires id, base_url, and model")
        extra_body = value.get("extra_body") or {}
        if not isinstance(extra_body, dict):
            raise ValueError(f"teacher {identifier} extra_body must be an object")
        return cls(
            identifier=identifier,
            base_url=base_url,
            model=model,
            priority=int(value.get("priority", 0)),
            api_key_env=str(value["api_key_env"]) if value.get("api_key_env") else None,
            timeout_seconds=float(value.get("timeout_seconds", 120)),
            extra_body=extra_body,
        )

    def complete(
        self,
        messages: list[dict[str, str]],
        *,
        max_output_tokens: int,
        temperature: float,
        seed: int,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": [{"role": "system", "content": _FINAL_ONLY_SYSTEM}, *messages],
            "max_tokens": max_output_tokens,
            "temperature": temperature,
            "seed": seed,
            **self.extra_body,
        }
        headers = {"Content-Type": "application/json"}
        if self.api_key_env:
            token = os.environ.get(self.api_key_env)
            if not token:
                raise RuntimeError(f"Missing environment variable {self.api_key_env}")
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=stable_json(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        started = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:1000]
            raise RuntimeError(f"teacher {self.identifier} returned HTTP {exc.code}: {detail}") from exc
        choices = body.get("choices") if isinstance(body, dict) else None
        if not isinstance(choices, list) or not choices:
            raise RuntimeError(f"teacher {self.identifier} returned no choices")
        message = choices[0].get("message") or {}
        raw = message.get("content")
        if not isinstance(raw, str):
            raise RuntimeError(f"teacher {self.identifier} returned no text content")
        answer, confidence = extract_final(raw)
        usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}
        prompt_tokens = int(usage.get("prompt_tokens", 0) or 0) or estimated_tokens(stable_json(messages))
        completion_tokens = int(usage.get("completion_tokens", 0) or 0) or estimated_tokens(answer)
        total_tokens = int(usage.get("total_tokens", 0) or 0) or prompt_tokens + completion_tokens
        return {
            "teacher_id": self.identifier,
            "priority": self.priority,
            "answer": answer,
            "confidence": confidence,
            "latency_ms": round((time.monotonic() - started) * 1000, 3),
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": total_tokens,
            },
        }


def _messages(row: dict[str, Any]) -> list[dict[str, str]]:
    supplied = row.get("messages")
    if isinstance(supplied, list) and supplied:
        messages: list[dict[str, str]] = []
        for item in supplied:
            if not isinstance(item, dict):
                raise ValueError("messages entries must be objects")
            role = str(item.get("role") or "user")
            content = str(item.get("content") or "").strip()
            if content:
                messages.append({"role": role, "content": content})
        if messages:
            return messages
    prompt = str(row.get("prompt") or row.get("instruction") or "").strip()
    if not prompt:
        raise ValueError("Every prompt row requires prompt, instruction, or messages")
    context = row.get("context")
    if context not in (None, {}, [], ""):
        prompt = f"{prompt}\n\nContext:\n{stable_json(context)}"
    return [{"role": "user", "content": prompt}]


def _query_many(
    teachers: list[Teacher],
    messages: list[dict[str, str]],
    *,
    max_output_tokens: int,
    temperature: float,
    seed: int,
    parallelism: int,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    answers: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    workers = max(1, min(parallelism, len(teachers)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(
                teacher.complete,
                messages,
                max_output_tokens=max_output_tokens,
                temperature=temperature,
                seed=seed,
            ): teacher
            for teacher in teachers
        }
        for future in concurrent.futures.as_completed(futures):
            teacher = futures[future]
            try:
                answers.append(future.result())
            except Exception as exc:
                failures.append({"teacher_id": teacher.identifier, "error": str(exc)})
    answers.sort(key=lambda item: (int(item["priority"]), str(item["teacher_id"])))
    failures.sort(key=lambda item: item["teacher_id"])
    return answers, failures


def configure_parser(parser: Any) -> None:
    parser.add_argument("--config", required=True)
    parser.add_argument("--prompts", required=True)
    parser.add_argument("--output", required=True)


def run_from_args(args: Any) -> dict[str, Any]:
    config_path = pathlib.Path(args.config).resolve()
    prompts_path = pathlib.Path(args.prompts).resolve()
    output = pathlib.Path(args.output).resolve()
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output}")

    config = read_json(config_path)
    if config.get("schema") != SCHEMA_CONFIG:
        raise SystemExit("Unsupported config schema")
    collection = config.get("collection") or {}
    teachers = sorted(
        [Teacher.from_config(item) for item in config.get("teachers") or []],
        key=lambda teacher: (teacher.priority, teacher.identifier),
    )
    if not teachers:
        raise SystemExit("At least one teacher is required")

    max_output_tokens = int(collection.get("max_output_tokens", 256))
    min_teachers = max(1, int(collection.get("min_teachers", 1)))
    max_teachers = max(min_teachers, min(len(teachers), int(collection.get("max_teachers", len(teachers)))))
    verify_rate = float(collection.get("verify_rate", 0.0))
    confidence_floor = float(collection.get("confidence_floor", 0.0))
    temperature = float(collection.get("temperature", 0.0))
    parallelism = int(collection.get("parallelism", max_teachers))
    max_total_tokens = int(collection.get("max_total_teacher_tokens", 0))
    seed = int(config.get("seed", 0))

    prompts = read_jsonl(prompts_path)
    dataset: list[dict[str, Any]] = []
    item_receipts: list[dict[str, Any]] = []
    total_teacher_tokens = 0

    for index, row in enumerate(prompts):
        prompt_id = str(row.get("id") or f"row-{index:08d}")
        messages = _messages(row)
        required = min_teachers
        if bool(row.get("verify")) or should_verify(prompt_id, seed=seed, verify_rate=verify_rate):
            required = min(max_teachers, max(required, 2))

        candidates, failures = _query_many(
            teachers[:required],
            messages,
            max_output_tokens=max_output_tokens,
            temperature=temperature,
            seed=seed + index,
            parallelism=parallelism,
        )
        spent = sum(int(item["usage"]["total_tokens"]) for item in candidates)
        total_teacher_tokens += spent

        while len(candidates) < max_teachers:
            expand = not candidates
            if candidates:
                winner, consensus = choose_consensus(candidates, max_output_tokens=max_output_tokens)
                confidence = winner.get("confidence")
                expand = (
                    consensus["distinct_answers"] > 1
                    or (confidence is not None and float(confidence) < confidence_floor)
                )
            if not expand:
                break
            next_teacher = teachers[len(candidates) + len(failures) : len(candidates) + len(failures) + 1]
            if not next_teacher:
                break
            extra, extra_failures = _query_many(
                next_teacher,
                messages,
                max_output_tokens=max_output_tokens,
                temperature=temperature,
                seed=seed + index,
                parallelism=1,
            )
            candidates.extend(extra)
            failures.extend(extra_failures)
            newly_spent = sum(int(item["usage"]["total_tokens"]) for item in extra)
            spent += newly_spent
            total_teacher_tokens += newly_spent

        if max_total_tokens > 0 and total_teacher_tokens > max_total_tokens:
            raise SystemExit(
                f"Teacher token budget exceeded after {prompt_id}: "
                f"{total_teacher_tokens} > {max_total_tokens}"
            )
        winner, consensus = choose_consensus(candidates, max_output_tokens=max_output_tokens)
        answer = str(winner["answer"])
        sample = {
            "id": prompt_id,
            "messages": messages,
            "answer": answer,
            "answer_sha256": sha256_text(answer),
            "split": str(row.get("split") or "train"),
            "teacher_count": len(candidates),
            "teacher_ids": [item["teacher_id"] for item in candidates],
            "agreement": consensus["agreement"],
            "source": "authorized-teacher-final-answer",
        }
        dataset.append(sample)
        item_receipts.append(
            {
                "id": prompt_id,
                "prompt_sha256": sha256_text(stable_json(messages)),
                "winner_teacher_id": winner["teacher_id"],
                "winner_answer_sha256": sample["answer_sha256"],
                "candidate_answer_sha256": [sha256_text(str(item["answer"])) for item in candidates],
                "consensus": consensus,
                "failures": failures,
                "teacher_tokens": spent,
            }
        )

    output.mkdir(parents=True)
    dataset_path = output / "dataset.jsonl"
    write_jsonl(dataset_path, dataset)
    receipt: dict[str, Any] = {
        "schema": SCHEMA_COLLECTION,
        "config": {"path": str(config_path), "sha256": sha256_file(config_path)},
        "prompts": {"path": str(prompts_path), "sha256": sha256_file(prompts_path), "rows": len(prompts)},
        "dataset": {"path": str(dataset_path), "sha256": sha256_file(dataset_path), "rows": len(dataset)},
        "teacher_tokens": total_teacher_tokens,
        "items": item_receipts,
        "raw_teacher_responses_persisted": False,
        "reasoning_fields_persisted": False,
    }
    receipt["receipt_digest"] = sha256_text(stable_json(receipt))
    write_json(output / "collection-receipt.json", receipt)
    return receipt
