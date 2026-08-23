import os, time, subprocess, traceback
from pathlib import Path

PYTHON = r"C:\Users\AwesomeKai\AppData\Local\Programs\Python\Python312\python.exe"
PROJECT = "lonee ryan - ARCHIE LOVING EDIT"
WORK_TIMELINE = "ARCHIE STORY CUT LIVE (2)"
SRT = r"C:\Users\AwesomeKai\Downloads\ARCHIE_LOVING_EDIT_WORK\ARCHIE_STORY_CUT_LIVE.srt"
LOG = Path(r"C:\Users\AwesomeKai\AppData\Local\Temp\finish_video_now_visible.log")

PROMPT = r'''You are the live visible DaVinci Resolve driver. This is execution, not a tutorial, report, or planning exercise.

HARD LOCK: remain in project "lonee ryan - ARCHIE LOVING EDIT". NEVER mutate timelines named "ARCHIE CUT" or "ARCHIE // PERFECT SYNC". Do not import or replace the story cut with an XML. The good current working timeline is the already-visible "ARCHIE STORY CUT LIVE (2)"; prior proof showed its assembled story structure (21 main video clips / 17 second-angle clips). Treat that as the working episode, not a sacrificial proof timeline.

VISIBLE ONLY FOR MUTATIONS: make every editing mutation with the visible Resolve GUI, mouse, and keyboard. Do not use Resolve scripting/API, hidden database writes, project-file surgery, or background timeline mutation. Hidden read-only sensing is fine. If a helper is slow or broken, abandon it and use the visible GUI yourself.

FIRST REAL MOVE: get this exact subtitle file onto the CURRENT working timeline using Resolve's visible UI:
C:\Users\AwesomeKai\Downloads\ARCHIE_LOVING_EDIT_WORK\ARCHIE_STORY_CUT_LIVE.srt
It contains the prepared 172 captions. Import it as subtitles using the visible File/Import/Subtitle workflow (or another visible Resolve subtitle workflow), add it to the active STORY CUT LIVE (2) timeline by timecode, and visibly prove subtitle text appears in the viewer/timeline. Do not rebuild the story cut while doing this.

THEN immediately watch/play the opening and several joins and edit for taste. Cut dead seconds, repeated setup, technical faff, weak pauses, and ugly joins. Preserve funny/awkward/revealing/emotional beats. iPhone/main angle is the stable home base; Samsung/second angle is for reactions, emphasis, awkward silence, visual reset, or a clearly better comedic/clarity beat—not random switching. Preserve solved sync.

AUDIO TASTE: dialogue should be crispy, close, and natural. Swingers crowd/background should be materially reduced, but preserve human room tone. No metallic AI-denoise, no watery artifacts, no smashed podcast compressor, no obvious level jumps at joins. Listen before and after changes. Structure and pacing before polish.

Save checkpoints with Ctrl+S as you work. Verify changes by playback/scrub. Do not narrate what you might do and do not tell Kai what to click. Keep operating Resolve. If a tool/UI route fails, make the smallest reversible visible move and switch routes. Finished podcast > tool loyalty > status essays.'''

NUDGE = r'''Act in Resolve now. No narration. Stay on ARCHIE STORY CUT LIVE (2), protect ARCHIE CUT and ARCHIE // PERFECT SYNC, and make the next visible editing move. If subtitles are not visibly on-screen yet, finish the SRT import first. Otherwise play a join, fix one real pacing/camera/audio taste problem visibly, verify, save, and continue.'''


def out(*a):
    s = " ".join(str(x) for x in a)
    print(s, flush=True)
    try:
        with LOG.open("a", encoding="utf-8", errors="replace") as f:
            f.write(time.strftime("%H:%M:%S ") + s + "\n")
    except Exception:
        pass


def ps(cmd, timeout=30):
    return subprocess.run(["powershell.exe", "-NoProfile", "-Command", cmd], capture_output=True, text=True, errors="replace", timeout=timeout)


def clipset(text):
    import win32clipboard
    win32clipboard.OpenClipboard()
    try:
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardText(text, win32clipboard.CF_UNICODETEXT)
    finally:
        win32clipboard.CloseClipboard()


def rows(w):
    z=[]
    for c in w.descendants():
        try:
            t=(c.window_text() or "").strip()
            if t: z.append((c.element_info.control_type,t,c))
        except Exception:
            pass
    return z


def send(w, text):
    from pywinauto import keyboard
    edits=[]
    for c in w.descendants():
        try:
            if c.element_info.control_type == "Edit" and c.is_visible() and c.is_enabled() and c.rectangle().width() > 300:
                edits.append(c)
        except Exception:
            pass
    if not edits:
        out("NO_COMPOSER")
        return False
    c=max(edits,key=lambda x:x.rectangle().width()*x.rectangle().height())
    clipset(text)
    c.click_input(); keyboard.send_keys("^a"); keyboard.send_keys("^v"); time.sleep(.3)
    for ct,t,b in rows(w):
        try:
            if ct == "Button" and t.lower() in ("send","send message","start task","run task") and b.is_enabled():
                b.click_input(); out("SEND_BUTTON", t); return True
        except Exception:
            pass
    c.click_input(); keyboard.send_keys("{ENTER}"); out("SEND_ENTER"); return True


