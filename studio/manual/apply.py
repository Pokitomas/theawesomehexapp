from __future__ import annotations

from pathlib import Path
import json
import os
import re
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
FUTURE_MEDIA_MOBILE_STYLE_MARKER = '<link rel="stylesheet" href="./future-media-mobile.css" data-future-media-mobile>'
FRONTIER_STYLE_MARKER = '<link rel="stylesheet" href="./frontier.css" data-frontier-product>'
REMOTE_STYLE_MARKER = '<link rel="stylesheet" href="./remote-terminal.css" data-remote-terminal>'
REMOTE_SERVICE_MARKER = '<link rel="service-desc" href="./.well-known/sideways-remote.json" type="application/json" data-sideways-remote>'
SCRIPT_MARKER = '<script type="module" src="./studio.js" data-studio-product></script>'
WORKSPACE_SCRIPT_MARKER = '<script type="module" src="./workspace-ui.js" data-workspace-product></script>'
CORE_ACTIONS_SCRIPT_MARKER = '<script type="module" src="./core-actions.js" data-core-actions></script>'
CHROME_SCRIPT_MARKER = '<script type="module" src="./workspace-chrome.js" data-workspace-chrome></script>'
UNIVERSAL_MEDIA_SCRIPT_MARKER = '<script type="module" src="./universal-media.js" data-universal-media></script>'
MEDIA_MODES_SCRIPT_MARKER = '<script type="module" src="./media-modes.js" data-media-modes></script>'
FRONTIER_SCRIPT_MARKER = '<script type="module" src="./frontier.js" data-frontier-product></script>'
REMOTE_SCRIPT_MARKER = '<script type="module" src="./remote-terminal.js" data-remote-terminal></script>'
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


def remote_snapshot() -> tuple[dict, dict]:
    state_path = ROOT / ".frankenstate"
    text = state_path.read_text(encoding="utf-8") if state_path.is_file() else ""
    field = lambda name, default="": (re.search(rf"(?m)^{re.escape(name)}:\s*(.+)$", text).group(1).strip() if re.search(rf"(?m)^{re.escape(name)}:\s*(.+)$", text) else default)
    summary_match = re.search(r"(?m)^\s+summary:\s*(.+)$", text)
    summary = summary_match.group(1).strip() if summary_match else "The repository is ready for its next exact-head work session."
    session = os.environ.get("REMOTE_PUBLIC_SESSION", "Pokitomas/theawesomehexapp:main")
    generation = int(os.environ.get("REMOTE_GENERATION", "1") or "1")
    head = os.environ.get("GITHUB_SHA") or field("merge_commit") or field("previous_product_merge")
    updated = field("updated_at") or os.environ.get("SOURCE_DATE_EPOCH") or ""
    message = {
        "id": f"build-{head[:12] or 'snapshot'}",
        "session": session,
        "generation": generation,
        "issuer": "repository",
        "parent": None,
        "issued_at": updated,
        "expires_at": None,
        "head_sha": head or None,
        "scope": ["repo:read"],
        "visibility": "public",
        "summary": summary,
        "payload": {"summary": summary, "source": "frankenstate"},
    }
    state = {
        "protocol_version": 1,
        "session": session,
        "generation": generation,
        "decision": "proceed",
        "head_sha": head or None,
        "claims": [],
        "blocker_count": 0,
        "terminal": False,
        "terminal_receipt": None,
        "summary": summary,
        "updated_at": updated or None,
        "updated_by": "repository",
        "messages": [message],
        "source": "snapshot",
    }
    manifest = {
        "protocol": "sideways-universal-remote/1",
        "session": session,
        "messages": "/api/remote?public=1",
        "state": "/api/remote/state?public=1",
        "snapshot": "./remote-snapshot.json",
        "terminal": "#live-work",
        "documentation": "/README_REMOTE.md",
    }
    return manifest, state


def write_remote_projection() -> None:
    manifest, state = remote_snapshot()
    well_known = MANUAL / ".well-known"
    well_known.mkdir(parents=True, exist_ok=True)
    (well_known / "sideways-remote.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (MANUAL / "remote-snapshot.json").write_text(json.dumps({"state": state}, indent=2) + "\n", encoding="utf-8")


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
        "future-media-mobile.css",
        "frontier.css",
        "remote-terminal.css",
        "studio.js",
        "copy.js",
        "actions.js",
        "workspace-db.js",
        "workspace-profile.js",
        "workspace-records.js",
        "workspace-migration.js",
        "workspace.js",
        "workspace-ui.js",
        "core-actions.js",
        "workspace-chrome.js",
        "universal-media.js",
        "media-modes.js",
        "frontier.js",
        "remote-terminal.js",
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
    text = inject_once(text, FUTURE_MEDIA_MOBILE_STYLE_MARKER, "</head>")
    text = inject_once(text, FRONTIER_STYLE_MARKER, "</head>")
    text = inject_once(text, REMOTE_STYLE_MARKER, "</head>")
    text = inject_once(text, REMOTE_SERVICE_MARKER, "</head>")
    text = inject_once(text, SCRIPT_MARKER, "</body>")
    text = inject_once(text, WORKSPACE_SCRIPT_MARKER, "</body>")
    text = inject_once(text, CORE_ACTIONS_SCRIPT_MARKER, "</body>")
    text = inject_once(text, CHROME_SCRIPT_MARKER, "</body>")
    text = inject_once(text, UNIVERSAL_MEDIA_SCRIPT_MARKER, "</body>")
    text = inject_once(text, MEDIA_MODES_SCRIPT_MARKER, "</body>")
    text = inject_once(text, FRONTIER_SCRIPT_MARKER, "</body>")
    text = inject_once(text, REMOTE_SCRIPT_MARKER, "</body>")
    index.write_text(text, encoding="utf-8")

    write_remote_projection()

    app = MANUAL / "app.js"
    app_text = release_core_schema_ownership(app.read_text(encoding="utf-8"))
    app.write_text(inject_core_refresh(app_text), encoding="utf-8")

    if IMPORT_INSTALLER.is_file():
        runpy.run_path(str(IMPORT_INSTALLER), run_name="__main__")

    print("applied one-owner corpus schema, durable ledger, off-thread hashing, viewport media hydration, the profile-first frontier surface, and the public live-work terminal")


if __name__ == "__main__":
    main()
