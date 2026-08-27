from __future__ import annotations

import hashlib,json,re,tempfile
from dataclasses import asdict,dataclass
from pathlib import Path
from typing import Any

from core import canonical,receipt,verify_receipt
from local_model_maker import RuntimeConfig,probe,run_maker
import voxel_runtime

SCHEMA="archie-voxel-heldout/v2"
@dataclass(frozen=True)
class Brief:id:str;seed:int;text:str;required:tuple[str,...]
BRIEF_FAMILIES=(
"Build an offline first-person voxel exploration game called {name}. The world must be procedurally generated from seed {seed}; support WASD movement, mouse look, jump/gravity, collision, remove/place blocks, at least four materials, and persistent save/load. It must launch from a local project without network dependencies.",
"Create a self-contained browser voxel sandbox named {name}, seed {seed}. Include terrain generation, first-person pointer-lock controls, solid voxel collision, mining and placement, material selection, world persistence, an on-screen HUD, and a small performance readout. No CDN or network assets.",
"Make a playable block-world prototype {name}. Deterministic seed {seed}; walking, looking, jumping, gravity, collision, raycast-like block interaction, multiple block types, save/load, and an offline runnable entry point are mandatory. Add one original mechanic of your choice.")
def briefs(count=3,base_seed=731003):
    out=[]
    for i in range(max(1,int(count))):
        seed=base_seed+i*7919;name=f"Heldout-{hashlib.sha256(str(seed).encode()).hexdigest()[:6]}";text=BRIEF_FAMILIES[i%len(BRIEF_FAMILIES)].format(name=name,seed=seed);required=("offline","world","movement","mouse_look","jump_gravity","collision","remove_place","materials","persistence","render_loop");bid=hashlib.sha256((str(seed)+"\0"+text).encode()).hexdigest()[:16];out.append(Brief(bid,seed,text,required))
    return out
def _all_text(root):
    chunks=[];files=[]
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.stat().st_size>2_000_000:continue
        try:text=p.read_text(encoding="utf-8")
        except Exception:continue
        rel=p.relative_to(root).as_posix();files.append({"path":rel,"bytes":len(text.encode())});chunks.append(f"\n/* FILE:{rel} */\n{text}")
    return "".join(chunks),files
def grade(root):
    text,files=_all_text(root);low=text.lower();checks={"entry":any(Path(f["path"]).name in {"index.html","main.html"} for f in files),"offline":not re.search(r"https?://|<script[^>]+src=|<link[^>]+href=['\"]https?",text,flags=re.I),"world":any(x in low for x in ("voxel","block","world","chunk")) and any(x in low for x in ("uint8array","array","map","grid")),"movement":("keyw" in low or "wasd" in low or "keydown" in low) and any(x in low for x in ("position","player","camera")),"mouse_look":any(x in low for x in ("pointerlock","movementx","mousemove")) and any(x in low for x in ("yaw","pitch","rotation")),"jump_gravity":"gravity" in low or ("space" in low and any(x in low for x in ("vy","velocity","jump"))),"collision":any(x in low for x in ("collision","solid(","collide","isblock","blocked")),"remove_place":any(x in low for x in ("mousedown","pointerdown","click")) and any(x in low for x in ("ray","remove","mine","place")),"materials":any(x in low for x in ("material","hotbar","blocktype","palette")),"persistence":any(x in low for x in ("localstorage","indexeddb","save","load")),"render_loop":"requestanimationframe" in low or "setanimationloop" in low};score=sum(bool(v) for v in checks.values())/len(checks);return receipt("voxel.grade",{"checks":checks,"score":score,"passes":all(checks.values()),"files":files})
def evaluate(config,root,brief):
    run=run_maker(config,brief.text,root);static=grade(root);runtime=voxel_runtime.execute(root);passes=run["payload"]["status"]=="FINISHED" and bool(static["payload"]["passes"]) and runtime["payload"].get("status")=="PASS"
    return receipt("voxel.heldout_case",{"schema":SCHEMA,"brief":asdict(brief),"maker":run["payload"],"grade":static["payload"],"runtime":runtime["payload"],"passes":passes,"claimable":passes})
def evaluate_suite(config,out_root,count=3):
    ready=probe(config)
    if ready["payload"]["status"]!="READY":return receipt("voxel.heldout_suite",{"status":"BLOCKED","reason":ready["payload"],"passes":False,"claimable":False})
    cases=[evaluate(config,out_root/b.id,b) for b in briefs(count=count)];passed=sum(bool(c["payload"]["passes"]) for c in cases);payloads=[c["payload"] for c in cases]
    return receipt("voxel.heldout_suite",{"status":"COMPLETE","cases":payloads,"passed":passed,"total":len(cases),"success_rate":passed/max(1,len(cases)),"passes":passed==len(cases),"claimable":passed==len(cases),"executed_runtime_required":True,"suite_sha256":hashlib.sha256(canonical(payloads)).hexdigest()})
def court():
    with tempfile.TemporaryDirectory(prefix="archie-voxel-grade-") as td:
        root=Path(td);root.joinpath("index.html").write_text("""<canvas></canvas><script>let world=new Uint8Array(99),player={position:0},yaw=0,pitch=0,gravity=9.8,material=1;function solid(){} function collision(){} function ray(){} addEventListener('keydown',e=>{if(e.code==='KeyW'||e.code==='Space')player.position++});addEventListener('mousemove',e=>{yaw+=e.movementX;pitch+=e.movementY});document.body.requestPointerLock;addEventListener('mousedown',()=>{ray();material=2});function save(){localStorage.setItem('w','x')}function load(){localStorage.getItem('w')}function loop(){requestAnimationFrame(loop)}loop();</script>""",encoding="utf-8");g1=grade(root);g2=grade(root);hs=briefs(4);unique=len({b.id for b in hs})==4;no_ref=all("ARCHIE VOXEL" not in b.text for b in hs);passes=verify_receipt(g1) and g1==g2 and bool(g1["payload"]["passes"]) and unique and no_ref;return receipt("voxel_heldout.court",{"passes":passes,"grader_deterministic":g1==g2,"brief_ids_unique":unique,"reference_name_absent":no_ref,"success_contract":"static grade + executed browser runtime PASS"})
if __name__=="__main__":print(json.dumps(court(),indent=2))
