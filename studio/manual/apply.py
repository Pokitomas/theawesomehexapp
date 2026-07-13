from __future__ import annotations

from pathlib import Path
import runpy
import shutil

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
PRODUCT = HERE / "product"
SHARED = HERE / "shared"
MANUAL = ROOT / "manual-app"
IMPORT_INSTALLER = HERE / "imports" / "apply.py"

STYLE_MARKER = '<link rel="stylesheet" href="./studio.css" data-studio-product>'
COMPONENT_STYLE_MARKER = '<link rel="stylesheet" href="./studio-components.css" data-studio-product>'
RESET_STYLE_MARKER = '<link rel="stylesheet" href="./studio-reset.css" data-studio-reset>'
WORKSPACE_STYLE_MARKER = '<link rel="stylesheet" href="./workspace.css" data-workspace-product>'
CARD_LAYOUT_STYLE_MARKER = '<link rel="stylesheet" href="./card-layout.css" data-card-layout>'
CHROME_STYLE_MARKER = '<link rel="stylesheet" href="./workspace-chrome.css" data-workspace-chrome>'
CHROME_POLISH_STYLE_MARKER = '<link rel="stylesheet" href="./workspace-chrome-polish.css" data-workspace-chrome-polish>'
FUTURE_MEDIA_STYLE_MARKER = '<link rel="stylesheet" href="./future-media.css" data-future-media>'
FUTURE_MEDIA_POLISH_STYLE_MARKER = '<link rel="stylesheet" href="./future-media-polish.css" data-future-media-polish>'
FUTURE_MEDIA_FINAL_STYLE_MARKER = '<link rel="stylesheet" href="./future-media-final.css" data-future-media-final>'
SURVIVAL_STYLE_MARKER = '<link rel="stylesheet" href="./survival-ledger.css" data-survival-ledger>'
SCRIPT_MARKER = '<script type="module" src="./studio.js" data-studio-product></script>'
WORKSPACE_SCRIPT_MARKER = '<script type="module" src="./workspace-ui.js" data-workspace-product></script>'
CORE_ACTIONS_SCRIPT_MARKER = '<script type="module" src="./core-actions.js" data-core-actions></script>'
CHROME_SCRIPT_MARKER = '<script type="module" src="./workspace-chrome.js" data-workspace-chrome></script>'
UNIVERSAL_MEDIA_SCRIPT_MARKER = '<script type="module" src="./universal-media.js" data-universal-media></script>'
MEDIA_MODES_SCRIPT_MARKER = '<script type="module" src="./media-modes.js" data-media-modes></script>'
VAULT_SCRIPT_MARKER = '<script type="module" src="./vault-ui.js" data-survival-ledger></script>'
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
CORE_DB_VERSION = "const DB_VERSION=1;\n"
CORE_DB_OPEN = "indexedDB.open(DB_NAME,DB_VERSION)"
CORE_DB_OPEN_CURRENT = "indexedDB.open(DB_NAME)"
CORE_DB_SUCCESS = "request.onsuccess=()=>resolve(request.result)"
CORE_DB_SUCCESS_CURRENT = "request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>db.close();resolve(db)}"

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


def release_core_schema_ownership(text: str) -> str:
    text = text.replace(CORE_DB_VERSION, "", 1)
    if CORE_DB_OPEN in text:
        text = text.replace(CORE_DB_OPEN, CORE_DB_OPEN_CURRENT, 1)
    elif CORE_DB_OPEN_CURRENT not in text:
        raise RuntimeError("cannot release core corpus schema version ownership")
    if CORE_DB_SUCCESS in text:
        text = text.replace(CORE_DB_SUCCESS, CORE_DB_SUCCESS_CURRENT, 1)
    elif CORE_DB_SUCCESS_CURRENT not in text:
        raise RuntimeError("cannot install core version-change close behavior")
    return text


def remove_retired_social(text: str) -> str:
    for marker in OLD_SOCIAL_MARKERS:
        text = text.replace(f"  {marker}\n", "").replace(marker, "")
    return text


def main() -> None:
    if not MANUAL.exists():
        raise SystemExit("manual-app is missing; assemble the canonical overlays first")

    shared_target = MANUAL / "shared"
    shared_target.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SHARED / "corpus-db.js", shared_target / "corpus-db.js")

    for name in (
        "studio.css",
        "studio-components.css",
        "studio-reset.css",
        "workspace.css",
        "card-layout.css",
        "workspace-chrome.css",
        "workspace-chrome-polish.css",
        "future-media.css",
        "future-media-polish.css",
        "future-media-final.css",
        "survival-ledger.css",
        "studio.js",
        "copy.js",
        "actions.js",
        "workspace-db.js",
        "workspace-profile.js",
        "workspace-records.js",
        "workspace-migration.js",
        "survival-ledger.js",
        "workspace.js",
        "workspace-ui.js",
        "core-actions.js",
        "workspace-chrome.js",
        "universal-media.js",
        "media-modes.js",
        "vault-ui.js",
        "system-icons.svg",
    ):
        shutil.copyfile(PRODUCT / name, MANUAL / name)

    workspace_db = MANUAL / "workspace-db.js"
    workspace_db.write_text(
        workspace_db.read_text(encoding="utf-8").replace("../shared/corpus-db.js", "./shared/corpus-db.js"),
        encoding="utf-8",
    )

    for retired in ("social.js", "social.css", "workspace-sync.js"):
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
    text = inject_once(text, CHROME_POLISH_STYLE_MARKER, "</head>")
    text = inject_once(text, FUTURE_MEDIA_STYLE_MARKER, "</head>")
    text = inject_once(text, FUTURE_MEDIA_POLISH_STYLE_MARKER, "</head>")
    text = inject_once(text, FUTURE_MEDIA_FINAL_STYLE_MARKER, "</head>")
    text = inject_once(text, SURVIVAL_STYLE_MARKER, "</head>")
    text = inject_once(text, SCRIPT_MARKER, "</body>")
    text = inject_once(text, WORKSPACE_SCRIPT_MARKER, "</body>")
    text = inject_once(text, CORE_ACTIONS_SCRIPT_MARKER, "</body>")
    text = inject_once(text, CHROME_SCRIPT_MARKER, "</body>")
    text = inject_once(text, UNIVERSAL_MEDIA_SCRIPT_MARKER, "</body>")
    text = inject_once(text, MEDIA_MODES_SCRIPT_MARKER, "</body>")
    text = inject_once(text, VAULT_SCRIPT_MARKER, "</body>")
    index.write_text(text, encoding="utf-8")

    app = MANUAL / "app.js"
    app_text = release_core_schema_ownership(app.read_text(encoding="utf-8"))
    app.write_text(inject_core_refresh(app_text), encoding="utf-8")

    if IMPORT_INSTALLER.is_file():
        runpy.run_path(str(IMPORT_INSTALLER), run_name="__main__")

    print("applied one-owner corpus schema, atomic ledger, off-thread hashing, viewport hydration, OPFS mirror, Ark recovery, universal media surfaces, and Flow Stage Grid physics")


if __name__ == "__main__":
    main()
