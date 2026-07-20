#!/usr/bin/env python3
from __future__ import annotations
import base64, hashlib, io, tarfile
from pathlib import Path
root = Path(__file__).resolve().parent
encoded = ''.join(path.read_text().strip() for path in sorted((root/'source.parts').glob('part-*.b64')))
raw = base64.b64decode(encoded)
expected = (root/'source.tar.gz.sha256').read_text().strip()
actual = hashlib.sha256(raw).hexdigest()
if actual != expected:
    raise SystemExit(f'bootstrap digest mismatch: {actual} != {expected}')
repo = root.parent
with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
    for member in archive.getmembers():
        target = (repo / member.name).resolve()
        if repo.resolve() not in target.parents and target != repo.resolve():
            raise SystemExit(f'unsafe archive member: {member.name}')
    archive.extractall(repo, filter='data')
print(f'unpacked source archive {actual}')
