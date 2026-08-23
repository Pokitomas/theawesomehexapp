import ctypes,json,os,time
from pathlib import Path
import psutil

B=Path(r'C:\Users\AwesomeKai\AppData\Local\Temp')
OUT=B/'ARCHIE_LIVE_STATE.json';TMP=B/'ARCHIE_LIVE_STATE.next.json';SCREEN=B/'archie_phone_screen.jpg'
REQ=B/'ARCHIE_STATE_ACTION_REQ.json';RESP=B/'ARCHIE_STATE_ACTION_RESP.json';RESPTMP=B/'ARCHIE_STATE_ACTION_RESP.next.json'
u=ctypes.windll.user32;k=ctypes.windll.kernel32
SW_RESTORE=9;KEYUP=2;SWP_NOMOVE=2;SWP_NOSIZE=1;SWP_SHOWWINDOW=0x40;VK={'ctrl':0x11,'shift':0x10,'alt':0x12,'space':0x20,'esc':0x1b,'z':0x5a,'s':0x53,'3':0x33,'4':0x34}
class POINT(ctypes.Structure):_fields_=[('x',ctypes.c_long),('y',ctypes.c_long)]
class RECT(ctypes.Structure):_fields_=[('left',ctypes.c_long),('top',ctypes.c_long),('right',ctypes.c_long),('bottom',ctypes.c_long)]
class LASTINPUTINFO(ctypes.Structure):_fields_=[('cbSize',ctypes.c_uint),('dwTime',ctypes.c_uint)]
def title(h):
 n=u.GetWindowTextLengthW(h);b=ctypes.create_unicode_buffer(n+1);u.GetWindowTextW(h,b,n+1);return b.value
def pid_for(h):
 p=ctypes.c_ulong();u.GetWindowThreadProcessId(h,ctypes.byref(p));return int(p.value)
_pc={}
def proc_name(pid):
 now=time.time();hit=_pc.get(pid)
 if hit and now-hit[0]<3:return hit[1]
 try:n=psutil.Process(pid).name() if pid else ''
 except:n=''
 _pc[pid]=(now,n);return n
def winrec(h):
 p=pid_for(h);t=title(h);return {'hwnd':int(h),'pid':p,'process':proc_name(p),'title':t,'project':t.split('DaVinci Resolve - ',1)[1] if t.startswith('DaVinci Resolve - ') else ''}
def meaningful_front():
 out=[]
 @ctypes.WINFUNCTYPE(ctypes.c_bool,ctypes.c_void_p,ctypes.c_void_p)
 def cb(h,l):
  if u.IsWindowVisible(h):
   t=title(h)
   if t:
    p=pid_for(h);n=proc_name(p).lower()
    if not (n=='textinputhost.exe' or (n=='pythonw.exe' and t=='tk') or (n=='explorer.exe' and t=='Program Manager')):
     out.append(winrec(h));return False
  return True
 u.EnumWindows(cb,0)
 return out[0] if out else winrec(u.GetForegroundWindow())
def idle_ms():
 li=LASTINPUTINFO();li.cbSize=ctypes.sizeof(li)
 if not u.GetLastInputInfo(ctypes.byref(li)):return None
 return int((k.GetTickCount()-li.dwTime)&0xffffffff)
def cursor():
 p=POINT();u.GetCursorPos(ctypes.byref(p));return [int(p.x),int(p.y)]
def app_counts():
 out={'Resolve':0,'Claude':0}
 try:
  for p in psutil.process_iter(['name']):
   n=(p.info.get('name') or '').lower()
   if n=='resolve.exe':out['Resolve']+=1
   elif n=='claude.exe':out['Claude']+=1
 except:pass
 return out
def atomic(path,tmp,v):tmp.write_text(json.dumps(v,separators=(',',':'),ensure_ascii=False),encoding='utf-8');os.replace(tmp,path)
def find_resolve():
 found=[]
 @ctypes.WINFUNCTYPE(ctypes.c_bool,ctypes.c_void_p,ctypes.c_void_p)
 def cb(h,l):
  if u.IsWindowVisible(h):
   t=title(h)
   if t.startswith('DaVinci Resolve - '):found.append((int(h),t))
  return True
 u.EnumWindows(cb,0);good=[x for x in found if 'ARCHIE LOVING EDIT' in x[1]]
 if not good:raise RuntimeError('Resolve guard: LOVING EDIT window missing')
 return good[0]
def key_down(x):u.keybd_event(VK[x],0,0,0)
def key_up(x):u.keybd_event(VK[x],0,KEYUP,0)
def keyseq(*keys):
 for x in keys:key_down(x)
 for x in reversed(keys):key_up(x)
