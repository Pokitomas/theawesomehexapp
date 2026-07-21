from __future__ import annotations

import concurrent.futures
import glob
import json
import pathlib
import threading
import time
import uuid
from typing import Any, Mapping, Sequence

from .common import PROMOTION, SUCCESS_PROTOCOL, ContinuumError, canonical_json, expand_path, read_json, run_checked, sha256_bytes, sha256_file, utc_now, write_json


def collect_files(root: pathlib.Path, patterns: Sequence[str]) -> list[pathlib.Path]:
    found = {pathlib.Path(item).resolve() for pattern in patterns for item in glob.glob(str(root / pattern), recursive=True) if pathlib.Path(item).is_file()}
    return sorted(found)


class SuccessBarrier:
    def __init__(self, config: Mapping[str, Any], job_dir: pathlib.Path): self.config, self.job_dir = config, job_dir

    def emit(self, state: Mapping[str, Any], source_sha: str, event: str = "SUCCESS") -> dict[str, Any]:
        digest = sha256_bytes(canonical_json(state))
        barrier_id = f"{event.lower()}-{digest[:16]}-{uuid.uuid4().hex[:8]}"
        envelope = {
            "protocol":SUCCESS_PROTOCOL,"command":event,"barrier_id":barrier_id,"created_at":utc_now(),
            "source_sha":source_sha,"state_digest":digest,"state":state,
            "rules":{"freeze_independent_generation":event=="SUCCESS","consume_exact_digest":True,
                     "recommendations_are_advisory":True,"execution_requires_new_signed_capsule":True},
        }
        write_json(self.job_dir / "handoffs" / f"{barrier_id}.json", envelope)
        providers, acknowledgements = list(self.config.get("providers", [])), []
        if providers:
            with concurrent.futures.ThreadPoolExecutor(max_workers=min(32,len(providers))) as pool:
                futures = {pool.submit(self._invoke, provider, envelope):provider for provider in providers}
                for future, provider in futures.items():
                    try: acknowledgements.append(future.result())
                    except Exception as exc:
                        acknowledgements.append({"provider":provider.get("id","unknown"),"status":"error","required":bool(provider.get("required",True)),"error":str(exc)})
        failures = [a for a in acknowledgements if a.get("required",True) and a.get("status") != "ack"]
        receipt = {"protocol":SUCCESS_PROTOCOL,"command":event,"barrier_id":barrier_id,"source_sha":source_sha,
                   "state_digest":digest,"completed_at":utc_now(),"acknowledgements":acknowledgements,
                   "status":"blocked" if failures else "complete","promotion":PROMOTION}
        write_json(self.job_dir / "handoffs" / f"{barrier_id}.receipt.json", receipt)
        if failures: raise ContinuumError("barrier blocked by: " + ", ".join(str(x.get("provider")) for x in failures))
        return receipt

    def _invoke(self, provider: Mapping[str, Any], envelope: Mapping[str, Any]) -> dict[str, Any]:
        pid, required = str(provider.get("id","unknown")), bool(provider.get("required",True))
        timeout, mode = int(provider.get("timeout_seconds",300)), provider.get("mode","command")
        if mode == "command":
            argv = provider.get("argv")
            if not isinstance(argv,list) or not argv or any(not isinstance(x,str) for x in argv): raise ContinuumError(f"invalid argv for {pid}")
            result = run_checked(argv, input_text=json.dumps(envelope), timeout=timeout)
            lines = [line for line in result.stdout.splitlines() if line.strip()]
            if not lines: raise ContinuumError(f"{pid} returned no acknowledgement")
            try: ack = json.loads(lines[-1])
            except json.JSONDecodeError as exc: raise ContinuumError(f"{pid} final line is not JSON") from exc
        elif mode == "file":
            inbox = expand_path(str(provider["inbox"])); inbox.mkdir(parents=True, exist_ok=True)
            write_json(inbox / f"{envelope['barrier_id']}.json", envelope)
            ack_path, deadline = inbox / f"{envelope['barrier_id']}.ack.json", time.monotonic()+timeout
            while not ack_path.exists() and time.monotonic() < deadline: time.sleep(.5)
            if not ack_path.exists(): raise ContinuumError(f"{pid} acknowledgement timeout")
            ack = read_json(ack_path)
        else: raise ContinuumError(f"unsupported provider mode: {mode}")
        if not isinstance(ack,dict) or ack.get("handoff_digest") != envelope["state_digest"]:
            raise ContinuumError(f"{pid} acknowledged a different digest")
        return {"provider":pid,"status":"ack","required":required,"handoff_digest":ack["handoff_digest"],
                "observations":ack.get("observations",[]),"proposed_next_capsule":ack.get("proposed_next_capsule")}


class StudyWatcher(threading.Thread):
    def __init__(self, barrier:SuccessBarrier, root:pathlib.Path, patterns:Sequence[str], source_sha:str, interval:int=30):
        super().__init__(daemon=True); self.barrier,self.root,self.patterns,self.source_sha = barrier,root,patterns,source_sha
        self.interval=max(5,interval); self.stop_event=threading.Event(); self.last_digest=None
    def stop(self)->None: self.stop_event.set()
    def run(self)->None:
        while not self.stop_event.wait(self.interval):
            files=collect_files(self.root,self.patterns); snapshot={str(p.relative_to(self.root)):sha256_file(p) for p in files}
            digest=sha256_bytes(canonical_json(snapshot))
            if snapshot and digest != self.last_digest:
                self.last_digest=digest
                try: self.barrier.emit({"telemetry":snapshot,"immutable":True},self.source_sha,event="STUDY")
                except Exception as exc: write_json(self.barrier.job_dir/"handoffs"/f"study-error-{int(time.time())}.json",{"error":str(exc)})
