from __future__ import annotations

import pathlib
import random
import time
from typing import Any

from .collect import Teacher, _messages
from .core import (
    SCHEMA_CONFIG,
    directory_identity,
    estimated_tokens,
    normalize_answer,
    read_json,
    read_jsonl,
    sha256_file,
    sha256_text,
    stable_json,
    write_json,
    write_jsonl,
)

SCHEMA_ON_POLICY = "archie-on-policy-repair-collection/v1"

_REPAIR_SYSTEM = (
    "You are supervising a smaller model on the smaller model's own generated trajectory. "
    "Return only the best corrected final answer. Do not expose analysis, hidden reasoning, "
    "scratch work, labels, scores, or a rationale. Preserve a correct student answer exactly; "
    "otherwise replace it with the shortest correct answer."
)


def deterministic_priority(prompt_id: str, *, seed: int, round_index: int, prior_failure_rate: float) -> tuple[float, str]:
    """Rank harder prompts first without making ordering depend on process timing."""
    jitter = int(sha256_text(f"{seed}:{round_index}:{prompt_id}")[:16], 16) / float(0xFFFFFFFFFFFFFFFF)
    hardness = max(0.0, min(1.0, float(prior_failure_rate)))
    return (-(0.9 * hardness + 0.1 * jitter), prompt_id)


def build_repair_messages(messages: list[dict[str, str]], student_answer: str) -> list[dict[str, str]]:
    transcript = stable_json(messages)
    return [
        {"role": "system", "content": _REPAIR_SYSTEM},
        {
            "role": "user",
            "content": (
                "Original conversation:\n"
                f"{transcript}\n\n"
                "Student-generated final answer:\n"
                f"{student_answer}\n\n"
                "Return only the corrected final answer."
            ),
        },
    ]


def make_repair_row(
    *,
    prompt_id: str,
    messages: list[dict[str, str]],
    task_type: str,
    student_answer: str,
    teacher_answer: str,
    teacher_id: str,
    round_index: int,
    rollout_seed: int,
    generation: dict[str, Any],
    teacher_usage: dict[str, Any],
) -> dict[str, Any] | None:
    student_answer = student_answer.strip()
    teacher_answer = teacher_answer.strip()
    if not student_answer or not teacher_answer:
        return None
    if normalize_answer(student_answer) == normalize_answer(teacher_answer):
        return None
    evidence = {
        "prompt_id": prompt_id,
        "messages_sha256": sha256_text(stable_json(messages)),
        "student_answer_sha256": sha256_text(student_answer),
        "teacher_answer_sha256": sha256_text(teacher_answer),
        "teacher_id": teacher_id,
        "round_index": round_index,
        "rollout_seed": rollout_seed,
        "generation": generation,
        "teacher_usage": teacher_usage,
    }
    evidence_digest = sha256_text(stable_json(evidence))
    return {
        "id": f"on_policy_{evidence_digest[:32]}",
        "group_id": f"on-policy:{prompt_id}",
        "messages": messages,
        "task_type": task_type,
        "failed_answer": student_answer,
        "repaired_answer": teacher_answer,
        "verified": True,
        "verification": {
            "status": "passed",
            "method": "black-box-teacher-correction-on-student-trajectory/v1",
            "teacher_id": teacher_id,
            "evidence_digest": evidence_digest,
        },
        "parent_trajectory_digest": sha256_text(stable_json({
            "messages": messages,
            "student_answer": student_answer,
            "rollout_seed": rollout_seed,
        })),
        "repair_trajectory_digest": sha256_text(stable_json({
            "messages": messages,
            "teacher_answer": teacher_answer,
            "teacher_id": teacher_id,
        })),
        "positive_evidence": [evidence_digest],
        "negative_evidence": [sha256_text(student_answer)],
        "provenance": evidence,
    }


def _prompt_text(tokenizer: Any, messages: list[dict[str, str]]) -> str:
    if hasattr(tokenizer, "apply_chat_template") and tokenizer.chat_template:
        return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    return "\n".join(f"<{item['role']}>\n{item['content']}" for item in messages) + "\n<assistant>\n"


