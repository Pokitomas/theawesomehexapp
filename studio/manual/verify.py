from __future__ import annotations

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
PRODUCT = HERE / "product"
MANUAL = ROOT / "manual-app"
WORKSPACE = PRODUCT / "workspace.js"

PRODUCT_FILES = [
    PRODUCT / name
    for name in (
        "copy.js",
        "icons.js",
        "actions.js",
        "shell.js",
        "studio.js",
        "studio.css",
        "studio-components.css",
        "studio-reset.css",
        "social.js",
        "social.css",
        "interaction.css",
        "import-studio.js",
        "import-studio.css",
        "import-phone.js",
    )
]
TEXT_FILES = PRODUCT_FILES + [
    HERE / "imports" / "registry.js",
    HERE / "imports" / "runtime.js",
    HERE / "imports" / "apply.py",
    HERE / "imports" / "verify.mjs",
    HERE / "prepare-kernel.py",
    HERE / "apply.py",
] + ([WORKSPACE] if WORKSPACE.is_file() else [])

JS_FILES = [
    PRODUCT / name
    for name in (
        "copy.js",
        "icons.js",
        "actions.js",
        "shell.js",
        "studio.js",
        "social.js",
        "import-studio.js",
        "import-phone.js",
    )
] + [
    HERE / "imports" / "registry.js",
    HERE / "imports" / "runtime.js",
    HERE / "imports" / "verify.mjs",
] + ([WORKSPACE] if WORKSPACE.is_file() else [])

BANNED_EDITORIAL = (
    "YOUR STUFF. ONE FEED.",
    "BRING YOUR INTERNET",
    "YOUR STUFF, RECOMPOSED",
    "YOUR INTERNET, YOUR WAY",
    "BRING SOMETHING OVER",
    "FROM YOUR STUFF",
    "YOUR FEED IS READY",
    "GOOD START",
)

BANNED_ACTIONS = (
    "nav.import",
    "nav.saved",
    "nav.profile",
    "feed.post",
    "feed.import",
    "post.react",
    "post.save",
    "post.mood",
)

REQUIRED_ACTIONS = (
    "nav.feed", "nav.places", "nav.create", "nav.me",
    "create.post", "create.import", "create.place", "create.close",
    "profile.open", "profile.save", "profile.random", "profile.close", "profile.avatar", "profile.color",
    "post.open", "post.publish", "post.update", "post.cancel", "post.attach", "post.link", "post.style", "post.place",
    "post.edit", "post.remix", "post.move", "post.later", "post.share", "post.archive", "post.restore", "post.delete", "post.more",
    "draft.resume", "draft.discard", "draft.autosave",
    "place.open", "place.create", "place.rename", "place.delete", "place.reorder", "undo.last",
    "import.instagram", "import.reddit", "import.tiktok", "import.youtube", "import.spotify", "import.x",
    "import.browser", "import.anything", "import.help", "import.stop", "import.retry", "import.open_feed",
)


def read(path: Path) -> str:
    raw = path.read_bytes()
    text = raw.decode("utf-8")
    if b"\x00" in raw:
        raise AssertionError(f"{path} contains NUL bytes")
    if any(byte < 32 and byte not in (9, 10, 13) for byte in raw):
        raise AssertionError(f"{path} contains binary control bytes")
    return text


def node_check(path: Path) -> None:
    subprocess.run(["node", "--check", str(path)], check=True)


def require(source: str, values: tuple[str, ...], label: str) -> None:
    missing = [value for value in values if value not in source]
    if missing:
        raise AssertionError(f"{label} missing: {', '.join(missing)}")


def forbid(source: str, values: tuple[str, ...], label: str) -> None:
    found = [value for value in values if value in source]
    if found:
        raise AssertionError(f"{label} returned: {', '.join(found)}")


