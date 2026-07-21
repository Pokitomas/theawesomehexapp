from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from squeeze import cuda


class CudaTests(unittest.TestCase):
    def test_missing_tools_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, mock.patch("shutil.which", return_value=None):
            report = cuda.doctor(Path(tmp))
        self.assertFalse(report.available)
        self.assertIn("nvidia-smi is unavailable", report.failures)
        self.assertIn("bubblewrap is required for network and filesystem isolation", report.failures)

    def test_low_disk_is_reported(self) -> None:
        usage = type("Usage", (), {"free": 1})()
        with tempfile.TemporaryDirectory() as tmp, mock.patch("shutil.which", return_value=None), mock.patch("shutil.disk_usage", return_value=usage):
            report = cuda.doctor(Path(tmp))
        self.assertIn("less than 20 GiB free in checkpoint storage", report.failures)


if __name__ == "__main__":
    unittest.main()
