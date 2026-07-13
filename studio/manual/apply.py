from __future__ import annotations

from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[2]
PRODUCT = Path(__file__).resolve().parent / "product"
MANUAL = ROOT / "manual-app"

STYLE_MARKER = '<link rel="stylesheet" href="./studio.css" data-studio-product>'
SCRIPT_MARKER = '<script type="module" src="./studio.js" data-studio-product></script>'


def inject_once(text: str, marker: str, before: str) -> str:
    if marker in text:
        return text
    if before not in text:
        raise RuntimeError(f"cannot inject before {before!r}")
    return text.replace(before, f"  {marker}\n{before}", 1)


def main() -> None:
    if not MANUAL.exists():
        raise SystemExit("manual-app is missing; assemble the canonical overlays first")

    shutil.copyfile(PRODUCT / "studio.css", MANUAL / "studio.css")
    shutil.copyfile(PRODUCT / "studio.js", MANUAL / "studio.js")
    shutil.copyfile(PRODUCT / "copy.js", MANUAL / "copy.js")

    index = MANUAL / "index.html"
    text = index.read_text(encoding="utf-8")
    text = inject_once(text, STYLE_MARKER, "</head>")
    text = inject_once(text, SCRIPT_MARKER, "</body>")
    index.write_text(text, encoding="utf-8")

    print("applied editable manual studio product layer")


if __name__ == "__main__":
    main()
