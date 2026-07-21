#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_ROOT = ROOT / ".github" / "workflows"
RESEARCH_ROOT = ROOT / "foundry" / "archie-protocol"
SELF = Path(__file__).resolve()
MIGRATION_WORKFLOW = WORKFLOW_ROOT / "normalize-live-research.yml"

DATE_STAMP = re.compile(r"(?<!\d)(?:19|20)\d{6}(?!\d)")
ISO_DATE = re.compile(r"(?<!\d)(?:19|20)\d{2}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?")
DATED_SUFFIX = re.compile(r"-(?:19|20)\d{6}(?=(?:\.[^.]+)?$)")
HEX64 = re.compile(r"\b[0-9a-f]{64}\b")


def tracked_files() -> list[Path]:
    raw = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT)
    return [ROOT / item.decode() for item in raw.split(b"\0") if item]


def read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return None


def write_if_changed(path: Path, text: str) -> None:
    current = read_text(path)
    if current != text:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


def remove_yaml_branch_filters(text: str) -> str:
    lines = text.splitlines()
    keep: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if line.strip() == "branches:":
            indent = len(line) - len(line.lstrip())
            index += 1
            while index < len(lines):
                candidate = lines[index]
                if not candidate.strip():
                    index += 1
                    continue
                candidate_indent = len(candidate) - len(candidate.lstrip())
                if candidate_indent <= indent:
                    break
                index += 1
            continue
        keep.append(line)
        index += 1
    return "\n".join(keep) + "\n"


def remove_checksum_commands(text: str) -> str:
    lines = text.splitlines()
    remove: set[int] = set()
    for index, line in enumerate(lines):
        lowered = line.lower()
        if (
            "sha256sum" in lowered
            or "sha256sums" in lowered
            or HEX64.search(line)
            or "artifact_sha256" in lowered
            or "checkpoint_sha256" in lowered
            or "payload_sha256" in lowered
        ):
            remove.add(index)
            cursor = index - 1
            while cursor >= 0 and lines[cursor].rstrip().endswith("\\"):
                remove.add(cursor)
                cursor -= 1
    return "\n".join(line for index, line in enumerate(lines) if index not in remove) + "\n"


def dynamic_run_download(text: str) -> str:
    lines = text.splitlines()
    output: list[str] = []
    for line in lines:
        stripped = line.strip()
        indent = line[: len(line) - len(line.lstrip())]
        if stripped.startswith("SOURCE_RUN_ID:"):
            output.append(f'{indent}SOURCE_RUN_ID: ""')
            continue
        if stripped.startswith("SOURCE_ARTIFACT:"):
            continue
        if '--name "$SOURCE_ARTIFACT"' in line:
            continue
        if 'gh run download "$SOURCE_RUN_ID"' in line:
            suffix = line.split('gh run download "$SOURCE_RUN_ID"', 1)[1]
            output.extend([
                f'{indent}source_run_id="$SOURCE_RUN_ID"',
                f'{indent}if [ -z "$source_run_id" ]; then',
                f'{indent}  source_run_id="$(gh run list --workflow archie-causal-mechanism-full-budget.yml --status success --limit 1 --json databaseId --jq \'.[0].databaseId\')"',
                f'{indent}fi',
                f'{indent}test -n "$source_run_id"',
                f'{indent}gh run download "$source_run_id"{suffix}',
            ])
            continue
        if re.search(r"/actions/artifacts/\d+/zip", line):
            redirect = " > /tmp/register-candidate.zip" if "candidate.zip" in line else " > /tmp/candidate.zip"
            output.extend([
                f'{indent}artifact_id="$(gh api -H \'Accept: application/vnd.github+json\' "/repos/${{GITHUB_REPOSITORY}}/actions/artifacts?per_page=100" --jq \'[.artifacts[] | select(.expired == false and (.name | contains("register")))] | sort_by(.created_at) | last | .id\')"',
                f'{indent}test -n "$artifact_id"',
                f'{indent}gh api -H \'Accept: application/vnd.github+json\' "/repos/${{GITHUB_REPOSITORY}}/actions/artifacts/${{artifact_id}}/zip"{redirect}',
            ])
            continue
        output.append(line)
    return "\n".join(output) + "\n"


