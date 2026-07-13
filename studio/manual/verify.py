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

JS_FILES = [
    PRODUCT / "copy.js",
    PRODUCT / "actions.js",
    PRODUCT / "studio.js",
    PRODUCT / "social.js",
    PRODUCT / "import-studio.js",
    PRODUCT / "import-phone.js",
    HERE / "imports" / "registry.js",
    HERE / "imports" / "runtime.js",
    HERE / "imports" / "verify.mjs",
]

BANNED_EDITORIAL = (
    "YOUR STUFF. ONE FEED.",
    "BRING YOUR INTERNET",
    "YOUR STUFF, RECOMPOSED",
    "YOUR INTERNET, YOUR WAY",
    "BRING SOMETHING OVER",
    "FROM YOUR STUFF",
    "GOOD START.",
    "YOUR FEED IS READY.",
)

REQUIRED_ACTIONS = (
    "nav.feed", "nav.import", "nav.saved", "nav.profile", "feed.post", "feed.import",
    "profile.open", "profile.save", "profile.random", "profile.close", "profile.avatar", "profile.color",
    "post.open", "post.publish", "post.cancel", "post.attach", "post.mood", "post.style",
    "post.react", "post.remix", "post.save", "post.share", "post.delete",
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
            '"actions.js"', '"social.js"', '"social.css"', "data-social-product",
        ),
        "generated product installer",
    )

    actions_source = source_text[PRODUCT / "actions.js"]
    for action_id in REQUIRED_ACTIONS:
        if actions_source.count(f"'{action_id}'") < 2:
            raise AssertionError(f"action contract is incomplete: {action_id}")
    require(actions_source, ("emitAction", "bindAction", "actionButton", "actionContract", "sideways:action"), "action runtime")

    studio_source = source_text[PRODUCT / "studio.js"]
    require(
        studio_source,
        ("actionButton", "bindAction", "feed.post", "feed.import", "openPost", "openProfile", "studio-launch-actions", "requestAnimationFrame"),
        "studio action surface",
    )
    forbid(studio_source, ("shouldAutoOpenApps", "studio-profile-setup", "storageCard(", "navigator.storage", "new MutationObserver"), "deleted first-run machinery")

    copy_source = source_text[PRODUCT / "copy.js"]
    require(copy_source, ("START HERE.", "POST", "IMPORT", "OPEN FEED"), "minimal visible copy")
    if len([line for line in copy_source.splitlines() if ": '" in line]) > 20:
        raise AssertionError("copy dictionary grew back into an editorial layer")

    social_source = source_text[PRODUCT / "social.js"]
    require(
        social_source,
        (
            "sideways-social-v1", "sideways-social-profile-v1", "sideways-action-results-v1",
            "createObjectStore(POST_STORE", "createObjectStore(EVENT_STORE", "openProfile", "openComposer",
            "imageFileToDataURL", "post.publish", "post.react", "post.remix", "post.save", "post.share",
            "post.delete", "rankByResults", "dataset.socialStream", "sideways:action",
        ),
        "social product",
    )
    forbid(social_source, ("new MutationObserver", "location.reload()", "stopImmediatePropagation"), "social interaction regression")

    for relative in ("studio.js", "social.js", "import-studio.js", "import-phone.js"):
        source = source_text[PRODUCT / relative]
        if "new MutationObserver" in source:
            raise AssertionError(f"{relative} reintroduced a whole-document mutation observer")

    import_source = source_text[PRODUCT / "import-studio.js"]
    require(
        import_source,
        (
            "actionButton", "bindAction", "const id = `import.${platform.id}`", "runtime.import(chosen)",
            "waitForCoreRefresh", "sideways:corpusrefresh", "host.replaceChildren(statusPanel() || importCard())",
        ),
        "one-tap import action surface",
    )
    forbid(import_source, ("location.reload()", "I HAVE THE FILES", "ADD TO MY FEED", "import-file-list", "import-queue-panel", "PICK FOLDER"), "legacy import workbench")

    component_css = source_text[PRODUCT / "studio-components.css"]
    require(component_css, (".studio-launch-actions", ".studio-launch-button", ".studio-progress-actions"), "launch component styling")
    forbid(component_css, (".studio-profile-", ".studio-storage-", ".drop-zone", ".queue li", ".studio-format-grid"), "dead prototype component styling")

    social_css = source_text[PRODUCT / "social.css"]
    require(social_css, (".social-top-post", ".social-post-card", ".social-profile-dialog", ".social-composer-dialog", ".social-option-grid", ".social-post-actions"), "social product styling")

    phone_source = source_text[PRODUCT / "import-phone.js"]
    require(phone_source, ("sidewaysImportFiles", "input.multiple = true", "removeAttribute('webkitdirectory')"), "native phone importer")
    forbid(phone_source, ("stopImmediatePropagation", "cloneNode", "PICK MORE FILES"), "patched phone control")

    if not MANUAL.exists():
        print("manual studio, action contract, social product, and importer source are clean")
        return

    generated_js = (
        "app.js", "profile.js", "kernel.js", "studio.js", "copy.js", "actions.js", "social.js",
        "import-studio.js", "import-phone.js", "imports/registry.js", "imports/runtime.js",
    )
    for name in generated_js:
        path = MANUAL / name
        assert_clean_text(path)
        node_check(path)

    app_text = assert_clean_text(MANUAL / "app.js")
    if app_text.count("'sideways:corpusrefresh'") != 1:
        raise AssertionError("generated core must contain exactly one import refresh bridge")
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
        "studio.css", "studio-components.css", "studio-reset.css", "social.css", "studio.js", "copy.js",
        "actions.js", "social.js", "import-studio.css", "import-studio.js", "import-phone.js",
        "imports/registry.js", "imports/runtime.js",
    )
    for asset in assets:
        if not (MANUAL / asset).is_file():
            raise AssertionError(f"product asset not applied: {asset}")

    if index.count("data-studio-product") != 3:
        raise AssertionError("studio layer must inject exactly two styles and one script")
    if index.count("data-studio-reset") != 1:
        raise AssertionError("product reset must inject exactly one stylesheet")
    if index.count("data-social-product") != 2:
        raise AssertionError("social product must inject exactly one style and one script")
    if index.count("data-import-workbench") != 2:
        raise AssertionError("import workbench must inject exactly one style and one script")
    if index.count("data-import-phone") != 1:
        raise AssertionError("phone importer fallback must inject exactly one script")

    generated_product = "\n".join(assert_clean_text(MANUAL / asset) for asset in assets if (MANUAL / asset).suffix in {".js", ".css"})
    forbid(generated_product.upper(), tuple(value.upper() for value in BANNED_EDITORIAL), "generated editorial copy")

    subprocess.run(["node", str(HERE / "imports" / "verify.mjs")], check=True)
    print("manual action contract, social posting, consumer import, and kernel contracts verified")


if __name__ == "__main__":
    main()
