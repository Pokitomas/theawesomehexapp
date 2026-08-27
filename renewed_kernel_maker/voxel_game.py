from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path
from typing import Any

from core import canonical, receipt, verify_receipt

SCHEMA = "archie-voxel-project/v1"

HTML = r'''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ARCHIE VOXEL</title><style>html,body{margin:0;height:100%;overflow:hidden;background:#111;color:#fff;font:12px monospace}canvas{width:100%;height:100%;display:block;image-rendering:pixelated}#hud{position:fixed;inset:10px auto auto 10px;background:#0008;padding:8px;border-radius:8px}#cross{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);font-size:20px}</style><canvas id=c></canvas><div id=hud>ARCHIE VOXEL · click to lock · WASD · space · LMB remove · RMB place · 1-4 material</div><div id=cross>+</div><script>
'use strict';const C=document.getElementById('c'),g=C.getContext('2d'),W=48,H=28,D=48,S=10;let seed=1337,mat=1,yaw=0,pitch=0,keys={},p={x:24,y:18,z:24,vy:0};const world=new Uint8Array(W*H*D),idx=(x,y,z)=>x+W*(z+D*y),inside=(x,y,z)=>x>=0&&z>=0&&y>=0&&x<W&&z<D&&y<H;function rng(n){n=(n^61)^(n>>>16);n=n+ (n<<3);n=n^(n>>>4);n=n*0x27d4eb2d;n=n^(n>>>15);return(n>>>0)/4294967296}function build(){world.fill(0);for(let z=0;z<D;z++)for(let x=0;x<W;x++){let h=6+Math.floor(rng(seed+x*73856093+z*19349663)*5);for(let y=0;y<=h;y++)world[idx(x,y,z)]=y===h?2:(y>h-3?3:1)}}build();function solid(x,y,z){x=Math.floor(x);y=Math.floor(y);z=Math.floor(z);return inside(x,y,z)&&world[idx(x,y,z)]!==0}function tryMove(nx,ny,nz){if(!solid(nx,ny,nz)&&!solid(nx,ny+1.6,nz)){p.x=nx;p.y=ny;p.z=nz;return true}return false}function ray(max=8){let cp=Math.cos(pitch),dx=Math.sin(yaw)*cp,dy=Math.sin(pitch),dz=Math.cos(yaw)*cp,last=null;for(let t=0;t<max;t+=.08){let q={x:Math.floor(p.x+dx*t),y:Math.floor(p.y+1.4+dy*t),z:Math.floor(p.z+dz*t)};if(solid(q.x,q.y,q.z))return{hit:q,prev:last};last=q}return null}C.onclick=()=>C.requestPointerLock();addEventListener('mousemove',e=>{if(document.pointerLockElement===C){yaw+=e.movementX*.0025;pitch=Math.max(-1.45,Math.min(1.45,pitch-e.movementY*.0025))}});addEventListener('keydown',e=>{keys[e.code]=1;if(/^Digit[1-4]$/.test(e.code))mat=+e.code.slice(5);if(e.code==='KeyP')save();if(e.code==='KeyO')load()});addEventListener('keyup',e=>keys[e.code]=0);addEventListener('contextmenu',e=>e.preventDefault());addEventListener('mousedown',e=>{if(document.pointerLockElement!==C)return;let r=ray();if(!r)return;if(e.button===0)world[idx(r.hit.x,r.hit.y,r.hit.z)]=0;if(e.button===2&&r.prev&&inside(r.prev.x,r.prev.y,r.prev.z))world[idx(r.prev.x,r.prev.y,r.prev.z)]=mat});function save(){localStorage.setItem('archie-voxel-world',JSON.stringify({schema:'archie-voxel-project/v1',seed,world:Array.from(world),p,yaw,pitch}))}function load(){let s=JSON.parse(localStorage.getItem('archie-voxel-world')||'null');if(s&&s.schema==='archie-voxel-project/v1'&&s.world?.length===world.length){world.set(s.world);p=s.p;yaw=s.yaw;pitch=s.pitch}}let last=performance.now(),frames=0,acc=0;function loop(now){let dt=Math.min(.05,(now-last)/1000);last=now;let f=(keys.KeyW?1:0)-(keys.KeyS?1:0),r=(keys.KeyD?1:0)-(keys.KeyA?1:0),sp=6*dt,dx=Math.sin(yaw)*f+Math.cos(yaw)*r,dz=Math.cos(yaw)*f-Math.sin(yaw)*r;tryMove(p.x+dx*sp,p.y,p.z+dz*sp);p.vy-=18*dt;if(keys.Space&&solid(p.x,p.y-.12,p.z))p.vy=7;tryMove(p.x,p.y+p.vy*dt,p.z)|| (p.vy=0);render();frames++;acc+=dt;if(acc>1){document.getElementById('hud').textContent=`ARCHIE VOXEL · seed ${seed} · mat ${mat} · ${frames} fps · P save O load`;frames=0;acc=0}requestAnimationFrame(loop)}function render(){C.width=innerWidth;C.height=innerHeight;g.fillStyle='#87bde8';g.fillRect(0,0,C.width,C.height);let scale=Math.min(C.width/64,C.height/36);for(let d=24;d>.5;d-=.35){let cx=p.x+Math.sin(yaw)*d,cz=p.z+Math.cos(yaw)*d,cy=p.y+Math.sin(pitch)*d*.45;for(let ox=-12;ox<=12;ox++){let x=Math.floor(cx+Math.cos(yaw)*ox*.7),z=Math.floor(cz-Math.sin(yaw)*ox*.7);for(let y=Math.min(H-1,Math.floor(cy+8));y>=Math.max(0,Math.floor(cy-8));y--){if(solid(x,y,z)){let sx=C.width/2+ox*scale*1.2,sy=C.height/2-(y-p.y)*scale*1.4+d*scale*.13;let sz=Math.max(2,scale*14/(1+d*.12));g.fillStyle=['','#777','#61a84b','#8b633e','#d7c36d'][world[idx(x,y,z)]]||'#aaa';g.fillRect(sx-sz/2,sy-sz/2,sz,sz);break}}}}}requestAnimationFrame(loop);
</script>'''