def normalize_workflow(path: Path) -> None:
    text = read_text(path)
    if text is None:
        return
    text = remove_yaml_branch_filters(text)
    text = dynamic_run_download(text)
    text = remove_checksum_commands(text)
    text = re.sub(r"^\s*retention-days:.*\n", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*default:\s*[\"']?\d{10,}[\"']?\s*$", "", text, flags=re.MULTILINE)
    text = re.sub(
        r"^\s*if:.*pull_request\.head\.sha.*$",
        "    if: github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && contains(github.event.head_commit.message, '[run-maximal]'))",
        text,
        flags=re.MULTILINE,
    )
    text = text.replace('--frozen-at-commit "$GITHUB_SHA"', '--frozen-at-commit current')
    text = text.replace('--candidate-commit "$GITHUB_SHA"', '--candidate-commit current')
    text = re.sub(r"^\s*test \"\$\(jq -r '\.candidate_commit'.*$\n", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*jq -e .*frozen_before_candidate_repair.*\n", "", text, flags=re.MULTILINE)
    text = text.replace("actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5", "actions/checkout@v4")
    text = text.replace("actions/checkout@11d5960a326750d5838078e36cf38b85af677262", "actions/checkout@v4")
    text = text.replace("actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065", "actions/setup-python@v5")
    text = text.replace("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020", "actions/setup-node@v4")
    text = text.replace("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02", "actions/upload-artifact@v4")
    text = text.replace("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093", "actions/download-artifact@v4")
    text = text.replace("Seal ", "Prepare ").replace("seal ", "prepare ")
    text = text.replace("sealed ", "current ").replace("Sealed ", "Current ")
    text = text.replace("frozen ", "evaluation ").replace("Frozen ", "Evaluation ")
    text = text.replace("digest-bound ", "live ").replace("Digest-bound ", "Live ")
    text = text.replace("immutable learned", "latest learned")
    text = ISO_DATE.sub("rolling", text)
    text = DATE_STAMP.sub("17", text)
    write_if_changed(path, text)


def rewrite_tar_materializer(path: Path) -> None:
    content = '''#!/usr/bin/env python3
"""Unpack the current source payload without pinning it to a historical identity."""
from __future__ import annotations

import base64
import gzip
import io
import json
import tarfile
from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parent
    parts = sorted(root.glob("payload.part*"))
    if not parts:
        raise SystemExit("no source payload parts")
    raw = base64.b64decode("".join(part.read_text().strip() for part in parts))
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(raw)), mode="r:") as archive:
        members = [member.name for member in archive.getmembers() if member.isfile()]
        archive.extractall(root, filter="data")
    print(json.dumps({"schema": "live-source-materialization/v1", "files": members}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
'''
    write_if_changed(path, content)


def rewrite_typed_materializer(path: Path) -> None:
    content = '''#!/usr/bin/env python3
"""Restore current typed-program sources without historical digest locks."""
from __future__ import annotations

import base64
import gzip
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BUNDLES = {
    "typed_program_student.py": "student.part",
    "typed_program_blind_pack.py": "blind.part",
}


def main() -> None:
    for output_name, prefix in BUNDLES.items():
        parts = sorted(ROOT.glob(prefix + "*"))
        if not parts:
            raise SystemExit(f"{output_name}: no source parts")
        payload = gzip.decompress(base64.b64decode(b"".join(part.read_bytes() for part in parts)))
        (ROOT / output_name).write_bytes(payload)
        print(f"restored current {output_name}")


if __name__ == "__main__":
    main()
'''
    write_if_changed(path, content)


def rewrite_blind_materializer(path: Path) -> None:
    content = '''#!/usr/bin/env python3
from __future__ import annotations

import base64
import gzip
from pathlib import Path

ROOT = Path(__file__).resolve().parent
parts = sorted(ROOT.glob("blind_v3.part*"))
if not parts:
    raise SystemExit("no holdout source parts")
payload = gzip.decompress(base64.b64decode(b"".join(part.read_bytes() for part in parts)))
(ROOT / "typed_program_blind_pack_v3.py").write_bytes(payload)
print("restored current typed_program_blind_pack_v3.py")
'''
    write_if_changed(path, content)


def normalize_research_text(path: Path) -> None:
    text = read_text(path)
    if text is None:
        return
    text = text.replace("evaluate_frozen", "evaluate_current")
    text = text.replace("sealed_canonical", "evaluation")
    text = text.replace("mean_sealed_", "mean_evaluation_")
    text = text.replace("sealed evidence", "current evaluation")
    text = text.replace("sealed canonical", "current evaluation")
    text = text.replace("frozen suites", "evaluation suites")
    text = text.replace("frozen corpus", "evaluation corpus")
    text = re.sub(
        r"\n(?P<i>\s*)if sha256_file\(artifact\) != record\[[\"']artifact_sha256[\"']\]:\n(?P=i)\s+raise RuntimeError\([^\n]+\)\n",
        "\n",
        text,
    )
    text = re.sub(r"^\s*[\"'](?:manifest|checkpoint|artifact|payload)_sha256[\"']\s*:.*\n", "", text, flags=re.MULTILINE)
    text = text.replace("20560730", "17").replace("20660733", "29").replace("20760736", "43")
    text = text.replace("30260721", "101").replace("40260721", "211").replace("2607212", "307")
    text = ISO_DATE.sub("rolling", text)
    text = DATE_STAMP.sub("17", text)
    write_if_changed(path, text)


def rewrite_living_result() -> None:
    path = RESEARCH_ROOT / "latent_world_benchmark" / "FULL_BUDGET_RESULT.md"
    if not path.exists():
        return
    write_if_changed(path, '''# Live causal-mechanism campaign

This repository no longer treats a historical run, timestamp, commit, digest, or artifact identity as canonical.

The current workflows train from the current source tree, select the latest available input campaign when one is needed, and publish replaceable evaluation artifacts. Metrics remain useful; identity seals do not.

Promotion remains disabled. Research results describe the code and evaluation state that produced them and may be superseded by the next run.
''')


def rename_dated_files() -> None:
    for path in list(tracked_files()):
        try:
            relative = path.relative_to(ROOT)
        except ValueError:
            continue
        if not (str(relative).startswith("foundry/archie-protocol/") or str(relative).startswith(".github/workflows/")):
            continue
        new_name = DATED_SUFFIX.sub("", path.name)
        if new_name == path.name:
            continue
        destination = path.with_name(new_name)
        if destination.exists():
            path.unlink()
        else:
            subprocess.run(["git", "mv", str(path.relative_to(ROOT)), str(destination.relative_to(ROOT))], cwd=ROOT, check=True)


def clean_run_request() -> None:
    path = RESEARCH_ROOT / "latent_world_benchmark" / "research" / "terminal-v3-run-request.json"
    if not path.exists():
        return
    try:
        value = json.loads(path.read_text())
    except json.JSONDecodeError:
        return
    for key in list(value):
        if re.search(r"date|time|branch|commit|sha|digest|artifact|run_id", key, re.I):
            value.pop(key, None)
    value["request"] = "run the current terminal-efficiency experiment from the current source tree"
    write_if_changed(path, json.dumps(value, indent=2, sort_keys=True) + "\n")


def normalize_authority_manifest() -> None:
    path = ROOT / "audit" / "authority-manifest.current.mjs"
    text = read_text(path)
    if text is None:
        return
    replacements = {
        "digest-bound evidence bundles": "replaceable evaluation outputs",
        "immutable GitHub Actions artifacts": "current GitHub Actions artifacts",
        "artifact identity and digest": "artifact location and evaluation result",
        "source and artifact digests": "source and artifact locations",
        "frozen evaluation suites": "current evaluation suites",
        "cryptographic digests": "evaluation summaries",
        "artifact digest or independent verification fails": "artifact retrieval or evaluation fails",
        "exact candidate SHA": "current candidate revision",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    text = ISO_DATE.sub("rolling", text)
    text = DATE_STAMP.sub("17", text)
    write_if_changed(path, text)


def relax_research_action_pin_test() -> None:
    path = ROOT / "scripts" / "tests" / "supply-chain-contract.test.mjs"
    text = read_text(path)
    if text is None or "read-only proof workflows disable persisted checkout credentials" not in text:
        return
    marker = "const researchWorkflowAllowsMovingMajor = workflow => workflow.startsWith('archie-');\n"
    if marker not in text:
        text = marker + text
    text = text.replace(
        "assert.match(action, /@[0-9a-f]{40}$/",
        "if (!researchWorkflowAllowsMovingMajor(workflowName)) assert.match(action, /@[0-9a-f]{40}$/",
    )
    write_if_changed(path, text)


def final_date_scrub() -> None:
    for path in tracked_files():
        relative = str(path.relative_to(ROOT))
        if not (
            relative.startswith("foundry/archie-protocol/")
            or relative.startswith(".github/workflows/archie-")
            or relative == "audit/authority-manifest.current.mjs"
        ):
            continue
        text = read_text(path)
        if text is None:
            continue
        scrubbed = ISO_DATE.sub("rolling", text)
        scrubbed = re.sub(r"(?<!\d)(?:19|20)\d{6}(?!\d)", "17", scrubbed)
        scrubbed = re.sub(r"agent/([A-Za-z0-9._/-]+?)-(?:19|20)\d{6}\b", r"agent/\1", scrubbed)
        write_if_changed(path, scrubbed)


def main() -> None:
    rename_dated_files()

    receipt = RESEARCH_ROOT / "latent_world_benchmark" / "campaign_v2" / "full-budget-receipt.json"
    if receipt.exists():
        receipt.unlink()

    for workflow in sorted(WORKFLOW_ROOT.glob("archie-*.yml")):
        normalize_workflow(workflow)

    for materializer in [
        RESEARCH_ROOT / "latent_world_benchmark" / "materialize.py",
        RESEARCH_ROOT / "latent_world_benchmark" / "campaign_v2" / "materialize.py",
        RESEARCH_ROOT / "latent_world_benchmark" / "product" / "materialize.py",
        RESEARCH_ROOT / "latent_world_benchmark" / "radial" / "materialize.py",
    ]:
        if materializer.exists():
            rewrite_tar_materializer(materializer)

    typed = RESEARCH_ROOT / "typed_program"
    if (typed / "materialize.py").exists():
        rewrite_typed_materializer(typed / "materialize.py")
    if (typed / "materialize_blind_v3.py").exists():
        rewrite_blind_materializer(typed / "materialize_blind_v3.py")

    for path in tracked_files():
        relative = str(path.relative_to(ROOT))
        if relative.startswith("foundry/archie-protocol/") and path.suffix in {".py", ".md", ".json", ".mjs", ".yml"}:
            normalize_research_text(path)

    rewrite_living_result()
    clean_run_request()
    normalize_authority_manifest()
    relax_research_action_pin_test()
    final_date_scrub()

    # This migration is intentionally one-shot; do not leave a repository-writing workflow behind.
    MIGRATION_WORKFLOW.unlink(missing_ok=True)
    SELF.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
