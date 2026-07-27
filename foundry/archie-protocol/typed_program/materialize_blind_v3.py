#!/usr/bin/env python3
from __future__ import annotations
import base64, gzip, hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parent
EXPECTED='b33d66997c56b2746e19485785f14ee219161a9a4aedaf83e7f0e99f2d66c917'
parts=sorted(ROOT.glob('blind_v3.part*'))
if not parts: raise SystemExit('no blind-v3 source parts')
payload=gzip.decompress(base64.b64decode(b''.join(p.read_bytes() for p in parts)))
observed=hashlib.sha256(payload).hexdigest()
if observed != EXPECTED: raise SystemExit(f'blind-v3 digest mismatch: {observed}')
(ROOT/'typed_program_blind_pack_v3.py').write_bytes(payload)
print(f'restored typed_program_blind_pack_v3.py sha256:{observed}')
