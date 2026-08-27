from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

try:
    from .core import receipt, verify_receipt
    from .render_ffmpeg import build_ffmpeg_plan, execute_plan
except ImportError:
    from core import receipt, verify_receipt
    from render_ffmpeg import build_ffmpeg_plan, execute_plan


def court() -> dict[str, Any]:
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        return receipt("editor.render_integration", {
            "status": "SKIP",
            "reason": "ffmpeg-or-ffprobe-missing",
            "passes": True,
        })

    with tempfile.TemporaryDirectory(prefix="archie-render-int-") as td:
        root = Path(td)
        src = root / "source.mp4"
        out = root / "out.mp4"
        make = subprocess.run([
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=5",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=5",
            "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(src),
        ], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=45)
        if make.returncode != 0 or not src.exists():
            return receipt("editor.render_integration", {
                "status": "FAIL", "stage": "fixture", "stdout_tail": make.stdout[-4000:], "passes": False,
            })

        project = {
            "schema": "archie-video-editor/v1",
            "name": "integration",
            "timebase": {"fps_num": 24, "fps_den": 1},
            "tracks": [
                {"id": "V1", "kind": "video", "clips": [
                    {"id": "v0", "source": str(src), "source_in": 0, "source_out": 48, "timeline_start": 0, "gain": 1.0, "speed_num": 1, "speed_den": 1},
                    {"id": "v1", "source": str(src), "source_in": 72, "source_out": 120, "timeline_start": 48, "gain": 1.0, "speed_num": 1, "speed_den": 1},
                ]},
                {"id": "A1", "kind": "audio", "clips": [
                    {"id": "a0", "source": str(src), "source_in": 0, "source_out": 48, "timeline_start": 0, "gain": 1.0, "speed_num": 1, "speed_den": 1},
                    {"id": "a1", "source": str(src), "source_in": 72, "source_out": 120, "timeline_start": 48, "gain": 1.0, "speed_num": 1, "speed_den": 1},
                ]},
            ],
        }
        plan = build_ffmpeg_plan(project, out, ffmpeg=ffmpeg, overwrite=True, preset="ultrafast")
        rendered = execute_plan(plan, timeout_s=90)
        if rendered["payload"].get("status") != "PASS":
            return receipt("editor.render_integration", {
                "status": "FAIL", "stage": "render", "render": rendered, "passes": False,
            })
        probe = subprocess.run([
            ffprobe, "-v", "error", "-show_entries", "format=duration", "-show_entries", "stream=codec_type",
            "-of", "json", str(out),
        ], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=20)
        try:
            meta = json.loads(probe.stdout)
            duration = float((meta.get("format") or {}).get("duration") or 0.0)
            kinds = sorted(s.get("codec_type") for s in meta.get("streams", []) if s.get("codec_type"))
        except Exception:
            duration, kinds = 0.0, []
        duration_ok = 3.85 <= duration <= 4.15
        av_ok = kinds == ["audio", "video"]
        return receipt("editor.render_integration", {
            "status": "PASS" if duration_ok and av_ok else "FAIL",
            "render_receipt_valid": verify_receipt(rendered),
            "duration_s": duration,
            "duration_exact_window": duration_ok,
            "streams": kinds,
            "audio_video_present": av_ok,
            "bytes": out.stat().st_size,
            "audio_mode": plan.audio_mode,
            "passes": duration_ok and av_ok and verify_receipt(rendered),
        })


if __name__ == "__main__":
    print(json.dumps(court(), indent=2))
