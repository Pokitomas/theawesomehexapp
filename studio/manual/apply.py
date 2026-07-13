from __future__ import annotations

from pathlib import Path
import runpy
import shutil

ROOT = Path(__file__).resolve().parents[2]
PRODUCT = Path(__file__).resolve().parent / "product"
MANUAL = ROOT / "manual-app"
IMPORT_INSTALLER = Path(__file__).resolve().parent / "imports" / "apply.py"

STYLE_MARKER = '<link rel="stylesheet" href="./studio.css" data-studio-product>'
COMPONENT_STYLE_MARKER = '<link rel="stylesheet" href="./studio-components.css" data-studio-product>'
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

    for name in ("studio.css", "studio-components.css", "studio.js", "copy.js"):
        shutil.copyfile(PRODUCT / name, MANUAL / name)

    index = MANUAL / "index.html"
    text = index.read_text(encoding="utf-8")
    text = inject_once(text, STYLE_MARKER, "</head>")
    text = inject_once(text, COMPONENT_STYLE_MARKER, "</head>")
    text = inject_once(text, SCRIPT_MARKER, "</body>")
    index.write_text(text, encoding="utf-8")

    if IMPORT_INSTALLER.is_file():
        runpy.run_path(str(IMPORT_INSTALLER), run_name="__main__")

    print("applied editable manual studio product layer")


if __name__ == "__main__":
    main()
