from __future__ import annotations

"""Export compact relation tables suitable for tabular calibration experiments.

This is intentionally model-agnostic. LimiX or another tabular foundation model can
consume the resulting rows, but no LimiX checkpoint is bundled or claimed as run.
"""

import argparse
import csv
import json
import re
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--teacher-jsonl", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    args = ap.parse_args()
    fields = ["index", "request_chars", "request_words", "attachment_count", "memory_present", "thread_present",
              "route", "authority", "context", "outcome_count", "active_clause_count", "teacher_executed", "teacher_model"]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", newline="") as out:
        writer = csv.DictWriter(out, fieldnames=fields); writer.writeheader()
        for line in args.teacher_jsonl.read_text().splitlines():
            if not line.strip():
                continue
            record = json.loads(line); src = record.get("source", {}); teacher = record.get("teacher", {})
            req = str(src.get("request", ""))
            writer.writerow({
                "index": record.get("index"), "request_chars": len(req), "request_words": len(re.findall(r"\w+", req)),
                "attachment_count": len(src.get("attachments", [])), "memory_present": int(bool(src.get("memory"))),
                "thread_present": int(bool(src.get("thread"))), "route": teacher.get("route", ""),
                "authority": teacher.get("authority", ""), "context": teacher.get("context", ""),
                "outcome_count": len(teacher.get("outcomes", [])), "active_clause_count": len(teacher.get("active_clauses", [])),
                "teacher_executed": int(bool(record.get("executed"))), "teacher_model": record.get("model", ""),
            })
    print(args.output)

if __name__ == "__main__":
    main()
