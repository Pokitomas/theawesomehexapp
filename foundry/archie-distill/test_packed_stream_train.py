#!/usr/bin/env python3
from __future__ import annotations
import importlib.util
import json
import math
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
TARGET = HERE / "packed_stream_train.py"
spec = importlib.util.spec_from_file_location("packed_stream_train", TARGET)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

safe = module.json_safe(
    {"positive": math.inf, "negative": -math.inf, "nan": math.nan, "nested": [1.0, math.inf]}
)
assert safe == {
    "positive": "Infinity",
    "negative": "-Infinity",
    "nan": "NaN",
    "nested": [1.0, "Infinity"],
}
json.dumps(safe, allow_nan=False)

overflow = {"loss": 2.6768579483032227, "grad_norm": math.inf}
assert module.is_recoverable_amp_overflow(overflow, 262144.0, 131072.0)
assert not module.is_recoverable_amp_overflow(overflow, 131072.0, 131072.0)
assert not module.is_recoverable_amp_overflow(
    {"loss": math.inf, "grad_norm": math.inf}, 262144.0, 131072.0
)
assert not module.is_recoverable_amp_overflow(
    {"loss": 2.6, "grad_norm": 3.0}, 262144.0, 131072.0
)

source = TARGET.read_text()
assert "sampler.cursor = cursor_before" in source
assert "max_amp_overflow_retries = 8" in source
assert '"STREAM_AMP_OVERFLOW_RETRY"' in source
print("PASS packed-stream AMP overflow recovery court")
