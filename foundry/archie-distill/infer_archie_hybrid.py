#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib

import torch

from archie_hybrid_core import ArchieHybridLM, ByteTokenizer, ModelConfig
from archie_tokenizers import tokenizer_from_metadata


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--max-new-tokens", type=int, default=64)
    parser.add_argument("--temperature", type=float, default=0.7)
    parser.add_argument("--top-k", type=int, default=30)
    parser.add_argument("--seed", type=int, default=20260722)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--plastic-state-in")
    parser.add_argument("--plastic-state-out")
    args = parser.parse_args()
    device = torch.device(
        args.device if args.device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu")
    )
    model_path = pathlib.Path(args.model).resolve()
    model_digest = hashlib.sha256(model_path.read_bytes()).hexdigest()
    payload = torch.load(model_path, map_location=device, weights_only=False)
    if payload.get("schema") != "archie-scratch-hybrid-model/v1":
        raise ValueError("unsupported Archie hybrid model")
    config = ModelConfig(**payload["config"])
    model = ArchieHybridLM(config).to(device)
    model.load_state_dict(payload["model"])
    model.eval()
    torch.manual_seed(args.seed)
    if device.type == "cuda":
        torch.cuda.manual_seed_all(args.seed)
    tokenizer = tokenizer_from_metadata(payload.get("tokenizer") or ByteTokenizer.metadata())
    prompt_tokens = tokenizer.encode(args.prompt, bos=True)
    tokens = torch.tensor([prompt_tokens], dtype=torch.long, device=device)
    plastic_state = None
    if args.plastic_state_in:
        state_payload = torch.load(
            pathlib.Path(args.plastic_state_in).resolve(), map_location=device, weights_only=False
        )
        if state_payload.get("schema") != "archie-plastic-state/v1":
            raise ValueError("unsupported Archie plastic-state artifact")
        if state_payload.get("model_sha256") != model_digest:
            raise ValueError("plastic state belongs to a different model")
        plastic_state = state_payload["state"]
    generated_tensor, next_plastic_state = model.generate_with_plastic_state(
        tokens, args.max_new_tokens, temperature=args.temperature, top_k=args.top_k,
        plastic_state=plastic_state,
    )
    generated = generated_tensor[0].tolist()
    state_digest = None
    if args.plastic_state_out:
        if next_plastic_state is None:
            raise ValueError("cannot export plastic state from a non-plastic model")
        state_path = pathlib.Path(args.plastic_state_out).resolve()
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_payload = {
            "schema": "archie-plastic-state/v1",
            "model_sha256": model_digest,
            "model_config": payload["config"],
            "state": next_plastic_state.detach().cpu(),
        }
        torch.save(state_payload, state_path)
        state_digest = hashlib.sha256(state_path.read_bytes()).hexdigest()
    full_text = tokenizer.decode(generated)
    continuation = tokenizer.decode(generated[len(prompt_tokens) :])
    print(
        json.dumps(
            {
                "prompt": args.prompt,
                "continuation": continuation,
                "text": full_text,
                "generated_tokens": len(generated) - len(prompt_tokens),
                "temperature": args.temperature,
                "top_k": args.top_k,
                "seed": args.seed,
                "device": str(device),
                "model_sha256": model_digest,
                "plastic_mode": config.plastic_mode,
                "plastic_state_loaded": args.plastic_state_in is not None,
                "plastic_state_sha256": state_digest,
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
