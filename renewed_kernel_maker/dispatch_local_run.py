from __future__ import annotations

import json
import urllib.request

RELAY="https://archie-chatgpt-relay.vercel.app/api/index"
DIRECTIVE="""OWNER-AUTHORIZED GATED 15-MINUTE CONTROLLER WORK SESSION.

PHASE 0 — SEAT TAKEOVER. DO ZERO ARCHIE PROJECT WORK BEFORE THIS PASSES.
Read http://127.0.0.1:8798/seat/head and determine the exact live current/outgoing model from seat/provider metadata. If active_occupant is not gpt56sol-chatgpt-live, yield/detach the outgoing occupant or stop only its disposable seat adapter so it cannot immediately reclaim, then attach gpt56sol-chatgpt-live with source=chatgpt, model=gpt-5.6-sol, transport=direct-developer-handoff, direct_developer=true, provider_neutral_seat=true. Touch it. Wait 5 seconds. Read seat/head again. Continue only if active_occupant is exactly gpt56sol-chatgpt-live. If that verification fails, stop immediately and perform no project work. Preserve controller 8798, worker 8799, Edge, Roblox, the PC, unrelated applications and unrelated processes. Do not restart the controller or worker. If the old resident remains running while detached, leave it detached and never reattach or fight a later replacement.

Only after the verified seat takeover, use a 15-minute wall-clock development budget to continue the current ARCHIE local-maker/fullstack job from existing state. Work only inside ARCHIE/theawesomehexapp and dedicated ARCHIE caches/workspaces. Pull current main and absorb current FULLSTACK.md, FULLSTACK_RESULT.json if present, runtime/model logs, corpus/study state, trajectories and prior heldout results. Do not reset progress or substitute a new toy project. Use full reasonable CPU/GPU/disk/network throughput available to the project while keeping a safe resource/disk reserve. Do not artificially throttle model/tool iterations. Keep inference and maker services loopback-only.

The canonical object is the whole stack, not disconnected primitives: controller -> universal remote/maker -> ARCHIE MAKER IDE -> real loopback local model -> provenance-aware study corpus -> trajectory/distillation/training loop -> fresh heldout courts.

First run python renewed_kernel_maker/maker_cli.py court and repair failures. Continue the concrete blocker. Keep/start a real OpenAI-compatible local model endpoint, preferring an already-present admissible model; otherwise acquire an approved locally fitting Qwen quant only when disk/VRAM permit it. Make the broad manifest-approved corpus and SQLite FTS study index genuinely usable through study_search, scaling within the time/free-disk budget while retaining source/license/hash/split/contamination metadata.

Then use ARCHIE MAKER's normal LOCAL model/tool loop on fresh heldout voxel briefs. The local model itself must write the project, inspect files, use study_search as useful, run checks, repair failures and finish. Never use voxel_game.py or copy a reference/template into generated projects. Pass requires both static heldout grading and actual browser execution/runtime proof. Preserve fresh seed/brief IDs, project hashes and trajectory hashes.

On failures, repair prompts, tool protocol, runtime, IDE, corpus retrieval, model selection or source as evidence indicates. Convert only non-heldout failures and approved synthetic/trajectory data into training examples. Use resource-gated SFT/LoRA/distillation only if actual local CUDA/dependencies and time admit it. Never train on heldout prompts. Rerun fresh heldout seeds after material changes. Commit/push reusable source fixes only if local repo credentials permit; never commit models, caches, personal data, secrets or private machine state.

At approximately 15 minutes stop cleanly. Do not kill healthy loopback project services merely because the work window ended.

At end post one issue 771 comment beginning CHATGPT_15M_CONTROLLER_RESULT containing: seat occupant verified and exact outgoing model if known, elapsed seconds, start/end commit, exact local model ID/quant/runtime, GPU/RAM/free disk, corpus document count/bytes/manifest/study hashes, substantive work performed, promotion court status, fresh heldout seed/brief IDs, every case's trajectory/project hashes plus browser-runtime/static grades, repair count, any training/distillation receipt, measured throughput if available, ARCHIE MAKER loopback status and exact blocker/remains. Never claim local-model voxel success unless the local model genuinely generated and executed every required fresh heldout project."""


def main()->int:
    req=urllib.request.Request(RELAY,data=json.dumps({"text":DIRECTIVE}).encode(),headers={"Content-Type":"application/json","Accept":"application/json","User-Agent":"archie-gated-chatgpt-15m/1"},method="POST")
    with urllib.request.urlopen(req,timeout=45) as r:
        body=r.read().decode("utf-8","replace")
        print("VERCEL_RELAY_STATUS",r.status);print(body[:12000])
        if not 200<=r.status<300:return 2
        try:obj=json.loads(body)
        except Exception:return 3
        return 0 if obj.get("ok") else 4

if __name__=="__main__":raise SystemExit(main())
