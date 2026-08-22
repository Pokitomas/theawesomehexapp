#!/usr/bin/env python3
from __future__ import annotations
import json, os, re, shutil, subprocess, sys, time, hashlib, pathlib, signal
from pathlib import Path

HOME = Path('/home/awesomekai')
ROOT = HOME / 'archie-remote' / 'agy-extension'
SCRATCH = ROOT / 'scratch'
REPORT = ROOT / 'agy-capability-report.json'
EVENTS = ROOT / 'events.jsonl'
BROKER = ROOT / 'agy_broker.py'
INBOX = ROOT / 'inbox'
RECEIPTS = ROOT / 'receipts'
STATE = ROOT / 'broker-state.json'
UNIT = HOME / '.config/systemd/user/archie-agy-broker.service'
MAX_OUT = 200_000

for p in (ROOT, SCRATCH, INBOX, RECEIPTS): p.mkdir(parents=True, exist_ok=True)

def now(): return time.time()
def emit(kind, **kw):
    rec={'t':now(),'kind':kind,**kw}
    with EVENTS.open('a',encoding='utf-8') as f: f.write(json.dumps(rec,ensure_ascii=False,sort_keys=True)+'\n')
    return rec

def run(argv, cwd=None, timeout=30, env=None):
    t0=time.monotonic()
    try:
        p=subprocess.run(argv,cwd=str(cwd) if cwd else None,env=env,capture_output=True,text=True,timeout=timeout)
        return {'argv':argv,'rc':p.returncode,'seconds':round(time.monotonic()-t0,3),'stdout':p.stdout[-MAX_OUT:],'stderr':p.stderr[-MAX_OUT:]}
    except subprocess.TimeoutExpired as e:
        return {'argv':argv,'rc':124,'timeout':True,'seconds':round(time.monotonic()-t0,3),'stdout':(e.stdout or '')[-MAX_OUT:] if isinstance(e.stdout,str) else '', 'stderr':(e.stderr or '')[-MAX_OUT:] if isinstance(e.stderr,str) else ''}
    except Exception as e:
        return {'argv':argv,'rc':125,'seconds':round(time.monotonic()-t0,3),'error':f'{type(e).__name__}: {e}','stdout':'','stderr':''}

def redacted_obj(x):
    bad=('token','secret','password','passwd','auth','credential','api_key','apikey','cookie')
    if isinstance(x,dict):
        return {k:('[REDACTED]' if any(b in k.lower() for b in bad) else redacted_obj(v)) for k,v in x.items()}
    if isinstance(x,list): return [redacted_obj(v) for v in x[:200]]
    if isinstance(x,str) and len(x)>10000: return x[:10000]+'...[truncated]'
    return x

def read_settings():
    p=HOME/'.gemini/antigravity-cli/settings.json'
    if not p.exists(): return {'exists':False}
    try: return {'exists':True,'path':str(p),'data':redacted_obj(json.loads(p.read_text(errors='replace')))}
    except Exception as e: return {'exists':True,'path':str(p),'error':str(e)}

