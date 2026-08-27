from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from core import receipt, verify_receipt


def _run(root: Path, script: str) -> dict[str, Any]:
    p = subprocess.run([sys.executable, script], cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=10)
    return receipt("maker.exec", {"script": script, "returncode": p.returncode, "stdout": p.stdout[-4000:]})


def court() -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="archie-maker-") as td:
        root = Path(td)
        app = root / "app.py"
        test = root / "test_app.py"
        app.write_text("def transform(x):\n    return x + 1\n\nif __name__ == '__main__':\n    print(transform(21))\n", encoding="utf-8")
        test.write_text("import app\nassert app.transform(21) == 42\nprint('APP_TEST_OK')\n", encoding="utf-8")
        inspect = receipt("maker.inspect", {"files": sorted(p.name for p in root.iterdir() if p.is_file())})
        before = _run(root, test.name)
        src = app.read_text(encoding="utf-8")
        app.write_text(src.replace("return x + 1", "return x * 2"), encoding="utf-8")
        # Same-size source repairs can alias a timestamp/size pyc cache inside a
        # very fast generate-test-repair cycle. Repair owns cache invalidation.
        shutil.rmtree(root / "__pycache__", ignore_errors=True)
        repair = receipt("maker.repair", {"changed": True, "cache_invalidated": True})
        after = _run(root, test.name)
        run = _run(root, app.name)
        return receipt("maker.court.v2", {
            "inspect_valid": verify_receipt(inspect),
            "pre_repair_failed": before["payload"]["returncode"] != 0,
            "repair_receipt": verify_receipt(repair),
            "cache_invalidated": repair["payload"]["cache_invalidated"],
            "post_repair_passed": after["payload"]["returncode"] == 0 and "APP_TEST_OK" in after["payload"]["stdout"],
            "run_passed": run["payload"]["returncode"] == 0 and run["payload"]["stdout"].strip().endswith("42"),
        })
