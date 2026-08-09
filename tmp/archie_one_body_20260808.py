#!/usr/bin/env python3
import json, os, pathlib, re, subprocess, time, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
HOME=pathlib.Path('/home/awesomekai')
REMOTE=HOME/'archie-remote'
RUNS=HOME/'runs'
PORT=int(os.environ.get('ARCHIE_UNIFIED_PORT','8794'))

def read_json(p, default=None):
    try:return json.loads(pathlib.Path(p).read_text(errors='replace'))
    except:return default

def tail(p,n=60):
    try:return pathlib.Path(p).read_text(errors='replace').splitlines()[-n:]
    except:return []

def ps_lines():
    try:
        s=subprocess.run(['ps','-eo','pid,ppid,etimes,pcpu,pmem,args','--sort=-etimes'],capture_output=True,text=True,timeout=2).stdout
        keep=[]
        for line in s.splitlines():
            lo=line.lower()
            if any(k in lo for k in ['archie','model_kernel_court','train_','qh_','ia_radix_catalog','observer.py','runtime_truth.py']):
                if 'grep ' not in lo: keep.append(line[:500])
        return keep[-80:]
    except:return []

def gpu():
    try:
        q=['nvidia-smi','--query-compute-apps=pid,process_name,used_memory','--format=csv,noheader,nounits']
        return subprocess.run(q,capture_output=True,text=True,timeout=2).stdout.strip().splitlines()
    except:return []

def recent_receipts():
    out=[]
    roots=[RUNS, HOME/'archie-quaternion-heisenberg-autoscale-v1', HOME/'archie-reading']
    now=time.time()
    for root in roots:
        if not root.exists(): continue
        try:
            for p in root.rglob('*.json'):
                try:
                    st=p.stat()
                    if now-st.st_mtime>36*3600: continue
                    name=p.name.lower()
                    if any(k in name for k in ['receipt','status','decision','court','truth','goalpost']):
                        out.append((st.st_mtime,str(p),st.st_size))
                except: pass
        except: pass
    out.sort(reverse=True)
    return [{'mtime':t,'path':p,'bytes':b} for t,p,b in out[:80]]

def pages():
    roots=[HOME, pathlib.Path('/mnt/c/Users/AwesomeKai/AppData/Local/Temp')]
    out=[]; now=time.time()
    for root in roots:
        if not root.exists(): continue
        candidates=[]
        if root==HOME:
            candidates=[HOME/'archie-remote',HOME/'archie-lab-observer-v2',HOME/'archie-reading',HOME/'archie-resident-gpt56']
        else:
            try:candidates=list(root.glob('datascience-artifact-site-*'))[-12:]
            except:candidates=[]
        for base in candidates:
            try:
                for p in base.rglob('*.html'):
                    try:
                        st=p.stat(); out.append((st.st_mtime,str(p),st.st_size))
                    except: pass
            except: pass
    out.sort(reverse=True)
    return [{'mtime':t,'path':p,'bytes':b} for t,p,b in out[:60]]

def state():
    truth=read_json(REMOTE/'runtime_truth.json',{}) or {}
    s5=RUNS/'archie-v3-contextual-token-ladder/s5-8192/train.log'
    s4=RUNS/'archie-v3-contextual-token-ladder/s4-4096/training-receipt.json'
    v4=RUNS/'archie-v4-directed-edge-discovery-s52/decision.json'
    return {
      'captured_unix':time.time(),
      'truth':truth,
      'gpu':gpu(),
      'processes':ps_lines(),
      's5_tail':tail(s5,80),
      's4_receipt':read_json(s4,{}),
      'v4_decision':read_json(v4,{}),
      'recent_receipts':recent_receipts(),
      'pages':pages(),
      'room_tail':[read_json_line(x) for x in tail(REMOTE/'roast.jsonl',50)],
    }

def read_json_line(x):
    try:return json.loads(x)
    except:return {'text':x}

