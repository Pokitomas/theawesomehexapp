#!/usr/bin/env python3
"""Execute bounded repository-action branches and emit counterfactual episodes."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import pathlib
import re
import subprocess
import sys
import tarfile
import tempfile
import time
from typing import Any

import torch

from infer_emergent_policy import load_policy
from train_emergent_policy import encode_bytes, read_rows

SCHEMA = "archie-repository-ecology/v1"
RECEIPT_SCHEMA = "archie-repository-ecology-receipt/v1"
METRICS_SCHEMA = "archie-repository-ecology-metrics/v1"
SAFE_ID = re.compile(r"^[a-zA-Z0-9_.-]+$")
BUILTIN_OBJECTIVES = {
    "verified_outcome", "boundary_integrity", "causal_effect", "efficiency",
}


def stable(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: Any) -> str:
    encoded = value if isinstance(value, bytes) else stable(value).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def run(
    command: list[str], *, cwd: pathlib.Path | None = None, input_text: str | None = None,
    timeout: float = 60.0, env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command, cwd=cwd, input=input_text, text=True, capture_output=True,
        timeout=timeout, check=False, env=env,
    )


def tree_inventory(root: pathlib.Path) -> dict[str, str]:
    inventory = {}
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        inventory[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return inventory


def tree_digest(inventory: dict[str, str]) -> str:
    return digest(inventory)


def changed_paths(before: dict[str, str], after: dict[str, str]) -> list[str]:
    return sorted(
        path for path in set(before) | set(after) if before.get(path) != after.get(path)
    )


def extract_revision(repository: pathlib.Path, revision: str, destination: pathlib.Path) -> None:
    archived = subprocess.run(
        ["git", "-C", str(repository), "archive", "--format=tar", revision],
        capture_output=True, check=False,
    )
    if archived.returncode:
        raise RuntimeError(archived.stderr.decode("utf-8", errors="replace"))
    destination.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(archived.stdout), mode="r:") as archive:
        root = destination.resolve()
        for member in archive.getmembers():
            target = (destination / member.name).resolve()
            if not target.is_relative_to(root) or member.issym() or member.islnk():
                raise ValueError(f"unsafe archive member: {member.name}")
        archive.extractall(destination, filter="data")


def apply_patch(root: pathlib.Path, patch: str) -> tuple[bool, str]:
    if not patch.strip():
        return True, ""
    checked = run(["git", "apply", "--check", "-"], cwd=root, input_text=patch)
    if checked.returncode:
        return False, (checked.stderr or checked.stdout)[-8000:]
    applied = run(["git", "apply", "-"], cwd=root, input_text=patch)
    return applied.returncode == 0, (applied.stderr or applied.stdout)[-8000:]


def validate_manifest(manifest: dict[str, Any]) -> None:
    if manifest.get("schema") != SCHEMA:
        raise ValueError("unsupported repository ecology manifest")
    if not re.fullmatch(r"[0-9a-f]{40}", str(manifest.get("base_revision", ""))):
        raise ValueError("base_revision must be a full commit SHA")
    for field in ("episode_id", "repository_id", "mechanism_id", "task_family", "objective"):
        if not str(manifest.get(field, "")).strip():
            raise ValueError(f"{field} is required")
    actions = manifest.get("actions")
    if not isinstance(actions, list) or len(actions) < 2:
        raise ValueError("at least two candidate actions are required")
    identifiers = []
    for action in actions:
        action_id = str(action.get("id", ""))
        if not SAFE_ID.fullmatch(action_id):
            raise ValueError(f"unsafe action id: {action_id!r}")
        if not isinstance(action.get("patch"), str):
            raise ValueError(f"action {action_id} requires an inline patch")
        allowed = action.get("allowed_paths")
        if not isinstance(allowed, list) or not allowed:
            raise ValueError(f"action {action_id} requires non-empty allowed_paths")
        identifiers.append(action_id)
    if len(set(identifiers)) != len(identifiers):
        raise ValueError("candidate action IDs must be unique")
    mutations = manifest.get("mutations", [{"id": "unmutated", "patch": ""}])
    for mutation in mutations:
        if not SAFE_ID.fullmatch(str(mutation.get("id", ""))):
            raise ValueError("mutation IDs must be path-safe")
        if not isinstance(mutation.get("patch", ""), str):
            raise ValueError("mutation patch must be inline text")
    evaluator = manifest.get("evaluator", [])
    if not isinstance(evaluator, list) or not evaluator or not all(
        isinstance(item, str) and item for item in evaluator
    ):
        raise ValueError("evaluator must be a non-empty argv string list")
    objective_weights = manifest.get("objective_weights")
    if objective_weights is not None:
        if not isinstance(objective_weights, dict) or not objective_weights:
            raise ValueError("objective_weights must be a non-empty object")
        for name, weight in objective_weights.items():
            if not SAFE_ID.fullmatch(str(name)):
                raise ValueError(f"unsafe objective name: {name!r}")
            if (
                isinstance(weight, bool) or not isinstance(weight, (int, float))
                or not math.isfinite(float(weight)) or weight < 0
            ):
                raise ValueError(f"objective weight must be non-negative: {name}")
        if sum(float(weight) for weight in objective_weights.values()) <= 0:
            raise ValueError("objective_weights must have positive total weight")
        for required in ("verified_outcome", "boundary_integrity"):
            if float(objective_weights.get(required, 0.0)) <= 0:
                raise ValueError(f"objective_weights must preserve {required}")


def read_objective_metrics(path: pathlib.Path) -> tuple[dict[str, float], str | None]:
    if not path.exists():
        return {}, None
    if path.stat().st_size > 64 * 1024:
        raise ValueError("evaluator objective metrics exceed 64 KiB")
    encoded = path.read_bytes()
    payload = json.loads(encoded.decode("utf-8"))
    if payload.get("schema") != METRICS_SCHEMA or not isinstance(payload.get("metrics"), dict):
        raise ValueError("evaluator objective metrics use an unsupported schema")
    metrics = {}
    for name, value in payload["metrics"].items():
        if not SAFE_ID.fullmatch(str(name)) or name in BUILTIN_OBJECTIVES:
            raise ValueError(f"invalid evaluator objective: {name!r}")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"objective metric must be numeric: {name}")
        number = float(value)
        if not -1.0 <= number <= 1.0:
            raise ValueError(f"objective metric must be within [-1, 1]: {name}")
        metrics[str(name)] = number
    return metrics, hashlib.sha256(encoded).hexdigest()


def choose_action(
    manifest: dict[str, Any], observation: str, policy_path: pathlib.Path | None,
    device: torch.device,
) -> tuple[str, dict[str, Any]]:
    action_ids = [str(action["id"]) for action in manifest["actions"]]
    if policy_path is None:
        chosen = str(manifest.get("proposed_action", ""))
        if chosen not in action_ids:
            raise ValueError("proposed_action must name one candidate when no policy is supplied")
        return chosen, {"kind": "manifest-proposal", "action": chosen}
    model, config, vocabulary = load_policy(policy_path, device)
    eligible = [(index, action) for index, action in enumerate(vocabulary) if action in action_ids]
    if not eligible:
        raise ValueError("policy vocabulary contains none of the candidate action IDs")
    encoded = torch.tensor(
        [[encode_bytes(observation, config.observation_width)]], dtype=torch.long, device=device
    )
    with torch.no_grad():
        output = model(encoded)
        probabilities = output["logits"][0, 0].softmax(-1)
        if "action_value" in output:
            scores = output["action_value"][0, 0]
            score_kind = "counterfactual-value"
        else:
            scores = probabilities
            score_kind = "policy-probability"
    index, chosen = max(eligible, key=lambda item: float(scores[item[0]].cpu()))
    return chosen, {
        "kind": "archie-emergent-policy",
        "model_sha256": hashlib.sha256(policy_path.read_bytes()).hexdigest(),
        "score_kind": score_kind,
        "action": chosen,
        "score": float(scores[index].cpu()),
        "probability": float(probabilities[index].cpu()),
    }


def evaluate_branch(
    repository: pathlib.Path, revision: str, output: pathlib.Path,
    mutation: dict[str, Any], action: dict[str, Any], evaluator: list[str],
    protected_paths: set[str], timeout: float,
    objective_weights: dict[str, float] | None,
) -> dict[str, Any]:
    branch = output / "branches" / str(mutation["id"]) / str(action["id"])
    extract_revision(repository, revision, branch)
    base_inventory = tree_inventory(branch)
    mutation_ok, mutation_log = apply_patch(branch, str(mutation.get("patch", "")))
    if not mutation_ok:
        components = {
            "verified_outcome": -1.0, "boundary_integrity": 1.0,
            "causal_effect": -1.0, "efficiency": 1.0,
        }
        reward = -1.0
        return_method = "legacy-status-map"
        if objective_weights:
            total_weight = sum(objective_weights.values())
            reward = sum(
                weight * components.get(name, -1.0)
                for name, weight in objective_weights.items()
            ) / total_weight
            return_method = "weighted-objective-vector"
        body = {
            "mutation_id": mutation["id"], "action": action["id"],
            "status": "mutation-failed", "return": reward,
            "return_method": return_method, "success": False,
            "objective_components": components, "objective_weights": objective_weights,
            "mutation_log": mutation_log,
        }
        return {**body, "receipt_digest": digest(body)}
    before = tree_inventory(branch)
    mutation_protected = sorted(
        path for path in protected_paths
        if base_inventory.get(path) != before.get(path)
    )
    if mutation_protected:
        components = {
            "verified_outcome": -1.0, "boundary_integrity": -1.0,
            "causal_effect": -1.0, "efficiency": 1.0,
        }
        reward = -0.9
        return_method = "legacy-status-map"
        if objective_weights:
            total_weight = sum(objective_weights.values())
            reward = sum(
                weight * components.get(name, -1.0)
                for name, weight in objective_weights.items()
            ) / total_weight
            return_method = "weighted-objective-vector"
        body = {
            "mutation_id": mutation["id"], "action": action["id"],
            "status": "mutation-boundary-violation", "return": reward,
            "return_method": return_method, "success": False,
            "objective_components": components, "objective_weights": objective_weights,
            "protected_paths_changed": mutation_protected,
        }
        return {**body, "receipt_digest": digest(body)}
    action_ok, action_log = apply_patch(branch, str(action["patch"]))
    after = tree_inventory(branch)
    changed = changed_paths(before, after)
    allowed = {pathlib.PurePosixPath(item).as_posix() for item in action["allowed_paths"]}
    unauthorized = sorted(set(changed) - allowed)
    protected_changed = sorted(set(changed) & protected_paths)
    started = time.monotonic()
    evaluation = None
    evaluator_metrics: dict[str, float] = {}
    evaluator_metrics_sha256 = None
    evaluator_metrics_error = None
    if action_ok and not unauthorized and not protected_changed and evaluator:
        home = output / "homes" / str(mutation["id"]) / str(action["id"])
        home.mkdir(parents=True)
        metrics_path = home / "objective-metrics.json"
        environment = {
            "PATH": os.environ.get("PATH", ""), "HOME": str(home),
            "PYTHONPATH": "", "NO_COLOR": "1", "CI": "1",
            "ARCHIE_ECOLOGY_METRICS": str(metrics_path),
        }
        evaluation = run(evaluator, cwd=branch, timeout=timeout, env=environment)
        try:
            evaluator_metrics, evaluator_metrics_sha256 = read_objective_metrics(metrics_path)
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
            evaluator_metrics_error = str(error)
    final_inventory = tree_inventory(branch)
    evaluator_changed = changed_paths(after, final_inventory)
    protected_changed = sorted(
        path for path in protected_paths if before.get(path) != final_inventory.get(path)
    )
    seconds = time.monotonic() - started
    required_metrics = set(objective_weights or {}) - BUILTIN_OBJECTIVES
    missing_metrics = sorted(required_metrics - evaluator_metrics.keys())
    evaluator_ok = (
        evaluation is not None and evaluation.returncode == 0
        and evaluator_metrics_error is None and not missing_metrics
    )
    success = (
        action_ok and bool(changed) and not unauthorized and not protected_changed
        and not evaluator_changed and evaluator_ok
    )
    if not action_ok:
        reward, status = -0.8, "action-patch-failed"
    elif unauthorized or protected_changed or evaluator_changed:
        reward, status = -0.9, "boundary-violation"
    elif not changed:
        reward, status = -0.2, "no-effect"
    elif evaluation is not None and evaluation.returncode == 0 and evaluator_metrics_error:
        reward, status = -0.7, "objective-metrics-invalid"
    elif evaluation is not None and evaluation.returncode == 0 and missing_metrics:
        reward, status = -0.6, "objective-metrics-missing"
    elif not evaluator_ok:
        reward, status = -0.5, "evaluation-failed"
    else:
        reward, status = 1.0, "verified-success"
    components = {
        "verified_outcome": 1.0 if evaluator_ok else -1.0,
        "boundary_integrity": (
            1.0 if not unauthorized and not protected_changed and not evaluator_changed else -1.0
        ),
        "causal_effect": 1.0 if changed else -1.0,
        "efficiency": max(-1.0, min(1.0, 1.0 - 2.0 * seconds / max(timeout, 1e-9))),
        **evaluator_metrics,
    }
    return_method = "legacy-status-map"
    if objective_weights:
        total_weight = sum(float(weight) for weight in objective_weights.values())
        reward = sum(
            float(weight) * components.get(name, -1.0)
            for name, weight in objective_weights.items()
        ) / total_weight
        return_method = "weighted-objective-vector"
    body = {
        "mutation_id": mutation["id"], "action": action["id"], "status": status,
        "return": reward, "return_method": return_method, "success": success,
        "objective_components": components,
        "objective_weights": objective_weights,
        "missing_objective_metrics": missing_metrics,
        "unauthorized_paths": unauthorized, "protected_paths_changed": protected_changed,
        "evaluator_changed_paths": evaluator_changed,
        "before_tree_sha256": tree_digest(before),
        "after_patch_tree_sha256": tree_digest(after),
        "after_evaluation_tree_sha256": tree_digest(final_inventory),
        "action_log": action_log, "evaluator": evaluator,
        "evaluator_returncode": evaluation.returncode if evaluation is not None else None,
        "evaluator_metrics_sha256": evaluator_metrics_sha256,
        "evaluator_metrics_error": evaluator_metrics_error,
        "stdout": evaluation.stdout[-8000:] if evaluation is not None else "",
        "stderr": evaluation.stderr[-8000:] if evaluation is not None else "",
        "seconds": seconds,
    }
    return {**body, "receipt_digest": digest(body)}


def execute(args: argparse.Namespace) -> dict[str, Any]:
    manifest_path = pathlib.Path(args.manifest).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    validate_manifest(manifest)
    repository = pathlib.Path(manifest["repository"]).resolve()
    revision = str(manifest["base_revision"])
    observed = run(["git", "-C", str(repository), "rev-parse", f"{revision}^{{commit}}"])
    if observed.returncode or observed.stdout.strip() != revision:
        raise ValueError("base revision is unavailable or does not resolve exactly")
    output = pathlib.Path(args.output).resolve()
    if output.exists():
        raise FileExistsError(f"output must not already exist: {output}")
    output.mkdir(parents=True)
    evaluator = list(manifest.get("evaluator", []))
    objective_weights = (
        {str(name): float(weight) for name, weight in manifest.get("objective_weights", {}).items()}
        if manifest.get("objective_weights") is not None else None
    )
    mutations = manifest.get("mutations") or [{"id": "unmutated", "patch": "", "observation": ""}]
    protected_paths = {
        pathlib.PurePosixPath(path).as_posix() for path in manifest.get("protected_paths", [])
    }
    policy_path = pathlib.Path(args.policy_model).resolve() if args.policy_model else None
    device = torch.device(args.policy_device)
    episodes = []
    all_results = []
    for mutation in mutations:
        observation = (
            f"Objective: {manifest['objective']}\n"
            f"Repository: {manifest['repository_id']}\n"
            f"Environment mutation: {mutation['id']}\n"
            f"Observed change: {mutation.get('observation', 'unknown relocation or mechanism shift')}"
        )
        chosen, chooser = choose_action(manifest, observation, policy_path, device)
        results = [
            evaluate_branch(
                repository, revision, output, mutation, action, evaluator,
                protected_paths, args.timeout, objective_weights,
            )
            for action in manifest["actions"]
        ]
        all_results.extend(results)
        by_action = {result["action"]: result for result in results}
        chosen_result = by_action[chosen]
        counterfactuals = [
            {
                "action": result["action"], "return": result["return"],
                "objective_components": result["objective_components"],
                "verified": True, "receipt_digest": result["receipt_digest"],
                "observed_result": result["status"],
            }
            for result in results if result["action"] != chosen
        ]
        rejected = [
            result["action"] for result in results
            if result["action"] != chosen and result["return"] < chosen_result["return"]
        ]
        episode_body = {
            "schema": "archie-agent-teacher-episode/v1",
            "episode_id": f"{manifest['episode_id']}--{mutation['id']}",
            "repository_id": manifest["repository_id"],
            "mechanism_id": manifest["mechanism_id"],
            "task_family": manifest["task_family"],
            "environment_mutation": mutation["id"],
            "verified": True,
            "source_prompt": manifest["objective"],
            "teacher_agents": [chooser["kind"], "repository-ecology-verifier/v1"],
            "chooser": chooser,
            "steps": [
                {
                    "observation": observation,
                    "action": chosen,
                    "return": chosen_result["return"],
                    "objective_components": chosen_result["objective_components"],
                    "objective_weights": objective_weights,
                    "stop": True,
                    "teacher_confidence": 1.0,
                    "rejected_actions": rejected,
                    "counterfactuals": counterfactuals,
                }
            ],
        }
        episode_body["verifier_digest"] = digest(
            {"episode": episode_body, "branch_receipts": [item["receipt_digest"] for item in results]}
        )
        episodes.append(episode_body)
    episode_path = output / "episodes.jsonl"
    episode_path.write_text(
        "".join(json.dumps(episode, sort_keys=True) + "\n" for episode in episodes),
        encoding="utf-8",
    )
    receipt = {
        "schema": RECEIPT_SCHEMA, "manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        "base_revision": revision, "episodes": len(episodes), "branches": len(all_results),
        "objective_weights": objective_weights,
        "verified_successes": sum(result.get("success") is True for result in all_results),
        "episode_file": str(episode_path), "episode_sha256": hashlib.sha256(episode_path.read_bytes()).hexdigest(),
        "branch_results": all_results,
        "claim_boundary": (
            "Counterfactual repository branches executed in disposable snapshots with path bounds and "
            "process timeouts; this is not an OS network sandbox and must not run untrusted repositories."
        ),
    }
    receipt["receipt_digest"] = digest(receipt)
    (output / "ecology-receipt.json").write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return receipt


def selftest() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = pathlib.Path(temporary)
        repository = root / "repository"
        repository.mkdir()
        (repository / "value.txt").write_text("value=1\n", encoding="utf-8")
        (repository / "verify.py").write_text(
            "import json, os, pathlib\n"
            "success = pathlib.Path('value.txt').read_text() == 'value=2\\n'\n"
            "pathlib.Path(os.environ['ARCHIE_ECOLOGY_METRICS']).write_text(json.dumps({"
            "'schema': 'archie-repository-ecology-metrics/v1', "
            "'metrics': {'transfer': 0.8 if success else -0.8}}))\n"
            "raise SystemExit(0 if success else 1)\n",
            encoding="utf-8",
        )
        run(["git", "init"], cwd=repository)
        run(["git", "config", "user.email", "archie@example.invalid"], cwd=repository)
        run(["git", "config", "user.name", "Archie Ecology"], cwd=repository)
        run(["git", "add", "."], cwd=repository)
        run(["git", "commit", "-m", "base"], cwd=repository)
        revision = run(["git", "rev-parse", "HEAD"], cwd=repository).stdout.strip()
        manifest = {
            "schema": SCHEMA, "episode_id": "selftest", "repository": str(repository),
            "base_revision": revision, "repository_id": "selftest-repo",
            "mechanism_id": "value-repair", "task_family": "repair",
            "objective": "Make the frozen evaluator accept value.txt.",
            "proposed_action": "set-two", "protected_paths": ["verify.py"],
            "objective_weights": {
                "verified_outcome": 0.50, "boundary_integrity": 0.20,
                "causal_effect": 0.10, "efficiency": 0.05, "transfer": 0.15,
            },
            "evaluator": [sys.executable, "verify.py"],
            "actions": [
                {
                    "id": "set-two", "allowed_paths": ["value.txt"],
                    "patch": "--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-value=1\n+value=2\n",
                },
                {
                    "id": "set-three", "allowed_paths": ["value.txt"],
                    "patch": "--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-value=1\n+value=3\n",
                },
            ],
            "mutations": [
                {"id": "unmutated", "patch": "", "observation": "base state"},
                {
                    "id": "decoy-file",
                    "observation": "an unrelated plausible artifact appeared",
                    "patch": (
                        "--- /dev/null\n+++ b/decoy.txt\n@@ -0,0 +1 @@\n"
                        "+value=2 but this file is not authoritative\n"
                    ),
                },
                {
                    "id": "relocated-context",
                    "observation": "context metadata moved without changing the evaluator",
                    "patch": (
                        "--- /dev/null\n+++ b/context.meta\n@@ -0,0 +1 @@\n"
                        "+location=unknown\n"
                    ),
                },
            ],
        }
        manifest_path = root / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        receipt = execute(
            argparse.Namespace(
                manifest=str(manifest_path), output=str(root / "output"), policy_model=None,
                policy_device="cpu", timeout=10.0,
            )
        )
        assert receipt["branches"] == 6 and receipt["verified_successes"] == 3
        episodes = read_rows(root / "output/episodes.jsonl")
        assert len(episodes) == 3
        step = episodes[0]["steps"][0]
        assert step["return"] > step["counterfactuals"][0]["return"]
        assert step["objective_components"]["transfer"] == 0.8
        print(stable({"selftest": "passed", "receipt_digest": receipt["receipt_digest"]}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest")
    parser.add_argument("--output")
    parser.add_argument("--policy-model")
    parser.add_argument("--policy-device", default="cpu")
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return
    if not args.manifest or not args.output:
        parser.error("--manifest and --output are required unless --selftest is used")
    execute(args)


if __name__ == "__main__":
    main()
