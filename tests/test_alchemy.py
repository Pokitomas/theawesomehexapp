from archie_distill.alchemy import common_prefix_length, compile_repair, recovery_depths


class TinyTokenizer:
    def __call__(self, text, add_special_tokens=False):
        return {"input_ids": text.split()}

    def decode(self, ids, skip_special_tokens=True):
        return " ".join(ids)


def test_recovery_depths_cover_divergence_to_late_failure() -> None:
    assert recovery_depths(2, 10, 4) == [2, 4, 7, 9]


def test_common_prefix_length() -> None:
    assert common_prefix_length([1, 2, 3], [1, 2, 4]) == 2


def test_compile_repair_creates_dense_sft_views() -> None:
    rows = compile_repair(
        TinyTokenizer(),
        {
            "id": "r1",
            "messages": [{"role": "user", "content": "Name the capital of France."}],
            "failed_answer": "The capital is Lyon because it is central",
            "repaired_answer": "The capital is Paris",
            "task_type": "text",
        },
        recovery_views=3,
    )
    kinds = [row["lesson_type"] for row in rows]
    assert kinds.count("clean-repair-anchor") == 1
    assert kinds.count("exact-divergence-continuation") == 1
    assert kinds.count("self-prefix-recovery") == 3
    assert all(row["split"] == "train" for row in rows)
    assert all(row["answer"] for row in rows)
