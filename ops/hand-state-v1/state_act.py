import ctypes,json,sys,time
import pyautogui
u=ctypes.windll.user32
SW_RESTORE=9

def title(hwnd):
    n=u.GetWindowTextLengthW(hwnd); b=ctypes.create_unicode_buffer(n+1); u.GetWindowTextW(hwnd,b,n+1); return b.value

def front_title():
    h=u.GetForegroundWindow(); return title(h) if h else ''

def find_resolve():
    found=[]
    @ctypes.WINFUNCTYPE(ctypes.c_bool,ctypes.c_void_p,ctypes.c_void_p)
    def cb(h,l):
        if u.IsWindowVisible(h):
            t=title(h)
            if t.startswith('DaVinci Resolve - '): found.append((int(h),t))
        return True
    u.EnumWindows(cb,0)
    if not found: raise RuntimeError('Resolve window missing')
    good=[x for x in found if 'ARCHIE LOVING EDIT' in x[1]]
    if not good: raise RuntimeError('Resolve guard: LOVING EDIT window missing')
    return good[0]

def focus_resolve():
    h,t=find_resolve(); u.ShowWindow(h,SW_RESTORE); u.BringWindowToTop(h); u.SetForegroundWindow(h); time.sleep(.025)
    ft=front_title()
    if 'DaVinci Resolve' not in ft or 'ARCHIE LOVING EDIT' not in ft: raise RuntimeError('Resolve focus not acquired')
    return ft

def key(*ks): pyautogui.hotkey(*ks) if len(ks)>1 else pyautogui.press(ks[0])

a=sys.argv[1].lower() if len(sys.argv)>1 else ''
out={'ok':True,'action':a}
try:
    if a=='tap':
        x=float(sys.argv[2]); y=float(sys.argv[3]); ft=front_title()
        if 'DaVinci Resolve' in ft and 'ARCHIE LOVING EDIT' not in ft: raise RuntimeError('Resolve guard blocked tap')
        sw,sh=pyautogui.size(); pyautogui.click(max(0,min(sw-1,int(x*sw))),max(0,min(sh-1,int(y*sh))))
    elif a=='take': out['title']=focus_resolve()
    elif a=='play': focus_resolve(); key('space')
    elif a=='save': focus_resolve(); key('ctrl','s')
    elif a=='undo': focus_resolve(); key('ctrl','z')
    elif a=='redo': focus_resolve(); key('ctrl','shift','z')
    elif a=='esc': key('esc')
    elif a=='fit': focus_resolve(); key('shift','z')
    elif a=='edit': focus_resolve(); key('shift','4')
    elif a=='cut': focus_resolve(); key('shift','3')
    elif a=='look': pass
    else: raise RuntimeError('unknown action')
except Exception as e: out={'ok':False,'action':a,'error':str(e)}
print(json.dumps(out,separators=(',',':')))
