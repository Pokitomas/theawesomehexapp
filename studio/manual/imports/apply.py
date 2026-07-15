from __future__ import annotations

from pathlib import Path
import os
import shutil

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
PRODUCT = HERE.parent / "product"
MANUAL = ROOT / "manual-app"

STYLE = '<link rel="stylesheet" href="./import-studio.css" data-import-workbench>'
SCRIPT = '<script type="module" src="./import-studio.js" data-import-workbench></script>'
PHONE_SCRIPT = '<script type="module" src="./import-phone.js" data-import-phone></script>'
ADD_STYLE = '<link rel="stylesheet" href="./add-to-sideways.css" data-add-to-sideways>'
ADD_SCRIPT = '<script type="module" src="./add-to-sideways.js" data-add-to-sideways></script>'
SOCIAL_STYLE = '<link rel="stylesheet" href="./social-client.css" data-social-spine>'
SOCIAL_SCRIPT = '<script type="module" src="./social-client.js" data-social-spine></script>'
SOCIAL_AUTHOR_CONTROLS_SCRIPT = '<script type="module" src="./social-author-controls.js" data-social-author-controls></script>'
SOCIAL_GOVERNANCE_CONTROLS_SCRIPT = '<script type="module" src="./social-governance-controls.js" data-social-governance-controls></script>'


def inject_once(text: str, marker: str, before: str) -> str:
    if marker in text:
        return text
    if before not in text:
        raise RuntimeError(f"cannot inject before {before!r}")
    return text.replace(before, f"  {marker}\n{before}", 1)


def remove_once(text: str, marker: str) -> str:
    return text.replace(f"  {marker}\n", "").replace(marker, "")


def main() -> None:
    if not MANUAL.exists():
        raise SystemExit("manual-app is missing; assemble the canonical product first")

    target = MANUAL / "imports"
    target.mkdir(parents=True, exist_ok=True)
    for name in ("registry.js", "runtime.js", "media-classifier.js", "hash-worker.js", "file-hash.js", "corpus-writer.js", "record-normalizer.js"):
        shutil.copyfile(HERE / name, target / name)
    for name in (
        "import-studio.js",
        "import-studio.css",
        "import-phone.js",
        "add-to-sideways.js",
        "add-to-sideways.css",
        "discovery-source.js",
        "discovery-private-boundary.js",
        "account-connections.js",
    ):
        shutil.copyfile(PRODUCT / name, MANUAL / name)
    shutil.copyfile(PRODUCT / "social-author-controls.js", MANUAL / "social-author-controls.js")
    shutil.copyfile(PRODUCT / "social-governance-controls.js", MANUAL / "social-governance-controls.js")

    index = MANUAL / "index.html"
    html = index.read_text(encoding="utf-8")
    html = inject_once(html, STYLE, "</head>")
    html = inject_once(html, ADD_STYLE, "</head>")
    html = inject_once(html, SCRIPT, "</body>")
    html = inject_once(html, PHONE_SCRIPT, "</body>")
    html = inject_once(html, ADD_SCRIPT, "</body>")
    social_live = os.environ.get("NETLIFY", "").lower() == "true" or os.environ.get("SOCIAL_LIVE_ENDPOINT", "") == "1"
    if social_live:
        html = inject_once(html, SOCIAL_AUTHOR_CONTROLS_SCRIPT, "</body>")
        html = inject_once(html, SOCIAL_GOVERNANCE_CONTROLS_SCRIPT, "</body>")
    else:
        html = remove_once(html, SOCIAL_STYLE)
        html = remove_once(html, SOCIAL_SCRIPT)
        html = remove_once(html, SOCIAL_AUTHOR_CONTROLS_SCRIPT)
        html = remove_once(html, SOCIAL_GOVERNANCE_CONTROLS_SCRIPT)
    index.write_text(html, encoding="utf-8")
    print("applied manual import workbench, unified Add to Sideways, and gated the complete live social client to server-backed builds")


if __name__ == "__main__":
    main()
