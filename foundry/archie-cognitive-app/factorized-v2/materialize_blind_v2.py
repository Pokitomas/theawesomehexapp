#!/usr/bin/env python3
import base64, hashlib, zlib
from pathlib import Path
SOURCE = Path(__file__).with_name("blind-challenge-v2.jsonl.zlib.b85")
OUT = Path(__file__).with_name("blind-challenge-v2.jsonl")
data = zlib.decompress(base64.b85decode(SOURCE.read_text().strip()))
assert hashlib.sha256(data).hexdigest() == "d14432ae332169205b31e96417550a3410b8f3e2bc9ff2c32aa89ff4c6a2d2b6"
OUT.write_bytes(data)
print(OUT, len(data), hashlib.sha256(data).hexdigest())
