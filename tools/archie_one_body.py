#!/usr/bin/env python3
import json, os, pathlib, subprocess, time, html
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
HOME=pathlib.Path('/home/awesomekai'); REMOTE=HOME/'archie-remote'; RUNS=HOME/'runs'; PORT=8794

def rj(p,d=None):
    try:return json.loads(pathlib.Path(p).read_text(errors='replace'))
    except:return d

def tail(p,n=50):
    try:return pathlib.Path(p).read_text(errors='replace').splitlines()[-n:]
    except:return []

def museum():
    root=pathlib.Path('/mnt/c/Users/AwesomeKai/AppData/Local/Temp')
    c=[]
    try:
        for p in root.glob('datascience-artifact-site-*/dist/client/index.html'):
            try:c.append((p.stat().st_mtime,p))
            except:pass
    except:pass
    return max(c)[1] if c else None

def pages():
    out=[]
    roots=[HOME/'archie-remote',HOME/'archie-lab-observer-v2',HOME/'archie-reading',HOME/'archie-resident-gpt56']
    t=pathlib.Path('/mnt/c/Users/AwesomeKai/AppData/Local/Temp')
    try: roots += list(t.glob('datascience-artifact-site-*'))[-20:]
    except: pass
    for root in roots:
        try:
            for p in root.rglob('*.html'):
                try:out.append((p.stat().st_mtime,str(p),p.stat().st_size))
                except:pass
        except:pass
    out.sort(reverse=True)
    return [{'mtime':a,'path':b,'bytes':c} for a,b,c in out[:100]]

