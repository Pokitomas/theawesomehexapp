#!/usr/bin/env python3
"""Fail-closed bootstrap for the pinned Archie distillation workspace."""
import argparse, hashlib, json, pathlib, platform, sys

def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--accept-downloads", action="store_true")
    args = parser.parse_args()
    profile = json.loads(pathlib.Path(args.profile).read_text(encoding="utf-8"))
    root = pathlib.Path(args.workspace).resolve()
    root.mkdir(parents=True, exist_ok=True)
    (root / "models" / "teacher").mkdir(parents=True, exist_ok=True)
    (root / "models" / "student").mkdir(parents=True, exist_ok=True)
    result = {
        "schema": "archie-distill-bootstrap/v1",
        "workspace": str(root),
        "profile_id": profile["id"],
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "downloads_accepted": bool(args.accept_downloads),
        "teacher_ready": False,
        "student_ready": False,
        "claim_boundary": profile["claim_boundary"]
    }
    teacher = root / "models" / "teacher" / profile["teacher"]["filename"]
    if teacher.exists():
        observed = digest(teacher)
        if observed != profile["teacher"]["sha256"]:
            raise SystemExit("Teacher digest mismatch; refusing to continue.")
        result["teacher_ready"] = True
    student = root / "models" / "student" / "config.json"
    result["student_ready"] = student.exists()
    if args.accept_downloads and (not result["teacher_ready"] or not result["student_ready"]):
        try:
            from huggingface_hub import snapshot_download, hf_hub_download
        except Exception as exc:
            raise SystemExit("Install huggingface_hub in the isolated environment before accepting downloads.") from exc
        if not result["student_ready"]:
            snapshot_download(repo_id=profile["student"]["repository"], revision=profile["student"]["revision"], local_dir=root / "models" / "student")
            result["student_ready"] = True
        if not result["teacher_ready"]:
            downloaded = hf_hub_download(repo_id=profile["teacher"]["repository"], revision=profile["teacher"]["revision"], filename=profile["teacher"]["filename"], local_dir=root / "models" / "teacher")
            if digest(downloaded) != profile["teacher"]["sha256"]:
                pathlib.Path(downloaded).unlink(missing_ok=True)
                raise SystemExit("Downloaded teacher digest mismatch.")
            result["teacher_ready"] = True
    (root / "bootstrap-receipt.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()
