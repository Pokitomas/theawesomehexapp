#!/usr/bin/env python3
"""Materialize exact symbolic-world benchmark source and receipts."""
from __future__ import annotations
import base64,gzip,hashlib,io,json,tarfile
from pathlib import Path
PAYLOAD_SHA256="0198dd4b1c31bd7e46a32a615173b28b017d645c3122850b613e0cfe23822268"
FILES={"README.md":"29ccf0b93e741baf44463ca9c31fc03cebcee4dd11cb37035621eef0e1a6bde4","checkpoint-manifest.json":"bca145f53b4fadd097d2fc890f8cf09d56c6af4a04a1bf0c09fadf8a687d3ec4","latent_world_benchmark.py":"88c8e13810a9b864d9f96e4aa8d55725d9e350201bca35f9ff9b5f2605f1d4d9","restore_checkpoints.py":"f69602f3e706084fc2705af3cd5a52445a65196d86a2a14ad9078a20cfd78296","test_benchmark.py":"3ab0d1bdcbdf954cfff780ec04660b6e48608f224a01fcf3573ec7b91585b4e6","unified_evaluation.json":"d9e3317706f9fae678bda3d9049fab561a0f00329b4fa243319ad0eeee9ae9d2"}
def main():
 root=Path(__file__).resolve().parent
 parts=sorted(root.glob("payload.part*"))
 if len(parts)!=4: raise SystemExit(f"expected 4 payload parts, found {len(parts)}")
 raw=base64.b64decode("".join(p.read_text().strip() for p in parts))
 if hashlib.sha256(raw).hexdigest()!=PAYLOAD_SHA256: raise SystemExit("payload digest mismatch")
 with tarfile.open(fileobj=io.BytesIO(gzip.decompress(raw)),mode="r:") as tar: tar.extractall(root,filter="data")
 observed={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in FILES}
 if observed!=FILES: raise SystemExit("materialized file digest mismatch")
 print(json.dumps({"schema":"archie-symbolic-world-materialization/v1","payload_sha256":PAYLOAD_SHA256,"files":observed,"promotion":"not-admitted"},indent=2,sort_keys=True))
if __name__=="__main__": main()
