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
RESET_STYLE_MARKER = '<link rel="stylesheet" href="./studio-reset.css" data-studio-reset>'
SOCIAL_STYLE_MARKER = '<link rel="stylesheet" href="./social.css" data-social-product>'
WORKSPACE_SCRIPT_MARKER = '<script type="module" src="./workspace.js" data-workspace-product></script>'
SHELL_SCRIPT_MARKER = '<script type="module" src="./shell.js" data-shell-product></script>'
SCRIPT_MARKER = '<script type="module" src="./studio.js" data-studio-product></script>'
SOCIAL_SCRIPT_MARKER = '<script type="module" src="./social.js" data-social-product></script>'
CORE_ANCHOR = "window.SidewaysCore={"
CORE_REFRESH_MARKER = "sideways:corpusrefresh"
CORE_REFRESH_BRIDGE = (
    "window.addEventListener('sideways:importcomplete',async()=>{"
    "try{"
    "await rebuildState();"
    "window.dispatchEvent(new CustomEvent('sideways:corpusrefresh',{detail:{count:state.records.length}}));"
    "if((location.hash||'#/feed')==='#/feed')renderFeed()"
    "}catch(error){"
    "console.error(error);"
    "window.dispatchEvent(new CustomEvent('sideways:corpusrefresherror',{detail:{message:error.message}}))"
    "}});"
)


def inject_once(text: str, marker: str, before: str) -> str:
    if marker in text:
        return text
    if before not in text:
        raise RuntimeError(f"cannot inject before {before!r}")
    return text.replace(before, f"  {marker}\n{before}", 1)


def inject_core_refresh(text: str) -> str:
    if CORE_REFRESH_MARKER in text:
        return text
    if CORE_ANCHOR not in text:
        raise RuntimeError("cannot install core import refresh bridge")
    return text.replace(CORE_ANCHOR, f"{CORE_REFRESH_BRIDGE}\n{CORE_ANCHOR}", 1)


def main() -> None:
    if not MANUAL.exists():
        raise SystemExit("manual-app is missing; assemble the canonical overlays first")

    required_assets = (
        "studio.css",
        "studio-components.css",
        "studio-reset.css",
        "social.css",
        "icons.js",
        "actions.js",
        "shell.js",
        "studio.js",
        "copy.js",
        "social.js",
    )
    for name in required_assets:
        shutil.copyfile(PRODUCT / name, MANUAL / name)

    workspace_source = PRODUCT / "workspace.js"
    if workspace_source.is_file():
        shutil.copyfile(workspace_source, MANUAL / "workspace.js")

    index = MANUAL / "index.html"
    text = index.read_text(encoding="utf-8")
    text = inject_once(text, STYLE_MARKER, "</head>")
    text = inject_once(text, COMPONENT_STYLE_MARKER, "</head>")
    text = inject_once(text, RESET_STYLE_MARKER, "</head>")
    text = inject_once(text, SOCIAL_STYLE_MARKER, "</head>")
    if workspace_source.is_file():
        text = inject_once(text, WORKSPACE_SCRIPT_MARKER, "</body>")
    text = inject_once(text, SHELL_SCRIPT_MARKER, "</body>")
    text = inject_once(text, SCRIPT_MARKER, "</body>")
    text = inject_once(text, SOCIAL_SCRIPT_MARKER, "</body>")
    index.write_text(text, encoding="utf-8")

    app = MANUAL / "app.js"
    app.write_text(inject_core_refresh(app.read_text(encoding="utf-8")), encoding="utf-8")

    if IMPORT_INSTALLER.is_file():
        runpy.run_path(str(IMPORT_INSTALLER), run_name="__main__")

    print("applied operating-system shell, workspace adapter, social product, action contract, and core refresh bridge")


if __name__ == "__main__":
    main()
