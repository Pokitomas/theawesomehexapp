import importlib.util
import types
import unittest
from pathlib import Path

import torch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "typed_recurrent_controller", HERE / "typed_recurrent_controller.py"
)
controller = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(controller)


class FakeReasoner:
    ROUTES = ("summary", "clarify", "decision")
    AUTHORITY_LABELS = ("allow", "deny")
    CONTEXT_LABELS = ("ready", "missing", "ambiguous")
    SPECIAL_TOKENS = (
        "<PAD>", "<UNK>", "<BOS>", "<EOS>",
        "<REQUEST>", "<ATTACHMENT>", "<MEMORY>", "<THREAD>",
        "<TASK_GRAPH>", "</TASK_GRAPH>", "<PLAN>", "</PLAN>", "<CLARIFY>",
    )

    @staticmethod
    def require_training_dependencies():
        return torch, None

    @staticmethod
    def prompt_from_row(row):
        return row["request"]

    @staticmethod
    def attachment_names(row):
        return list(row.get("attachments", []))

    @staticmethod
    def memory_text(row):
        return str(row.get("memory", ""))

    class SentencePieceTokenizer:
        def __init__(self, _):
            self.special_ids = {
                token: index for index, token in enumerate(FakeReasoner.SPECIAL_TOKENS)
            }


class TypedControllerTests(unittest.TestCase):
    def setUp(self):
        controller.configure_special_ids({
            "<REQUEST>": 4,
            "<ATTACHMENT>": 5,
            "<MEMORY>": 6,
            "<THREAD>": 7,
            "<ABSENT>": 8,
            "<PRESENT>": 9,
        })

    def config(self):
        return types.SimpleNamespace(
            d_model=32,
            encoder_layers=1,
            decoder_layers=1,
            dropout=0.0,
            dim_feedforward=64,
            max_target_tokens=16,
        )

    def test_structured_source_serializes_absence_and_payloads(self):
        text = controller.structured_source_text(FakeReasoner, {
            "request": "Apply the saved condition.",
            "attachments": [],
            "memory": "Condition alpha",
            "thread": "",
        })
        self.assertIn("<ATTACHMENT> <ABSENT>", text)
        self.assertIn("<MEMORY> <PRESENT> Condition alpha", text)
        self.assertIn("<THREAD> <ABSENT>", text)

    def test_authority_lane_is_invariant_to_memory_payload(self):
        Model = controller.build_controller_class(FakeReasoner, reasoning_steps=3)
        model = Model(vocab_size=32, pad_id=0, transform_classes=2, config=self.config()).eval()
        left = torch.tensor([[4, 10, 5, 8, 6, 9, 20, 7, 8]])
        right = torch.tensor([[4, 10, 5, 8, 6, 9, 21, 7, 8]])
        padding = torch.zeros_like(left, dtype=torch.bool)
        with torch.no_grad():
            _, left_state = model.encode(left, padding)
            _, right_state = model.encode(right, padding)
            left_auth = model.authority_head(left_state)
            right_auth = model.authority_head(right_state)
        self.assertTrue(torch.equal(left_auth, right_auth))

    def test_forward_contract_and_recurrent_depth(self):
        Model = controller.build_controller_class(FakeReasoner, reasoning_steps=4)
        model = Model(vocab_size=32, pad_id=0, transform_classes=5, config=self.config())
        source = torch.tensor([[4, 10, 5, 8, 6, 8, 7, 8]])
        target = torch.tensor([[2, 11, 12]])
        result = model(source, target, source.eq(0), target.eq(0))
        self.assertEqual(model.reasoning_steps, 4)
        self.assertEqual(result["token_logits"].shape, (1, 3, 32))
        self.assertEqual(result["route_logits"].shape, (1, 3))
        self.assertEqual(result["authority_logits"].shape, (1, 2))
        self.assertEqual(result["context_logits"].shape, (1, 3))
        self.assertEqual(result["transform_logits"].shape, (1, 5))

    def test_install_is_idempotent(self):
        fake = types.SimpleNamespace(**{
            name: getattr(FakeReasoner, name)
            for name in (
                "SPECIAL_TOKENS", "SentencePieceTokenizer", "prompt_from_row",
                "attachment_names", "memory_text", "require_training_dependencies",
                "ROUTES", "AUTHORITY_LABELS", "CONTEXT_LABELS",
            )
        })
        controller.install_controller(fake)
        first = fake.build_model_class
        controller.install_controller(fake)
        self.assertIs(first, fake.build_model_class)
        self.assertIn("<ABSENT>", fake.SPECIAL_TOKENS)


if __name__ == "__main__":
    unittest.main()
