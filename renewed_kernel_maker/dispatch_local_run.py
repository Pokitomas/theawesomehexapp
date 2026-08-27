from __future__ import annotations

import json
import urllib.request

RELAY="https://archie-chatgpt-relay.vercel.app/api/index"
DIRECTIVE="""OWNER-AUTHORIZED SOFTWARE DEVELOPMENT RUN on the local workstation. Work only on the ARCHIE local-maker project and its dedicated caches/workspaces; do not modify unrelated applications, personal files, credentials, or system settings. Pull current Pokitomas/theawesomehexapp main and treat renewed_kernel_maker/FULLSTACK.md as the canonical architecture.

Goal: make the full stack real enough that a genuinely local model can create a complete voxel game from the ARCHIE MAKER app. Run python renewed_kernel_maker/maker_cli.py court first and repair any failures. Inventory existing GGUF/local-model files and installed inference runtimes without downloading a giant teacher. Prefer an already-present model; otherwise choose a locally admissible open model from model_sourcing.py. Test Qwen3-8B Q4, Qwen2.5-Coder-7B Q4, or a smaller Qwen only if they actually fit. Do not claim a model fit until it launches and answers a loopback OpenAI-compatible endpoint.

Build a dedicated corpus cache and study index using corpus_sources.json, corpus_build.py, curriculum.py, and study_index.py. Only ingest sources permitted by the manifest; retain source/license/hash/split metadata; do not ingest unrelated private files, secrets, benchmark heldout prompts, or credentials. Scale corpus acquisition to reasonable free-disk/time limits. Build deterministic curriculum shards, then expose the resulting FTS study DB to ARCHIE MAKER through ARCHIE_STUDY_DB.

Start the local model server and ARCHIE MAKER server on loopback only. Use the maker's normal model/tool loop, not voxel_game.py or a copied template, to run at least three fresh heldout voxel briefs through voxel_heldout.evaluate_suite. The model may use approved study_search. It must write the project, inspect it, run checks, repair failures and finish. Record project/trajectory hashes and grader results. If it fails, convert non-heldout failures and approved synthetic trajectories into training examples and use the resource-gated SFT/LoRA path only if GPU and dependencies admit it; never train on heldout cases.

Continue improving the IDE, tool loop, corpus, prompting, model selection and training until either all fresh heldout voxel cases pass or a concrete local resource/runtime blocker is demonstrated. Reference ARCHIE VOXEL is a grader/reference only. At the end post one issue 771 comment beginning LOCAL_MAKER_VOXEL_RESULT with local commit, model ID/quantization/runtime, GPU/RAM/free disk, corpus count/bytes/manifest/study-index hashes, heldout brief IDs, trajectory/project hashes and grades, repair steps, training receipt if any, measured tokens/sec if available, and exact blocker/remains. Never report local-model voxel success unless the local model actually produced and executed the heldout projects."""


def main()->int:
    req=urllib.request.Request(RELAY,data=json.dumps({"text":DIRECTIVE}).encode(),headers={"Content-Type":"application/json","Accept":"application/json","User-Agent":"archie-local-maker-voxel/2"},method="POST")
    with urllib.request.urlopen(req,timeout=45) as r:
        body=r.read().decode("utf-8","replace"); print("VERCEL_RELAY_STATUS",r.status); print(body[:12000])
        if not 200<=r.status<300:return 2
        try:obj=json.loads(body)
        except Exception:return 3
        return 0 if obj.get("ok") else 4

if __name__=="__main__":raise SystemExit(main())