def gpu():
    try:return subprocess.run(['nvidia-smi','--query-compute-apps=pid,process_name,used_memory','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=2).stdout.strip().splitlines()
    except:return []

def procs():
    try:s=subprocess.run(['ps','-eo','pid,ppid,etimes,pcpu,pmem,args'],capture_output=True,text=True,timeout=2).stdout
    except:return []
    keys=('archie','model_kernel_court','train_','qh_','ia_radix_catalog','observer.py','runtime_truth.py')
    return [x[:600] for x in s.splitlines() if any(k in x.lower() for k in keys) and 'grep ' not in x.lower()][-80:]

def receipts():
    out=[]; now=time.time()
    for root in [RUNS,HOME/'archie-quaternion-heisenberg-autoscale-v1',HOME/'archie-reading']:
        try:
            for p in root.rglob('*.json'):
                try:
                    st=p.stat(); n=p.name.lower()
                    if now-st.st_mtime<48*3600 and any(k in n for k in ('receipt','status','decision','court','truth','goalpost')):out.append((st.st_mtime,str(p),st.st_size))
                except:pass
        except:pass
    out.sort(reverse=True);return [{'mtime':a,'path':b,'bytes':c} for a,b,c in out[:100]]

def state():
    truth=rj(REMOTE/'runtime_truth.json',{}) or {}
    room=[]
    for x in tail(REMOTE/'roast.jsonl',40):
        try:room.append(json.loads(x))
        except:pass
    return {'captured_unix':time.time(),'truth':truth,'gpu':gpu(),'processes':procs(),'pages':pages(),'receipts':receipts(),'room':room,'s5':tail(RUNS/'archie-v3-contextual-token-ladder/s5-8192/train.log',60),'v4':rj(RUNS/'archie-v4-directed-edge-discovery-s52/decision.json',{}) or {}}

INJECT=r'''<style>
#live-machine{border-top:3px double var(--line-dark);background:rgba(126,47,41,.035)}
.livegrid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border:1px solid var(--line);margin:1.2rem 0}.livecell{background:var(--paper);padding:.85rem}.livebig{font:600 1.8rem/1 var(--mono);letter-spacing:-.05em}.livepre{font:11px/1.4 var(--mono);white-space:pre-wrap;max-height:260px;overflow:auto;border-top:1px solid var(--line);padding-top:.6rem}.machinepages{font:10px/1.35 var(--mono);word-break:break-all}.machinepages li{margin:.35rem 0}.pulse{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--good);margin-right:.4rem;box-shadow:0 0 0 3px rgba(53,84,61,.12)}@media(max-width:820px){.livegrid{grid-template-columns:1fr}}
</style>
<script>
async function archieLive(){try{const d=await fetch('/api/state',{cache:'no-store'}).then(r=>r.json()),s=d.truth?.summary||{};document.querySelector('.topline .state').innerHTML='<span class="pulse"></span>live machine truth · '+new Date(d.captured_unix*1000).toLocaleTimeString();let E=id=>document.getElementById(id);E('lv-compute').textContent=(s.compute||'unknown').toUpperCase();E('lv-controller').textContent=s.controller||'unknown';E('lv-agents').textContent=s.agents||d.truth?.agents?.state||'unknown';E('lv-gpu').textContent=d.gpu.length?d.gpu.join('\n'):'no compute PID';E('lv-train').textContent=(d.s5||[]).slice(-20).join('\n')||'no s5 trace';E('lv-procs').textContent=(d.processes||[]).join('\n');E('lv-room').textContent=(d.room||[]).slice(-12).map(x=>'['+(x.from||'?')+'] '+(x.text||'')).join('\n\n');E('lv-pages').innerHTML=(d.pages||[]).map(x=>'<li>'+String(x.path).replace('/home/awesomekai/','~/')+' · '+x.bytes+' B</li>').join('');E('lv-receipts').innerHTML=(d.receipts||[]).slice(0,25).map(x=>'<li>'+String(x.path).replace('/home/awesomekai/','~/')+'</li>').join('');let v=d.v4||{};E('lv-v4').textContent='directed-edge promotion: '+String(v.promote_to_three_seed_confirmation??false)+' · paired ΔBPB '+String(v.paired_edge_minus_control_bpb??'—')}catch(e){console.warn(e)}}
archieLive();setInterval(archieLive,3000);
</script>'''
LIVE=r'''<section id="live-machine" data-searchable><div class="section-head"><div class="section-no">00 / LIVE</div><div><h2>Machine truth, now</h2><p class="dek">The static museum used to stop where the live machine began. This section collapses that split: runtime identity, training trace, receipts, room evidence, and every ARCHIE HTML surface indexed from the research directories. Personal media and ASMR folders are deliberately not scanned.</p></div></div><div class="livegrid"><div class="livecell"><div class="datum-label">Compute</div><div class="livebig" id="lv-compute">—</div></div><div class="livecell"><div class="datum-label">Controller</div><div class="livebig" id="lv-controller">—</div></div><div class="livecell"><div class="datum-label">Agents</div><div class="livebig" id="lv-agents">—</div></div></div><h3>GPU owner</h3><pre class="livepre" id="lv-gpu">—</pre><h3>Current training trace</h3><pre class="livepre" id="lv-train">—</pre><div class="callout"><strong>Current branch verdict.</strong> <span id="lv-v4">loading</span></div><details><summary>Live process argv <span class="status observed">observed</span></summary><div class="detail-body"><pre class="livepre" id="lv-procs"></pre></div></details><details><summary>Shared room tail <span class="status recorded">recorded</span></summary><div class="detail-body"><pre class="livepre" id="lv-room"></pre></div></details><details open><summary>Collapsed page index <span class="status observed">observed</span></summary><div class="detail-body"><p>These are the representational HTML surfaces found in ARCHIE research directories and generated artifact sites. This experimental record is now the canonical viewing surface; the list below is provenance, not a request to keep a window pile.</p><ol class="machinepages" id="lv-pages"></ol></div></details><details><summary>Recent receipts / courts / decisions <span class="status observed">observed</span></summary><div class="detail-body"><ol class="machinepages" id="lv-receipts"></ol></div></details></section>'''

def page():
    p=museum()
    if not p:return '<h1>ARCHIE museum source not found</h1>'
    s=p.read_text(errors='replace')
    s=s.replace('Mode: read-only museum','Mode: live read-only one-body')
    s=s.replace('Host state not polled by this static build','live machine truth loading')
    marker='<section id="record" data-searchable>'
    if marker in s:s=s.replace(marker,LIVE+'\n'+marker,1)
    s=s.replace('</head>',INJECT+'</head>',1)
    return s

class H(BaseHTTPRequestHandler):
    def log_message(self,*a):pass
    def do_GET(self):
        p=urlparse(self.path).path
        if p=='/api/state':
            b=json.dumps(state(),ensure_ascii=False).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b);return
        if p in ('/','/index.html'):
            b=page().encode();self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b);return
        self.send_response(404);self.end_headers()
if __name__=='__main__':
    print('ARCHIE ONE BODY http://127.0.0.1:8794',flush=True);ThreadingHTTPServer(('127.0.0.1',PORT),H).serve_forever()
