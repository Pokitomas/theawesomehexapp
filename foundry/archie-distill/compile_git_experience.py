#!/usr/bin/env python3
"""Compile real Git history into causal before->change->after experience pairs."""
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile
from collections import Counter, defaultdict
from typing import Any

SCHEMA = "archie-git-experience/v1"
RECEIPT_SCHEMA = "archie-git-experience-receipt/v1"
CAUSAL_EVENT_SCHEMA = "archie-causal-event-patch/v1"
TEXT_SUFFIXES = {
    ".c", ".cc", ".cpp", ".css", ".go", ".h", ".hpp", ".html", ".ini",
    ".java", ".js", ".json", ".jsonl", ".jsx", ".kt", ".lua", ".md",
    ".mjs", ".py", ".rb", ".rs", ".rst", ".scss", ".sh", ".sql", ".toml",
    ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
}
TEXT_NAMES = {
    "Dockerfile", "GNUmakefile", "Kconfig", "LICENSE", "Makefile", "README",
    "meson.build",
}
ZERO_SHA = "0" * 40


def stable(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: Any) -> str:
    payload = value if isinstance(value, bytes) else stable(value).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1 << 20):
            value.update(block)
    return value.hexdigest()


def git(repo: pathlib.Path, *arguments: str, input_bytes: bytes | None = None) -> bytes:
    completed = subprocess.run(
        ["git", "-C", str(repo), *arguments], input=input_bytes,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if completed.returncode:
        error = completed.stderr.decode("utf-8", errors="replace").strip()
        raise SystemExit(f"git {' '.join(arguments)} failed: {error}")
    return completed.stdout


class GitObjects:
    def __init__(self, repo: pathlib.Path) -> None:
        self.process = subprocess.Popen(
            ["git", "-C", str(repo), "cat-file", "--batch"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )

    def read(self, object_id: str) -> tuple[str, bytes]:
        if self.process.stdin is None or self.process.stdout is None:
            raise RuntimeError("git object reader is closed")
        self.process.stdin.write(object_id.encode("ascii") + b"\n")
        self.process.stdin.flush()
        header = self.process.stdout.readline().decode("ascii", errors="replace").strip()
        fields = header.split()
        if len(fields) == 2 and fields[1] == "missing":
            raise SystemExit(f"missing Git object {object_id}")
        if len(fields) != 3:
            raise SystemExit(f"invalid git cat-file response for {object_id}: {header}")
        object_type, size = fields[1], int(fields[2])
        content = self.process.stdout.read(size)
        if self.process.stdout.read(1) != b"\n":
            raise SystemExit(f"invalid git cat-file terminator for {object_id}")
        return object_type, content

    def close(self) -> None:
        if self.process.stdin is not None:
            self.process.stdin.close()
        self.process.wait(timeout=10)
        if self.process.returncode:
            error = b"" if self.process.stderr is None else self.process.stderr.read()
            raise SystemExit(error.decode("utf-8", errors="replace"))


def parse_commit(content: bytes) -> dict[str, Any]:
    header, _, message = content.partition(b"\n\n")
    parents: list[str] = []
    tree = author_time = ""
    for line in header.splitlines():
        if line.startswith(b"tree "):
            tree = line[5:].decode("ascii")
        elif line.startswith(b"parent "):
            parents.append(line[7:].decode("ascii"))
        elif line.startswith(b"author "):
            fields = line.rsplit(b" ", 2)
            if len(fields) == 3:
                author_time = fields[-2].decode("ascii", errors="replace")
    return {
        "tree": tree,
        "parents": parents,
        "author_time": author_time,
        "message": message.decode("utf-8", errors="replace").strip(),
    }


def parse_raw_changes(raw: bytes) -> list[dict[str, str]]:
    fields = raw.split(b"\0")
    changes: list[dict[str, str]] = []
    index = 0
    while index < len(fields):
        metadata = fields[index]
        index += 1
        if not metadata:
            continue
        if not metadata.startswith(b":"):
            raise SystemExit("unexpected git diff-tree record")
        values = metadata[1:].decode("ascii").split()
        if len(values) != 5:
            raise SystemExit("invalid git diff-tree metadata")
        old_mode, new_mode, old_sha, new_sha, status = values
        if index >= len(fields):
            raise SystemExit("git diff-tree record has no path")
        old_path = fields[index].decode("utf-8", errors="surrogateescape")
        index += 1
        new_path = old_path
        if status[:1] in {"R", "C"}:
            if index >= len(fields):
                raise SystemExit("git rename record has no destination")
            new_path = fields[index].decode("utf-8", errors="surrogateescape")
            index += 1
        changes.append({
            "old_mode": old_mode, "new_mode": new_mode, "old_sha": old_sha,
            "new_sha": new_sha, "status": status, "old_path": old_path,
            "new_path": new_path,
        })
    return changes


def likely_text(path: str, content: bytes) -> bool:
    name = pathlib.PurePosixPath(path).name
    suffix = pathlib.PurePosixPath(path).suffix.lower()
    if suffix not in TEXT_SUFFIXES and name not in TEXT_NAMES:
        return False
    if b"\0" in content[:4096]:
        return False
    decoded = content.decode("utf-8", errors="replace")
    if not decoded.strip():
        return False
    return decoded.count("\ufffd") / max(len(decoded), 1) < 0.01


def read_blob(objects: GitObjects, object_id: str, maximum: int) -> bytes | None:
    if object_id == ZERO_SHA:
        return b""
    object_type, content = objects.read(object_id)
    if object_type != "blob" or len(content) > maximum:
        return None
    return content


def unified_patch(old_path: str, new_path: str, before: str, after: str) -> str:
    return "".join(difflib.unified_diff(
        before.splitlines(keepends=True), after.splitlines(keepends=True),
        fromfile=f"a/{old_path}", tofile=f"b/{new_path}", n=3,
    ))


def prompt_for(repository: str, commit: str, parent: str | None, message: str,
               status: str, old_path: str, new_path: str, before: str) -> str:
    identity = {
        "repository": repository,
        "parent": parent or ZERO_SHA,
        "commit": commit,
        "status": status,
        "old_path": old_path,
        "new_path": new_path,
    }
    return (
        "ARCHIE_GIT_TRANSITION_V1\n"
        f"{stable(identity)}\n"
        "HUMAN_COMMIT_MESSAGE\n"
        f"{message}\n"
        "PARENT_FILE\n"
        f"{before}\n"
        "VERIFIED_PATCH\n"
    )


def choose_rejected(row: dict[str, Any], candidates: list[dict[str, Any]]) -> dict[str, Any]:
    path = pathlib.PurePosixPath(row["new_path"] or row["old_path"])
    suffix = path.suffix.lower() or path.name
    logical_path = row["new_path"] or row["old_path"]
    pools = [
        [item for item in candidates if item["commit"] != row["commit"] and item["chosen_target"] != row["chosen_target"] and (item["new_path"] or item["old_path"]) == logical_path and item["status"][:1] == row["status"][:1]],
        [item for item in candidates if item["commit"] != row["commit"] and item["chosen_target"] != row["chosen_target"] and (item["new_path"] or item["old_path"]) == logical_path],
        [item for item in candidates if item["commit"] != row["commit"] and item["chosen_target"] != row["chosen_target"] and item["suffix"] == suffix and item["status"][:1] == row["status"][:1]],
        [item for item in candidates if item["commit"] != row["commit"] and item["chosen_target"] != row["chosen_target"] and item["suffix"] == suffix],
        [item for item in candidates if item["commit"] != row["commit"] and item["chosen_target"] != row["chosen_target"]],
    ]
    for pool in pools:
        if pool:
            return min(pool, key=lambda item: (
                abs(len(item["chosen_target"]) - len(row["chosen_target"])),
                digest({"episode": row["episode_id"], "candidate": item["episode_id"]}),
            ))
    raise SystemExit(f"split {row['split']} has no counterfactual candidate")


def causal_event_patch(row: dict[str, Any], rejected: dict[str, Any]) -> dict[str, Any]:
    logical_path = row["new_path"] or row["old_path"]
    belief_key = f"repository-file:{row['repository']}:{logical_path}"
    before_exists = row["old_blob"] != ZERO_SHA
    after_exists = row["new_blob"] != ZERO_SHA
    operation = "revise"
    if not before_exists:
        operation = "assert"
    elif not after_exists:
        operation = "retire"
    chosen_action_id = f"patch:{digest(row['chosen_target'])[:24]}"
    rejected_action_id = f"patch:{digest(rejected['chosen_target'])[:24]}"
    event = {
        "schema": CAUSAL_EVENT_SCHEMA,
        "belief_before": {
            "claims": [{
                "key": belief_key,
                "value": {"exists": before_exists, "git_blob": row["old_blob"]},
                "confidence": 1.0,
                "provenance": {"parent_commit": row["parent"] or ZERO_SHA},
            }],
        },
        "observation": {
            "kind": "committed-repository-transition",
            "commit": row["commit"],
            "parent": row["parent"] or ZERO_SHA,
            "human_message_sha256": digest(row["prompt"].split("HUMAN_COMMIT_MESSAGE\n", 1)[-1].split("\nPARENT_FILE\n", 1)[0]),
        },
        "candidate_actions": [
            {
                "action_id": chosen_action_id,
                "protocol": "git-apply-unified-diff/v1",
                "target_field": "chosen_target",
                "patch_sha256": digest(row["chosen_target"]),
                "verified_against_observed_successor": True,
            },
            {
                "action_id": rejected_action_id,
                "protocol": "git-apply-unified-diff/v1",
                "target_field": "rejected_target",
                "patch_sha256": digest(rejected["chosen_target"]),
                "verified_against_observed_successor": False,
            },
            {
                "action_id": "abstain",
                "protocol": "no-operation/v1",
                "verified_against_observed_successor": False,
            },
        ],
        "predicted_effects": {
            chosen_action_id: {
                "belief_key": belief_key,
                "exists": after_exists,
                "git_blob": row["new_blob"],
            },
            rejected_action_id: {"status": "unknown-unexecuted"},
            "abstain": {"git_blob": row["old_blob"]},
        },
        "chosen_action_id": chosen_action_id,
        "world_after": {
            "commit": row["commit"],
            "tree": row["tree"],
            "file": {"path": logical_path, "exists": after_exists, "git_blob": row["new_blob"]},
        },
        "belief_patch": [{
            "operation": operation,
            "key": belief_key,
            "before": {"exists": before_exists, "git_blob": row["old_blob"]},
            "after": {"exists": after_exists, "git_blob": row["new_blob"]},
            "confidence": 1.0,
        }],
        "receipts": {
            "chosen_patch_sha256": digest(row["chosen_target"]),
            "source_git_blob": row["old_blob"],
            "successor_git_blob": row["new_blob"],
            "successor_tree": row["tree"],
        },
        "counterfactual_credit": {
            "status": "contrast-only-unexecuted",
            "rejected_action_id": rejected_action_id,
            "claim_boundary": "The rejected patch is a real patch from the same temporal split, not a measured outcome in this state.",
        },
    }
    event["event_digest"] = digest(event)
    return event


def inject_causal_context(prompt: str, event: dict[str, Any]) -> str:
    marker = "VERIFIED_PATCH\n"
    if not prompt.endswith(marker):
        raise SystemExit("Git transition prompt is missing its patch marker")
    visible = {
        "belief_before": event["belief_before"],
        "observation": event["observation"],
        "candidate_actions": event["candidate_actions"],
        "predicted_effects": event["predicted_effects"],
    }
    return prompt[:-len(marker)] + f"CAUSAL_EVENT_CONTEXT\n{stable(visible)}\n{marker}"


def compile_repository(
    repo: pathlib.Path, *, holdout_rate: float, max_commits: int,
    max_files_per_commit: int, max_file_bytes: int, max_patch_bytes: int,
    history_mode: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    repo = repo.resolve()
    git(repo, "rev-parse", "--is-inside-work-tree")
    revision_args = ["rev-list", "--reverse", "--topo-order"]
    if history_mode == "first-parent":
        revision_args.append("--first-parent")
    revision_args.append("HEAD")
    commits = git(repo, *revision_args).decode("ascii").split()
    if max_commits > 0:
        commits = commits[-max_commits:]
    remote_query = subprocess.run(
        ["git", "-C", str(repo), "config", "--get", "remote.origin.url"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    remote = remote_query.stdout.decode("utf-8", errors="replace").strip()
    repository = remote or repo.name
    objects = GitObjects(repo)
    commit_records: list[dict[str, Any]] = []
    skipped = Counter()
    try:
        for order, commit in enumerate(commits):
            object_type, commit_bytes = objects.read(commit)
            if object_type != "commit":
                raise SystemExit(f"{commit} is not a commit object")
            metadata = parse_commit(commit_bytes)
            if len(metadata["parents"]) > 1:
                skipped["merge_commit"] += 1
                continue
            parent = metadata["parents"][0] if metadata["parents"] else None
            raw = git(
                repo, "diff-tree", "--root", "--no-commit-id", "-r", "-M",
                "--raw", "-z", commit,
            )
            accepted = 0
            for change in parse_raw_changes(raw):
                if accepted >= max_files_per_commit:
                    skipped["per_commit_file_cap"] += 1
                    continue
                if change["old_mode"] == "160000" or change["new_mode"] == "160000":
                    skipped["submodule"] += 1
                    continue
                before_bytes = read_blob(objects, change["old_sha"], max_file_bytes)
                after_bytes = read_blob(objects, change["new_sha"], max_file_bytes)
                if before_bytes is None or after_bytes is None:
                    skipped["file_too_large"] += 1
                    continue
                probe_path = change["new_path"] if after_bytes else change["old_path"]
                probe_bytes = after_bytes if after_bytes else before_bytes
                if not likely_text(probe_path, probe_bytes):
                    skipped["non_text"] += 1
                    continue
                before = before_bytes.decode("utf-8", errors="replace")
                after = after_bytes.decode("utf-8", errors="replace")
                patch = unified_patch(change["old_path"], change["new_path"], before, after)
                patch_bytes = patch.encode("utf-8")
                if not patch or len(patch_bytes) > max_patch_bytes:
                    skipped["patch_too_large_or_empty"] += 1
                    continue
                episode_identity = {
                    "repository": repository, "commit": commit,
                    "old_path": change["old_path"], "new_path": change["new_path"],
                    "old_blob": change["old_sha"], "new_blob": change["new_sha"],
                }
                episode_id = f"git_{digest(episode_identity)[:32]}"
                prompt = prompt_for(
                    repository, commit, parent, metadata["message"], change["status"],
                    change["old_path"], change["new_path"], before,
                )
                commit_records.append({
                    "schema": SCHEMA, "episode_id": episode_id, "group_id": commit,
                    "repository": repository, "commit": commit, "parent": parent,
                    "tree": metadata["tree"], "author_time": metadata["author_time"],
                    "order": order, "status": change["status"],
                    "old_path": change["old_path"], "new_path": change["new_path"],
                    "old_blob": change["old_sha"], "new_blob": change["new_sha"],
                    "suffix": pathlib.PurePosixPath(probe_path).suffix.lower() or pathlib.PurePosixPath(probe_path).name,
                    "prompt": prompt, "chosen_target": patch,
                    "actual_source_bytes": len(before_bytes) + len(patch_bytes) + len(metadata["message"].encode("utf-8")),
                })
                accepted += 1
            if accepted == 0:
                skipped["commit_without_episode"] += 1
    finally:
        objects.close()
    if len(commit_records) < 4:
        raise SystemExit("fewer than four real Git experience episodes survived filtering")
    groups = sorted({(row["order"], row["commit"]) for row in commit_records})
    development_groups = max(1, round(len(groups) * holdout_rate))
    development_commits = {commit for _, commit in groups[-development_groups:]}
    for row in commit_records:
        row["split"] = "development" if row["commit"] in development_commits else "train"
    split_rows = {
        split: [row for row in commit_records if row["split"] == split]
        for split in ("train", "development")
    }
    for split, rows in split_rows.items():
        if len(rows) < 2:
            raise SystemExit(f"{split} split needs at least two real episodes")
        for row in rows:
            rejected = choose_rejected(row, rows)
            row["rejected_episode_id"] = rejected["episode_id"]
            row["rejected_target"] = rejected["chosen_target"]
            row["causal_event_patch"] = causal_event_patch(row, rejected)
            row["prompt"] = inject_causal_context(row["prompt"], row["causal_event_patch"])
            body = dict(row)
            row["episode_digest"] = digest(body)
    train = sorted(split_rows["train"], key=lambda row: row["episode_id"])
    development = sorted(split_rows["development"], key=lambda row: row["episode_id"])
    head = git(repo, "rev-parse", "HEAD").decode("ascii").strip()
    receipt_body = {
        "schema": RECEIPT_SCHEMA,
        "repository": repository,
        "repository_path": str(repo),
        "head": head,
        "history_mode": history_mode,
        "configuration": {
            "holdout_rate": holdout_rate, "max_commits": max_commits,
            "max_files_per_commit": max_files_per_commit,
            "max_file_bytes": max_file_bytes, "max_patch_bytes": max_patch_bytes,
        },
        "counts": {
            "commits_considered": len(commits),
            "commit_groups": len(groups),
            "episodes": len(commit_records), "train": len(train),
            "development": len(development), "skipped": dict(sorted(skipped.items())),
        },
        "status_counts": dict(sorted(Counter(row["status"][:1] for row in commit_records).items())),
        "suffix_counts": dict(sorted(Counter(row["suffix"] for row in commit_records).items())),
        "episode_digests": [row["episode_digest"] for row in sorted(commit_records, key=lambda row: row["episode_id"])],
        "source_policy": {
            "language_model_generated_rows": 0,
            "semantic_payload": "real Git commit messages, parent blobs, successor blobs, and deterministic unified diffs",
            "counterfactuals": "targets from other real commits in the same temporal split",
            "causal_event_patches": "typed belief-before, candidate-action, observed-world-after, belief-revision, and receipt records derived from Git objects",
        },
        "claim_boundary": "These are deterministic observations of committed repository transitions. They are not proof that a commit was correct, deployed, or causally sufficient by itself.",
    }
    receipt = {**receipt_body, "receipt_digest": digest(receipt_body)}
    return train, development, receipt


def write_jsonl(path: pathlib.Path, rows: list[dict[str, Any]]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(stable(row) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def compile_to(output: pathlib.Path, repo: pathlib.Path, args: argparse.Namespace) -> dict[str, Any]:
    if output.exists():
        raise SystemExit(f"refusing to overwrite existing output: {output}")
    output.mkdir(parents=True)
    train, development, receipt = compile_repository(
        repo, holdout_rate=args.holdout_rate, max_commits=args.max_commits,
        max_files_per_commit=args.max_files_per_commit,
        max_file_bytes=args.max_file_bytes, max_patch_bytes=args.max_patch_bytes,
        history_mode=args.history_mode,
    )
    train_path = output / "git-experience.train.jsonl"
    development_path = output / "git-experience.development.jsonl"
    write_jsonl(train_path, train)
    write_jsonl(development_path, development)
    receipt["artifacts"] = {
        "train": {"path": str(train_path), "sha256": sha256_file(train_path)},
        "development": {"path": str(development_path), "sha256": sha256_file(development_path)},
    }
    body = dict(receipt)
    body.pop("receipt_digest", None)
    receipt["receipt_digest"] = digest(body)
    receipt_path = output / "git-experience-receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return receipt


def selftest() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = pathlib.Path(temporary)
        repo = root / "repo"
        repo.mkdir()
        git(repo, "init")
        for index in range(10):
            path = repo / f"module-{index % 3}.py"
            prior = path.read_text(encoding="utf-8") if path.exists() else ""
            path.write_text(prior + f"def value_{index}():\n    return {index}\n", encoding="utf-8")
            git(repo, "add", ".")
            git(
                repo, "-c", "user.name=Archie Test", "-c", "user.email=archie@example.invalid",
                "commit", "-m", f"Add observed value {index}",
            )
        args = argparse.Namespace(
            holdout_rate=0.3, max_commits=0, max_files_per_commit=4,
            max_file_bytes=4096, max_patch_bytes=4096, history_mode="all",
        )
        receipt = compile_to(root / "out", repo, args)
        assert receipt["counts"]["episodes"] == 10
        assert receipt["source_policy"]["language_model_generated_rows"] == 0
        rows = [json.loads(line) for line in (root / "out" / "git-experience.train.jsonl").read_text(encoding="utf-8").splitlines()]
        assert all(row["chosen_target"] != row["rejected_target"] for row in rows)
        assert all(row["causal_event_patch"]["schema"] == CAUSAL_EVENT_SCHEMA for row in rows)
        assert all("CAUSAL_EVENT_CONTEXT" in row["prompt"] for row in rows)
        assert all(row["causal_event_patch"]["counterfactual_credit"]["status"] == "contrast-only-unexecuted" for row in rows)
        print(json.dumps({"selftest": "passed", **receipt["counts"]}, indent=2, sort_keys=True))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", default=".")
    parser.add_argument("--output")
    parser.add_argument("--holdout-rate", type=float, default=0.15)
    parser.add_argument("--max-commits", type=int, default=0)
    parser.add_argument("--max-files-per-commit", type=int, default=6)
    parser.add_argument("--max-file-bytes", type=int, default=16_384)
    parser.add_argument("--max-patch-bytes", type=int, default=16_384)
    parser.add_argument("--history-mode", choices=["all", "first-parent"], default="all")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return
    if not args.output:
        parser.error("--output is required")
    if not 0 < args.holdout_rate < 0.5:
        parser.error("--holdout-rate must be in (0, 0.5)")
    for name in ("max_files_per_commit", "max_file_bytes", "max_patch_bytes"):
        if getattr(args, name) < 1:
            parser.error(f"--{name.replace('_', '-')} must be positive")
    receipt = compile_to(
        pathlib.Path(args.output).resolve(), pathlib.Path(args.repository).resolve(), args,
    )
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
