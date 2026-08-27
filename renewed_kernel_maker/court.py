from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

HERE=Path(__file__).resolve().parent
if str(HERE) not in sys.path:sys.path.insert(0,str(HERE))

from core import Capability,SeatLease,UniversalRemoteKernel,receipt,verify_receipt
import corpus_foundry,curriculum,distill,local_model_maker,local_runtime,maker_fixture,model_sourcing,model_tournament,preference_train,render_ffmpeg,render_integration,study_index,synthetic_pref,train_sft,trajectory_dataset,video_editor_v2,voxel_game,voxel_heldout

def wrap(kind,module,key):
    r=module.court();return receipt(kind,{key:r["payload"],"passes":bool(r["payload"].get("passes"))})
def cold_start_court():
    modules="core,maker_fixture,video_editor_v2,render_ffmpeg,render_integration,synthetic_pref,preference_train,distill,voxel_game,corpus_foundry,curriculum,study_index,model_sourcing,model_tournament,local_model_maker,local_runtime,voxel_heldout,trajectory_dataset,train_sft"
    code="import sys;sys.path.insert(0,"+repr(str(HERE))+ ");import "+modules+";print(core.SCHEMA)";t0=time.perf_counter_ns();p=subprocess.run([sys.executable,"-c",code],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=20);elapsed=time.perf_counter_ns()-t0
    return receipt("court.cold_start",{"returncode":p.returncode,"elapsed_ns":elapsed,"elapsed_ms":elapsed/1e6,"stdout":p.stdout[-2000:],"passes":p.returncode==0 and "archie-kernel-maker/v1" in p.stdout})
def receipt_court():
    value=receipt("fixture",{"z":1,"a":[3,2,1]});again=receipt("fixture",{"a":[3,2,1],"z":1});bad=json.loads(json.dumps(value));bad["payload"]["z"]=2;passes=verify_receipt(value) and value["sha256"]==again["sha256"] and not verify_receipt(bad);return receipt("court.receipt",{"valid":verify_receipt(value),"order_independent":value["sha256"]==again["sha256"],"corruption_detected":not verify_receipt(bad),"passes":passes})
def stale_seat_court():
    seat=SeatLease();a=seat.claim("alpha",now=10,ttl_s=1);refused=seat.claim("beta",now=10.5,ttl_s=1);takeover=seat.claim("beta",now=11.01,ttl_s=1);good=a["payload"].get("occupant")=="alpha" and refused["kind"]=="seat.refused" and takeover["payload"].get("occupant")=="beta" and takeover["payload"].get("takeover") is True;return receipt("court.stale_seat",{"alpha":a,"pre_expiry":refused,"post_expiry":takeover,"passes":good})
def remote_court():
    k=UniversalRemoteKernel();seen=[]
    def adapter(action):seen.append(action);return {"ok":True,"verified":True,"proof":{"echo":action}}
    k.register(Capability("desktop.type",mutating=True,reversible=True),adapter);basis=k.observe({"focused":"editor"});gen=basis["payload"]["basis_generation"];good=k.act("desktop.type",{"text":"x"},basis_generation=gen);k.observe({"focused":"other"});stale=k.act("desktop.type",{"text":"bad"},basis_generation=gen);unknown=k.act("desktop.unknown",{},basis_generation=k.basis_generation);passes=good["kind"]=="remote.effect" and stale["kind"]=="remote.refused" and stale["payload"].get("reason")=="stale_basis" and unknown["kind"]=="remote.refused" and seen==[{"text":"x"}];return receipt("court.remote",{"good":good,"stale":stale,"unknown":unknown,"executed":seen,"passes":passes})
def maker_court():
    r=maker_fixture.court();p=r["payload"];passes=all(bool(p.get(k)) for k in ("inspect_valid","pre_repair_failed","repair_receipt","cache_invalidated","post_repair_passed","run_passed"));return receipt("court.maker",{"maker":p,"passes":passes})
def editor_court():
    r=video_editor_v2.court();p=r["payload"];b=p["benchmark"];passes=all(bool(p.get(k)) for k in ("add_receipt","split_receipt","undo_receipt","redo_receipt","redo_exact","portable_roundtrip","save_receipt")) and bool(b["deterministic_replay"]) and bool(b["exact_frame_roundtrip"]) and bool(b["mutation_receipts_valid"]);return receipt("court.editor",{"editor":p,"passes":passes})
def distill_court():
    r=distill.court();p=r["payload"];passes=bool(p["kl_oracle"]["passes"]) and p["import_attempt"]["status"] in {"BLOCKED","READY_TO_MATERIALIZE"} and p["triton"]["status"] in {"SKIP","PASS"};return receipt("court.distill",{"distill":p,"passes":passes})
def run():
    courts={"cold_start":cold_start_court(),"receipts":receipt_court(),"stale_seat":stale_seat_court(),"remote":remote_court(),"maker":maker_court(),"video_editor":editor_court(),"video_render":wrap("court.render",render_ffmpeg,"render"),"video_render_integration":wrap("court.render_integration",render_integration,"integration"),"voxel_reference":wrap("court.voxel",voxel_game,"voxel"),"local_model_maker_membrane":wrap("court.local_maker",local_model_maker,"local_maker"),"local_runtime":wrap("court.local_runtime",local_runtime,"local_runtime"),"voxel_heldout_grader":wrap("court.voxel_heldout",voxel_heldout,"voxel_heldout"),"corpus_foundry":wrap("court.corpus",corpus_foundry,"corpus"),"curriculum":wrap("court.curriculum",curriculum,"curriculum"),"study_index":wrap("court.study_index",study_index,"study_index"),"trajectory_dataset":wrap("court.trajectory_dataset",trajectory_dataset,"trajectory_dataset"),"model_sourcing":wrap("court.model_sourcing",model_sourcing,"model_sourcing"),"model_tournament":wrap("court.model_tournament",model_tournament,"model_tournament"),"distill":distill_court(),"synthetic_preference":wrap("court.synthetic",synthetic_pref,"synthetic"),"preference_training":wrap("court.preference_training",preference_train,"training"),"sft_recipe":wrap("court.sft",train_sft,"sft")}
    passes={n:bool(v["payload"].get("passes")) for n,v in courts.items()};return receipt("kernel-maker.promotion-court",{"courts":courts,"passes":passes,"all_required_pass":all(passes.values()),"promotion":"ADMIT" if all(passes.values()) else "REFUSE","local_model_voxel_claim":"NOT_EVALUATED_BY_HOSTED_CI; only voxel_heldout.evaluate_suite on a real local endpoint may set this claim"})
if __name__=="__main__":out=run();print(json.dumps(out,indent=2,default=str));raise SystemExit(0 if out["payload"]["all_required_pass"] else 1)
