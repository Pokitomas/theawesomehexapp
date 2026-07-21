from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from squeeze.receipts import canonical_receipt_bytes, ensure_identity_key, sign_receipt


class ReceiptTests(unittest.TestCase):
    def test_receipt_signature_verifies(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            key = ensure_identity_key(Path(tmp))
            body = {"schema": "squeeze-receipt-v1", "promotion": "research-only-not-admitted", "files": {}}
            signed = sign_receipt(body, key)
            signature = signed.pop("signature")
            public = Ed25519PublicKey.from_public_bytes(base64.b64decode(signature["public_key"]))
            public.verify(base64.b64decode(signature["value"]), canonical_receipt_bytes(signed))

    def test_identity_key_is_reused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = ensure_identity_key(root)
            second = ensure_identity_key(root)
            self.assertEqual(first.private_bytes_raw(), second.private_bytes_raw())
            self.assertEqual((root / "ed25519-private.pem").stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
