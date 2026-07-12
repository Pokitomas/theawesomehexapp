#!/usr/bin/env python3
from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path("dist/manual")
REQUIRED_FILES = (
    "index.html",
    "app.js",
    "profile.js",
    "style.css",
    "profile.css",
    "assets/sideways-mark.svg",
    "assets/sideways-mask.svg",
    "assets/site.webmanifest",
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


for relative in REQUIRED_FILES:
    require((ROOT / relative).is_file(), f"missing manual edition file: {relative}")

require(not (ROOT / "data").exists(), "manual edition must not contain built corpus data")
require(not (ROOT / "media").exists(), "manual edition must not contain mirrored corpus media")

html = (ROOT / "index.html").read_text(encoding="utf-8")
app = (ROOT / "app.js").read_text(encoding="utf-8")
profile = (ROOT / "profile.js").read_text(encoding="utf-8")
all_text = "\n".join((html, app, profile))

for word in (
    "FILES",
    "FOLDER",
    "PASTE",
    "LINK",
    "OPEN PACK",
    "SAVE PACK",
    "PUT IN",
    "EMPTY ALL",
    "ADD THINGS",
    "KEEP",
    "BOX",
    "SEND",
    "FIX",
    "DONE",
    "THROW OUT",
):
    require(word in all_text, f"missing simple control wording: {word}")

for primitive in (
    "indexedDB",
    "DecompressionStream",
    "sideways-manual-pack-v1",
    "webkitdirectory",
    "application/pdf",
    "unzipFile",
    ".zip",
    "application/vnd.openxmlformats-officedocument",
    "crypto.subtle.digest",
):
    require(primitive in all_text, f"missing upload primitive: {primitive}")

require("fetch(" not in app, "manual edition must not silently retrieve a remote corpus")
require("dist/manual/data" not in all_text, "manual edition references bundled corpus data")

subprocess.run(["node", "--check", str(ROOT / "app.js")], check=True)
subprocess.run(["node", "--check", str(ROOT / "profile.js")], check=True)

print("manual edition verified: empty, local, upload-ready, WALL-E controls")