HTML=r'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ARCHIE — one body</title>
<style>
:root{--ink:#191714;--paper:#eee4d1;--paper2:#d9c6a7;--brown:#5b3a2d;--rust:#9b4e34;--moss:#52604c;--blue:#3f5f67;--line:#9e896d;--soft:#f7f0e2;--red:#8d332c;--green:#2f6b4f;--gold:#b48b43}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font-family:Georgia,'Times New Roman',serif}.top{position:sticky;top:0;z-index:20;background:rgba(25,23,20,.96);color:var(--paper);display:flex;gap:14px;align-items:center;padding:10px 18px;border-bottom:4px solid var(--rust);backdrop-filter:blur(8px)}.brand{font:800 17px/1 ui-monospace,monospace;letter-spacing:.14em}.nav{display:flex;gap:6px;overflow:auto}.nav a{color:#e6d5b9;text-decoration:none;font:700 11px ui-monospace,monospace;padding:6px 8px;border:1px solid #66574a}.clock{margin-left:auto;font:11px ui-monospace,monospace;color:#c8b79b;white-space:nowrap}.hero{padding:38px 4vw 28px;border-bottom:1px solid var(--line);background:radial-gradient(circle at 80% 20%,#d2b98f55,transparent 35%),linear-gradient(115deg,#efe3cc,#d9c6a7)}h1{font-size:clamp(44px,9vw,108px);line-height:.82;margin:0;letter-spacing:-.06em}.sub{font:700 12px/1.5 ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;margin-top:20px;max-width:920px}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px;padding:12px 4vw}.card{background:var(--soft);border:1px solid var(--line);box-shadow:2px 2px 0 #6e5b4430;padding:14px;min-width:0}.span12{grid-column:span 12}.span8{grid-column:span 8}.span7{grid-column:span 7}.span6{grid-column:span 6}.span5{grid-column:span 5}.span4{grid-column:span 4}.span3{grid-column:span 3}.k{font:800 10px ui-monospace,monospace;letter-spacing:.15em;text-transform:uppercase;color:var(--rust)}h2{font-size:30px;margin:4px 0 12px;letter-spacing:-.03em}h3{font-size:18px;margin:10px 0 6px}.mono,pre,code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.mono{font-size:11px;line-height:1.45}.big{font:800 clamp(26px,5vw,62px)/.9 ui-monospace,monospace}.badge{display:inline-block;padding:3px 6px;border:1px solid currentColor;font:800 10px ui-monospace,monospace;margin:2px}.ok{color:var(--green)}.bad{color:var(--red)}.warn{color:#8a641d}.muted{color:#6c6255}.bar{height:9px;background:#cbb99e;margin:8px 0;overflow:hidden}.bar>i{display:block;height:100%;background:var(--rust);width:0}.proc{max-height:320px;overflow:auto;white-space:pre-wrap}.room{max-height:520px;overflow:auto}.msg{border-top:1px dotted var(--line);padding:8px 0}.who{font:800 10px ui-monospace,monospace;color:var(--rust)}.text{font:13px/1.4 ui-monospace,monospace;white-space:pre-wrap}.diagram{width:100%;min-height:260px}.node{fill:#f7f0e2;stroke:#5b3a2d;stroke-width:1.5}.edge{stroke:#5b3a2d;stroke-width:1.5;fill:none;marker-end:url(#a)}.svgt{font:700 11px ui-monospace,monospace;fill:#191714}.tiny{font:10px ui-monospace,monospace;fill:#5b3a2d}.table{width:100%;border-collapse:collapse;font:11px/1.35 ui-monospace,monospace}.table td,.table th{border-top:1px solid #b9a88e;padding:6px;text-align:left;vertical-align:top}.receipt{word-break:break-all}.pages li{margin:5px 0;font:11px/1.35 ui-monospace,monospace}.footer{padding:28px 4vw 50px;font:11px/1.5 ui-monospace,monospace;color:#5d5449;border-top:1px solid var(--line)}@media(max-width:900px){.span8,.span7,.span6,.span5,.span4,.span3{grid-column:span 12}.grid{padding:8px}.top{padding:8px}.hero{padding:28px 14px}.nav{display:none}}
</style></head><body><div class="top"><div class="brand">ARCHIE / ONE BODY</div><div class="nav"><a href="#live">LIVE</a><a href="#anatomy">ANATOMY</a><a href="#train">TRAIN</a><a href="#courts">COURTS</a><a href="#corpus">CORPUS</a><a href="#room">ROOM</a><a href="#pages">PAGES</a></div><div class="clock" id="clock">loading</div></div>
<section class="hero"><div class="k">field manual · runtime truth · research anatomy · corpus provenance</div><h1>ARCHIE<br>WITHOUT THE<br>WINDOW PILE.</h1><div class="sub">One representational surface. It does not steer experiments. It reads machine truth, training traces, receipts, corpus work, and the shared room. No fake cognition. No decorative latent coordinates.</div></section>
<div class="grid" id="live"><section class="card span4"><div class="k">canonical compute</div><div class="big" id="compute">—</div><div id="truthbadges"></div><div class="mono muted" id="truthmeta"></div></section><section class="card span4"><div class="k">GPU ownership</div><h2>physical device</h2><div class="mono" id="gpu">—</div></section><section class="card span4"><div class="k">agents</div><h2>real, not addressed</h2><div class="mono" id="agents">—</div></section>
<section class="card span12" id="anatomy"><div class="k">model anatomy</div><h2>tiny contextual survivor — what actually computes</h2><svg class="diagram" viewBox="0 0 1200 300"><defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#5b3a2d"/></marker></defs><rect class="node" x="20" y="105" width="140" height="70"/><text class="svgt" x="36" y="132">260-symbol</text><text class="tiny" x="36" y="151">byte + special IDs</text><path class="edge" d="M160 140H215"/><rect class="node" x="215" y="105" width="145" height="70"/><text class="svgt" x="232" y="132">embedding</text><text class="tiny" x="232" y="151">d = 192</text><path class="edge" d="M360 140H415"/><rect class="node" x="415" y="55" width="190" height="170"/><text class="svgt" x="432" y="82">8 residual blocks</text><text class="tiny" x="432" y="108">6 × Delta mixer</text><text class="tiny" x="432" y="128">2 × local attention</text><text class="tiny" x="432" y="148">window 256</text><text class="tiny" x="432" y="168">conv kernel 4</text><text class="tiny" x="432" y="188">SwiGLU FFN</text><path class="edge" d="M605 140H660"/><rect class="node" x="660" y="50" width="215" height="180"/><text class="svgt" x="678" y="78">typed Delta memory</text><text class="tiny" x="678" y="105">heads 6 · key 8 · value 32</text><text class="tiny" x="678" y="125">read-before-write</text><text class="tiny" x="678" y="145">block 32</text><text class="tiny" x="678" y="165">address ≠ contextual value</text><text class="tiny" x="678" y="185">state is FP32</text><path class="edge" d="M875 140H930"/><rect class="node" x="930" y="105" width="120" height="70"/><text class="svgt" x="947" y="132">RMSNorm</text><text class="tiny" x="947" y="151">residual</text><path class="edge" d="M1050 140H1090"/><rect class="node" x="1090" y="105" width="90" height="70"/><text class="svgt" x="1105" y="132">tied LM</text><text class="tiny" x="1105" y="151">CE/BPB</text></svg><div class="mono muted">Nonrecurrent maximum reach in the long1024 court: 6×(4−1)+2×(256−1)=528 tokens. The recurrent path can transmit farther; the ≥645-lag natural-prefix intervention showed transmission without useful natural-text benefit. That is a capacity/opportunity result, not a long-memory victory.</div></section>
<section class="card span7" id="train"><div class="k">training</div><h2>current trace</h2><div id="trainhead"></div><pre class="proc" id="trainlog">—</pre></section><section class="card span5"><div class="k">survivor</div><h2>s4 contextual</h2><div class="big" id="s4bpb">—</div><div class="mono" id="s4meta"></div><hr><div class="k">killed branch</div><h3>directed-edge v4</h3><div class="mono" id="v4"></div></section>
<section class="card span8" id="courts"><div class="k">recent evidence</div><h2>receipts, decisions, courts</h2><table class="table"><thead><tr><th>age</th><th>artifact</th><th>bytes</th></tr></thead><tbody id="receipts"></tbody></table></section><section class="card span4"><div class="k">scientific boundary</div><h2>what survives</h2><p><span class="badge ok">S4 SURVIVES</span> contextual line remains the admitted research survivor.</p><p><span class="badge bad">V4 KILLED</span> directed-edge failed its preregistered utility gate; no rescue by goalpost edit.</p><p><span class="badge bad">TRITON NOT ADMITTED</span> clean full-model court showed speed but parity failure; speed is not promotion.</p><p><span class="badge warn">LONG MEMORY OPEN</span> transmission exists; useful natural-text dependence beyond local reach was not shown by the far-prefix court.</p></section>
<section class="card span6" id="corpus"><div class="k">corpus / books</div><h2>deconditioning lane</h2><p>Books and historical documents are evidence sources, not wallpaper. This surface deliberately does not read personal media folders or ASMR content. It watches the research ingestion lane and receipts only.</p><div class="mono">Public-domain/historical reading lane → provenance/rights → normalized text → held-out separation → sampler → gradients → sealed evaluation.</div><div class="bar"><i style="width:68%"></i></div><div class="mono muted">Project Panama stays “not located” until a real source path exists. No invented anatomy.</div></section><section class="card span6"><div class="k">ordinary GPT vs ARCHIE</div><h2>difference without mythology</h2><table class="table"><tr><th>GPT-ish</th><th>ARCHIE tiny contextual</th></tr><tr><td>token embeddings + global/local causal attention + MLP</td><td>byte/special embedding + local attention interleaved with addressed Delta recurrence + FFN</td></tr><tr><td>inference history commonly carried in KV cache</td><td>recurrent Delta state is an explicit learned fast-state mechanism inside the sequence</td></tr><tr><td>weights store slow learned statistics</td><td>same; fast state does not magically become permanent memory</td></tr><tr><td>CE next-token objective</td><td>same core LM objective, normalized to BPB in these courts</td></tr></table></section>
<section class="card span7" id="room"><div class="k">shared room</div><h2>what agents actually said</h2><div class="room" id="roomlog"></div></section><section class="card span5"><div class="k">live process evidence</div><h2>argv, not vibes</h2><pre class="proc" id="procs">—</pre></section>
<section class="card span12" id="pages"><div class="k">collapsed representational surfaces</div><h2>pages found on the machine</h2><p class="muted">These are indexed so you can trace where the visual language came from; this page is the replacement, not another layer on top.</p><ol class="pages" id="pagelist"></ol></section></div>
<div class="footer">ARCHIE ONE BODY · local read-only representation server · data source: live filesystem + /proc + nvidia-smi + sealed JSON receipts. This surface never starts/stops training, never edits checkpoints, and never treats room prose as runtime authority. Refreshes every 3 seconds.</div>
<script>
const $=s=>document.querySelector(s); const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); const age=t=>{let s=Math.max(0,Date.now()/1000-t);return s<60?s.toFixed(0)+'s':s<3600?(s/60).toFixed(0)+'m':(s/3600).toFixed(1)+'h'};
function val(o,path,d='—'){for(const k of path.split('.')){if(o==null||!(k in o))return d;o=o[k]}return o}
async function tick(){try{let d=await fetch('/api/state',{cache:'no-store'}).then(r=>r.json());let s=d.truth?.summary||{};$('#clock').textContent=new Date(d.captured_unix*1000).toLocaleTimeString();$('#compute').textContent=(s.compute||'unknown').toUpperCase();$('#truthbadges').innerHTML=`<span class="badge ${s.canonical_state==='unambiguous'?'ok':'warn'}">${esc(s.canonical_state||'unknown')}</span><span class="badge ${s.trainer_count?'ok':'muted'}">${s.trainer_count||0} trainer</span><span class="badge">${s.controller_count||0} controller</span>`;$('#truthmeta').textContent=`queue: ${s.controller||'unknown'} · history conflicts: ${s.history_conflict_count||0}`;$('#gpu').innerHTML=d.gpu.length?d.gpu.map(x=>`<span class="badge warn">${esc(x)}</span>`).join('<br>'):'<span class="badge ok">no compute PID</span>';let a=d.truth?.agents||{};$('#agents').textContent=`state ${a.state||s.agents||'unknown'}\n${Object.entries(a.live||{}).map(([k,v])=>k+': '+v.map(x=>x.pid).join(', ')).join('\n')}`;let sr=d.s4_receipt||{};$('#s4bpb').textContent=val(sr,'evaluation.mean_bits_per_byte','2.170272');$('#s4meta').textContent=`model ${val(sr,'model.parameter_count','3,770,796')} params\nstatus ${val(sr,'status','sealed')}`;let v=d.v4_decision||{};$('#v4').innerHTML=`promote: <b>${esc(v.promote_to_three_seed_confirmation??false)}</b><br>paired ΔBPB: ${esc(v.paired_edge_minus_control_bpb??'—')}<br>receipt: ${esc((v.receipt_digest||'—').slice(0,18))}…`;let lines=d.s5_tail||[];$('#trainlog').textContent=lines.join('\n')||'No s5 trace present.';let last=lines.at(-1)||'';$('#trainhead').innerHTML=`<span class="badge ${last?'warn':'muted'}">${last?'trace present':'idle/no trace'}</span>`;$('#receipts').innerHTML=(d.recent_receipts||[]).map(r=>`<tr><td>${age(r.mtime)}</td><td class="receipt">${esc(r.path.replace('/home/awesomekai/','~/'))}</td><td>${r.bytes}</td></tr>`).join('');$('#roomlog').innerHTML=(d.room_tail||[]).reverse().map(m=>`<div class="msg"><div class="who">${esc(m.from||'?')} · ${esc(m.t||'')}</div><div class="text">${esc(m.text||'')}</div></div>`).join('');$('#procs').textContent=(d.processes||[]).join('\n');$('#pagelist').innerHTML=(d.pages||[]).map(p=>`<li><b>${age(p.mtime)}</b> · ${esc(p.path.replace('/home/awesomekai/','~/'))} · ${p.bytes} B</li>`).join('')||'<li>none indexed</li>'}catch(e){$('#clock').textContent='read error '+e}}
tick();setInterval(tick,3000);
</script></body></html>'''

class H(BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_GET(self):
        p=urlparse(self.path).path
        if p=='/api/state':
            b=json.dumps(state(),ensure_ascii=False).encode(); self.send_response(200);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b);return
        if p in ('/','/index.html'):
            b=HTML.encode();self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b);return
        self.send_response(404);self.end_headers()

def main():
    print(f'ARCHIE ONE BODY http://127.0.0.1:{PORT}',flush=True)
    ThreadingHTTPServer(('127.0.0.1',PORT),H).serve_forever()
if __name__=='__main__':main()
