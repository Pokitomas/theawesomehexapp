from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

try:
    from .core import canonical, receipt
except ImportError:
    from core import canonical, receipt

SCHEMA = "archie-cut-render/v1"


@dataclass(frozen=True)
class RenderPlan:
    argv: tuple[str, ...]
    project_sha256: str
    output: str
    sources: tuple[str, ...]
    video_segments: int
    audio_mode: str


def _fps(project: dict[str, Any]) -> Fraction:
    tb = project.get("timebase") or {}
    num = int(tb.get("fps_num", 30000))
    den = int(tb.get("fps_den", 1001))
    if num <= 0 or den <= 0:
        raise ValueError("invalid timebase")
    return Fraction(num, den)


def _seconds(frame: int, fps: Fraction) -> str:
    if frame < 0:
        raise ValueError("negative frame")
    v = Fraction(int(frame), 1) / fps
    return f"{float(v):.9f}".rstrip("0").rstrip(".")


def _tracks(project: dict[str, Any]) -> list[dict[str, Any]]:
    tracks = project.get("tracks")
    if not isinstance(tracks, list):
        raise ValueError("tracks required")
    return [t for t in tracks if isinstance(t, dict)]


def _clip_sort_key(c: dict[str, Any]) -> tuple[int, str]:
    return int(c.get("timeline_start", 0)), str(c.get("id", ""))


def validate_project(project: dict[str, Any]) -> dict[str, Any]:
    fps = _fps(project)
    seen: set[str] = set()
    source_paths: set[str] = set()
    by_track: dict[str, list[dict[str, Any]]] = {}
    for track in _tracks(project):
        tid = str(track.get("id") or "")
        if not tid:
            raise ValueError("track id required")
        clips = sorted((c for c in track.get("clips", []) if isinstance(c, dict)), key=_clip_sort_key)
        last_end = 0
        for clip in clips:
            cid = str(clip.get("id") or "")
            if not cid or cid in seen:
                raise ValueError("duplicate/missing clip id")
            seen.add(cid)
            src = str(clip.get("source") or "")
            if not src:
                raise ValueError(f"source required for {cid}")
            source_paths.add(src)
            sin = int(clip.get("source_in", 0))
            sout = int(clip.get("source_out", 0))
            start = int(clip.get("timeline_start", 0))
            speed_num = int(clip.get("speed_num", 1))
            speed_den = int(clip.get("speed_den", 1))
            if sin < 0 or sout <= sin or start < 0 or speed_num <= 0 or speed_den <= 0:
                raise ValueError(f"invalid clip {cid}")
            duration = Fraction(sout - sin, 1) * Fraction(speed_den, speed_num)
            tl_frames = duration.numerator // duration.denominator
            end = start + tl_frames
            if start < last_end:
                raise ValueError(f"overlap on {tid}")
            last_end = end
        by_track[tid] = clips
    return {
        "fps_num": fps.numerator,
        "fps_den": fps.denominator,
        "clip_count": len(seen),
        "sources": sorted(source_paths),
        "tracks": {k: len(v) for k, v in sorted(by_track.items())},
    }


def build_ffmpeg_plan(
    project: dict[str, Any],
    output: str | Path,
    *,
    ffmpeg: str = "ffmpeg",
    video_codec: str = "libx264",
    crf: int = 18,
    preset: str = "medium",
    audio_codec: str = "aac",
    audio_bitrate: str = "192k",
    overwrite: bool = False,
) -> RenderPlan:
    """Build a deterministic ffmpeg argv for a contiguous V1/A1 timeline.

    Audio is copied semantically, not bitstream-copied: no gain/compression/filter
    is applied unless the project explicitly changed clip gain. This preserves the
    editor's audio-untouched-by-default contract while allowing trimmed concat.
    """
    meta = validate_project(project)
    fps = Fraction(meta["fps_num"], meta["fps_den"])
    tracks = {str(t.get("id")): t for t in _tracks(project)}
    video_track = tracks.get("V1") or next((t for t in _tracks(project) if t.get("kind") == "video"), None)
    if not video_track:
        raise ValueError("video track required")
    vclips = sorted([c for c in video_track.get("clips", []) if isinstance(c, dict)], key=_clip_sort_key)
    if not vclips:
        raise ValueError("video clips required")
    atrack = tracks.get("A1") or next((t for t in _tracks(project) if t.get("kind") == "audio"), None)
    aclips = sorted([c for c in (atrack or {}).get("clips", []) if isinstance(c, dict)], key=_clip_sort_key)

    sources: list[str] = []
    source_index: dict[str, int] = {}
    for c in vclips + aclips:
        src = str(c["source"])
        if src not in source_index:
            source_index[src] = len(sources)
            sources.append(src)

    argv: list[str] = [ffmpeg, "-hide_banner", "-loglevel", "warning", "-y" if overwrite else "-n"]
    for src in sources:
        argv += ["-i", src]

    filters: list[str] = []
    vlabels: list[str] = []
    for i, c in enumerate(vclips):
        idx = source_index[str(c["source"])]
        sin, sout = int(c["source_in"]), int(c["source_out"])
        sn, sd = int(c.get("speed_num", 1)), int(c.get("speed_den", 1))
        start_s, end_s = _seconds(sin, fps), _seconds(sout, fps)
        speed = Fraction(sn, sd)
        label = f"v{i}"
        chain = f"[{idx}:v]trim=start={start_s}:end={end_s},setpts=(PTS-STARTPTS)/{float(speed):.12g}"
        filters.append(chain + f"[{label}]")
        vlabels.append(f"[{label}]")

    audio_mode = "none"
    alabels: list[str] = []
    if aclips:
        audio_mode = "untouched-default"
        for i, c in enumerate(aclips):
            idx = source_index[str(c["source"])]
            sin, sout = int(c["source_in"]), int(c["source_out"])
            start_s, end_s = _seconds(sin, fps), _seconds(sout, fps)
            gain = float(c.get("gain", 1.0))
            label = f"a{i}"
            chain = f"[{idx}:a]atrim=start={start_s}:end={end_s},asetpts=PTS-STARTPTS"
            if abs(gain - 1.0) > 1e-12:
                chain += f",volume={gain:.12g}"
                audio_mode = "explicit-gain"
            filters.append(chain + f"[{label}]")
            alabels.append(f"[{label}]")

    if len(vlabels) == 1:
        filters.append(f"{vlabels[0]}null[vout]")
    else:
        filters.append("".join(vlabels) + f"concat=n={len(vlabels)}:v=1:a=0[vout]")

    if alabels:
        if len(alabels) == 1:
            filters.append(f"{alabels[0]}anull[aout]")
        else:
            filters.append("".join(alabels) + f"concat=n={len(alabels)}:v=0:a=1[aout]")

    argv += ["-filter_complex", ";".join(filters), "-map", "[vout]"]
    if alabels:
        argv += ["-map", "[aout]"]
    argv += ["-r", f"{fps.numerator}/{fps.denominator}", "-c:v", video_codec, "-crf", str(int(crf)), "-preset", preset]
    if alabels:
        argv += ["-c:a", audio_codec, "-b:a", audio_bitrate]
    argv += ["-movflags", "+faststart", str(output)]

    return RenderPlan(
        argv=tuple(argv),
        project_sha256=hashlib.sha256(canonical(project)).hexdigest(),
        output=str(output),
        sources=tuple(sources),
        video_segments=len(vclips),
        audio_mode=audio_mode,
    )


