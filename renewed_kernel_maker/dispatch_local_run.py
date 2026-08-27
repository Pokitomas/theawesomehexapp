from __future__ import annotations

import json
import urllib.request

RELAY="https://archie-chatgpt-relay.vercel.app/api/index"
DIRECTIVE="""OWNER-AUTHORIZED LOCAL MAKER CONTINUATION. Enter the existing controller-resident workstation session and work only inside the ARCHIE project plus dedicated ARCHIE cache/workspace directories. Preserve unrelated applications, personal files, credentials and system settings. Pull current Pokitomas/theawesomehexapp main first.

Do not decompose this into primitives. The canonical object is one stack described by renewed_kernel_maker/FULLSTACK.md: controller -> universal remote/maker -> ARCHIE MAKER IDE -> loopback local model runtime -> approved study corpus -> trajectory/distillation/training loop -> heldout courts.

Start with the executable spine, not prose: run the unified court, then execute `python renewed_kernel_maker/fullstack_bootstrap.py --root <a dedicated ARCHIE work directory> --allow-network --max-sources 12 --cases 3`. This one command is meant to discover/build llama.cpp if needed, prefer an existing admissible GGUF or acquire the official Qwen3-4B Q4_K_M fallback, build a provenance-aware permissive-code corpus and 100k deterministic curriculum, construct the SQLite FTS study index, launch the model and ARCHIE MAKER on loopback, and make the LOCAL model produce three fresh heldout voxel projects through the normal tool loop. Repair bootstrap defects in source and rerun rather than bypassing the stack.

A voxel template/reference does not count. Success requires the local model itself to write fresh project files from heldout briefs, use its file/study/run tools, repair failures, finish, and pass the heldout grader with project+trajectory hashes. If 4B cannot do it, inspect failure trajectories and run model_tournament.py against any stronger locally admissible models already present; if none fit, improve study retrieval, prompts/tool protocol, and train only from TRAIN/synthetic/approved trajectories using training_orchestrator.py + trajectory_dataset.py + train_sft.py when actual CUDA/dependencies admit it. Never train on heldout briefs or copy voxel_game.py into generated projects. Triton remains a performance backend only after reference equivalence.

Scale the approved corpus beyond the first 12 sources only while preserving a free-disk reserve and the source/license/hash/split/contamination manifest. Do not ingest unrelated private data or secrets. The model may study this corpus through study_search; corpus possession is not itself a capability claim.

Keep ARCHIE MAKER available on loopback so the same local model can subsequently make arbitrary apps from its UI. Continue closed-loop development until all fresh voxel cases pass or a concrete local hardware/runtime blocker is demonstrated. At natural return post one issue 771 comment beginning LOCAL_MAKER_VOXEL_RESULT containing seat/controller evidence, repo/local commit, exact local model + quantization + inference runtime, GPU/RAM/free disk, corpus document count/bytes/manifest/study-index hashes, heldout brief IDs, each trajectory/project hash and grade, repair counts, model throughput if available, any training/distillation receipt, ARCHIE MAKER loopback status, and exact remaining blocker. Do not report local-model voxel success without executed heldout-project evidence."""


def main()->int:
    req=urllib.request.Request(RELAY,data=json.dumps({"text":DIRECTIVE}).encode(),headers={"Content-Type":"application/json","Accept":"application/json","User-Agent":"archie-fullstack-local-maker/3"},method="POST")
    with urllib.request.urlopen(req,timeout=45) as r:
        body=r.read().decode("utf-8","replace")
        print("VERCEL_RELAY_STATUS",r.status);print(body[:12000])
        if not 200<=r.status<300:return 2
        try:obj=json.loads(body)
        except Exception:return 3
        return 0 if obj.get("ok") else 4

if __name__=="__main__":raise SystemExit(main())
