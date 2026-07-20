#!/usr/bin/env python3
import argparse, base64, hashlib, json
from pathlib import Path

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--model',required=True); ap.add_argument('--out',required=True); ap.add_argument('--part-bytes',type=int,default=90000); args=ap.parse_args()
    source=Path(args.model); raw=source.read_bytes(); out=Path(args.out); out.mkdir(parents=True,exist_ok=True)
    encoded=base64.b64encode(raw).decode('ascii'); names=[]; chars=max(4,args.part_bytes//3*4)
    for i,start in enumerate(range(0,len(encoded),chars)):
        name=f'part-{i:03d}.b64'; (out/name).write_text(encoded[start:start+chars]+'\n'); names.append(name)
    manifest={'schema':'archie-cognitive-router-artifact/v1','model':'cognitive-router.pt','bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'encoding':'base64-concatenated','parts':names}
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n'); print(json.dumps(manifest,indent=2))
if __name__=='__main__': main()
