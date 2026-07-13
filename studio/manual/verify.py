from __future__ import annotations

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
PRODUCT = HERE / "product"
MANUAL = ROOT / "manual-app"

TEXT_FILES = [
    PRODUCT / "copy.js",
    PRODUCT / "actions.js",
    PRODUCT / "studio.js",
    PRODUCT / "studio.css",
    PRODUCT / "studio-components.css",
    PRODUCT / "studio-reset.css",
    PRODUCT / "workspace-db.js",
    PRODUCT / "workspace-profile.js",
    PRODUCT / "workspace-records.js",
    PRODUCT / "workspace-sync.js",
    PRODUCT / "workspace-migration.js",
    PRODUCT / "workspace.js",
    PRODUCT / "workspace-ui.js",
    PRODUCT / "core-actions.js",
    PRODUCT / "workspace.css",
    PRODUCT / "system-icons.svg",
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

JS_FILES = [
    PRODUCT / "copy.js",
    PRODUCT / "actions.js",
    PRODUCT / "studio.js",
    PRODUCT / "workspace-db.js",
    PRODUCT / "workspace-profile.js",
    PRODUCT / "workspace-records.js",
    PRODUCT / "workspace-sync.js",
    PRODUCT / "workspace-migration.js",
    PRODUCT / "workspace.js",
    PRODUCT / "workspace-ui.js",
    PRODUCT / "core-actions.js",
    PRODUCT / "import-studio.js",
    PRODUCT / "import-phone.js",
    HERE / "imports" / "registry.js",
    HERE / "imports" / "runtime.js",
    HERE / "imports" / "verify.mjs",
]

BANNED_PRODUCT = (
    "YOUR STUFF. ONE FEED.",
    "BRING YOUR INTERNET",
    "YOUR STUFF, RECOMPOSED",
    "YOUR INTERNET, YOUR WAY",
    "BRING SOMETHING OVER",
    "FROM YOUR STUFF",
    "GOOD START.",
    "YOUR FEED IS READY.",
    "post.mood",
    "post.style",
    "post.react",
    "post.remix",
    "profile.random",
    "profile.avatar",
    "social-post-card",
    "social-option-grid",
    "studio-lime",
    "studio-orange",
)

REQUIRED_ACTIONS = (
    "nav.feed", "nav.places", "nav.library", "nav.import", "nav.saved", "nav.profile",
    "feed.post", "feed.import", "profile.open", "profile.save", "profile.close", "profile.accent",
    "post.open", "post.publish", "post.cancel", "post.attach", "post.remove_attachment",
    "post.edit", "post.delete", "post.save", "post.share",
    "record.source", "record.author", "record.open", "record.save", "record.collect", "record.share",
    "composer.place", "composer.clear_place",
    "places.open", "places.create", "places.save", "places.use", "places.locate", "places.delete", "places.close",
    "library.saved", "import.instagram", "import.reddit", "import.tiktok", "import.youtube", "import.spotify",
    "import.x", "import.browser", "import.anything", "import.help", "import.stop", "import.retry", "import.open_feed",
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
    if (PRODUCT / "social.js").exists() or (PRODUCT / "social.css").exists():
        raise AssertionError("retired social subsystem files still exist")

    source_text = {path: assert_clean_text(path) for path in TEXT_FILES}
    for path in JS_FILES:
        node_check(path)

    all_product = "\n".join(source_text[path] for path in TEXT_FILES if PRODUCT in path.parents)
    forbid(all_product, BANNED_PRODUCT, "retired visual or posting system")

    kernel_prepare = source_text[HERE / "prepare-kernel.py"]
    require(kernel_prepare, ("\\s*=.*$", "state.records.length&&!els.feedView.hidden", "refusing a blind compatibility patch"), "kernel compatibility contract")

    apply_source = source_text[HERE / "apply.py"]
    require(
        apply_source,
        (
            "CORE_REFRESH_BRIDGE", "sideways:importcomplete", "sideways:corpusrefresh", "await rebuildState()",
            '"workspace-db.js"', '"workspace-profile.js"', '"workspace-records.js"', '"workspace-sync.js"',
            '"workspace-migration.js"', '"workspace.js"', '"workspace-ui.js"', '"core-actions.js"', '"workspace.css"',
            '"system-icons.svg"', "data-workspace-product",
            "remove_retired_social",
        ),
        "generated workspace installer",
    )

    actions_source = source_text[PRODUCT / "actions.js"]
    for action_id in REQUIRED_ACTIONS:
        if actions_source.count(f"'{action_id}'") < 2:
            raise AssertionError(f"action contract is incomplete: {action_id}")
    require(actions_source, ("emitAction", "bindAction", "actionButton", "actionContract", "sideways:action", "actionLabel"), "action runtime")

    copy_source = source_text[PRODUCT / "copy.js"]
    require(copy_source, ("Make something, or bring something in.", "Your feed", "Places", "Your profile", "Choose where it came from"), "lived product copy")
    if len([line for line in copy_source.splitlines() if ": '" in line]) > 45:
        raise AssertionError("copy dictionary grew into an editorial layer")

    studio_source = source_text[PRODUCT / "studio.js"]
    require(
        studio_source,
        (
            "workspace-nav", "nav.places", "workspace-feed-header", "workspace-library-header",
            "studio-launch-button is-post", "studio-launch-button is-import", "requestAnimationFrame",
            "openComposer", "system-icons.svg",
        ),
        "workspace shell",
    )
    forbid(studio_source, ("new MutationObserver", "location.reload()", "shouldAutoOpenApps"), "shell regression")

    workspace_modules = (
        "workspace-db.js", "workspace-profile.js", "workspace-records.js",
        "workspace-sync.js", "workspace-migration.js", "workspace.js",
    )
    workspace_source = "\n".join(source_text[PRODUCT / name] for name in workspace_modules)
    require(
        workspace_source,
        (
            "sideways-manual-corpus-v1", "sideways-workspace-v1", "createObjectStore(DRAFT_STORE",
            "createObjectStore(PLACE_STORE", "createObjectStore(EVENT_STORE", "publishEntry", "updateEntry",
            "deleteEntry", "insertRecord", "sideways:importcomplete", "saveDraft", "listPlaces", "recordsByPlace",
            "configureSync", "flushOutbox", "migrateLegacySocial", "sideways:legacy:", "sideways:workspace:",
        ),
        "workspace data service",
    )
    forbid(workspace_source, ("credentials", "Authorization", "localStorage.setItem('token", "new MutationObserver"), "workspace service safety")

    ui_source = source_text[PRODUCT / "workspace-ui.js"]
    require(
        ui_source,
        (
            "workspaceComposer", "workspacePlacesView", "openComposer", "openPlacePicker", "openPlaceEditor",
            "Workspace.publishEntry", "Workspace.updateEntry", "Workspace.deleteEntry", "Workspace.prepareImage",
            "navigator.geolocation", "data-workspace-post-controls", "sideways:workspacechange",
        ),
        "workspace UI",
    )
    forbid(ui_source, ("REACTIONS", "MOODS", "STYLES", "REMIX", "new MutationObserver", "location.reload()"), "retired social UI")

    core_actions_source = source_text[PRODUCT / "core-actions.js"]
    require(
        core_actions_source,
        ("record.source", "record.author", "record.open", "record.save", "record.collect", "record.share", "bindAction", "sideways:feedrender"),
        "core action adapter",
    )
    forbid(core_actions_source, ("new MutationObserver", "location.reload()", "stopImmediatePropagation"), "core action adapter regression")

    component_css = source_text[PRODUCT / "studio-components.css"]
    require(component_css, (".studio-launch-actions", ".studio-launch-button", ".workspace-feed-header", ".workspace-route-view"), "workspace component styling")

    workspace_css = source_text[PRODUCT / "workspace.css"]
    require(workspace_css, (".workspace-window", ".workspace-composer-text", ".workspace-place-grid", ".workspace-owned-actions"), "workspace window styling")

    studio_css = source_text[PRODUCT / "studio.css"]
    require(studio_css, ("backdrop-filter", "--workspace-accent", ".workspace-nav", "1px solid", ".workspace-new-button"), "lived visual system")
    forbid(studio_css, ("5px 5px 0", "8px 8px 0", "font-weight: 950", "rotate(-"), "retired acid-paper styling")

    icon_source = source_text[PRODUCT / "system-icons.svg"]
    for icon_id in ("feed", "library", "pin", "user", "compose", "image", "trash", "share", "bookmark", "location", "window"):
        require(icon_source, (f'id="{icon_id}"',), "system icon sprite")

    import_source = source_text[PRODUCT / "import-studio.js"]
    require(import_source, ("actionButton", "bindAction", "const id = `import.${platform.id}`", "runtime.import(chosen)", "waitForCoreRefresh"), "one-tap import action surface")
    forbid(import_source, ("location.reload()", "I HAVE THE FILES", "ADD TO MY FEED", "PICK FOLDER"), "legacy import workbench")

    import_css = source_text[PRODUCT / "import-studio.css"]
    require(import_css, (".source-card-grid", ".source-card", ".source-import", "--workspace-accent"), "library styling")
    forbid(import_css, ("5px 5px 0", "7px 7px 0", "font-weight: 950"), "acid importer styling")

    for relative in (
        "studio.js", "workspace-db.js", "workspace-profile.js", "workspace-records.js",
        "workspace-sync.js", "workspace-migration.js", "workspace.js", "workspace-ui.js",
        "import-studio.js", "import-phone.js",
    ):
        if "new MutationObserver" in source_text[PRODUCT / relative]:
            raise AssertionError(f"{relative} reintroduced a whole-document mutation observer")

    phone_source = source_text[PRODUCT / "import-phone.js"]
    require(phone_source, ("sidewaysImportFiles", "input.multiple = true", "removeAttribute('webkitdirectory')"), "native phone importer")
    forbid(phone_source, ("stopImmediatePropagation", "cloneNode", "PICK MORE FILES"), "patched phone control")

    if not MANUAL.exists():
        print("manual lived workspace, canonical posting, places, and importer source are clean")
        return

    generated_js = (
        "app.js", "profile.js", "kernel.js", "studio.js", "copy.js", "actions.js",
        "workspace-db.js", "workspace-profile.js", "workspace-records.js", "workspace-sync.js",
        "workspace-migration.js", "workspace.js", "workspace-ui.js", "core-actions.js", "import-studio.js",
        "import-phone.js", "imports/registry.js", "imports/runtime.js",
    )
    for name in generated_js:
        path = MANUAL / name
        assert_clean_text(path)
        node_check(path)

    app_text = assert_clean_text(MANUAL / "app.js")
    if app_text.count("'sideways:corpusrefresh'") != 1:
        raise AssertionError("generated core must contain exactly one corpus refresh bridge")
    if "await rebuildState()" not in app_text:
        raise AssertionError("generated core refresh bridge must rebuild the live corpus")

    index = assert_clean_text(MANUAL / "index.html")
    for hook in ("corpusStatus", "debugPolicy", "debugState", "debugPanel"):
        if f'id="{hook}"' not in index:
            raise AssertionError(f"stable DOM hook missing: {hook}")
    corpus = index + app_text
    for label in ("ADD", "KEEP", "READ", "SEND", "FILES +"):
        if label not in corpus:
            raise AssertionError(f"stable phone-test label missing: {label}")

    assets = (
        "studio.css", "studio-components.css", "studio-reset.css", "workspace.css", "studio.js", "copy.js",
        "actions.js", "workspace-db.js", "workspace-profile.js", "workspace-records.js", "workspace-sync.js",
        "workspace-migration.js", "workspace.js", "workspace-ui.js", "core-actions.js", "system-icons.svg", "import-studio.css", "import-studio.js",
        "import-phone.js", "imports/registry.js", "imports/runtime.js",
    )
    for asset in assets:
        if not (MANUAL / asset).is_file():
            raise AssertionError(f"product asset not applied: {asset}")
    for retired in ("social.js", "social.css"):
        if (MANUAL / retired).exists():
            raise AssertionError(f"retired generated asset remains: {retired}")

    if index.count("data-studio-product") != 3:
        raise AssertionError("studio layer must inject exactly two styles and one script")
    if index.count("data-studio-reset") != 1:
        raise AssertionError("product reset must inject exactly one stylesheet")
    if index.count("data-workspace-product") != 2:
        raise AssertionError("workspace layer must inject exactly one style and one script")
    if index.count("data-core-actions") != 1:
        raise AssertionError("core action adapter must inject exactly one script")
    if "data-social-product" in index:
        raise AssertionError("retired social layer remains in generated index")
    if index.count("data-import-workbench") != 2:
        raise AssertionError("import workbench must inject exactly one style and one script")
    if index.count("data-import-phone") != 1:
        raise AssertionError("phone importer fallback must inject exactly one script")

    generated_product = "\n".join(assert_clean_text(MANUAL / asset) for asset in assets if (MANUAL / asset).suffix in {".js", ".css", ".svg"})
    forbid(generated_product, BANNED_PRODUCT, "generated retired product")

    subprocess.run(["node", str(HERE / "imports" / "verify.mjs")], check=True)
    print("manual lived workspace, canonical posting, places, and importer contracts verified")


if __name__ == "__main__":
    main()
