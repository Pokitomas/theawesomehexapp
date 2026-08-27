from __future__ import annotations

import copy
import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Any

from core import canonical, receipt, verify_receipt

PROJECT_SCHEMA = "archie-video-editor/v1"


def frac(value: str | int | float | Fraction) -> Fraction:
    if isinstance(value, Fraction):
        return value
    if isinstance(value, int):
        return Fraction(value, 1)
    if isinstance(value, float):
        return Fraction(str(value))
    return Fraction(value)


@dataclass(frozen=True)
class Timebase:
    fps_num: int = 30000
    fps_den: int = 1001

    @property
    def fps(self) -> Fraction:
        return Fraction(self.fps_num, self.fps_den)

    def seconds_at_frame(self, frame: int) -> Fraction:
        return Fraction(int(frame) * self.fps_den, self.fps_num)

    def frame_at_seconds(self, seconds: Fraction, *, nearest: bool = False) -> int:
        raw = seconds * self.fps
        if nearest:
            return int(raw + Fraction(1, 2))
        return raw.numerator // raw.denominator


@dataclass
class Clip:
    id: str
    source: str
    source_in: int
    source_out: int
    timeline_start: int
    gain: float = 1.0
    speed_num: int = 1
    speed_den: int = 1

    @property
    def source_frames(self) -> int:
        return max(0, int(self.source_out) - int(self.source_in))

    @property
    def timeline_frames(self) -> int:
        speed = Fraction(self.speed_num, self.speed_den)
        if speed <= 0:
            raise ValueError("speed must be positive")
        frames = Fraction(self.source_frames, 1) / speed
        return max(0, frames.numerator // frames.denominator)

    @property
    def timeline_end(self) -> int:
        return int(self.timeline_start) + self.timeline_frames


@dataclass
class Track:
    id: str
    kind: str
    clips: list[Clip] = field(default_factory=list)


@dataclass
class EditOp:
    id: str
    kind: str
    args: dict[str, Any]
    before: dict[str, Any]
    after: dict[str, Any]


class Project:
    def __init__(self, *, name: str = "Untitled", timebase: Timebase | None = None) -> None:
        self.schema = PROJECT_SCHEMA
        self.name = name
        self.timebase = timebase or Timebase()
        self.tracks: list[Track] = [Track("V1", "video"), Track("A1", "audio")]
        self.history: list[EditOp] = []
        self.redo_stack: list[EditOp] = []

    def snapshot(self) -> dict[str, Any]:
        return {
            "schema": self.schema,
            "name": self.name,
            "timebase": asdict(self.timebase),
            "tracks": [
                {"id": t.id, "kind": t.kind, "clips": [asdict(c) for c in t.clips]}
                for t in self.tracks
            ],
        }

    @classmethod
    def from_snapshot(cls, value: dict[str, Any]) -> "Project":
        tbv = value.get("timebase") or {}
        p = cls(name=str(value.get("name") or "Untitled"), timebase=Timebase(int(tbv.get("fps_num", 30000)), int(tbv.get("fps_den", 1001))))
        p.tracks = []
        for tv in value.get("tracks") or []:
            t = Track(str(tv["id"]), str(tv["kind"]), [])
            for cv in tv.get("clips") or []:
                t.clips.append(Clip(**cv))
            p.tracks.append(t)
        return p

    def _track(self, track_id: str) -> Track:
        for t in self.tracks:
            if t.id == track_id:
                return t
        raise KeyError(track_id)

    def _apply(self, kind: str, args: dict[str, Any], fn) -> EditOp:
        before = self.snapshot()
        fn()
        self._validate()
        after = self.snapshot()
        op = EditOp(uuid.uuid4().hex, kind, copy.deepcopy(args), before, after)
        self.history.append(op)
        self.redo_stack.clear()
        return op

    def _validate(self) -> None:
        ids: set[str] = set()
        for t in self.tracks:
            last_end = -1
            for c in sorted(t.clips, key=lambda x: (x.timeline_start, x.id)):
                if c.id in ids:
                    raise ValueError(f"duplicate clip {c.id}")
                ids.add(c.id)
                if c.source_in < 0 or c.source_out <= c.source_in:
                    raise ValueError("bad source range")
                if c.timeline_start < 0:
                    raise ValueError("negative timeline position")
                if c.timeline_start < last_end:
                    raise ValueError(f"overlap on {t.id}")
                last_end = c.timeline_end

    def add_clip(self, track_id: str, source: str, source_in: int, source_out: int, timeline_start: int, *, clip_id: str | None = None) -> EditOp:
        cid = clip_id or uuid.uuid4().hex[:12]
        args = {"track_id": track_id, "source": source, "source_in": source_in, "source_out": source_out, "timeline_start": timeline_start, "clip_id": cid}
        return self._apply("add_clip", args, lambda: self._track(track_id).clips.append(Clip(cid, source, int(source_in), int(source_out), int(timeline_start))))

    def split(self, track_id: str, clip_id: str, timeline_frame: int) -> EditOp:
        track = self._track(track_id)
        original = next(c for c in track.clips if c.id == clip_id)
        cut = int(timeline_frame)
        if not original.timeline_start < cut < original.timeline_end:
            raise ValueError("split must be inside clip")
        rel_tl = cut - original.timeline_start
        source_delta = Fraction(rel_tl * original.speed_num, original.speed_den)
        source_cut = original.source_in + source_delta.numerator // source_delta.denominator
        if not original.source_in < source_cut < original.source_out:
            raise ValueError("split cannot quantize to source boundary")
        args = {"track_id": track_id, "clip_id": clip_id, "timeline_frame": cut}

        def change() -> None:
            track.clips.remove(original)
            left = copy.deepcopy(original)
            right = copy.deepcopy(original)
            left.id = original.id + "L"
            right.id = original.id + "R"
            left.source_out = source_cut
            right.source_in = source_cut
            right.timeline_start = cut
            track.clips.extend([left, right])
            track.clips.sort(key=lambda c: (c.timeline_start, c.id))

        return self._apply("split", args, change)

    def trim(self, track_id: str, clip_id: str, *, source_in: int | None = None, source_out: int | None = None) -> EditOp:
        track = self._track(track_id)
        clip = next(c for c in track.clips if c.id == clip_id)
        args = {"track_id": track_id, "clip_id": clip_id, "source_in": source_in, "source_out": source_out}

        def change() -> None:
            if source_in is not None:
                delta = int(source_in) - clip.source_in
                clip.source_in = int(source_in)
                clip.timeline_start += Fraction(delta * clip.speed_den, clip.speed_num).numerator // Fraction(delta * clip.speed_den, clip.speed_num).denominator
            if source_out is not None:
                clip.source_out = int(source_out)

        return self._apply("trim", args, change)

    def set_gain(self, track_id: str, clip_id: str, gain: float) -> EditOp:
        clip = next(c for c in self._track(track_id).clips if c.id == clip_id)
        return self._apply("set_gain", {"track_id": track_id, "clip_id": clip_id, "gain": float(gain)}, lambda: setattr(clip, "gain", float(gain)))

    def undo(self) -> dict[str, Any]:
        if not self.history:
            return receipt("editor.undo", {"ok": False, "reason": "empty"})
        op = self.history.pop()
        current = self.snapshot()
        restored = Project.from_snapshot(op.before)
        self.name, self.timebase, self.tracks = restored.name, restored.timebase, restored.tracks
        op.after = current
        self.redo_stack.append(op)
        return receipt("editor.undo", {"ok": True, "op": op.kind, "op_id": op.id})

    def redo(self) -> dict[str, Any]:
        if not self.redo_stack:
            return receipt("editor.redo", {"ok": False, "reason": "empty"})
        op = self.redo_stack.pop()
        restored = Project.from_snapshot(op.after)
        self.name, self.timebase, self.tracks = restored.name, restored.timebase, restored.tracks
        self.history.append(op)
        return receipt("editor.redo", {"ok": True, "op": op.kind, "op_id": op.id})

    def save(self, path: Path) -> dict[str, Any]:
        data = self.snapshot()
        path.write_bytes(canonical(data) + b"\n")
        return receipt("editor.save", {"path": path.name, "bytes": path.stat().st_size, "project_sha256": __import__("hashlib").sha256(canonical(data)).hexdigest()})

    @classmethod
    def load(cls, path: Path) -> "Project":
        return cls.from_snapshot(json.loads(path.read_text(encoding="utf-8")))


def benchmark(iterations: int = 2000) -> dict[str, Any]:
    iterations = max(10, int(iterations))
    p = Project(name="court", timebase=Timebase(24000, 1001))
    # One long synthetic source clip, then deterministic gain operations. We do
    # not benchmark random data because reproducibility is part of the court.
    p.add_clip("V1", "synthetic.mov", 0, 24_000, 0, clip_id="c0")
    start = time.perf_counter_ns()
    for i in range(iterations):
        p.set_gain("V1", "c0", 1.0 + (i % 7) * 0.01)
    elapsed_ns = time.perf_counter_ns() - start
    snap1 = p.snapshot()
    b1 = canonical(snap1)
    # Replay from the same deterministic command trace.
    q = Project(name="court", timebase=Timebase(24000, 1001))
    q.add_clip("V1", "synthetic.mov", 0, 24_000, 0, clip_id="c0")
    for i in range(iterations):
        q.set_gain("V1", "c0", 1.0 + (i % 7) * 0.01)
    same = b1 == canonical(q.snapshot())
    frame_probe = [p.timebase.seconds_at_frame(x) for x in (0, 1, 23, 24, 24000)]
    roundtrip = [p.timebase.frame_at_seconds(x) for x in frame_probe]
    return receipt("editor.benchmark", {
        "iterations": iterations,
        "elapsed_ns": elapsed_ns,
        "ops_per_s": iterations / max(1e-12, elapsed_ns / 1e9),
        "deterministic_replay": same,
        "exact_frame_roundtrip": roundtrip == [0, 1, 23, 24, 24000],
        "history_depth": len(p.history),
    })


def court() -> dict[str, Any]:
    p = Project(name="video-court", timebase=Timebase(24, 1))
    add = p.add_clip("V1", "a.mov", 0, 240, 0, clip_id="a")
    split = p.split("V1", "a", 120)
    before_undo = canonical(p.snapshot())
    undo = p.undo()
    redo = p.redo()
    after_redo = canonical(p.snapshot())
    import tempfile
    with tempfile.TemporaryDirectory(prefix="archie-edit-") as td:
        path = Path(td) / "project.json"
        save = p.save(path)
        loaded = Project.load(path)
        portable = canonical(loaded.snapshot()) == canonical(p.snapshot())
    bench = benchmark(500)
    return receipt("editor.court", {
        "add_receipt": verify_receipt(add),
        "split_receipt": verify_receipt(split),
        "undo_receipt": verify_receipt(undo) and bool(undo["payload"]["ok"]),
        "redo_receipt": verify_receipt(redo) and bool(redo["payload"]["ok"]),
        "redo_exact": before_undo == after_redo,
        "portable_roundtrip": portable,
        "save_receipt": verify_receipt(save),
        "benchmark": bench["payload"],
    })


if __name__ == "__main__":
    print(json.dumps(court(), indent=2, default=str))
