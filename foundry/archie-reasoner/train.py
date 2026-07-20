#!/usr/bin/env python3
"""Train and evaluate the Archie generative reasoner directly from external audit data.

The trainer is intentionally provider-neutral and offline. It never downloads weights or data,
never writes into the admitted product model path, and always emits promotion:not-admitted.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import math
import os
import random
import shutil
import sys
import time
from functools import partial
from pathlib import Path
from typing import Any, Iterable, Sequence

from archie_reasoner import (
    AUTHORITY_LABELS,
    CONTEXT_LABELS,
    DEFAULT_TRANSFORMS,
    PRESETS,
    RESPONSE_ACTION,
    ROUTES,
    ModelConfig,
    ReasonerDataset,
    SentencePieceTokenizer,
    apply_fail_closed,
    build_model_class,
    collate_reasoner,
    config_dict,
    context_state_from_row,
    filter_frozen_rows,
    fit_temperature,
    frozen_prompt_set,
    parameter_count,
    prompt_from_row,
    read_records,
    require_training_dependencies,
    route_from_row,
    route_metrics,
    sha256_file,
    sha256_json,
    source_text,
    stratified_split,
    target_objects,
    train_sentencepiece,
    transform_from_row,
    write_receipt,
)


EVAL_FILENAMES = (
    "router-v2-original-heldout.jsonl",
    "router-real-v2-heldout.jsonl",
    "router-real-v3-final.jsonl",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, help="Training JSON/JSONL produced from the audit corpus")
    parser.add_argument("--evals", help="Directory containing the three frozen router JSONL suites")
    parser.add_argument("--suite", help="Optional reconstructed suite-80 JSON")
    parser.add_argument("--frozen", action="append", default=[], help="Additional frozen JSON/JSONL prompt pack")
    parser.add_argument("--output", required=True, help="Output directory for tokenizer/checkpoints/receipts")
    parser.add_argument("--preset", choices=sorted(PRESETS), default="full")
    parser.add_argument("--seed", type=int, help="Override preset seed")
    parser.add_argument("--epochs", type=int, help="Override preset epochs")
    parser.add_argument("--batch-size", type=int, help="Override preset batch size")
    parser.add_argument("--learning-rate", type=float, help="Override preset learning rate")
    parser.add_argument("--device", choices=("auto", "cpu", "cuda", "mps"), default="auto")
    parser.add_argument("--num-workers", type=int, default=0)
    parser.add_argument("--threads", type=int, default=max(1, min(4, os.cpu_count() or 1)), help="PyTorch CPU threads")
    parser.add_argument("--resume", action="store_true", help="Resume output/last.pt when present")
    parser.add_argument("--max-eval-examples", type=int, default=8, help="Free-running generation sample per final split; 0 generates every example")
    parser.add_argument("--run-name", default="")
    parser.add_argument(
        "--sweep",
        default="",
        help="Comma-separated presets. Runs each in output/<preset>-seed<seed>; use with --seeds.",
    )
    parser.add_argument("--seeds", default="", help="Comma-separated seeds for --sweep")
    return parser.parse_args()


def selected_device(torch: Any, requested: str):
    if requested != "auto":
        if requested == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("--device cuda requested but CUDA is unavailable")
        if requested == "mps" and not getattr(torch.backends, "mps", None):
            raise RuntimeError("--device mps requested but MPS is unavailable")
        return torch.device(requested)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def seed_everything(torch: Any, seed: int) -> None:
    os.environ.setdefault("PYTHONHASHSEED", str(seed))
    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    if hasattr(torch, "use_deterministic_algorithms"):
        torch.use_deterministic_algorithms(True, warn_only=True)
    if hasattr(torch.backends, "cudnn"):
        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True


def evaluation_paths(evals_dir: str | None, suite: str | None, extra: Sequence[str]) -> list[Path]:
    paths: list[Path] = []
    if evals_dir:
        base = Path(evals_dir)
        paths.extend(base / name for name in EVAL_FILENAMES if (base / name).exists())
    if suite and Path(suite).exists():
        paths.append(Path(suite))
    paths.extend(Path(item) for item in extra if Path(item).exists())
    return paths


def override_config(base: ModelConfig, args: argparse.Namespace, seed: int | None = None) -> ModelConfig:
    changes: dict[str, Any] = {}
    if seed is not None:
        changes["seed"] = seed
    elif args.seed is not None:
        changes["seed"] = args.seed
    if args.epochs is not None:
        changes["epochs"] = args.epochs
    if args.batch_size is not None:
        changes["batch_size"] = args.batch_size
    if args.learning_rate is not None:
        changes["learning_rate"] = args.learning_rate
    return dataclasses.replace(base, **changes)


def loader_for(
    torch: Any,
    rows: Sequence[dict[str, Any]],
    tokenizer: SentencePieceTokenizer,
    config: ModelConfig,
    transform_labels: Sequence[str],
    *,
    shuffle: bool,
    num_workers: int,
):
    dataset = ReasonerDataset(rows, tokenizer, config, transform_labels)
    generator = torch.Generator()
    generator.manual_seed(config.seed + (11 if shuffle else 29))
    return torch.utils.data.DataLoader(
        dataset,
        batch_size=config.batch_size,
        shuffle=shuffle,
        num_workers=num_workers,
        collate_fn=partial(collate_reasoner, pad_id=tokenizer.pad_id),
        generator=generator,
        drop_last=False,
        persistent_workers=num_workers > 0,
    )


def move_batch(batch: dict[str, Any], device: Any) -> dict[str, Any]:
    return {
        key: value.to(device, non_blocking=True) if hasattr(value, "to") else value
        for key, value in batch.items()
    }



def mean_dict(values: Sequence[dict[str, float]]) -> dict[str, float]:
    if not values:
        return {}
    return {
        key: sum(item[key] for item in values) / len(values)
        for key in values[0]
    }


def expected_for_row(row: dict[str, Any]) -> tuple[str, str, str, str]:
    graph, plan = target_objects(row)
    return (
        str(graph["route"]),
        str(graph["authority"]),
        str(graph["context"]),
        str(plan["response_action"]),
    )



def evaluate_teacher_forced(
    torch: Any,
    model: Any,
    loader: Any,
    tokenizer: SentencePieceTokenizer,
    device: Any,
    config: ModelConfig,
) -> dict[str, float]:
    model.eval()
    totals = {
        "total": 0.0,
        "generation": 0.0,
        "route": 0.0,
        "authority": 0.0,
        "context": 0.0,
        "transform": 0.0,
    }
    examples = 0
    with torch.inference_mode():
        for raw_batch in loader:
            batch = move_batch(raw_batch, device)
            target_input = batch["target_ids"][:, :-1].contiguous()
            labels = batch["target_ids"][:, 1:].contiguous()
            outputs = model(
                batch["source_ids"],
                target_input,
                batch["source_padding"],
                target_input.eq(tokenizer.pad_id),
            )
            generation = torch.nn.functional.cross_entropy(
                outputs["token_logits"].reshape(-1, outputs["token_logits"].size(-1)),
                labels.masked_fill(labels.eq(tokenizer.pad_id), -100).reshape(-1),
                ignore_index=-100,
                label_smoothing=config.label_smoothing,
            )
            route = torch.nn.functional.cross_entropy(outputs["route_logits"], batch["route"])
            authority = torch.nn.functional.cross_entropy(outputs["authority_logits"], batch["authority"])
            context = torch.nn.functional.cross_entropy(outputs["context_logits"], batch["context"])
            transform = torch.nn.functional.cross_entropy(outputs["transform_logits"], batch["transform"])
            total = (
                config.generation_loss_weight * generation
                + config.route_loss_weight * route
                + config.authority_loss_weight * authority
                + config.context_loss_weight * context
                + config.transform_loss_weight * transform
            )
            count = int(batch["source_ids"].size(0))
            examples += count
            for key, value in {
                "total": total,
                "generation": generation,
                "route": route,
                "authority": authority,
                "context": context,
                "transform": transform,
            }.items():
                totals[key] += float(value.detach().cpu()) * count
    return {key: value / max(1, examples) for key, value in totals.items()}



def evaluate(
    torch: Any,
    model: Any,
    loader: Any,
    tokenizer: SentencePieceTokenizer,
    device: Any,
    transform_labels: Sequence[str],
    *,
    temperature: float = 1.0,
    max_examples: int = 16,
) -> dict[str, Any]:
    """Evaluate auxiliary heads on every row and free generation on a bounded sample.

    `max_examples` is the free-running generation budget, not a cap on route/authority/context
    evaluation. Set it to 0 only when exhaustive autoregressive generation is intentional.
    """
    model.eval()
    aux_route_predictions: list[str] = []
    route_expected: list[str] = []
    authority_predictions: list[str] = []
    authority_expected: list[str] = []
    context_predictions: list[str] = []
    context_expected: list[str] = []
    transform_predictions: list[str] = []
    transform_expected: list[str] = []

    generated_route_predictions: list[str] = []
    generated_route_expected: list[str] = []
    response_predictions: list[str] = []
    response_expected: list[str] = []
    exact_matches = 0
    parse_success = 0
    fail_closed_required = 0
    fail_closed_satisfied = 0
    generation_examples = 0
    errors: list[dict[str, Any]] = []
    route_logits_all: list[Any] = []
    route_labels_all: list[Any] = []

    with torch.inference_mode():
        for raw_batch in loader:
            rows = raw_batch["rows"]
            batch = move_batch(raw_batch, device)
            _, pooled = model.encode(batch["source_ids"], batch["source_padding"])
            route_logits = model.route_head(pooled)
            authority_logits = model.authority_head(pooled)
            context_logits = model.context_head(pooled)
            transform_logits = model.transform_head(pooled)

            scaled_route_logits = route_logits / max(0.05, float(temperature))
            route_indices = scaled_route_logits.argmax(dim=-1).cpu().tolist()
            authority_indices = authority_logits.argmax(dim=-1).cpu().tolist()
            context_indices = context_logits.argmax(dim=-1).cpu().tolist()
            transform_indices = transform_logits.argmax(dim=-1).cpu().tolist()
            route_logits_all.append(route_logits.detach().cpu())
            route_labels_all.append(batch["route"].detach().cpu())

            for index, row in enumerate(rows):
                expected_route, expected_authority, expected_context, _ = expected_for_row(row)
                aux_route_predictions.append(ROUTES[route_indices[index]])
                route_expected.append(expected_route)
                authority_predictions.append(AUTHORITY_LABELS[authority_indices[index]])
                authority_expected.append(expected_authority)
                context_predictions.append(CONTEXT_LABELS[context_indices[index]])
                context_expected.append(expected_context)
                transform_predictions.append(transform_labels[transform_indices[index]])
                transform_expected.append(transform_from_row(row))

            remaining = 0 if max_examples < 0 else (len(rows) if max_examples == 0 else max(0, max_examples - generation_examples))
            take = min(len(rows), remaining)
            if take <= 0:
                continue
            generated = model.generate(
                batch["source_ids"][:take],
                batch["source_padding"][:take],
                tokenizer.bos_id,
                tokenizer.eos_id,
                model.config.max_target_tokens,
            )
            generated_ids = generated["generated_ids"].cpu().tolist()
            generated_authority = generated["authority_logits"].argmax(dim=-1).cpu().tolist()
            generated_context = generated["context_logits"].argmax(dim=-1).cpu().tolist()
            generated_transform = generated["transform_logits"].argmax(dim=-1).cpu().tolist()
            generated_aux_route = generated["route_logits"].argmax(dim=-1).cpu().tolist()

            for index in range(take):
                row = rows[index]
                decoded = tokenizer.decode(generated_ids[index])
                transform = transform_labels[generated_transform[index]]
                guarded = apply_fail_closed(
                    decoded,
                    generated_authority[index],
                    generated_context[index],
                    transform,
                )
                expected_route, expected_authority, expected_context, expected_action = expected_for_row(row)
                predicted_route = str(guarded["graph"]["route"])
                predicted_authority = str(guarded["graph"]["authority"])
                predicted_context = str(guarded["graph"]["context"])
                predicted_action = str(guarded["plan"]["response_action"])

                generated_route_predictions.append(predicted_route)
                generated_route_expected.append(expected_route)
                response_predictions.append(predicted_action)
                response_expected.append(expected_action)

                parsed_as_model = guarded["decision_source"] == "model"
                parse_success += int(parsed_as_model)
                exact_matches += int(
                    predicted_route == expected_route
                    and predicted_authority == expected_authority
                    and predicted_context == expected_context
                    and predicted_action == expected_action
                )
                requires_clarify = expected_route == "clarify"
                fail_closed_required += int(requires_clarify)
                fail_closed_satisfied += int(requires_clarify and predicted_route == "clarify")

                if len(errors) < 32 and (
                    predicted_route != expected_route
                    or predicted_action != expected_action
                    or not parsed_as_model
                ):
                    errors.append(
                        {
                            "id": row.get("id"),
                            "prompt": prompt_from_row(row)[:240],
                            "expected_route": expected_route,
                            "predicted_route": predicted_route,
                            "expected_action": expected_action,
                            "predicted_action": predicted_action,
                            "decision_source": guarded["decision_source"],
                            "aux_route": ROUTES[generated_aux_route[index]],
                            "decoded": decoded[:600],
                        }
                    )
                generation_examples += 1

    route_logits = torch.cat(route_logits_all, dim=0) if route_logits_all else torch.empty((0, len(ROUTES)))
    route_labels = torch.cat(route_labels_all, dim=0) if route_labels_all else torch.empty((0,), dtype=torch.long)
    nll = (
        float(torch.nn.functional.cross_entropy(route_logits / max(0.05, temperature), route_labels))
        if route_labels.numel()
        else None
    )
    total = len(route_expected)
    route_result = route_metrics(aux_route_predictions, route_expected)
    generated_route = route_metrics(generated_route_predictions, generated_route_expected)
    return {
        "examples": total,
        "generation_examples": generation_examples,
        "task_graph_parse_rate": parse_success / max(1, generation_examples),
        "joint_exact_rate": exact_matches / max(1, generation_examples),
        "route": route_result,
        "generated_route": generated_route,
        "authority_accuracy": sum(a == b for a, b in zip(authority_predictions, authority_expected)) / max(1, total),
        "context_accuracy": sum(a == b for a, b in zip(context_predictions, context_expected)) / max(1, total),
        "transform_accuracy": sum(a == b for a, b in zip(transform_predictions, transform_expected)) / max(1, total),
        "response_action_accuracy": sum(a == b for a, b in zip(response_predictions, response_expected)) / max(1, generation_examples),
        "forced_clarify_recall": fail_closed_satisfied / max(1, fail_closed_required),
        "forced_clarify_cases": fail_closed_required,
        "route_nll": nll,
        "errors": errors,
        "_route_logits": route_logits,
        "_route_labels": route_labels,
    }

def public_metrics(metrics: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in metrics.items() if not key.startswith("_")}


def external_evaluations(
    torch: Any,
    model: Any,
    tokenizer: SentencePieceTokenizer,
    config: ModelConfig,
    transform_labels: Sequence[str],
    device: Any,
    paths: Sequence[Path],
    temperature: float,
    max_examples: int,
    num_workers: int,
) -> dict[str, Any]:
    results: dict[str, Any] = {}
    for path in paths:
        rows = read_records(path)
        if not rows:
            continue
        loader = loader_for(
            torch, rows, tokenizer, config, transform_labels,
            shuffle=False, num_workers=num_workers,
        )
        results[path.name] = public_metrics(
            evaluate(
                torch, model, loader, tokenizer, device, transform_labels,
                temperature=temperature, max_examples=max_examples,
            )
        )
    return results


def save_checkpoint(
    torch: Any,
    path: Path,
    model: Any,
    optimizer: Any,
    scheduler: Any,
    scaler: Any,
    *,
    epoch: int,
    global_step: int,
    best_score: float,
    config: ModelConfig,
    transform_labels: Sequence[str],
    temperature: float,
) -> None:
    payload = {
        "schema": "archie-reasoner-checkpoint/v1",
        "model_state": model.state_dict(),
        "optimizer_state": optimizer.state_dict(),
        "scheduler_state": scheduler.state_dict(),
        "scaler_state": scaler.state_dict() if scaler is not None else None,
        "epoch": epoch,
        "global_step": global_step,
        "best_score": best_score,
        "config": config_dict(config),
        "transform_labels": list(transform_labels),
        "temperature": temperature,
        "promotion": "not-admitted",
    }
    temporary = path.with_suffix(path.suffix + ".tmp")
    torch.save(payload, temporary)
    temporary.replace(path)


def train_candidate(
    args: argparse.Namespace,
    *,
    preset: str,
    seed: int,
    output_dir: Path,
) -> dict[str, Any]:
    torch, _ = require_training_dependencies()
    torch.set_num_threads(max(1, int(args.threads)))
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
    seed_everything(torch, seed)
    device = selected_device(torch, args.device)
    config = override_config(PRESETS[preset], args, seed=seed)
    output_dir.mkdir(parents=True, exist_ok=True)

    eval_paths = evaluation_paths(args.evals, args.suite, args.frozen)
    all_rows = read_records(args.data)
    if not all_rows:
        raise RuntimeError("training dataset is empty")
    frozen = frozen_prompt_set(eval_paths)
    filtered_rows, removed_rows = filter_frozen_rows(all_rows, frozen)
    if len(filtered_rows) < len(ROUTES) * 2:
        raise RuntimeError(
            f"only {len(filtered_rows)} non-frozen rows remain; need at least two examples per route"
        )
    train_rows, dev_rows = stratified_split(filtered_rows, config.dev_fraction, seed)
    if not dev_rows:
        raise RuntimeError("development split is empty")

    transform_labels = sorted(
        set(DEFAULT_TRANSFORMS)
        | {transform_from_row(row) for row in filtered_rows}
    )

    tokenizer_prefix = output_dir / "tokenizer"
    tokenizer_model = tokenizer_prefix.with_suffix(".model")
    if not tokenizer_model.exists() or not args.resume:
        for stale in (
            tokenizer_prefix.with_suffix(".model"),
            tokenizer_prefix.with_suffix(".vocab"),
            tokenizer_prefix.with_suffix(".corpus.txt"),
        ):
            stale.unlink(missing_ok=True)
        train_sentencepiece(train_rows, tokenizer_prefix, config.vocab_size)
    tokenizer = SentencePieceTokenizer(tokenizer_model)

    train_loader = loader_for(
        torch, train_rows, tokenizer, config, transform_labels,
        shuffle=True, num_workers=args.num_workers,
    )
    dev_loader = loader_for(
        torch, dev_rows, tokenizer, config, transform_labels,
        shuffle=False, num_workers=args.num_workers,
    )

    ArchieReasoner = build_model_class()
    model = ArchieReasoner(
        tokenizer.vocab_size,
        tokenizer.pad_id,
        len(transform_labels),
        config,
    ).to(device)

    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=config.learning_rate,
        weight_decay=config.weight_decay,
        betas=(0.9, 0.95),
    )
    updates_per_epoch = math.ceil(len(train_loader) / max(1, config.grad_accumulation))
    total_steps = max(1, updates_per_epoch * config.epochs)
    warmup_steps = round(total_steps * config.warmup_fraction)

    def schedule_factor(step: int) -> float:
        if step < warmup_steps:
            return max(1e-8, step / max(1, warmup_steps))
        progress = (step - warmup_steps) / max(1, total_steps - warmup_steps)
        return 0.5 * (1.0 + math.cos(math.pi * min(1.0, progress)))

    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, schedule_factor)
    use_amp = device.type == "cuda"
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)

    start_epoch = 0
    global_step = 0
    best_score = -1.0
    temperature = 1.0
    last_path = output_dir / "last.pt"
    best_path = output_dir / "best.pt"
    if args.resume and last_path.exists():
        checkpoint = torch.load(last_path, map_location=device, weights_only=False)
        model.load_state_dict(checkpoint["model_state"])
        optimizer.load_state_dict(checkpoint["optimizer_state"])
        scheduler.load_state_dict(checkpoint["scheduler_state"])
        if checkpoint.get("scaler_state"):
            scaler.load_state_dict(checkpoint["scaler_state"])
        start_epoch = int(checkpoint["epoch"]) + 1
        global_step = int(checkpoint["global_step"])
        best_score = float(checkpoint.get("best_score", -1.0))
        temperature = float(checkpoint.get("temperature", 1.0))

    history: list[dict[str, Any]] = []
    started = time.time()
    for epoch in range(start_epoch, config.epochs):
        model.train()
        optimizer.zero_grad(set_to_none=True)
        losses: list[dict[str, float]] = []
        for batch_index, raw_batch in enumerate(train_loader):
            batch = move_batch(raw_batch, device)
            target_input = batch["target_ids"][:, :-1].contiguous()
            labels = batch["target_ids"][:, 1:].contiguous()
            target_padding = target_input.eq(tokenizer.pad_id)
            with torch.amp.autocast(device_type="cuda", enabled=use_amp):
                outputs = model(
                    batch["source_ids"],
                    target_input,
                    batch["source_padding"],
                    target_padding,
                )
                # Replace the loss labels explicitly to avoid coupling to the collator representation.
                generation = torch.nn.functional.cross_entropy(
                    outputs["token_logits"].reshape(-1, outputs["token_logits"].size(-1)),
                    labels.masked_fill(labels.eq(tokenizer.pad_id), -100).reshape(-1),
                    ignore_index=-100,
                    label_smoothing=config.label_smoothing,
                )
                route = torch.nn.functional.cross_entropy(outputs["route_logits"], batch["route"])
                authority = torch.nn.functional.cross_entropy(outputs["authority_logits"], batch["authority"])
                context = torch.nn.functional.cross_entropy(outputs["context_logits"], batch["context"])
                transform = torch.nn.functional.cross_entropy(outputs["transform_logits"], batch["transform"])
                total = (
                    config.generation_loss_weight * generation
                    + config.route_loss_weight * route
                    + config.authority_loss_weight * authority
                    + config.context_loss_weight * context
                    + config.transform_loss_weight * transform
                )
                scaled_loss = total / max(1, config.grad_accumulation)
            scaler.scale(scaled_loss).backward()
            should_step = (
                (batch_index + 1) % config.grad_accumulation == 0
                or batch_index + 1 == len(train_loader)
            )
            if should_step:
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(model.parameters(), config.grad_clip)
                scaler.step(optimizer)
                scaler.update()
                optimizer.zero_grad(set_to_none=True)
                scheduler.step()
                global_step += 1
            losses.append(
                {
                    "total": float(total.detach().cpu()),
                    "generation": float(generation.detach().cpu()),
                    "route": float(route.detach().cpu()),
                    "authority": float(authority.detach().cpu()),
                    "context": float(context.detach().cpu()),
                    "transform": float(transform.detach().cpu()),
                }
            )

        dev_losses = evaluate_teacher_forced(
            torch, model, dev_loader, tokenizer, device, config,
        )
        dev_metrics = evaluate(
            torch, model, dev_loader, tokenizer, device, transform_labels,
            temperature=1.0, max_examples=-1,
        )
        temperature = fit_temperature(
            dev_metrics["_route_logits"].to(device),
            dev_metrics["_route_labels"].to(device),
        )
        if dev_metrics["_route_labels"].numel():
            dev_metrics["route_nll"] = float(
                torch.nn.functional.cross_entropy(
                    dev_metrics["_route_logits"].to(device) / max(0.05, temperature),
                    dev_metrics["_route_labels"].to(device),
                ).detach().cpu()
            )
        token_score = 1.0 / (1.0 + dev_losses["generation"])
        score = (
            0.35 * token_score
            + 0.35 * dev_metrics["route"]["accuracy"]
            + 0.10 * dev_metrics["authority_accuracy"]
            + 0.10 * dev_metrics["context_accuracy"]
            + 0.10 * dev_metrics["transform_accuracy"]
        )
        epoch_record = {
            "epoch": epoch + 1,
            "learning_rate": optimizer.param_groups[0]["lr"],
            "train_loss": mean_dict(losses),
            "development_teacher_forced_loss": dev_losses,
            "temperature": temperature,
            "score": score,
            "development_heads": public_metrics(dev_metrics),
        }
        history.append(epoch_record)
        print(json.dumps(epoch_record, sort_keys=True), flush=True)

        if score > best_score:
            best_score = score
            save_checkpoint(
                torch, best_path, model, optimizer, scheduler, scaler,
                epoch=epoch, global_step=global_step, best_score=best_score,
                config=config, transform_labels=transform_labels, temperature=temperature,
            )
        save_checkpoint(
            torch, last_path, model, optimizer, scheduler, scaler,
            epoch=epoch, global_step=global_step, best_score=best_score,
            config=config, transform_labels=transform_labels, temperature=temperature,
        )

    if not best_path.exists():
        # Covers a fully resumed run whose best checkpoint predates this invocation.
        if last_path.exists():
            shutil.copy2(last_path, best_path)
        else:
            raise RuntimeError("training produced no checkpoint")
    best = torch.load(best_path, map_location=device, weights_only=False)
    model.load_state_dict(best["model_state"])
    temperature = float(best.get("temperature", temperature))

    final_dev = public_metrics(
        evaluate(
            torch, model, dev_loader, tokenizer, device, transform_labels,
            temperature=temperature, max_examples=args.max_eval_examples,
        )
    )
    frozen_results = external_evaluations(
        torch, model, tokenizer, config, transform_labels, device,
        eval_paths, temperature, args.max_eval_examples, args.num_workers,
    )

    checkpoint_digest = sha256_file(best_path)
    tokenizer_digest = sha256_file(tokenizer_model)
    data_digest = sha256_json(
        [
            {
                "prompt": prompt_from_row(row),
                "route": route_from_row(row),
                "source": source_text(row),
                "target": target_objects(row),
            }
            for row in train_rows
        ]
    )
    elapsed = time.time() - started
    body = {
        "schema": "archie-generative-reasoner-receipt/v1",
        "run": {
            "name": args.run_name or f"{preset}-seed{seed}",
            "preset": preset,
            "seed": seed,
            "device_type": device.type,
            "elapsed_seconds": round(elapsed, 3),
            "global_steps": global_step,
        },
        "model": {
            "method": "sentencepiece-attentive-gru-task-graph/v1",
            "parameters": parameter_count(model),
            "config": config_dict(config),
            "temperature": temperature,
            "checkpoint": best_path.name,
            "checkpoint_sha256": checkpoint_digest,
            "tokenizer_sha256": tokenizer_digest,
            "transform_labels": transform_labels,
        },
        "data": {
            "input_rows": len(all_rows),
            "frozen_prompt_count": len(frozen),
            "removed_frozen_rows": len(removed_rows),
            "train_rows": len(train_rows),
            "development_rows": len(dev_rows),
            "train_digest": data_digest,
            "external_suites": [path.name for path in eval_paths],
        },
        "evaluation": {
            "development": final_dev,
            "frozen": frozen_results,
            "history": history,
        },
        "safety": {
            "authority_labels": list(AUTHORITY_LABELS),
            "context_labels": list(CONTEXT_LABELS),
            "deny_forces_clarify": True,
            "missing_or_ambiguous_context_forces_clarify": True,
            "invalid_generation_forces_clarify": True,
        },
        "promotion": "not-admitted",
        "claim_boundary": (
            "The checkpoint generates a supervised task graph and grounded response plan. "
            "It does not generate final user prose, execute tools, read attachment contents unless "
            "those contents are explicitly represented in the input row, or inherit admission from "
            "the existing twelve-route classifier."
        ),
    }
    receipt = write_receipt(output_dir / "receipt.json", body)
    (output_dir / "history.json").write_text(
        json.dumps(history, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return receipt


def main() -> int:
    args = parse_args()
    output = Path(args.output)
    if args.sweep:
        presets = [item.strip() for item in args.sweep.split(",") if item.strip()]
        unknown = [item for item in presets if item not in PRESETS]
        if unknown:
            raise SystemExit(f"unknown sweep presets: {unknown}")
        seeds = (
            [int(item.strip()) for item in args.seeds.split(",") if item.strip()]
            if args.seeds
            else [args.seed if args.seed is not None else PRESETS["full"].seed]
        )
        leaderboard: list[dict[str, Any]] = []
        for preset in presets:
            for seed in seeds:
                destination = output / f"{preset}-seed{seed}"
                receipt = train_candidate(
                    args, preset=preset, seed=seed, output_dir=destination
                )
                dev = receipt["evaluation"]["development"]
                leaderboard.append(
                    {
                        "preset": preset,
                        "seed": seed,
                        "parameters": receipt["model"]["parameters"],
                        "joint_exact_rate": dev["joint_exact_rate"],
                        "route_accuracy": dev["route"]["accuracy"],
                        "response_action_accuracy": dev["response_action_accuracy"],
                        "receipt": str(destination / "receipt.json"),
                    }
                )
        leaderboard.sort(
            key=lambda row: (
                row["joint_exact_rate"],
                row["route_accuracy"],
                row["response_action_accuracy"],
                -row["parameters"],
            ),
            reverse=True,
        )
        output.mkdir(parents=True, exist_ok=True)
        write_receipt(
            output / "sweep-receipt.json",
            {
                "schema": "archie-reasoner-sweep-receipt/v1",
                "candidates": leaderboard,
                "selection_rule": (
                    "Highest development joint exact rate, then route accuracy, then response-action "
                    "accuracy, then fewer parameters. Frozen suites remain reporting-only."
                ),
                "promotion": "not-admitted",
            },
        )
        print(json.dumps({"ok": True, "candidates": leaderboard}, indent=2))
        return 0

    preset = args.preset
    seed = args.seed if args.seed is not None else PRESETS[preset].seed
    receipt = train_candidate(args, preset=preset, seed=seed, output_dir=output)
    print(
        json.dumps(
            {
                "ok": True,
                "receipt": str(output / "receipt.json"),
                "checkpoint": str(output / "best.pt"),
                "parameters": receipt["model"]["parameters"],
                "development": receipt["evaluation"]["development"],
                "promotion": receipt["promotion"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
