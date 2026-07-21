from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from squeeze.workspace import JobWorkspace, WorkspaceError, build_bwrap_command


class WorkspaceTests(unittest.TestCase):
    def test_sandbox_unshares_network_and_uses_argv(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            workspace = JobWorkspace(root)
            workspace.create()
            cwd = workspace.root / "source"
            cwd.mkdir()
            with mock.patch("shutil.which", return_value="/usr/bin/bwrap"):
                command = build_bwrap_command(
                    Path("/usr/bin/python3"),
                    ["-m", "squeeze.terminal_adapter"],
                    workspace=workspace,
                    cwd=cwd,
                    python_prefix=Path("/usr"),
                    environment={"PYTHONNOUSERSITE": "1"},
                )
            self.assertIn("--unshare-net", command)
            self.assertEqual(command[-3:], ["/usr/bin/python3", "-m", "squeeze.terminal_adapter"])
            self.assertNotIn("sh", command[:1])

    def test_cwd_outside_workspace_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = JobWorkspace(Path(tmp) / "job")
            workspace.create()
            with mock.patch("shutil.which", return_value="/usr/bin/bwrap"):
                with self.assertRaises(WorkspaceError):
                    build_bwrap_command(
                        Path("/usr/bin/python3"),
                        [],
                        workspace=workspace,
                        cwd=Path("/tmp"),
                        python_prefix=Path("/usr"),
                        environment={},
                    )


if __name__ == "__main__":
    unittest.main()
