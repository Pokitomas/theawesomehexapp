from __future__ import annotations

import os
import pathlib
import time
from typing import Any

from .core import (
    SCHEMA_CONFIG,
    SCHEMA_EVALUATION,
    estimated_tokens,
    manifest,
    read_json,
    read_jsonl,
    score_answer,
    sha256_file,
    sha256_text,
    stable_json,
    write_json,
)


def _directory_identity(root: pathlib.Path) -> dict[str, Any]:
    files = manifest(root)
    return {
        "digest": sha256_text(stable_json(files)),
        "file_count": len(files),
        "bytes": sum(int(item["bytes"]) for item in files),
    }


def _messages(row: dict[str, Any]) -> list[dict[str, str]]:
    supplied = row.get("messages")
    if isinstance(supplied, list) and supplied:
        return [
            {"role": str(item.get("role") or "user"), "content": str(item.get("content") or "")}
            for item in supplied
            if isinstance(item, dict)
        ]
    prompt = str(row.get("prompt") or row.get("instruction") or "").strip()
    if not prompt:
        raise ValueError(f"Holdout row {row.get('id', '<unknown>')} has no prompt")
    return [{"role": "user", "content": prompt}]


def _references(row: dict[str, Any]) -> list[str]:
    values = row.get("references")
    if isinstance(values, list):
        references = [str(item) for item in values if str(item).strip()]
    else:
        reference = str(row.get("reference") or "").strip()
        references = [reference] if reference else []
    if not references:
        raise ValueError(f"Holdout row {row.get('id', '<unknown>')} has no reference")
    return references


def configure_parser(parser: Any) -> None:
    parser.add_argument("--config", required=True)
    parser.add_argument("--holdout", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--adapter", required=True)
    parser.add_argument("--output", required=True)


def run_from_args(args: Any) -> dict[str, Any]:
    config_path = pathlib.Path(args.config).resolve()
    holdout_path = pathlib.Path(args.holdout).resolve()
    model_dir = pathlib.Path(args.model).resolve()
    adapter_dir = pathlib.Path(args.adapter).resolve()
    output_path = pathlib.Path(args.output).resolve()
    if output_path.exists():
        raise SystemExit(f"Refusing to overwrite existing output: {output_path}")
    if not model_dir.is_dir() or not adapter_dir.is_dir():
        raise SystemExit("Model and adapter must both exist locally")

    config = read_json(config_path)
    if config.get("schema") != SCHEMA_CONFIG:
        raise SystemExit("Unsupported config schema")
    evaluation_cfg = config.get("evaluation") or {}
    max_new_tokens = int(evaluation_cfg.get("max_new_tokens", 256))
    seed = int(config.get("seed", 0))

    os.environ["PYTHONHASHSEED"] = str(seed)
    os.environ["CUBLAS_WORKSPACE_CONFIG"] = ":4096:8"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"

    try:
        import torch
        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    except Exception as exc:
        raise SystemExit("Install requirements-train.txt before evaluation") from exc

    if not torch.cuda.is_available():
        raise SystemExit("CUDA is required; CPU fallback is intentionally disabled")
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.use_deterministic_algorithms(True)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True

    tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    quantization = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.float16,
    )
    base_model = AutoModelForCausalLM.from_pretrained(
        model_dir,
        quantization_config=quantization,
        device_map={"": torch.cuda.current_device()},
        local_files_only=True,
        trust_remote_code=False,
    )
    model = PeftModel.from_pretrained(base_model, adapter_dir, is_trainable=False)
    model.eval()

    rows = read_jsonl(holdout_path)
    if not rows:
        raise SystemExit("Holdout is empty")

    item_receipts: list[dict[str, Any]] = []
    exact_sum = 0.0
    f1_sum = 0.0
    combined_sum = 0.0
    generated_tokens = 0
    started = time.monotonic()

    for index, row in enumerate(rows):
        row_id = str(row.get("id") or f"row-{index:08d}")
        messages = _messages(row)
        references = _references(row)
        if hasattr(tokenizer, "apply_chat_template") and tokenizer.chat_template:
            prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        else:
            prompt = "\n".join(f"<{item['role']}>\n{item['content']}" for item in messages) + "\n<assistant>\n"
        inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
        prompt_length = int(inputs["input_ids"].shape[-1])
        with torch.inference_mode():
            output = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                num_beams=1,
                use_cache=True,
                pad_token_id=tokenizer.pad_token_id,
                eos_token_id=tokenizer.eos_token_id,
            )
        new_tokens = output[0, prompt_length:]
        prediction = tokenizer.decode(new_tokens, skip_special_tokens=True).strip()
        token_count = int(new_tokens.shape[-1])
        generated_tokens += token_count
        score = score_answer(prediction, references)
        exact_sum += score["exact"]
        f1_sum += score["token_f1"]
        combined_sum += score["combined"]
        item_receipts.append(
            {
                "id": row_id,
                "prompt_sha256": sha256_text(stable_json(messages)),
                "reference_sha256": [sha256_text(item) for item in references],
                "prediction_sha256": sha256_text(prediction),
                "prediction_tokens": token_count or estimated_tokens(prediction),
                "metrics": score,
            }
        )

    count = len(rows)
    metrics = {
        "exact": exact_sum / count,
        "token_f1": f1_sum / count,
        "combined": combined_sum / count,
    }
    receipt: dict[str, Any] = {
        "schema": SCHEMA_EVALUATION,
        "config": {"path": str(config_path), "sha256": sha256_file(config_path)},
        "holdout": {"path": str(holdout_path), "sha256": sha256_file(holdout_path), "rows": count},
        "student_checkpoint": {"path": str(model_dir), **_directory_identity(model_dir)},
        "adapter": {"path": str(adapter_dir), **_directory_identity(adapter_dir)},
        "decoding": {
            "max_new_tokens": max_new_tokens,
            "do_sample": False,
            "num_beams": 1,
            "seed": seed,
        },
        "metrics": metrics,
        "generated_tokens": generated_tokens,
        "runtime_seconds": round(time.monotonic() - started, 3),
        "items": item_receipts,
        "promotion": "not-admitted",
    }
    receipt["receipt_digest"] = sha256_text(stable_json(receipt))
    write_json(output_path, receipt)
    return receipt
