#!/usr/bin/env python3
"""Verified route-corpus distillation for a local OpenAI-compatible teacher.

Designed for llama.cpp, vLLM, Ollama-compatible bridges, or any local server that
implements /v1/chat/completions. It never changes frozen evaluation suites.
"""
from __future__ import annotations

import argparse, hashlib, json, os, random, time, urllib.request
from collections import Counter, defaultdict
from pathlib import Path

ROUTES = ["checklist","clarify","compound","decision","errands","event","message","next_action","objective","plan","study","summary"]
STYLES = [
    "casual text-message English with contractions",
    "brief spoken request with filler words",
    "messy but understandable mobile dictation",
    "polite conversational request",
    "urgent informal request",
    "follow-up message that relies on prior context",
]

def canon(text: str) -> str:
    return " ".join(str(text).lower().split())

def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

def call_teacher(endpoint: str, model: str, messages, temperature: float, timeout: int):
    payload = json.dumps({"model": model, "messages": messages, "temperature": temperature, "response_format": {"type":"json_object"}}).encode()
    req = urllib.request.Request(endpoint.rstrip("/") + "/v1/chat/completions", data=payload, headers={"Content-Type":"application/json", "Authorization": f"Bearer {os.getenv('ARCHIE_TEACHER_KEY','local')}"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        body = json.load(response)
    return json.loads(body["choices"][0]["message"]["content"])

def frozen_prompts(paths):
    result=set()
    for path in paths:
        p=Path(path)
        if not p.exists(): continue
        if p.suffix==".jsonl": rows=[json.loads(line) for line in p.read_text().splitlines() if line.strip()]
        else: rows=json.loads(p.read_text())
        for row in rows:
            text=row.get("text") or row.get("prompt")
            if text: result.add(canon(text))
    return result

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--endpoint", default="http://127.0.0.1:8080")
    ap.add_argument("--model", default="local-teacher")
    ap.add_argument("--samples-per-row", type=int, default=6)
    ap.add_argument("--judges", type=int, default=3)
    ap.add_argument("--seed", type=int, default=3407)
    ap.add_argument("--timeout", type=int, default=180)
    ap.add_argument("--freeze", action="append", default=[])
    args=ap.parse_args()
    random.seed(args.seed)
    rows=json.loads(Path(args.data).read_text())
    frozen=frozen_prompts(args.freeze)
    seen={canon(r["prompt"]) for r in rows} | frozen
    accepted=[]; rejected=[]; per_route=Counter()
    system=f"You create training examples for a 12-route classifier. Allowed routes: {', '.join(ROUTES)}. Preserve the source route and meaning. Never copy wording. Return JSON only."
    for index,row in enumerate(rows):
        style=STYLES[index % len(STYLES)]
        prompt=row["prompt"]; route=row["route"]
        request=f'''Source route: {route}\nSource request: {prompt}\nGenerate {args.samples_per_row} meaning-preserving rewrites in {style}. Include some order-sensitive variants and, when natural, metadata fields attachments, memory, reply_to. Return {{"candidates":[{{"prompt":"...","route":"{route}","attachments":[],"memory":"","reply_to":""}}]}}.'''
        try: candidates=call_teacher(args.endpoint,args.model,[{"role":"system","content":system},{"role":"user","content":request}],0.8,args.timeout).get("candidates",[])
        except Exception as exc:
            rejected.append({"source":index,"reason":f"teacher:{exc}"}); continue
        for candidate in candidates:
            text=canon(candidate.get("prompt",""))
            if not text or text in seen or candidate.get("route") != route:
                rejected.append({"source":index,"prompt":text,"reason":"duplicate-frozen-or-route"}); continue
            votes=[]
            for judge in range(args.judges):
                q=f'''Classify this request into exactly one route from {ROUTES}. Also decide whether it preserves the meaning of the source. Source: {prompt}\nCandidate: {text}\nReturn JSON {{"route":"...","faithful":true,"confidence":0.0}}.'''
                try: verdict=call_teacher(args.endpoint,args.model,[{"role":"system","content":"Be a strict independent verifier. JSON only."},{"role":"user","content":q}],0.0,args.timeout)
                except Exception: verdict={"route":"error","faithful":False,"confidence":0}
                votes.append(verdict)
            route_votes=Counter(v.get("route") for v in votes)
            faithful=sum(bool(v.get("faithful")) for v in votes)
            confidence=sum(float(v.get("confidence",0)) for v in votes)/max(1,len(votes))
            if route_votes[route] >= (args.judges//2+1) and faithful >= (args.judges//2+1) and confidence >= .65:
                seen.add(text); per_route[route]+=1
                accepted.append({**row, **candidate, "prompt":text, "route":route, "distillation":{"method":"multi-sample-majority-fidelity/v1","teacher":args.model,"votes":votes,"source_digest":digest({"route":route,"prompt":prompt})}})
            else: rejected.append({"source":index,"prompt":text,"reason":"verifier-reject","votes":votes})
    output=rows+accepted
    Path(args.out).parent.mkdir(parents=True,exist_ok=True)
    Path(args.out).write_text(json.dumps(output,indent=2)+"\n")
    receipt={"schema":"archie-route-megadistill/v1","teacher":args.model,"endpoint_host":args.endpoint.split('/')[2],"source_rows":len(rows),"accepted_rows":len(accepted),"rejected_rows":len(rejected),"route_additions":dict(per_route),"frozen_prompt_count":len(frozen),"output_digest":digest(output),"promotion":"not-admitted","claim_boundary":"Synthetic rewrites passed teacher-consensus fidelity checks; this is not independent proof of student improvement."}
    Path(args.out+".receipt.json").write_text(json.dumps(receipt,indent=2)+"\n")
    print(json.dumps(receipt,indent=2))

if __name__ == "__main__": main()
