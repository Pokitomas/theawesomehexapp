#!/usr/bin/env python3
from pathlib import Path
import hashlib, json
ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / 'manifest.json').read_text())
for item in manifest['files']:
    path = ROOT / item['path']
    raw = path.read_bytes()
    assert len(raw) == item['bytes'], item['path']
    assert hashlib.sha256(raw).hexdigest() == item['sha256'], item['path']
report = json.loads((ROOT / 'mastery-report.json').read_text())
assert report['promotion']['state'] == 'not-admitted'
assert report['promotion']['production_modified'] is False
deployment = json.loads((ROOT / 'deployment-identity.json').read_text())
assert deployment['deployment_changed'] is False
assert deployment['production_route_model_changed'] is False
assert deployment['promotion_state'] == 'not-admitted'
print(f"verified {len(manifest['files'])} core evidence files; production unchanged; not-admitted")
