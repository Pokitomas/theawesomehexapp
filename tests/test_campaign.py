import json
from pathlib import Path

from archie_distill.campaign import _append_unique, round_plan


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows), encoding="utf-8")


def test_round_plan_is_isolated_and_deterministic(tmp_path: Path) -> None:
    plan = round_plan(2, root=tmp_path)
    assert plan["round"] == tmp_path / "round-002"
    assert plan["adapter"] == tmp_path / "round-002" / "training" / "adapter"
    assert plan["evaluation"] == tmp_path / "round-002" / "evaluation-receipt.json"


def test_cumulative_dataset_preserves_first_seen_order_and_deduplicates(tmp_path: Path) -> None:
    bootstrap = tmp_path / "bootstrap.jsonl"
    repair = tmp_path / "repair.jsonl"
    output = tmp_path / "cumulative.jsonl"
    _write_jsonl(bootstrap, [{"id": "a", "answer": "one"}, {"id": "b", "answer": "two"}])
    _write_jsonl(repair, [{"id": "b", "answer": "duplicate"}, {"id": "c", "answer": "three"}])

    receipt = _append_unique(output, [bootstrap, repair])
    rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]

    assert [row["id"] for row in rows] == ["a", "b", "c"]
    assert receipt["rows"] == 3
    assert len(receipt["sources"]) == 2
