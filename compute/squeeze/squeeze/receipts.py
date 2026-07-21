from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Mapping

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_manifest(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): sha256_file(path)
        for path in sorted(root.rglob("*"))
        if path.is_file() and path.name not in {"receipt.json", "SHA256SUMS"}
    }


def ensure_identity_key(identity_root: Path) -> Ed25519PrivateKey:
    identity_root.mkdir(parents=True, exist_ok=True)
    key_path = identity_root / "ed25519-private.pem"
    if key_path.exists():
        return serialization.load_pem_private_key(key_path.read_bytes(), password=None)
    key = Ed25519PrivateKey.generate()
    encoded = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    temporary = key_path.with_suffix(".tmp")
    temporary.write_bytes(encoded)
    os.chmod(temporary, 0o600)
    os.replace(temporary, key_path)
    return key


def canonical_receipt_bytes(receipt_without_signature: Mapping[str, Any]) -> bytes:
    return (json.dumps(receipt_without_signature, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sign_receipt(receipt_without_signature: Mapping[str, Any], key: Ed25519PrivateKey) -> dict[str, Any]:
    payload = canonical_receipt_bytes(receipt_without_signature)
    signature = key.sign(payload)
    public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return {
        **receipt_without_signature,
        "signature": {
            "algorithm": "ed25519",
            "public_key": base64.b64encode(public).decode("ascii"),
            "value": base64.b64encode(signature).decode("ascii"),
        },
    }


def write_sha256s(root: Path, manifest: Mapping[str, str]) -> Path:
    path = root / "SHA256SUMS"
    path.write_text("".join(f"{digest}  {name}\n" for name, digest in sorted(manifest.items())), encoding="utf-8")
    return path