def execute_plan(plan: RenderPlan, *, cwd: str | Path | None = None, timeout_s: int = 3600) -> dict[str, Any]:
    exe = shutil.which(plan.argv[0])
    if not exe:
        return receipt("editor.render", {
            "status": "BLOCKED",
            "reason": "ffmpeg-missing",
            "project_sha256": plan.project_sha256,
            "argv": list(plan.argv),
        })
    argv = [exe, *plan.argv[1:]]
    p = subprocess.run(argv, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout_s)
    out = Path(cwd or ".") / plan.output if not Path(plan.output).is_absolute() else Path(plan.output)
    ok = p.returncode == 0 and out.exists() and out.stat().st_size > 0
    return receipt("editor.render", {
        "status": "PASS" if ok else "FAIL",
        "returncode": p.returncode,
        "bytes": out.stat().st_size if out.exists() else 0,
        "project_sha256": plan.project_sha256,
        "audio_mode": plan.audio_mode,
        "stdout_tail": p.stdout[-6000:],
    })


def court() -> dict[str, Any]:
    project = {
        "schema": "archie-video-editor/v1",
        "name": "render-court",
        "timebase": {"fps_num": 24, "fps_den": 1},
        "tracks": [
            {"id": "V1", "kind": "video", "clips": [
                {"id": "v0", "source": "a.mp4", "source_in": 0, "source_out": 48, "timeline_start": 0, "gain": 1.0, "speed_num": 1, "speed_den": 1},
                {"id": "v1", "source": "a.mp4", "source_in": 72, "source_out": 120, "timeline_start": 48, "gain": 1.0, "speed_num": 1, "speed_den": 1},
            ]},
            {"id": "A1", "kind": "audio", "clips": [
                {"id": "a0", "source": "a.mp4", "source_in": 0, "source_out": 48, "timeline_start": 0, "gain": 1.0, "speed_num": 1, "speed_den": 1},
                {"id": "a1", "source": "a.mp4", "source_in": 72, "source_out": 120, "timeline_start": 48, "gain": 1.0, "speed_num": 1, "speed_den": 1},
            ]},
        ],
    }
    p1 = build_ffmpeg_plan(project, "out.mp4")
    p2 = build_ffmpeg_plan(json.loads(json.dumps(project)), "out.mp4")
    filters = p1.argv[p1.argv.index("-filter_complex") + 1]
    return receipt("editor.render_court", {
        "deterministic": p1.argv == p2.argv,
        "project_hash_stable": p1.project_sha256 == p2.project_sha256,
        "audio_untouched_default": p1.audio_mode == "untouched-default" and "volume=" not in filters,
        "trim_exact": "trim=start=0:end=2" in filters and "trim=start=3:end=5" in filters,
        "concat_video": "concat=n=2:v=1:a=0" in filters,
        "concat_audio": "concat=n=2:v=0:a=1" in filters,
        "passes": p1.argv == p2.argv and p1.audio_mode == "untouched-default" and "volume=" not in filters,
        "argv": list(p1.argv),
    })


if __name__ == "__main__":
    print(json.dumps(court(), indent=2))
