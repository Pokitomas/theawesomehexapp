#!/usr/bin/env python3
"""Explicit QLoRA/SFT entrypoint. It never promotes the resulting adapter."""
import argparse, hashlib, json, pathlib, time

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--train-jsonl", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    profile = json.loads(pathlib.Path(args.profile).read_text(encoding="utf-8"))
    train_file = pathlib.Path(args.train_jsonl).resolve()
    rows = [json.loads(line) for line in train_file.read_text(encoding="utf-8").splitlines() if line.strip()]
    positives = [row for row in rows if not row.get("negative") and row.get("target")]
    if not positives:
        raise SystemExit("No reviewed positive examples were supplied.")
    try:
        import torch
        from datasets import Dataset
        from peft import LoraConfig
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, TrainingArguments
        from trl import SFTTrainer
    except Exception as exc:
        raise SystemExit("Pinned training dependencies are not installed in this environment.") from exc
    model_dir = pathlib.Path(args.workspace) / "models" / "student"
    output = pathlib.Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True)
    quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_compute_dtype=torch.bfloat16)
    model = AutoModelForCausalLM.from_pretrained(model_dir, quantization_config=quant, device_map="auto", local_files_only=True)
    texts = [{"text": json.dumps({"instruction": row["instruction"], "context": row.get("compact_context")}) + "\n" + row["target"]} for row in positives]
    dataset = Dataset.from_list(texts)
    cfg = profile["training"]
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        peft_config=LoraConfig(r=cfg["lora_rank"], lora_alpha=cfg["lora_alpha"], task_type="CAUSAL_LM"),
        args=TrainingArguments(output_dir=str(output / "checkpoints"), num_train_epochs=cfg["epochs"], learning_rate=cfg["learning_rate"], seed=cfg["seed"], report_to=[]),
        dataset_text_field="text"
    )
    result = trainer.train()
    trainer.model.save_pretrained(output / "adapter")
    tokenizer.save_pretrained(output / "adapter")
    receipt = {
        "schema": "archie-distill-training-receipt/v1",
        "profile_id": profile["id"],
        "train_rows": len(positives),
        "train_sha256": sha256(train_file),
        "metrics": result.metrics,
        "promotion": "not-admitted",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    }
    (output / "training-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2))

if __name__ == "__main__":
    main()