REQUIRED = [
    "requestPointerLock", "KeyW", "Space", "contextmenu", "localStorage", "archie-voxel-project/v1",
    "world[idx", "ray(", "tryMove(", "requestAnimationFrame"
]


def generate(root: Path, *, seed: int = 1337, brief: str = "procedural survival voxel sandbox") -> dict[str, Any]:
    root.mkdir(parents=True, exist_ok=True)
    body = HTML.replace("let seed=1337", f"let seed={int(seed)}")
    (root / "index.html").write_text(body, encoding="utf-8")
    spec = {"schema": SCHEMA, "seed": int(seed), "brief": str(brief), "entry": "index.html", "network": False}
    (root / "project.json").write_bytes(canonical(spec)+b"\n")
    return receipt("voxel.generate", {"spec": spec, "files": ["index.html", "project.json"], "project_sha256": hashlib.sha256(canonical(spec)).hexdigest()})


def inspect(root: Path) -> dict[str, Any]:
    html = (root / "index.html").read_text(encoding="utf-8")
    spec = json.loads((root / "project.json").read_text(encoding="utf-8"))
    checks = {x: x in html for x in REQUIRED}
    return receipt("voxel.inspect", {"schema": spec.get("schema"), "checks": checks, "offline": "http://" not in html and "https://" not in html, "bytes": len(html.encode())})


def court() -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="archie-voxel-") as td:
        root = Path(td)
        a = generate(root, seed=424242, brief="heldout voxel world")
        i = inspect(root)
        first = (root / "index.html").read_bytes()
        root2 = root / "r2"
        b = generate(root2, seed=424242, brief="heldout voxel world")
        second = (root2 / "index.html").read_bytes()
        checks = i["payload"]["checks"]
        passes = verify_receipt(a) and verify_receipt(i) and verify_receipt(b) and all(checks.values()) and i["payload"]["offline"] and first == second
        return receipt("voxel.court", {"passes": passes, "deterministic_generation": first == second, "offline": i["payload"]["offline"], "checks": checks, "bytes": i["payload"]["bytes"]})

if __name__ == "__main__": print(json.dumps(court(), indent=2))
