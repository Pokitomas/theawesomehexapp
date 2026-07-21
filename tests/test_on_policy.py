from archie_distill.on_policy import (
    build_repair_messages,
    deterministic_priority,
    make_repair_row,
)


def test_priority_is_deterministic_and_hardness_dominates() -> None:
    first = deterministic_priority("alpha", seed=7, round_index=2, prior_failure_rate=0.9)
    repeated = deterministic_priority("alpha", seed=7, round_index=2, prior_failure_rate=0.9)
    easy = deterministic_priority("beta", seed=7, round_index=2, prior_failure_rate=0.1)
    assert first == repeated
    assert first[0] < easy[0]


def test_repair_prompt_contains_student_trajectory_without_requesting_reasoning() -> None:
    messages = [{"role": "user", "content": "What is 2 + 2?"}]
    repair_messages = build_repair_messages(messages, "5")
    assert repair_messages[0]["role"] == "system"
    assert "Do not expose analysis" in repair_messages[0]["content"]
    assert "Student-generated final answer:\n5" in repair_messages[1]["content"]


def test_make_repair_row_emits_verified_failed_to_repair_shape() -> None:
    row = make_repair_row(
        prompt_id="math-1",
        messages=[{"role": "user", "content": "What is 2 + 2?"}],
        task_type="number",
        student_answer="5",
        teacher_answer="4",
        teacher_id="teacher-a",
        round_index=1,
        rollout_seed=99,
        generation={"generated_tokens": 1},
        teacher_usage={"total_tokens": 8},
    )
    assert row is not None
    assert row["verified"] is True
    assert row["failed_answer"] == "5"
    assert row["repaired_answer"] == "4"
    assert row["verification"]["method"].startswith("black-box-teacher-correction")
    assert row["positive_evidence"]
    assert row["negative_evidence"]


def test_make_repair_row_drops_teacher_agreement() -> None:
    row = make_repair_row(
        prompt_id="math-1",
        messages=[{"role": "user", "content": "What is 2 + 2?"}],
        task_type="number",
        student_answer="4.",
        teacher_answer="4",
        teacher_id="teacher-a",
        round_index=1,
        rollout_seed=99,
        generation={},
        teacher_usage={},
    )
    assert row is None