def process_snapshot():
    out=[]
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit(): continue
        try:
            cmd=(proc/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace').strip()
            comm=(proc/'comm').read_text(errors='replace').strip()
            if comm!='agy' and not re.search(r'(^|/)agy(?:\s|$)',cmd): continue
            cwd=os.readlink(proc/'cwd')
            stat=(proc/'status').read_text(errors='replace')
            rss=re.search(r'^VmRSS:\s+(.+)$',stat,re.M)
            out.append({'pid':int(proc.name),'comm':comm,'cmdline':cmd[:4000],'cwd':cwd,'rss':rss.group(1) if rss else None})
        except Exception: pass
    return sorted(out,key=lambda x:x['pid'])

def brain_snapshot():
    base=HOME/'.gemini/antigravity-cli/brain'
    if not base.exists(): return {'exists':False,'conversations':[]}
    rows=[]
    for d in base.iterdir():
        if not d.is_dir(): continue
        tr=d/'.system_generated/logs/transcript.jsonl'
        try: mt=tr.stat().st_mtime if tr.exists() else d.stat().st_mtime
        except Exception: mt=0
        rows.append({'id':d.name,'mtime':mt,'transcript_exists':tr.exists(),'transcript_bytes':tr.stat().st_size if tr.exists() else 0})
    rows.sort(key=lambda x:x['mtime'],reverse=True)
    return {'exists':True,'count':len(rows),'conversations':rows[:20]}

def detect_flags(helptext):
    candidates=['--add-dir','--continue','--conversation','--dangerously-skip-permissions','--prompt-interactive','--log-file','--model','--new-project','--print','--print-timeout','--project','--prompt','--sandbox','--output-format']
    return {x:(x in helptext) for x in candidates}

def normalize_text(r): return ((r.get('stdout') or '')+'\n'+(r.get('stderr') or '')).strip()

def headless(agy, prompt, flags, cwd, timeout=120, extra=None, allow_tools=False):
    args=[agy]
    if extra: args+=extra
    if flags.get('--output-format'): args += ['--output-format','stream-json']
    if allow_tools and flags.get('--dangerously-skip-permissions'): args.append('--dangerously-skip-permissions')
    if flags.get('--print'): args += ['--print',prompt]
    else: args += ['-p',prompt]
    return run(args,cwd=cwd,timeout=timeout)

def score_exact(r, needle):
    t=normalize_text(r)
    return {'ok':r.get('rc')==0 and needle in t,'contains':needle in t,'rc':r.get('rc'),'seconds':r.get('seconds')}

def choose_model(models_text):
    toks=[]
    for line in models_text.splitlines():
        s=line.strip().strip('*-• ')
        if not s or len(s)>160: continue
        m=re.search(r'([A-Za-z0-9][A-Za-z0-9._:/-]{2,})',s)
        if m: toks.append(m.group(1))
    prefs=('gemini-3.1-pro','gemini-3-pro','claude-opus','opus','pro')
    for pref in prefs:
        for t in toks:
            if pref in t.lower(): return t
    return None

def install_broker(agy, flags, preferred_model):
    code=r'''#!/usr/bin/env python3
from pathlib import Path
import json,os,subprocess,time,hashlib,fcntl
HOME=Path('/home/awesomekai'); ROOT=HOME/'archie-remote'/'agy-extension'; IN=ROOT/'inbox'; OUT=ROOT/'receipts'; LOCK=ROOT/'broker.lock'; STATE=ROOT/'broker-state.json'
for p in (IN,OUT): p.mkdir(parents=True,exist_ok=True)
AGY=__AGY__
FLAGS=__FLAGS__
MODEL=__MODEL__
def atomic(p,obj):
 t=p.with_suffix(p.suffix+'.tmp');t.write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n');t.replace(p)
def run_task(p):
 try:d=json.loads(p.read_text())
 except Exception as e:return {'ok':False,'error':f'invalid task: {e}'}
 tid=str(d.get('id') or p.stem); prompt=str(d.get('prompt') or '').strip(); cwd=Path(d.get('cwd') or str(ROOT/'scratch')).resolve(); timeout=min(max(int(d.get('timeout',600)),10),1800)
 if not prompt:return {'id':tid,'ok':False,'error':'empty prompt'}
 allowed=(str(cwd).startswith('/home/awesomekai/') or str(cwd).startswith('/mnt/c/Users/AwesomeKai/'))
 if not allowed:return {'id':tid,'ok':False,'error':'cwd outside allowed roots'}
 argv=[AGY]
 if FLAGS.get('--output-format'):argv += ['--output-format','stream-json']
 if d.get('sandbox') and FLAGS.get('--sandbox'):argv.append('--sandbox')
 if d.get('full_tools') and FLAGS.get('--dangerously-skip-permissions'):argv.append('--dangerously-skip-permissions')
 if MODEL and d.get('use_strongest',True) and FLAGS.get('--model'):argv += ['--model',MODEL]
 if FLAGS.get('--print'):argv += ['--print',prompt]
 else:argv += ['-p',prompt]
 t0=time.time()
 try:
  r=subprocess.run(argv,cwd=str(cwd),capture_output=True,text=True,timeout=timeout)
  rec={'schema':'archie-agy-broker-receipt/v1','id':tid,'time':time.time(),'seconds':time.time()-t0,'ok':r.returncode==0,'returncode':r.returncode,'argv':argv[:-1]+['[PROMPT]'],'cwd':str(cwd),'stdout':r.stdout[-1000000:],'stderr':r.stderr[-200000:]}
 except subprocess.TimeoutExpired as e:rec={'schema':'archie-agy-broker-receipt/v1','id':tid,'time':time.time(),'seconds':time.time()-t0,'ok':False,'timeout':True,'stdout':(e.stdout or '')[-1000000:] if isinstance(e.stdout,str) else '','stderr':(e.stderr or '')[-200000:] if isinstance(e.stderr,str) else ''}
 rec['sha256']=hashlib.sha256(json.dumps(rec,sort_keys=True).encode()).hexdigest();atomic(OUT/f'{tid}.json',rec);return rec
def main():
 with LOCK.open('a+') as lf:
  fcntl.flock(lf,fcntl.LOCK_EX|fcntl.LOCK_NB)
  while True:
   atomic(STATE,{'schema':'archie-agy-broker-state/v1','pid':os.getpid(),'time':time.time(),'agy':AGY,'model':MODEL})
   for p in sorted(IN.glob('*.json')):
    working=p.with_suffix('.working')
    try:p.replace(working)
    except FileNotFoundError:continue
    rec=run_task(working); working.rename(working.with_suffix('.done'))
   time.sleep(.5)
if __name__=='__main__':main()
'''
    code=code.replace('__AGY__',repr(agy)).replace('__FLAGS__',repr(flags)).replace('__MODEL__',repr(preferred_model))
    BROKER.write_text(code); BROKER.chmod(0o755)
    UNIT.parent.mkdir(parents=True,exist_ok=True)
    UNIT.write_text(f'''[Unit]\nDescription=ARCHIE persistent Antigravity delegation broker\nAfter=default.target network-online.target\n\n[Service]\nType=simple\nExecStart=/usr/bin/python3 {BROKER}\nRestart=always\nRestartSec=2\nNice=10\nCPUWeight=20\nOOMScoreAdjust=200\nEnvironment=PYTHONUNBUFFERED=1\n\n[Install]\nWantedBy=default.target\n''')
    run(['systemctl','--user','daemon-reload'],timeout=20)
    en=run(['systemctl','--user','enable','--now','archie-agy-broker.service'],timeout=30)
    return en

def main():
    emit('start', pid=os.getpid())
    agy=shutil.which('agy')
    if not agy:
        for c in [HOME/'.local/bin/agy', Path('/usr/local/bin/agy')]:
            if c.exists(): agy=str(c); break
    report={'schema':'archie-agy-capability-report/v1','started':now(),'agy':agy,'processes_before':process_snapshot(),'settings':read_settings(),'brain_before':brain_snapshot(),'probes':{},'scores':{}}
    if not agy:
        report['fatal']='agy not found'; REPORT.write_text(json.dumps(report,indent=2)); emit('fatal',reason='agy not found'); return 2
    basics={'version':run([agy,'--version'],timeout=20),'help':run([agy,'--help'],timeout=20)}
    helptext=normalize_text(basics['help']); flags=detect_flags(helptext)
    report['basics']=basics; report['flags']=flags
    subcommands=[]
    for s in ('help','models','plugin','plugins','changelog','install','update'):
        r=run([agy,s,'--help'],timeout=20)
        report['probes'][f'{s}_help']=r
        if r.get('rc')==0: subcommands.append(s)
    if 'models' in subcommands: report['probes']['models']=run([agy,'models'],timeout=30)
    if 'plugins' in subcommands: report['probes']['plugins']=run([agy,'plugins'],timeout=30)
    if 'plugin' in subcommands:
        for args in (['plugin','list'],['plugin','--help']): report['probes']['plugin_'+'_'.join(args[1:])]=run([agy,*args],timeout=30)
    models_text=normalize_text(report['probes'].get('models',{})); preferred=choose_model(models_text)
    report['preferred_model']=preferred
    session=SCRATCH/f'court-{int(now())}'; session.mkdir(parents=True,exist_ok=True)
    (session/'fixture.txt').write_text('AGY_FIXTURE_8f3ac21\n')
    p1=headless(agy,'Reply with exactly AGY_PROBE_OK and nothing else. Do not use tools.',flags,session,90)
    report['probes']['exact_text']=p1; report['scores']['exact_text']=score_exact(p1,'AGY_PROBE_OK')
    p2=headless(agy,'Read fixture.txt using your available filesystem/tool interface. Reply with exactly its single line and nothing else.',flags,session,120)
    report['probes']['read_fixture']=p2; report['scores']['read_fixture']=score_exact(p2,'AGY_FIXTURE_8f3ac21')
    p3=headless(agy,'Using your available command/tool interface, run a harmless command equivalent to printf AGY_TOOL_EXEC_OK and then reply with exactly AGY_TOOL_EXEC_OK.',flags,session,150,allow_tools=True)
    report['probes']['tool_exec']=p3; report['scores']['tool_exec']=score_exact(p3,'AGY_TOOL_EXEC_OK')
    if flags.get('--dangerously-skip-permissions'):
        target=session/'agy-write-proof.txt'
        p4=headless(agy,'Create a file named agy-write-proof.txt in the current directory containing exactly AGY_WRITE_OK followed by a newline. Then reply with exactly AGY_WRITE_OK.',flags,session,150,allow_tools=True)
        report['probes']['write_scratch']=p4
        ok=target.exists() and target.read_text(errors='replace').strip()=='AGY_WRITE_OK'
        report['scores']['write_scratch']={'ok':ok,'rc':p4.get('rc'),'seconds':p4.get('seconds')}
    if flags.get('--sandbox'):
        ps=headless(agy,'Reply exactly AGY_SANDBOX_OK.',flags,session,90,extra=['--sandbox'])
        report['probes']['sandbox']=ps; report['scores']['sandbox']=score_exact(ps,'AGY_SANDBOX_OK')
    if flags.get('--add-dir'):
        extra=session/'extra';extra.mkdir(exist_ok=True);(extra/'extra.txt').write_text('AGY_ADD_DIR_OK\n')
        pa=headless(agy,'Read extra.txt from the additional directory and reply exactly with its contents.',flags,session,120,extra=['--add-dir',str(extra)])
        report['probes']['add_dir']=pa;report['scores']['add_dir']=score_exact(pa,'AGY_ADD_DIR_OK')
    if flags.get('--log-file'):
        logp=session/'agy-cli.log'; pl=headless(agy,'Reply exactly AGY_LOG_OK.',flags,session,90,extra=['--log-file',str(logp)])
        report['probes']['log_file']=pl; report['scores']['log_file']={'ok':pl.get('rc')==0 and logp.exists(),'bytes':logp.stat().st_size if logp.exists() else 0}
    if flags.get('--print-timeout'):
        pt=headless(agy,'Reply exactly AGY_TIMEOUT_FLAG_OK.',flags,session,90,extra=['--print-timeout','60s'])
        report['probes']['print_timeout']=pt;report['scores']['print_timeout']=score_exact(pt,'AGY_TIMEOUT_FLAG_OK')
    if preferred and flags.get('--model'):
        pm=headless(agy,'Reply exactly AGY_MODEL_OK.',flags,session,120,extra=['--model',preferred])
        report['probes']['preferred_model']=pm;report['scores']['preferred_model']=score_exact(pm,'AGY_MODEL_OK')
    real_prompt='''Act as a read-only forensic engineer on this ARCHIE workstation. Do not stop/restart services, do not kill processes, do not launch CUDA/GPU work, and do not alter model/training artifacts. Inspect actual local evidence under /home/awesomekai/archie-remote, /home/awesomekai/hotwire, relevant systemd user unit definitions, and current process metadata. Identify the strongest currently installed control surfaces, stale/dead transports, and one high-information CPU-only next experiment. Write your evidence-grounded report to ./AGY_ARCHIE_AUDIT.md and include exact paths/commands you observed. Use subagents if they are genuinely available and useful, but verify their claims before inclusion.'''
    auditdir=ROOT/'delegated-audit'; auditdir.mkdir(exist_ok=True)
    audit=headless(agy,real_prompt,flags,auditdir,600,extra=(['--add-dir',str(HOME/'archie-remote'),'--add-dir',str(HOME/'hotwire')] if flags.get('--add-dir') else None),allow_tools=True)
    report['probes']['delegated_archie_audit']=audit
    report['scores']['delegated_archie_audit']={'ok':audit.get('rc')==0,'report_exists':(auditdir/'AGY_ARCHIE_AUDIT.md').exists(),'seconds':audit.get('seconds')}
    broker_install=install_broker(agy,flags,preferred)
    report['broker_install']=broker_install
    task={'id':'initial-extension-task-20260822','prompt':'Read the latest agy-capability-report.json in /home/awesomekai/archie-remote/agy-extension and the generated AGY_ARCHIE_AUDIT.md if present. Produce /home/awesomekai/archie-remote/agy-extension/scratch/AGY_EXTENSION_SYNTHESIS.md containing: measured strengths, measured failures, which invocation mode should be used by GPT-5.6 as a delegated worker, and three concrete safe task classes. Do not mutate services, processes, trainers, or GPU state.','cwd':str(ROOT/'scratch'),'timeout':600,'full_tools':True,'use_strongest':True}
    (INBOX/'initial-extension-task-20260822.json').write_text(json.dumps(task,indent=2)+'\n')
    report['processes_after']=process_snapshot();report['brain_after']=brain_snapshot();report['finished']=now()
    ok_count=sum(bool(v.get('ok')) for v in report['scores'].values() if isinstance(v,dict)); report['score_summary']={'passed':ok_count,'total':len(report['scores'])}
    REPORT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    emit('complete',report=str(REPORT),score=report['score_summary'],broker='archie-agy-broker.service')
    return 0

if __name__=='__main__': raise SystemExit(main())
