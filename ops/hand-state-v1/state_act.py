import json,sys,time
from pywinauto import Desktop
import pyautogui

def front_title():
    try:
        import ctypes
        u=ctypes.windll.user32; h=u.GetForegroundWindow(); n=u.GetWindowTextLengthW(h); b=ctypes.create_unicode_buffer(n+1);u.GetWindowTextW(h,b,n+1);return b.value
    except Exception:return ''

def resolve_window():
    D=Desktop(backend='uia')
    ws=[w for w in D.windows() if 'DaVinci Resolve' in (w.window_text() or '')]
    if not ws: raise RuntimeError('Resolve window missing')
    w=ws[0]
    if 'ARCHIE LOVING EDIT' not in (w.window_text() or ''): raise RuntimeError('Resolve guard: not LOVING EDIT')
    return w

def focus_resolve():
    w=resolve_window(); w.set_focus(); time.sleep(.04); return w.window_text()

def key(*ks):
    pyautogui.hotkey(*ks) if len(ks)>1 else pyautogui.press(ks[0])

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
except Exception as e:
    out={'ok':False,'action':a,'error':str(e)}
print(json.dumps(out,separators=(',',':')))
