from __future__ import annotations

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
PRODUCT = HERE / "product"
MANUAL = ROOT / "manual-app"

BASE_TEXT_FILES = [
    PRODUCT / "copy.js",
    PRODUCT / "icons.js",
    PRODUCT / "actions.js",
    PRODUCT / "shell.js",
    PRODUCT / "studio.js",
    PRODUCT / "studio.css",
    PRODUCT / "studio-components.css",
    PRODUCT / "studio-reset.css",
    PRODUCT / "social.js",
    PRODUCT / "social.css",
    PRODUCT / "import-studio.js",
    PRODUCT / "import-studio.css",
    PRODUCT / "import-phone.js",
    HERE / "imports" / "registry.js",
    HERE / "imports" / "runtime.js",
    HERE / "imports" / "apply.py",
    HERE / "imports" / "verify.mjs",
    HERE / "prepare-kernel.py",
    HERE / "apply.py",
]
WORKSPACE_SOURCE = PRODUCT / "workspace.js"
TEXT_FILES = BASE_TEXT_FILES + ([WORKSPACE_SOURCE] if WORKSPACE_SOURCE.is_file() else [])

JS_FILES = [
    PRODUCT / "copy.js",
    PRODUCT / "icons.js",
    PRODUCT / "actions.js",
    PRODUCT / "shell.js",
    PRODUCT / "studio.js",
    PRODUCT / "social.js",
    PRODUCT / "import-studio.js",
    PRODUCT / "import-phone.js",
    HERE / "imports" / "registry.js",
    HERE / "imports" / "runtime.js",
    HERE / "imports" / "verify.mjs",
] + ([WORKSPACE_SOURCE] if WORKSPACE_SOURCE.is_file() else [])

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