def configure_parser(parser: Any) -> None:
    parser.add_argument("--config", required=True)
    parser.add_argument("--prompts", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--adapter")
    parser.add_argument("--history")
    parser.add_argument("--round", type=int, default=0)
    parser.add_argument("--output", required=True)


def run_from_args(args: Any) -> dict[str, Any]:
    config_path = pathlib.Path(args.config).resolve()
    prompts_path = pathlib.Path(args.prompts).resolve()
    model_dir = pathlib.Path(args.model).resolve()
    adapter_dir = pathlib.Path(args.adapter).resolve() if args.adapter else None
    history_path = pathlib.Path(args.history).resolve() if args.history else None
    output = pathlib.Path(args.output).resolve()
    round_index = int(args.round)
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output}")
    if not model_dir.is_dir():
        raise SystemExit(f"Local student checkpoint is missing: {model_dir}")
    if adapter_dir is not None and not adapter_dir.is_dir():
        raise SystemExit(f"Student adapter is missing: {adapter_dir}")

    config = read_json(config_path)
    if config.get("schema") != SCHEMA_CONFIG:
        raise SystemExit("Unsupported config schema")
    cfg = config.get("on_policy") or {}
    seed = int(config.get("seed", 0))
    teachers = sorted(
        [Teacher.from_config(item) for item in config.get("teachers") or []],
        key=lambda teacher: (teacher.priority, teacher.identifier),
    )
    if not teachers:
        raise SystemExit("At least one teacher is required for on-policy correction")
    teacher = teachers[0]

    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    except Exception as exc:
        raise SystemExit("Install requirements-train.txt before on-policy rollout collection") from exc
    if not torch.cuda.is_available():
        raise SystemExit("CUDA is required; CPU fallback is intentionally disabled")

    random.seed(seed + round_index)
    torch.manual_seed(seed + round_index)
    torch.cuda.manual_seed_all(seed + round_index)
    tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    quantization = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.float16,
    )
    model = AutoModelForCausalLM.from_pretrained(
        model_dir,
        quantization_config=quantization,
        device_map={"": torch.cuda.current_device()},
        local_files_only=True,
        trust_remote_code=False,
    )
    if adapter_dir is not None:
        try:
            from peft import PeftModel
        except Exception as exc:
            raise SystemExit("PEFT is required when --adapter is supplied") from exc
        model = PeftModel.from_pretrained(model, adapter_dir, is_trainable=False)
    model.eval()

    prompts = read_jsonl(prompts_path)
    prior: dict[str, list[bool]] = {}
    if history_path is not None:
        for row in read_jsonl(history_path):
            prompt_id = str(row.get("prompt_id") or "")
            if prompt_id:
                prior.setdefault(prompt_id, []).append(bool(row.get("teacher_changed_answer")))
    def failure_rate(prompt_id: str) -> float:
        values = prior.get(prompt_id) or []
        return sum(values) / len(values) if values else 0.5

    prompts = sorted(
        prompts,
        key=lambda row: deterministic_priority(
            str(row.get("id") or sha256_text(stable_json(row))[:16]),
            seed=seed,
            round_index=round_index,
            prior_failure_rate=failure_rate(str(row.get("id") or "")),
        ),
    )
    max_prompts = int(cfg.get("max_prompts_per_round", 0))
    if max_prompts > 0:
        prompts = prompts[:max_prompts]
    max_new_tokens = int(cfg.get("max_new_tokens", 256))
    temperature = float(cfg.get("student_temperature", 0.7))
    top_p = float(cfg.get("student_top_p", 0.95))
    teacher_temperature = float(cfg.get("teacher_temperature", 0.0))
    teacher_max_tokens = int(cfg.get("teacher_max_output_tokens", max_new_tokens))

    repairs: list[dict[str, Any]] = []
    trajectories: list[dict[str, Any]] = []
    total_teacher_tokens = 0
    started = time.monotonic()
    for index, row in enumerate(prompts):
        prompt_id = str(row.get("id") or f"prompt-{index:08d}")
        messages = _messages(row)
        rollout_seed = seed + round_index * 1_000_003 + index
        generator = torch.Generator(device=model.device).manual_seed(rollout_seed)
        encoded = tokenizer(_prompt_text(tokenizer, messages), return_tensors="pt").to(model.device)
        with torch.inference_mode():
            generated = model.generate(
                **encoded,
                max_new_tokens=max_new_tokens,
                do_sample=temperature > 0,
                temperature=max(temperature, 1e-5),
                top_p=top_p,
                pad_token_id=tokenizer.pad_token_id,
                eos_token_id=tokenizer.eos_token_id,
                generator=generator,
            )
        continuation = generated[0, encoded["input_ids"].shape[1]:]
        student_answer = tokenizer.decode(continuation, skip_special_tokens=True).strip()
        supervision = teacher.complete(
            build_repair_messages(messages, student_answer),
            max_output_tokens=teacher_max_tokens,
            temperature=teacher_temperature,
            seed=rollout_seed,
        )
        teacher_answer = str(supervision["answer"]).strip()
        usage = dict(supervision.get("usage") or {})
        total_teacher_tokens += int(usage.get("total_tokens", 0))
        generation = {
            "max_new_tokens": max_new_tokens,
            "temperature": temperature,
            "top_p": top_p,
            "generated_tokens": int(continuation.shape[0]),
        }
        repair = make_repair_row(
            prompt_id=prompt_id,
            messages=messages,
            task_type=str(row.get("task_type") or "text"),
            student_answer=student_answer,
            teacher_answer=teacher_answer,
            teacher_id=teacher.identifier,
            round_index=round_index,
            rollout_seed=rollout_seed,
            generation=generation,
            teacher_usage=usage,
        )
        changed = repair is not None
        if repair is not None:
            repairs.append(repair)
        trajectories.append({
            "prompt_id": prompt_id,
            "round_index": round_index,
            "rollout_seed": rollout_seed,
            "student_answer_sha256": sha256_text(student_answer),
            "teacher_answer_sha256": sha256_text(teacher_answer),
            "teacher_changed_answer": changed,
            "student_output_tokens": estimated_tokens(student_answer),
            "teacher_usage": usage,
        })

    output.mkdir(parents=True)
    repairs_path = output / "on-policy-repairs.jsonl"
    trajectories_path = output / "on-policy-trajectories.jsonl"
    write_jsonl(repairs_path, repairs)
    write_jsonl(trajectories_path, trajectories)
    receipt: dict[str, Any] = {
        "schema": SCHEMA_ON_POLICY,
        "method": "student-rollout-black-box-teacher-repair-causal-divergence/v1",
        "round_index": round_index,
        "config": {"path": str(config_path), "sha256": sha256_file(config_path)},
        "prompts": {"path": str(prompts_path), "sha256": sha256_file(prompts_path), "rows": len(prompts)},
        "student_checkpoint": {"path": str(model_dir), **directory_identity(model_dir)},
        "student_adapter": ({"path": str(adapter_dir), **directory_identity(adapter_dir)} if adapter_dir else None),
        "teacher": {"id": teacher.identifier, "model": teacher.model, "priority": teacher.priority},
        "counts": {"trajectories": len(trajectories), "teacher_repairs": len(repairs), "accepted_unchanged": len(trajectories) - len(repairs)},
        "teacher_tokens": total_teacher_tokens,
        "outputs": {
            "repairs_sha256": sha256_file(repairs_path),
            "trajectories_sha256": sha256_file(trajectories_path),
        },
        "runtime_seconds": round(time.monotonic() - started, 3),
        "next_stage": "Compile on-policy-repairs.jsonl with `archie-distill pairs --repairs`, then train with `preference-train`; repeat using the new adapter.",
        "claim_boundary": "This receipt proves student-distribution rollout and sanitized teacher correction collection, not model improvement or admission.",
        "promotion": "not-admitted",
    }
    receipt["receipt_digest"] = sha256_text(stable_json(receipt))
    write_json(output / "on-policy-receipt.json", receipt)
    return receipt
