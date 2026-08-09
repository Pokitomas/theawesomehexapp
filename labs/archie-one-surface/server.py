#!/usr/bin/env python3
import json, os, pathlib, subprocess, time, re
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
ROOT=pathlib.Path(__file__).resolve().parent
REMOTE=pathlib.Path('/home/awesomekai/archie-remote')
RUNS=pathlib.Path('/home/awesomekai/runs')

def read_json(p):
    try:return json.loads(pathlib.Path(p).read_text(errors='replace'))
    except Exception:return None

def proc_rows():
    rows=[]
    try:
        out=subprocess.run(['ps','-eo','pid=,ppid=,etimes=,args='],capture_output=True,text=True,timeout=3).stdout
        for ln in out.splitlines():
            m=re.match(r'\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)',ln)
            if m: rows.append({'pid':int(m[1]),'ppid':int(m[2]),'etimes':int(m[3]),'argv':m[4]})
    except Exception:pass
    return rows

def gpu_rows(procs):
    by={p['pid']:p for p in procs}; out=[]
    try:
        r=subprocess.run(['nvidia-smi','--query-compute-apps=pid,process_name,used_memory','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=3)
        for ln in r.stdout.splitlines():
            parts=[x.strip() for x in ln.split(',')]
            if parts and parts[0].isdigit():
                pid=int(parts[0]); q=by.get(pid,{})
                out.append({'pid':pid,'name':parts[1] if len(parts)>1 else '', 'memory_mib':parts[2] if len(parts)>2 else '', 'argv':q.get('argv','')})
    except Exception:pass
    return out

def latest_training():
    candidates=[]
    for base in [RUNS, pathlib.Path('/home/awesomekai')]:
        try:
            for p in base.rglob('train.log'):
                try:
                    st=p.stat()
                    if st.st_size and st.st_mtime > time.time()-7*86400: candidates.append((st.st_mtime,p))
                except Exception:pass
        except Exception:pass
    if not candidates:return None
    _,p=max(candidates,key=lambda x:x[0])
    try: tail='\n'.join(p.read_text(errors='replace').splitlines()[-14:])
    except Exception:tail=''
    return {'name':str(p).replace('/home/awesomekai/','~/'),'mtime':p.stat().st_mtime,'tail':tail}

def recent_events(n=14):
    p=REMOTE/'roast.jsonl'
    try: lines=p.read_text(errors='replace').splitlines()[-220:]
    except Exception:return []
    out=[]
    for ln in lines:
        try:
            x=json.loads(ln); txt=str(x.get('text',''))
            if txt and x.get('from') not in {'kai'}: out.append({'t':x.get('t',''),'from':x.get('from','?'),'text':txt[:500]})
        except Exception:pass
    return out[-n:]

def state():
    procs=proc_rows()
    pats={'runtime truth':'runtime_truth.py','observer':'archie-lab-observer-v2/observer.py','reading visual':'deconditioning-20260808/visual/server.py','museum':'http.server 8877','gate':'archie-remote/gate.py','live exec':'archie-remote/live_exec.py','shell sidecar':'archie-shell-sidecar.py','resident':'archie-resident-gpt56/resident.py'}
    services=[{'name':name,'live':any(pat in p['argv'] for p in procs)} for name,pat in pats.items()]
    agentp=[p for p in procs if any(k in p['argv'] for k in ['agent_worker.py','codex_room_bridge.py','resident.py'])]
    return {'generated_unix':time.time(),'runtime':read_json(REMOTE/'runtime_truth.json') or {},'gpu':gpu_rows(procs),'services':services,'agents':[{'pid':p['pid'],'argv':p['argv'],'live':True} for p in agentp],'training':latest_training(),'events':recent_events(),'representation':{'schema':'archie-one-surface/v1','read_only':True,'sources':'project UI + receipts + live process truth','personal_media_scanned':False}}

class H(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split('?',1)[0]=='/api/state':
            b=json.dumps(state(),indent=2).encode(); self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Cache-Control','no-store'); self.send_header('Content-Length',str(len(b))); self.end_headers(); self.wfile.write(b); return
        return super().do_GET()
    def log_message(self,fmt,*args): pass

if __name__=='__main__':
    os.chdir(ROOT); host=os.environ.get('ARCHIE_ONE_HOST','127.0.0.1'); port=int(os.environ.get('ARCHIE_ONE_PORT','8890'))
    print(f'ARCHIE ONE SURFACE http://{host}:{port}',flush=True)
    ThreadingHTTPServer((host,port),H).serve_forever()
