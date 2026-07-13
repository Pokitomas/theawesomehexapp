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
WORKSPACE_STYLE_MARKER = '<link rel="stylesheet" href="./workspace.css" data-workspace-product>'
CARD_LAYOUT_STYLE_MARKER = '<link rel="stylesheet" href="./card-layout.css" data-card-layout>'
CHROME_STYLE_MARKER = '<link rel="stylesheet" href="./workspace-chrome.css" data-workspace-chrome>'
SCRIPT_MARKER = '<script type="module" src="./studio.js" data-studio-product></script>'
WORKSPACE_SCRIPT_MARKER = '<script type="module" src="./workspace-ui.js" data-workspace-product></script>'
CORE_ACTIONS_SCRIPT_MARKER = '<script type="module" src="./core-actions.js" data-core-actions></script>'
CHROME_SCRIPT_MARKER = '<script type="module" src="./workspace-chrome.js" data-workspace-chrome></script>'
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

OLD_SOCIAL_MARKERS = (
    '<link rel="stylesheet" href="./social.css" data-social-product>',
    '<script type="module" src="./social.js" data-social-product></script>',
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


def remove_retired_social(text: str) -> str:
    for marker in OLD_SOCIAL_MARKERS:
        text = text.replace(f"  {marker}\n", "").replace(marker, "")
    return text


def main() -> None:
    if not MANUAL.exists():
        raise SystemExit("manual-app is missing; assemble the canonical overlays first")

    for name in (
        "studio.css",
        "studio-components.css",
        "studio-reset.css",
        "workspace.css",
        "card-layout.css",
        "workspace-chrome.css",
        "studio.js",
        "copy.js",
        "actions.js",
        "workspace-db.js",
        "workspace-profile.js",
        "workspace-records.js",
        "workspace-sync.js",
        "workspace-migration.js",
        "workspace.js",
        "workspace-ui.js",
        "core-actions.js",
        "workspace-chrome.js",
        "system-icons.svg",
    ):
        shutil.copyfile(PRODUCT / name, MANUAL / name)

    for retired in ("social.js", "social.css"):
        path = MANUAL / retired
        if path.exists():
            path.unlink()

    index = MANUAL / "index.html"
    text = remove_retired_social(index.read_text(encoding="utf-8"))
    text = inject_once(text, STYLE_MARKER, "</head>")
    text = inject_once(text, COMPONENT_STYLE_MARKER, "</head>")
    text = inject_once(text, RESET_STYLE_MARKER, "</head>")
    text = inject_once(text, WORKSPACE_STYLE_MARKER, "</head>")
    text = inject_once(text, CARD_LAYOUT_STYLE_MARKER, "</head>")
    text = inject_once(text, CHROME_STYLE_MARKER, "</head>")
    text = inject_once(text, SCRIPT_MARKER, "</body>")
    text = inject_once(text, WORKSPACE_SCRIPT_MARKER, "</body>")
    text = inject_once(text, CORE_ACTIONS_SCRIPT_MARKER, "</body>")
    text = inject_once(text, CHROME_SCRIPT_MARKER, "</body>")
    index.write_text(text, encoding="utf-8")

    app = MANUAL / "app.js"
    app.write_text(inject_core_refresh(app.read_text(encoding="utf-8")), encoding="utf-8")

    if IMPORT_INSTALLER.is_file():
        runpy.run_path(str(IMPORT_INSTALLER), run_name="__main__")

    print("applied lived workspace, canonical posting, places, action contract, readable card layout, remembered-Windows chrome, and core refresh bridge")


if __name__ == "__main__":
    main()