def click_xy(px,py):
 u.SetCursorPos(int(px),int(py));u.mouse_event(0x0002,0,0,0,0);u.mouse_event(0x0004,0,0,0,0)
def focus_resolve():
 h,t=find_resolve();u.ShowWindow(h,SW_RESTORE);u.SetWindowPos(h,0,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_SHOWWINDOW);u.BringWindowToTop(h)
 r=RECT();u.GetWindowRect(h,ctypes.byref(r));x=max(r.left+180,min(r.right-180,(r.left+r.right)//2));y=max(r.top+8,min(r.bottom-8,r.top+14));click_xy(x,y);time.sleep(.025)
 mf=meaningful_front()
 if mf.get('hwnd')!=h:raise RuntimeError('Resolve focus not acquired: '+mf.get('title','')[:120])
 return mf.get('title','')
def click_norm(x,y):
 mf=meaningful_front();ft=mf.get('title','')
 if 'DaVinci Resolve' in ft and 'ARCHIE LOVING EDIT' not in ft:raise RuntimeError('Resolve guard blocked tap')
 sw=u.GetSystemMetrics(0);sh=u.GetSystemMetrics(1);px=max(0,min(sw-1,int(float(x)*sw)));py=max(0,min(sh-1,int(float(y)*sh)));click_xy(px,py);return [px,py]
def perform(d):
 a=str(d.get('action','')).lower();out={'ok':True,'action':a}
 if a=='tap':out['point']=click_norm(d.get('x',0),d.get('y',0))
 elif a=='take':out['title']=focus_resolve()
 elif a=='play':focus_resolve();keyseq('space')
 elif a=='save':focus_resolve();keyseq('ctrl','s')
 elif a=='undo':focus_resolve();keyseq('ctrl','z')
 elif a=='redo':focus_resolve();keyseq('ctrl','shift','z')
 elif a=='esc':keyseq('esc')
 elif a=='fit':focus_resolve();keyseq('shift','z')
 elif a=='edit':focus_resolve();keyseq('shift','4')
 elif a=='cut':focus_resolve();keyseq('shift','3')
 elif a=='look':pass
 else:raise RuntimeError('unknown action')
 return out
seq=content_seq=motion_seq=screen_seq=0;last_front=last_cursor=last_screen_ns=None;apps={'Resolve':0,'Claude':0};next_apps=0.;last_req='';last_action=None
while True:
 started=time.perf_counter();now=time.time();seq+=1
 try:
  if REQ.exists():
   d=json.loads(REQ.read_text(encoding='utf-8'));rid=str(d.get('id',''))
   if rid and rid!=last_req:
    last_req=rid;ta=time.perf_counter()
    try:r=perform(d)
    except Exception as e:r={'ok':False,'action':str(d.get('action','')),'error':str(e)}
    r.update({'id':rid,'at':time.time(),'worker_ms':round((time.perf_counter()-ta)*1000,2)});atomic(RESP,RESPTMP,r);last_action=r
 except Exception:pass
 rawh=int(u.GetForegroundWindow() or 0);raw=winrec(rawh) if rawh else {'hwnd':0,'pid':0,'process':'','title':'','project':''};front=meaningful_front();cur=cursor();front_sig=(front['hwnd'],front['pid'],front['process'],front['title'])
 if front_sig!=last_front:content_seq+=1;last_front=front_sig
 if cur!=last_cursor:motion_seq+=1;last_cursor=cur
 try:sm=SCREEN.stat();sns=sm.st_mtime_ns;ssize=sm.st_size
 except Exception:sns=0;ssize=0
 if sns!=last_screen_ns:screen_seq+=1;last_screen_ns=sns
 if now>=next_apps:apps=app_counts();next_apps=now+1.
 sample_ms=(time.perf_counter()-started)*1000
 v={'schema':'archie-live-state/v1','at':now,'seq':seq,'content_seq':content_seq,'motion_seq':motion_seq,'front':front,'raw_front':raw,'front_method':'z_order_meaningful','cursor':cur,'idle_ms':idle_ms(),'apps':apps,'screen':{'seq':screen_seq,'mtime':sns/1e9 if sns else 0,'bytes':ssize},'guard':{'resolve_target':'lonee ryan - ARCHIE LOVING EDIT','locked':['lonee ryan - ARCHIE CUT','ARCHIE // PERFECT SYNC']},'semantics':{'mode':'deterministic','ml_awake':False,'note':'ML not required for live state fast-path'},'last_action':last_action,'sample_ms':round(sample_ms,3)}
 try:atomic(OUT,TMP,v)
 except:pass
 delay=.05-(time.perf_counter()-started)
 if delay>0:time.sleep(delay)
