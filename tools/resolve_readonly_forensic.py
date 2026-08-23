import os, sys, json, traceback

MODULES = [
    r"C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting\Modules",
    r"C:\Program Files\Blackmagic Design\DaVinci Resolve\Developer\Scripting\Modules",
]
for path in MODULES:
    if os.path.exists(path) and path not in sys.path:
        sys.path.append(path)
os.environ.setdefault("RESOLVE_SCRIPT_LIB", r"C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll")


def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default

try:
    import DaVinciResolveScript as dvr
    resolve = dvr.scriptapp("Resolve")
    print("CONNECTED", bool(resolve))
    if not resolve:
        raise SystemExit(2)
    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject()
    print("PROJECT", project.GetName() if project else None)
    if not project:
        raise SystemExit(3)

    settings = {}
    for key in (
        "timelineFrameRate", "timelineResolutionWidth", "timelineResolutionHeight",
        "videoMonitorFormat", "audioSampleRate", "timelinePlaybackFrameRate",
    ):
        settings[key] = safe(lambda k=key: project.GetSetting(k))
    print("PROJECT_SETTINGS", json.dumps(settings, ensure_ascii=True))

    print("TIMELINE_COUNT", project.GetTimelineCount())
    for i in range(1, (project.GetTimelineCount() or 0) + 1):
        tl = project.GetTimelineByIndex(i)
        print("TIMELINE", i, repr(tl.GetName()), tl.GetStartFrame(), tl.GetEndFrame())

    tl = project.GetCurrentTimeline()
    print("CURRENT_TIMELINE", repr(tl.GetName()) if tl else None)
    if not tl:
        raise SystemExit(0)

    print("CURRENT_RANGE", tl.GetStartFrame(), tl.GetEndFrame(), "FPS", safe(lambda: tl.GetSetting("timelineFrameRate")))
    for kind in ("video", "audio", "subtitle"):
        try:
            count = tl.GetTrackCount(kind)
        except Exception as exc:
            print("TRACK_COUNT_ERROR", kind, repr(exc))
            continue
        print("TRACK_COUNT", kind, count)
        for ti in range(1, count + 1):
            name = safe(lambda: tl.GetTrackName(kind, ti), "")
            enabled = safe(lambda: tl.GetIsTrackEnabled(kind, ti))
            items = safe(lambda: tl.GetItemListInTrack(kind, ti), []) or []
            print("TRACK", kind, ti, repr(name), "ENABLED", enabled, "ITEMS", len(items))
            for j, item in enumerate(items):
                mp = safe(item.GetMediaPoolItem)
                path = ""
                props = {}
                if mp:
                    path = safe(lambda: mp.GetClipProperty("File Path"), "") or ""
                    for key in ("FPS", "Audio Ch", "Audio Codec", "Video Codec", "Resolution", "Duration", "Start TC", "Sample Rate"):
                        props[key] = safe(lambda k=key: mp.GetClipProperty(k))
                print(
                    "ITEM", kind, ti, j,
                    repr(safe(item.GetName, "")),
                    safe(item.GetStart), safe(item.GetEnd), safe(item.GetDuration),
                    repr(path), json.dumps(props, ensure_ascii=True),
                )

    markers = safe(tl.GetMarkers, {}) or {}
    print("MARKERS", json.dumps(markers, ensure_ascii=True, default=str))
except SystemExit:
    raise
except Exception:
    traceback.print_exc()
    raise
