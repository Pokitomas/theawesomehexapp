#!/usr/bin/env python3
import argparse,base64,hashlib,json
from pathlib import Path
ap=argparse.ArgumentParser();ap.add_argument('--artifact-dir',required=True);ap.add_argument('--out',required=True);args=ap.parse_args()
d=Path(args.artifact_dir);m=json.loads((d/'manifest.json').read_text());raw=base64.b64decode(''.join((d/p).read_text().strip() for p in m['parts']))
assert len(raw)==m['bytes'];assert hashlib.sha256(raw).hexdigest()==m['sha256'];Path(args.out).write_bytes(raw);print(args.out)
