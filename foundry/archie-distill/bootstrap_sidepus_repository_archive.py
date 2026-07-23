#!/usr/bin/env python3
"""Build and ingest a provenance-bound Sidepus WARC from a tracked repository snapshot."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import mimetypes
import pathlib
import re
import subprocess
import sys
import urllib.parse
from typing import Any

from foundry.sidepus.acquisition import discover_local_archives
from foundry.sidepus.catalog import Catalog, atomic_json, digest_json, sha256_file
from foundry.sidepus.governance import bind_pending_jobs, run_governed_worker

CONTENT_POLICY_SCHEMA = "sidepus-content-policy/v2"
RIGHTS_SCHEMA = "sidepus-rights-decision/v1"
BOOTSTRAP_SCHEMA = "sidepus-repository-archive-bootstrap/v1"
MANIFEST_SCHEMA = "sidepus-windows-git-manifest/v1"
SYNTHETIC_HOST = "repository.archive.sidepus.invalid"
HEX40 = re.compile(r"^[0-9a-f]{40}$")

TEXT_SUFFIXES = {
    ".bash", ".c", ".cc", ".cfg", ".conf", ".cpp", ".css", ".csv", ".cxx",
    ".go", ".h", ".hpp", ".html", ".ini", ".java", ".js", ".jsx", ".json",
    ".kt", ".kts", ".md", ".mjs", ".php", ".plist", ".ps1", ".py", ".pyi",
    ".rb", ".rs", ".rst", ".scala", ".sh", ".sql", ".swift", ".toml", ".ts",
    ".tsx", ".txt", ".xml", ".yaml", ".yml", ".zsh",
}


def run(repo: pathlib.Path, *args: str, binary: bool = False) -> bytes | str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return result.stdout if binary else result.stdout.decode("utf-8", errors="strict").strip()


def tracked_paths(repo: pathlib.Path) -> list[pathlib.Path]:
    raw = run(repo, "ls-files", "-z", binary=True)
    assert isinstance(raw, bytes)
    result: list[pathlib.Path] = []
    for encoded in raw.split(b"\0"):
        if not encoded:
            continue
        relative = pathlib.PurePosixPath(encoded.decode("utf-8", errors="strict"))
        path = repo.joinpath(*relative.parts)
        if path.is_file():
            result.append(path)
    return result


def load_repository_manifest(
    repo: pathlib.Path, manifest_path: pathlib.Path
) -> tuple[str, str, list[pathlib.Path], str]:
    manifest_path = manifest_path.expanduser().resolve()
    value = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict) or value.get("schema") != MANIFEST_SCHEMA:
        raise ValueError(f"repository manifest must use {MANIFEST_SCHEMA}")
    commit = str(value.get("commit", "")).lower()
    tree = str(value.get("tree", "")).lower()
    if not HEX40.fullmatch(commit) or not HEX40.fullmatch(tree):
        raise ValueError("repository manifest commit/tree must be lowercase 40-hex Git IDs")
    raw_paths = value.get("paths")
    if not isinstance(raw_paths, list) or not raw_paths:
        raise ValueError("repository manifest requires a nonempty paths list")
    paths: list[pathlib.Path] = []
    seen: set[str] = set()
    for raw in raw_paths:
        if not isinstance(raw, str) or not raw or "\x00" in raw:
            raise ValueError("repository manifest paths must be nonempty strings")
        relative = pathlib.PurePosixPath(raw)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError(f"unsafe repository manifest path: {raw!r}")
        normalized = relative.as_posix()
        if normalized in seen:
            raise ValueError(f"duplicate repository manifest path: {normalized}")
        seen.add(normalized)
        path = repo.joinpath(*relative.parts)
        if not path.is_file():
            raise ValueError(f"tracked repository file is missing: {normalized}")
        paths.append(path)
    return commit, tree, paths, sha256_file(manifest_path)


def media_type(path: pathlib.Path) -> str:
    suffix = path.suffix.lower()
    if suffix in TEXT_SUFFIXES or path.name in {"Dockerfile", "Makefile", "LICENSE"}:
        if suffix == ".json":
            return "application/json"
        if suffix in {".html", ".htm"}:
            return "text/html; charset=utf-8"
        if suffix == ".xml":
            return "application/xml"
        return "text/plain; charset=utf-8"
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def write_warc(
    repo: pathlib.Path,
    output: pathlib.Path,
    commit: str,
    paths: list[pathlib.Path],
) -> dict[str, Any]:
    try:
        from warcio.statusandheaders import StatusAndHeaders  # type: ignore
        from warcio.warcwriter import WARCWriter  # type: ignore
    except ImportError as error:
        raise RuntimeError("warcio is required; install it into ARCHIE_PYTHON first") from error

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.unlink(missing_ok=True)
    total_bytes = text_files = binary_files = 0
    with temporary.open("wb") as stream:
        writer = WARCWriter(stream, gzip=True)
        for path in paths:
            relative = path.relative_to(repo).as_posix()
            payload = path.read_bytes()
            mime = media_type(path)
            target = (
                f"https://{SYNTHETIC_HOST}/Pokitomas/theawesomehexapp/"
                f"{commit}/{urllib.parse.quote(relative, safe='/')}"
            )
            headers = StatusAndHeaders(
                "200 OK",
                [("Content-Type", mime), ("Content-Length", str(len(payload)))],
                protocol="HTTP/1.1",
            )
            record = writer.create_warc_record(
                target,
                "response",
                payload=io.BytesIO(payload),
                http_headers=headers,
                warc_headers_dict={
                    "WARC-Source-URI": f"git+https://github.com/Pokitomas/theawesomehexapp@{commit}#{relative}",
                    "WARC-Identified-Payload-Type": mime.split(";", 1)[0],
                },
            )
            writer.write_record(record)
            total_bytes += len(payload)
            if mime.startswith("text/") or mime.split(";", 1)[0] in {
                "application/json", "application/xml", "application/javascript"
            }:
                text_files += 1
            else:
                binary_files += 1
    temporary.replace(output)
    return {
        "files": len(paths),
        "text_files": text_files,
        "binary_files": binary_files,
        "source_bytes": total_bytes,
        "warc_bytes": output.stat().st_size,
        "warc_sha256": sha256_file(output),
    }


def stable_write(path: pathlib.Path, value: dict[str, Any]) -> None:
    if path.exists():
        existing = json.loads(path.read_text(encoding="utf-8"))
        if existing != value:
            raise RuntimeError(f"refusing to replace different sealed file: {path}")
        return
    atomic_json(path, value)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--rights-manifest", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--repository-manifest")
    args = parser.parse_args()

    repo = pathlib.Path(args.repo).expanduser().resolve()
    state = pathlib.Path(args.state_dir).expanduser().resolve()
    rights_path = pathlib.Path(args.rights_manifest).expanduser().resolve()
    receipt_path = pathlib.Path(args.receipt).expanduser().resolve()

    repository_manifest: str | None = None
    repository_manifest_sha256: str | None = None
    if args.repository_manifest:
        manifest_path = pathlib.Path(args.repository_manifest)
        if not manifest_path.is_absolute():
            manifest_path = repo / manifest_path
        commit, tree, paths, repository_manifest_sha256 = load_repository_manifest(
            repo, manifest_path
        )
        repository_manifest = str(manifest_path.resolve())
        identity_source = "windows-git-manifest"
    else:
        commit = str(run(repo, "rev-parse", "HEAD"))
        tree = str(run(repo, "rev-parse", "HEAD^{tree}"))
        dirty = str(run(repo, "status", "--porcelain=v1", "--untracked-files=no"))
        if dirty:
            raise SystemExit("tracked repository worktree is dirty; refusing ambiguous WARC snapshot")
        paths = tracked_paths(repo)
        identity_source = "native-git"

    archive = state / "source-archives" / f"theawesomehexapp-{commit}.warc.gz"
    if archive.exists():
        archive_metrics = {
            "warc_bytes": archive.stat().st_size,
            "warc_sha256": sha256_file(archive),
            "reused": True,
        }
    else:
        archive_metrics = {
            **write_warc(repo, archive, commit, paths),
            "reused": False,
        }

    policy = {
        "schema": CONTENT_POLICY_SCHEMA,
        "approved_by_operator": True,
        "scope": "one immutable tracked-repository snapshot",
        "repository": "Pokitomas/theawesomehexapp",
        "commit": commit,
        "tree": tree,
        "allowed_adapter": "local-archive",
        "allowed_target_host": SYNTHETIC_HOST,
        "disallowed_network_acquisition": True,
        "claim_boundary": (
            "This policy authorizes ingestion only of the operator-invoked local repository "
            "snapshot. It grants no permission for unrelated web or archive content."
        ),
    }
    rights = {
        "schema": RIGHTS_SCHEMA,
        "approved_by_operator": True,
        "repository": "Pokitomas/theawesomehexapp",
        "commit": commit,
        "synthetic_archive_host": SYNTHETIC_HOST,
        "rules": [
            {
                "host_suffix": SYNTHETIC_HOST,
                "adapter": "local-archive",
                "status": "operator-authorized-repository-snapshot",
                "label": "tracked-repository-bootstrap",
                "allow_training": True,
            }
        ],
        "claim_boundary": (
            "This manifest applies only to records generated from this tracked repository "
            "snapshot and does not authorize third-party archive records."
        ),
    }
    stable_write(rights_path, rights)

    with Catalog(state) as catalog:
        policy_digest = catalog.install_policy("content", policy)
        discovered = discover_local_archives(
            catalog,
            [archive],
            source_id=f"repository-snapshot:Pokitomas/theawesomehexapp@{commit}",
        )
        bound = bind_pending_jobs(catalog, policy_digest)
        worker = run_governed_worker(
            catalog,
            owner="repository-bootstrap",
            limit=max(1, int(discovered["inserted"])),
            quarantine_after_attempts=1,
        )
        snapshot = catalog.snapshot()
        warc_records = int(
            catalog.connection.execute("SELECT COUNT(*) FROM warc_records").fetchone()[0]
        )

    if worker["failed"] or worker["quarantined"]:
        raise SystemExit(json.dumps(worker, indent=2, sort_keys=True))
    if warc_records < 1:
        raise SystemExit("repository WARC ingestion produced no indexed records")

    receipt = {
        "schema": BOOTSTRAP_SCHEMA,
        "repository": str(repo),
        "repository_identity": "Pokitomas/theawesomehexapp",
        "repository_identity_source": identity_source,
        "repository_manifest": repository_manifest,
        "repository_manifest_sha256": repository_manifest_sha256,
        "commit": commit,
        "tree": tree,
        "tracked_files": len(paths),
        "archive": str(archive),
        "archive_metrics": archive_metrics,
        "content_policy_digest": policy_digest,
        "rights_manifest": str(rights_path),
        "rights_manifest_sha256": sha256_file(rights_path),
        "discovery": discovered,
        "jobs_bound": bound,
        "worker": worker,
        "warc_records": warc_records,
        "catalog": snapshot,
        "claim_boundary": (
            "This creates a real Sidepus archive substrate from repository records. It is a "
            "bootstrap corpus, not evidence that broad civilization-scale web ingestion exists."
        ),
    }
    receipt["receipt_digest"] = digest_json(receipt)
    atomic_json(receipt_path, receipt)
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