def main() -> None:
    source = {path: read(path) for path in TEXT_FILES}
    for path in JS_FILES:
        node_check(path)

    product_text = "\n".join(source[path] for path in PRODUCT_FILES + ([WORKSPACE] if WORKSPACE.is_file() else []))
    forbid(product_text.upper(), tuple(value.upper() for value in BANNED_EDITORIAL), "editorial copy")
    forbid(product_text, ("new MutationObserver", "location.reload()", "stopImmediatePropagation"), "interaction regression")

    kernel = source[HERE / "prepare-kernel.py"]
    require(kernel, ("\\s*=.*$", "state.records.length&&!els.feedView.hidden", "refusing a blind compatibility patch"), "kernel preparation")

    installer = source[HERE / "apply.py"]
    require(
        installer,
        (
            "CORE_REFRESH_BRIDGE",
            "await rebuildState()",
            '"icons.js"',
            '"actions.js"',
            '"shell.js"',
            '"social.js"',
            '"interaction.css"',
            "WORKSPACE_SCRIPT_MARKER",
            "SHELL_SCRIPT_MARKER",
            "INTERACTION_STYLE_MARKER",
        ),
        "product installer",
    )

    actions = source[PRODUCT / "actions.js"]
    for action_id in REQUIRED_ACTIONS:
        if actions.count(f"'{action_id}'") < 2:
            raise AssertionError(f"action contract incomplete: {action_id}")
    forbid(actions, tuple(f"'{action_id}'" for action_id in BANNED_ACTIONS), "deleted action")
    require(
        actions,
        ("command:", "payload:", "result:", "optimistic:", "undoable:", "destructive:", "dataset.actionCommand", "dataset.actionOptimistic", "dataset.actionUndoable", "actionContract"),
        "backend action schema",
    )

    icons = source[PRODUCT / "icons.js"]
    require(icons, ("feed:", "places:", "create:", "me:", "later:", "archive:", "export function icon"), "icon set")

    shell = source[PRODUCT / "shell.js"]
    require(
        shell,
        (
            "#/feed", "#/places", "#/me",
            "nav.feed", "nav.places", "nav.create", "nav.me",
            "os-dock", "os-titlebar", "os-create-sheet",
            "osPlacesView", "osMeView", "renderPlaces", "renderMe", "SidewaysWorkspace",
        ),
        "operating-system shell",
    )
    forbid(shell, ("nav.saved", "nav.import", "post.react"), "obsolete shell topology")

    studio = source[PRODUCT / "studio.js"]
    require(studio, ("create.post", "create.import", "nav.places", "studio-launch-actions", "requestAnimationFrame"), "feed launch surface")
    forbid(studio, ("shouldAutoOpenApps", "studio-profile-setup", "storageCard(", "navigator.storage", "nav.saved", "feed.import"), "deleted first-run model")

    social = source[PRODUCT / "social.js"]
    require(
        social,
        (
            "DRAFT_STORE", "saveDraft", "publishDraft", "listDrafts",
            "setActivePlace", "listPlaces", "updateEntity", "moveEntity",
            "archiveEntity", "restoreEntity", "deleteEntity", "undoLast",
            "post.update", "post.move", "post.later", "post.archive", "post.restore", "undo.last",
            "social-draft-status", "sideways:workspacechange", "sideways:placeopen",
        ),
        "workspace-aware social model",
    )
    forbid(social, ("post.react", "post.save", "REACTIONS"), "fake single-user social feature")

    import_js = source[PRODUCT / "import-studio.js"]
    require(import_js, ("const id = `import.${platform.id}`", "runtime.import(chosen)", "waitForCoreRefresh", "host.replaceChildren(statusPanel() || importCard())"), "one-tap importer")
    forbid(import_js, ("I HAVE THE FILES", "ADD TO MY FEED", "import-file-list", "import-queue-panel", "PICK FOLDER"), "legacy import workbench")

    studio_css = source[PRODUCT / "studio.css"]
    require(
        studio_css,
        (
            "--os-accent", "--os-window", "body > .topbar", ".os-dock", ".os-sheet", ".os-create-grid",
            ".os-places-grid", ".os-me-hero", "backdrop-filter", "prefers-reduced-motion", "prefers-color-scheme: dark",
            "cubic-bezier(.2,.9,.22,1.08)",
        ),
        "paint and physics",
    )
    forbid(studio_css, ("--studio-paper", "--studio-ink", "--studio-shadow", "background-size: 28px 28px", "5px 5px 0", "8px 8px 0"), "killed neo-brutalist system")

    require(source[PRODUCT / "studio-components.css"], (".studio-launch-actions", ".studio-launch-button", ".studio-progress-actions", "var(--os-line)"), "launch styling")
    require(source[PRODUCT / "social.css"], (".social-post-card", ".social-dialog", ".social-place-picker", ".social-draft-status", "var(--os-line)"), "social styling")
    require(source[PRODUCT / "interaction.css"], (".os-menu-list", ".os-toast", ".os-menu-item", ".social-post-link"), "interaction styling")
    require(source[PRODUCT / "import-studio.css"], (".source-card-grid", ".source-import", ".import-complete-panel", "var(--os-line)", "os-import-pulse"), "Open-style importer")

    if WORKSPACE.is_file():
        workspace = source[WORKSPACE]
        require(
            workspace,
            (
                "createWorkspaceBackend", "listPlaces", "createPlace", "renamePlace", "deletePlace",
                "listEntities", "getEntity", "updateEntity", "moveEntity", "saveDraft", "listDrafts", "deleteDraft",
                "publishDraft", "archiveEntity", "restoreEntity", "deleteEntity", "undo", "exportSnapshot", "importSnapshot",
            ),
            "workspace backend",
        )

    if not MANUAL.exists():
        print("OS product source verified")
        return

    generated_assets = [
        "studio.css", "studio-components.css", "studio-reset.css", "social.css", "interaction.css",
        "icons.js", "actions.js", "shell.js", "studio.js", "copy.js", "social.js",
        "import-studio.css", "import-studio.js", "import-phone.js",
        "imports/registry.js", "imports/runtime.js",
    ] + (["workspace.js"] if WORKSPACE.is_file() else [])

    generated_js = [
        "app.js", "profile.js", "kernel.js", "icons.js", "actions.js", "shell.js", "studio.js", "copy.js", "social.js",
        "import-studio.js", "import-phone.js", "imports/registry.js", "imports/runtime.js",
    ] + (["workspace.js"] if WORKSPACE.is_file() else [])
    for name in generated_js:
        node_check(MANUAL / name)

    app = read(MANUAL / "app.js")
    if app.count("'sideways:corpusrefresh'") != 1 or "await rebuildState()" not in app:
        raise AssertionError("core refresh bridge must exist exactly once")

    index = read(MANUAL / "index.html")
    for hook in ("corpusStatus", "debugPolicy", "debugState", "debugPanel"):
        if f'id="{hook}"' not in index:
            raise AssertionError(f"stable DOM hook missing: {hook}")
    for label in ("ADD", "KEEP", "READ", "SEND", "FILES +"):
        if label not in index + app:
            raise AssertionError(f"stable compatibility label missing: {label}")
    for asset in generated_assets:
        if not (MANUAL / asset).is_file():
            raise AssertionError(f"generated asset missing: {asset}")

    exact_markers = {
        "data-studio-product": 3,
        "data-studio-reset": 1,
        "data-social-product": 2,
        "data-interaction-product": 1,
        "data-shell-product": 1,
        "data-import-workbench": 2,
        "data-import-phone": 1,
    }
    if WORKSPACE.is_file():
        exact_markers["data-workspace-product"] = 1
    for marker, expected in exact_markers.items():
        actual = index.count(marker)
        if actual != expected:
            raise AssertionError(f"{marker} expected {expected}, got {actual}")

    generated_text = "\n".join(read(MANUAL / asset) for asset in generated_assets if Path(asset).suffix in {".js", ".css"})
    forbid(generated_text.upper(), tuple(value.upper() for value in BANNED_EDITORIAL), "generated editorial copy")

    subprocess.run(["node", str(HERE / "imports" / "verify.mjs")], check=True)
    print("operating-system shell, workspace model, interaction physics, importer, and kernel verified")


if __name__ == "__main__":
    main()
