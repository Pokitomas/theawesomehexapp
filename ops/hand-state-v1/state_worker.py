import ctypes, json, os, time
from pathlib import Path
try:
    import psutil
except Exception:
    psutil=None

B=Path(r'C:\Users\AwesomeKai\AppData\Local\Temp')
OUT=B/'ARCHIE_LIVE_STATE.json'
TMP=B/'ARCHIE_LIVE_STATE.next.json'
SCREEN=B/'archie_phone_screen.jpg'
user32=ctypes.windll.user32
kernel32=ctypes.windll.kernel32

class POINT(ctypes.Structure):
    _fields_=[('x',ctypes.c_long),('y',ctypes.c_long)]
class LASTINPUTINFO(ctypes.Structure):
    _fields_=[('cbSize',ctypes.c_uint),('dwTime',ctypes.c_uint)]

def title(hwnd):
    n=user32.GetWindowTextLengthW(hwnd)
    b=ctypes.create_unicode_buffer(n+1)
    user32.GetWindowTextW(hwnd,b,n+1)
    return b.value

def pid_for(hwnd):
    p=ctypes.c_ulong()
    user32.GetWindowThreadProcessId(hwnd,ctypes.byref(p))
    return int(p.value)

_proc_cache={}
def proc_name(pid):
    now=time.time(); hit=_proc_cache.get(pid)
    if hit and now-hit[0]<4: return hit[1]
    name=''
    if psutil and pid:
        try:name=psutil.Process(pid).name()
        except Exception:pass
    _proc_cache[pid]=(now,name)
    return name

def idle_ms():
    li=LASTINPUTINFO(); li.cbSize=ctypes.sizeof(li)
    if not user32.GetLastInputInfo(ctypes.byref(li)): return None
    now=kernel32.GetTickCount()
    return int((now-li.dwTime)&0xffffffff)

def cursor():
    p=POINT(); user32.GetCursorPos(ctypes.byref(p)); return [int(p.x),int(p.y)]

def app_counts():
    out={'Resolve':0,'Claude':0}
    if not psutil:return out
    try:
        for p in psutil.process_iter(['name']):
            n=(p.info.get('name') or '').lower()
            if n=='resolve.exe':out['Resolve']+=1
            elif n=='claude.exe':out['Claude']+=1
    except Exception:pass
    return out

def atomic(v):
    TMP.write_text(json.dumps(v,separators=(',',':'),ensure_ascii=False),encoding='utf-8')
    os.replace(TMP,OUT)

seq=0; content_seq=0; motion_seq=0; screen_seq=0
last_front=None; last_cursor=None; last_screen_ns=None; apps={'Resolve':0,'Claude':0}; next_apps=0.0
while True:
    started=time.perf_counter(); now=time.time(); seq+=1
    hwnd=int(user32.GetForegroundWindow() or 0); t=title(hwnd) if hwnd else ''
    pid=pid_for(hwnd) if hwnd else 0; pn=proc_name(pid)
    cur=cursor(); front_sig=(hwnd,pid,pn,t)
    if front_sig!=last_front: content_seq+=1; last_front=front_sig
    if cur!=last_cursor: motion_seq+=1; last_cursor=cur
    try: sm=SCREEN.stat(); sns=sm.st_mtime_ns; ssize=sm.st_size
    except Exception: sns=0; ssize=0
    if sns!=last_screen_ns: screen_seq+=1; last_screen_ns=sns
    if now>=next_apps: apps=app_counts(); next_apps=now+1.0
    project=''
    if t.startswith('DaVinci Resolve - '): project=t.split('DaVinci Resolve - ',1)[1]
    sample_ms=(time.perf_counter()-started)*1000
    v={
      'schema':'archie-live-state/v1','at':now,'seq':seq,'content_seq':content_seq,'motion_seq':motion_seq,
      'front':{'hwnd':hwnd,'pid':pid,'process':pn,'title':t,'project':project},
      'cursor':cur,'idle_ms':idle_ms(),'apps':apps,
      'screen':{'seq':screen_seq,'mtime':(sns/1e9 if sns else 0),'bytes':ssize},
      'guard':{'resolve_target':'lonee ryan - ARCHIE LOVING EDIT','locked':['lonee ryan - ARCHIE CUT','ARCHIE // PERFECT SYNC']},
      'semantics':{'mode':'deterministic','ml_awake':False,'note':'ML not required for live state fast-path'},
      'sample_ms':round(sample_ms,3)
    }
    try:atomic(v)
    except Exception:pass
    delay=.05-(time.perf_counter()-started)
    if delay>0: time.sleep(delay)