BANNED_PRODUCT_ACTIONS = (
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


def assert_clean_text(path: Path) -> str:
    raw = path.read_bytes()
    text = raw.decode("utf-8")
    if b"\x00" in raw:
        raise AssertionError(f"{path} contains NUL bytes")
    bad = [byte for byte in raw if byte < 32 and byte not in (9, 10, 13)]
    if bad:
        raise AssertionError(f"{path} contains binary control bytes")
    return text


def node_check(path: Path) -> None:
    subprocess.run(["node", "--check", str(path)], check=True)


def require(source: str, values: tuple[str, ...], label: str) -> None:
    for value in values:
        if value not in source:
            raise AssertionError(f"{label} missing: {value}")


def forbid(source: str, values: tuple[str, ...], label: str) -> None:
    for value in values:
        if value in source:
            raise AssertionError(f"{label} returned: {value}")


def main() -> None:
    source_text = {path: assert_clean_text(path) for path in TEXT_FILES}
    for path in JS_FILES:
        node_check(path)

    all_product = "\n".join(source_text[path] for path in TEXT_FILES if PRODUCT in path.parents)
    forbid(all_product.upper(), tuple(value.upper() for value in BANNED_EDITORIAL), "editorial product copy")

    kernel_prepare = source_text[HERE / "prepare-kernel.py"]
    require(kernel_prepare, ("\\s*=.*$", "state.records.length&&!els.feedView.hidden", "refusing a blind compatibility patch"), "kernel compatibility contract")

    apply_source = source_text[HERE / "apply.py"]
    require(
        apply_source,
        (
            "CORE_REFRESH_BRIDGE", "sideways:importcomplete", "sideways:corpusrefresh", "await rebuildState()",
            '"icons.js"', '"actions.js"', '"shell.js"', '"social.js"', '"social.css"',
            "data-shell-product", "data-social-product", "WORKSPACE_SCRIPT_MARKER",
        ),
        "generated product installer",
    )

    icons_source = source_text[PRODUCT / "icons.js"]
    require(icons_source, ("feed:", "places:", "create:", "me:", "later:", "archive:", "export function icon"), "icon asset system")

    actions_source = source_text[PRODUCT / "actions.js"]
    for action_id in REQUIRED_ACTIONS:
        if actions_source.count(f"'{action_id}'") < 2:
            raise AssertionError(f"action contract is incomplete: {action_id}")
    forbid(actions_source, tuple(f"'{action_id}'" for action_id in BANNED_PRODUCT_ACTIONS), "deleted product action")
    require(
        actions_source,
        (
            "command:", "payload:", "result:", "optimistic:", "undoable:", "destructive:",
            "emitAction", "bindAction", "actionButton", "actionContract", "sideways:action",
        ),
        "formal action/backend contract",
    )

    shell_source = source_text[PRODUCT / "shell.js"]
    require(
        shell_source,
        (
            "#/feed", "#/places", "#/me", "nav.feed", "nav.places", "nav.create", "nav.me",
            "os-dock", "os-titlebar", "os-create-sheet", "osPlacesView", "osMeView",
            "showCreateSheet", "renderPlaces", "renderMe", "SidewaysWorkspace",
        ),
        "operating-system shell",
    )
    forbid(shell_source, ("nav.saved", "nav.import", "post.react"), "obsolete shell topology")

    studio_source = source_text[PRODUCT / "studio.js"]
    require(studio_source, ("create.post", "create.import", "nav.places", "studio-launch-actions", "requestAnimationFrame"), "feed launch surface")
    forbid(studio_source, ("shouldAutoOpenApps", "studio-profile-setup", "storageCard(", "navigator.storage", "new MutationObserver", "nav.saved", "feed.import"), "deleted first-run or navigation machinery")

    copy_source = source_text[PRODUCT / "copy.js"]
    require(copy_source, ("'Sideways'", "'Start'", "'Feed'", "'Import'"), "contemporary visible labels")
    if len([line for line in copy_source.splitlines() if ": '" in line]) > 16:
        raise AssertionError("copy dictionary grew back into an editorial layer")

    social_source = source_text[PRODUCT / "social.js"]
    require(
        social_source,
        (
            "sideways-social-v1", "sideways-social-profile-v1", "sideways-action-results-v1",
            "DRAFT_STORE", "saveDraft", "publishDraft", "listDrafts", "setActivePlace", "listPlaces",
            "updateEntity", "moveEntity", "archiveEntity", "restoreEntity", "deleteEntity", "undoLast",
            "post.update", "post.move", "post.later", "post.archive", "post.restore", "undo.last",
            "social-draft-status", "sideways:workspacechange", "sideways:placeopen",
        ),
        "workspace-aware social product",
    )
    forbid(social_source, ("post.react", "post.save", "REACTIONS", "saved: false", "new MutationObserver", "location.reload()", "stopImmediatePropagation"), "fake social or interaction regression")

    for relative in ("studio.js", "shell.js", "social.js", "import-studio.js", "import-phone.js"):
        source = source_text[PRODUCT / relative]
        if "new MutationObserver" in source:
            raise AssertionError(f"{relative} reintroduced a whole-document mutation observer")

    import_source = source_text[PRODUCT / "import-studio.js"]
    require(import_source, ("const id = `import.${platform.id}`", "runtime.import(chosen)", "waitForCoreRefresh", "sideways:corpusrefresh", "host.replaceChildren(statusPanel() || importCard())"), "one-tap import surface")
    forbid(import_source, ("location.reload()", "I HAVE THE FILES", "ADD TO MY FEED", "import-file-list", "import-queue-panel", "PICK FOLDER"), "legacy import workbench")

    studio_css = source_text[PRODUCT / "studio.css"]
    require(
        studio_css,
        (
            "--os-accent", "--os-window", ".os-titlebar", ".os-dock", ".os-sheet", ".os-create-grid",
            ".os-places-grid", ".os-me-hero", "backdrop-filter", "prefers-reduced-motion", "prefers-color-scheme: dark",
            "cubic-bezier(.2,.9,.22,1.08)",
        ),
        "paint and physics system",
    )
    forbid(
        studio_css,
        (
            "--studio-paper", "--studio-ink", "--studio-shadow", "background-size: 28px 28px",
            "5px 5px 0", "8px 8px 0", "border: 2px solid var(--studio",
        ),
        "killed neo-brutalist visual system",
    )

    component_css = source_text[PRODUCT / "studio-components.css"]
    require(component_css, (".studio-launch-actions", ".studio-launch-button", ".studio-progress-actions", "var(--os-line)"), "launch component styling")
    forbid(component_css, ("var(--studio-ink)", "var(--studio-lime)", "5px 5px 0", "8px 8px 0"), "old launch styling")

    social_css = source_text[PRODUCT / "social.css"]
    require(social_css, (".social-post-card", ".social-dialog", ".social-composer-text", ".social-place-picker", ".social-draft-status", "var(--os-line)"), "workspace social styling")
    forbid(social_css, ("var(--studio-ink)", "var(--studio-yellow)", "5px 5px 0", "border: 2px solid"), "old social styling")

    import_css = source_text[PRODUCT / "import-studio.css"]
    require(import_css, (".source-card-grid", ".source-import", ".import-complete-panel", "var(--os-line)", "os-import-pulse"), "Open-style importer visuals")
    forbid(import_css, ("var(--studio-ink", "var(--studio-surface", "5px 5px 0", "7px 7px 0", "border: 2px solid"), "old importer styling")

    phone_source = source_text[PRODUCT / "import-phone.js"]
    require(phone_source, ("sidewaysImportFiles", "input.multiple = true", "removeAttribute('webkitdirectory')"), "native phone importer")
    forbid(phone_source, ("stopImmediatePropagation", "cloneNode", "PICK MORE FILES"), "patched phone control")

    if WORKSPACE_SOURCE.is_file():
        workspace_source = source_text[WORKSPACE_SOURCE]
        require(
            workspace_source,
            (
                "createWorkspaceBackend", "listPlaces", "createPlace", "renamePlace", "deletePlace",
                "listEntities", "getEntity", "updateEntity", "moveEntity", "saveDraft", "listDrafts",
                "publishDraft", "archiveEntity", "restoreEntity", "deleteEntity", "undo", "exportSnapshot", "importSnapshot",
                "sideways:workspacechange",
            ),
            "workspace backend",
        )

    if not MANUAL.exists():
        print("operating-system product source, actions, social model, and importer are clean")
        return

    generated_js = [
        "app.js", "profile.js", "kernel.js", "icons.js", "actions.js", "shell.js", "studio.js", "copy.js", "social.js",
        "import-studio.js", "import-phone.js", "imports/registry.js", "imports/runtime.js",
    ] + (["workspace.js"] if WORKSPACE_SOURCE.is_file() else [])
    for name in generated_js:
        path = MANUAL / name
        assert_clean_text(path)
        node_check(path)

    app_text = assert_clean_text(MANUAL / "app.js")
    if app_text.count("'sideways:corpusrefresh'") != 1 or "await rebuildState()" not in app_text:
        raise AssertionError("generated core refresh bridge must exist exactly once and rebuild live corpus")

    index = assert_clean_text(MANUAL / "index.html")
    for hook in ("corpusStatus", "debugPolicy", "debugState", "debugPanel"):
        if f'id="{hook}"' not in index:
            raise AssertionError(f"stable DOM hook missing: {hook}")
    corpus = index + app_text
    for label in ("ADD", "KEEP", "READ", "SEND", "FILES +"):
        if label not in corpus:
            raise AssertionError(f"stable phone-test label missing: {label}")

    assets = [
        "studio.css", "studio-components.css", "studio-reset.css", "social.css", "icons.js", "actions.js", "shell.js",
        "studio.js", "copy.js", "social.js", "import-studio.css", "import-studio.js", "import-phone.js",
        "imports/registry.js", "imports/runtime.js",
    ] + (["workspace.js"] if WORKSPACE_SOURCE.is_file() else [])
    for asset in assets:
        if not (MANUAL / asset).is_file():
            raise AssertionError(f"product asset not applied: {asset}")

    if index.count("data-studio-product") != 3:
        raise AssertionError("studio layer must inject exactly two styles and one script")
    if index.count("data-studio-reset") != 1:
        raise AssertionError("product reset must inject exactly one stylesheet")
    if index.count("data-social-product") != 2:
        raise AssertionError("social product must inject exactly one style and one script")
    if index.count("data-shell-product") != 1:
        raise AssertionError("operating-system shell must inject exactly one script")
    if WORKSPACE_SOURCE.is_file() and index.count("data-workspace-product") != 1:
        raise AssertionError("workspace backend must inject exactly one script")
    if index.count("data-import-workbench") != 2 or index.count("data-import-phone") != 1:
        raise AssertionError("import workbench assets are not injected exactly once")

    generated_product = "\n".join(assert_clean_text(MANUAL / asset) for asset in assets if (MANUAL / asset).suffix in {".js", ".css"})
    forbid(generated_product.upper(), tuple(value.upper() for value in BANNED_EDITORIAL), "generated editorial copy")

    subprocess.run(["node", str(HERE / "imports" / "verify.mjs")], check=True)
    print("operating-system shell, workspace actions, drafts, places, importer, and kernel contracts verified")


if __name__ == "__main__":
    main()
