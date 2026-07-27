import datetime as dt
import pathlib
import tempfile
import unittest

from compute.continuum.capsule import assigned_shards, sign_capsule, validate_task_args, verify_capsule
from compute.continuum.common import PROMOTION, PROTOCOL, ContinuumError
from compute.continuum.execution import render_argv
from compute.continuum.handoff import SuccessBarrier


class ContinuumTests(unittest.TestCase):
    def setUp(self):
        self.key = "k" * 64
        now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        self.raw = {
            "protocol": PROTOCOL,
            "job_id": "job-1",
            "issued_at": now.isoformat().replace("+00:00", "Z"),
            "expires_at": (now + dt.timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
            "source": {"repo": "Pokitomas/theawesomehexapp", "sha": "a" * 40},
            "task": {"name": "terminal-efficiency-v3", "args": {"steps": 10}},
            "nodes": ["alienware-1", "alienware-2"],
            "shards": 8,
            "promotion": PROMOTION,
        }
        self.config = {
            "node_id": "alienware-1",
            "repo": "Pokitomas/theawesomehexapp",
            "workspace": "/tmp/continuum",
            "security": {"allowed_repos": ["Pokitomas/theawesomehexapp"], "allowed_tasks": ["terminal-efficiency-v3"]},
            "tasks": {"terminal-efficiency-v3": {"allowed_args": {"steps": "int"}, "argv": ["python3", "train.py", "--steps", "{steps}"]}},
        }

    def test_sign_and_verify_capsule(self):
        signed = sign_capsule(self.raw, self.key)
        capsule = verify_capsule(signed, self.key, self.config)
        self.assertEqual(capsule.job_id, "job-1")
        self.assertEqual(capsule.source_sha, "a" * 40)

    def test_tampering_is_rejected(self):
        signed = sign_capsule(self.raw, self.key)
        signed["task"]["args"]["steps"] = 999
        with self.assertRaises(ContinuumError): verify_capsule(signed, self.key, self.config)

    def test_promotion_is_fail_closed(self):
        raw = dict(self.raw); raw["promotion"] = "admitted"
        with self.assertRaises(ContinuumError): sign_capsule(raw, self.key)

    def test_unknown_task_argument_is_rejected(self):
        with self.assertRaises(ContinuumError): validate_task_args(self.config["tasks"]["terminal-efficiency-v3"], {"shell": "rm -rf /"})

    def test_rendezvous_assignment_is_complete_and_unique(self):
        nodes = ["alienware-1", "alienware-2", "alienware-3"]
        assignments = {node: assigned_shards("job-1", nodes, 100, node) for node in nodes}
        flattened = [shard for values in assignments.values() for shard in values]
        self.assertEqual(sorted(flattened), list(range(100)))
        self.assertEqual(len(flattened), len(set(flattened)))

    def test_success_barrier_accepts_exact_digest(self):
        with tempfile.TemporaryDirectory() as temp:
            provider = pathlib.Path(temp) / "provider.py"
            provider.write_text("import json,sys\ne=json.load(sys.stdin)\nprint(json.dumps({'handoff_digest':e['state_digest']}))\n")
            config = {"providers": [{"id": "mock", "mode": "command", "argv": ["python3", str(provider)], "required": True}]}
            receipt = SuccessBarrier(config, pathlib.Path(temp) / "job").emit({"x": 1}, "a" * 40)
            self.assertEqual(receipt["status"], "complete")

    def test_success_barrier_rejects_wrong_digest(self):
        with tempfile.TemporaryDirectory() as temp:
            provider = pathlib.Path(temp) / "provider.py"
            provider.write_text("import json,sys\njson.load(sys.stdin)\nprint(json.dumps({'handoff_digest':'wrong'}))\n")
            config = {"providers": [{"id": "mock", "mode": "command", "argv": ["python3", str(provider)], "required": True}]}
            with self.assertRaises(ContinuumError): SuccessBarrier(config, pathlib.Path(temp) / "job").emit({"x": 1}, "a" * 40)

    def test_render_argv_never_uses_shell(self):
        self.assertEqual(render_argv(["python3", "train.py", "--steps", "{steps}"], {"steps": 12}), ["python3", "train.py", "--steps", "12"])

    def test_integer_bounds_and_order_are_local_policy(self):
        task = {"allowed_args": {"rung1": {"type":"int","min":1,"max":100}, "rung2": {"type":"int","min":2,"max":100}, "rung3": {"type":"int","min":3,"max":100}}, "strictly_increasing_args": ["rung1","rung2","rung3"]}
        self.assertEqual(validate_task_args(task, {"rung1":1,"rung2":2,"rung3":3})["rung3"], 3)
        with self.assertRaises(ContinuumError): validate_task_args(task, {"rung1":1,"rung2":50,"rung3":101})
        with self.assertRaises(ContinuumError): validate_task_args(task, {"rung1":3,"rung2":2,"rung3":4})

    def test_capsule_workflow_binds_source_to_github_sha(self):
        workflow = pathlib.Path(__file__).parents[2] / ".github" / "workflows" / "archie-continuum-capsule.yml"
        text = workflow.read_text()
        self.assertIn('--source-sha "$GITHUB_SHA"', text)
        self.assertIn('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"', text)
        self.assertIn("Require repository owner dispatch", text)
        self.assertNotIn("runs-on: [self-hosted", text)


if __name__ == "__main__": unittest.main()