def visible_resolve_reacquire():
    from pywinauto import Desktop, keyboard
    d=Desktop(backend="uia")
    wins=[]
    for w in d.windows():
        try:
            title=w.window_text()
            if "DaVinci Resolve" in title: wins.append(w)
        except Exception:
            pass
    out("RESOLVE_WINDOWS", len(wins), [w.window_text() for w in wins[:4]])
    if not wins: return False
    w=wins[0]
    try:
        w.set_focus(); time.sleep(.6)
        keyboard.send_keys("+4"); time.sleep(.8)  # Resolve Edit page
        keyboard.send_keys("+z"); time.sleep(.8)  # fit timeline
        keyboard.send_keys("^s"); time.sleep(.4)
        out("RESOLVE_VISIBLE_REACQUIRED")
        return True
    except Exception as e:
        out("RESOLVE_FOCUS_WARN", repr(e)); return False


def open_claude():
    from pywinauto import Desktop
    d=Desktop(backend="uia")
    ws=[z for z in d.windows() if "Claude" in (z.window_text() or "")]
    if not ws:
        r=ps("$p=Get-Process Claude -ErrorAction SilentlyContinue; if(!$p){$a=Get-StartApps|?{$_.Name -like '*Claude*'}|select -First 1; if($a){Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\\'+$a.AppID)}}")
        out("CLAUDE_START", r.returncode, r.stderr[-300:]); time.sleep(7)
        d=Desktop(backend="uia"); ws=[z for z in d.windows() if "Claude" in (z.window_text() or "")]
    out("CLAUDE_WINDOWS", len(ws), [z.window_text() for z in ws[:4]])
    return ws[0] if ws else None


def configure_local_cowork(w):
    w.set_focus(); time.sleep(.5)
    rr=rows(w)
    for ct,t,c in rr:
        try:
            if ct == "RadioButton" and t == "Cowork" and not c.is_selected(): c.click_input(); time.sleep(.6); break
        except Exception: pass
    rr=rows(w)
    for ct,t,c in rr:
        try:
            if t == "Choose where this task runs": c.click_input(); time.sleep(.5); break
        except Exception: pass
    rr=rows(w)
    for ct,t,c in rr:
        try:
            if ct == "RadioButton" and t.startswith("On your computer"): c.click_input(); out("LOCAL_COMPUTER"); time.sleep(.5); break
        except Exception: pass
    rr=rows(w)
    for ct,t,c in rr:
        try:
            if ct == "Button" and t == "Skip all approvals" and c.is_enabled(): c.click_input(); out("SKIP_APPROVALS"); time.sleep(.4); break
        except Exception: pass


def supervise(seconds=420):
    w=open_claude()
    if not w:
        out("CLAUDE_UNAVAILABLE"); return
    configure_local_cowork(w)
    pre="\n".join(t for _,t,_ in rows(w))
    out("CLAUDE_PRE", pre[-2500:].replace("\n"," | "))
    if not send(w,PROMPT): return
    start=time.time(); last_snap=""; last_nudge=start
    while time.time()-start < seconds:
        time.sleep(8)
        rr=rows(w); joined="\n".join(t for _,t,_ in rr); snap=joined[-5000:]
        if snap != last_snap:
            out("CLAUDE_DELTA", int(time.time()-start), snap[-1800:].replace("\n"," | "))
            last_snap=snap; last_nudge=time.time()
        for ct,t,c in rr:
            tl=t.lower().strip()
            if ct == "Button" and any(tl == x or tl.startswith(x) for x in ("allow","approve","continue","run","retry","use computer")) and not any(x in tl for x in ("sign in","login","password","2fa","purchase","pay")):
                try:
                    if c.is_visible() and c.is_enabled(): c.click_input(); out("CLICK",t); time.sleep(.6)
                except Exception: pass
        low=joined.lower()
        narrating=any(x in low for x in ("i can't interact","i cannot interact","i can guide you","you can click","server disconnected","windows-mcp: server disconnected"))
        if narrating or time.time()-last_nudge > 45:
            if send(w,NUDGE): out("NUDGE", "failure" if narrating else "stale")
            last_nudge=time.time()
    out("SUPERVISION_WINDOW_END")


def main():
    try: LOG.unlink(missing_ok=True)
    except Exception: pass
    out("VISIBLE_FINISH_BEGIN", time.strftime("%Y-%m-%d %H:%M:%S"))
    out("TARGET_PROJECT", PROJECT)
    out("TARGET_TIMELINE", WORK_TIMELINE)
    out("SRT_EXISTS", Path(SRT).exists(), SRT)
    try: visible_resolve_reacquire()
    except Exception: out("RESOLVE_REACQUIRE_FATAL", traceback.format_exc())
    try: supervise()
    except Exception: out("SUPERVISE_FATAL", traceback.format_exc())
    out("VISIBLE_FINISH_END", time.strftime("%Y-%m-%d %H:%M:%S"))

if __name__ == "__main__":
    main()
