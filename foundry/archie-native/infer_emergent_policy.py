#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib

import torch

from train_emergent_policy import Config, EmergentPolicy, encode_bytes


def load_policy(path: pathlib.Path, device: torch.device):
    payload = torch.load(path, map_location=device, weights_only=False)
    if payload.get("schema") != "archie-emergent-policy/v1":
        raise ValueError("unsupported emergent policy checkpoint")
    config = Config(**payload["config"])
    vocabulary = list(payload["action_vocabulary"])
    model = EmergentPolicy(config, len(vocabulary)).to(device)
    model.load_state_dict(payload["model"])
    model.eval()
    return model, config, vocabulary


@torch.no_grad()
def predict(model, config: Config, vocabulary: list[str], text: str, device: torch.device):
    observation = torch.tensor(
        [[encode_bytes(text, config.observation_width)]], dtype=torch.long, device=device
    )
    output = model(observation)
    probabilities = output["logits"][0, 0].softmax(-1)
    values, indices = probabilities.topk(min(3, len(vocabulary)))
    result = {
        "action": vocabulary[int(indices[0])],
        "confidence": float(values[0].cpu()),
        "alternatives": [
            {"action": vocabulary[int(index)], "confidence": float(value)}
            for value, index in zip(values.cpu(), indices.cpu())
        ],
        "value": float(output["value"][0, 0].cpu()),
        "stop_probability": float(output["stop"][0, 0].sigmoid().cpu()),
    }
    if "action_value" in output:
        result["counterfactual_values"] = [
            {"action": action, "value": float(output["action_value"][0, 0, index].cpu())}
            for index, action in enumerate(vocabulary)
        ]
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()
    device = torch.device(
        args.device if args.device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu")
    )
    model_path = pathlib.Path(args.model).resolve()
    model, config, vocabulary = load_policy(model_path, device)
    result = predict(model, config, vocabulary, args.text, device)
    result["model_sha256"] = hashlib.sha256(model_path.read_bytes()).hexdigest()
    result["device"] = str(device)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
