from __future__ import annotations

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
MANUAL = ROOT / "manual-app"

TEXT_FILES = [
    HERE / "product" / "copy.js",
    HERE / "product" / "studio.js",
    HERE / "product" / "studio.css",
    HERE / "product" / "studio-components.css",
    HERE / "product" / "studio-reset.css",
    HERE / "product" / "import-studio.js",
    HERE / "product" / "import-studio.css",
    HERE / "product" / "import-phone.js",
    HERE / "imports" / "registry.js",
    HERE / "imports" / "runtime.js",
    HERE / "imports" / "apply.py",
    HERE / "imports" / "verify.mjs",
    HERE / "prepare-kernel.py",
    HERE / "apply.py",
]


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


def main() -> None:
    for path in TEXT_FILES:
        assert_clean_text(path)

    for path in (
        HERE / "product" / "copy.js",
        HERE / "product" / "studio.js",
        HERE / "product" / "import-studio.js",
        HERE / "product" / "import-phone.js",
        HERE / "imports" / "registry.js",
        HERE / "imports" / "runtime.js",
        HERE / "imports" / "verify.mjs",
    ):
        node_check(path)

    kernel_prepare = assert_clean_text(HERE / "prepare-kernel.py")
    for contract in (
        "\\s*=.*$",
        "state.records.length&&!els.feedView.hidden",
        "refusing a blind compatibility patch",
    ):
        if contract not in kernel_prepare:
            raise AssertionError(f"kernel compatibility contract missing: {contract}")

    apply_source = assert_clean_text(HERE / "apply.py")
    for contract in (
        "CORE_REFRESH_BRIDGE",
        "sideways:importcomplete",
        "sideways:corpusrefresh",
        "await rebuildState()",
    ):
        if contract not in apply_source:
            raise AssertionError(f"core refresh bridge contract missing: {contract}")

    studio_source = assert_clean_text(HERE / "product" / "studio.js")
    for contract in ("requestAnimationFrame", "setText", "shouldAutoOpenApps", "routeTo('#/add')"):
        if contract not in studio_source:
            raise AssertionError(f"consumer first-run contract missing: {contract}")
    for forbidden in ("studio-profile-setup", "PROFILE_KEY", "storageCard(", "navigator.storage"):
        if forbidden in studio_source:
            raise AssertionError(f"first run reintroduced setup machinery: {forbidden}")

    for relative in ("studio.js", "import-studio.js", "import-phone.js"):
        source = assert_clean_text(HERE / "product" / relative)
        if "new MutationObserver" in source:
            raise AssertionError(f"{relative} reintroduced a whole-document mutation observer")

    copy_source = assert_clean_text(HERE / "product" / "copy.js")
    for forbidden in ("profileTitle", "storageUnknown", "queueEmpty", "CHOOSE FILES", "REAL EXPORT"):
        if forbidden in copy_source:
            raise AssertionError(f"visible copy reintroduced implementation language: {forbidden}")

    component_css = assert_clean_text(HERE / "product" / "studio-components.css")
    for forbidden in (".studio-profile-", ".studio-storage-", ".drop-zone", ".queue li", ".studio-format-grid"):
        if forbidden in component_css:
            raise AssertionError(f"dead prototype component styling returned: {forbidden}")

    import_source = assert_clean_text(HERE / "product" / "import-studio.js")
    if "location.reload()" in import_source:
        raise AssertionError("imports must not force an automatic page reload")
    for contract in (
        "Instagram",
        "Reddit",
        "TikTok",
        "YouTube",
        "Spotify",
        "NEED YOUR DOWNLOAD?",
        "runtime.import(chosen)",
        "IMPORT ${platform.name.toUpperCase()}",
        "waitForCoreRefresh",
        "sideways:corpusrefresh",
        "await refreshed",
        "studio-add-modern",
    ):
        if contract not in import_source:
            raise AssertionError(f"one-tap platform contract missing: {contract}")
    for forbidden in ("I HAVE THE FILES", "ADD TO MY FEED", "CHOOSE DIFFERENT FILES", "import-file-list", "import-queue-panel", "PICK FOLDER"):
        if forbidden in import_source:
            raise AssertionError(f"consumer import reintroduced file-workbench UI: {forbidden}")

    import_css = assert_clean_text(HERE / "product" / "import-studio.css")
    for contract in (".source-import", ".source-help", ".import-progress-panel", ".import-complete-panel"):
        if contract not in import_css:
            raise AssertionError(f"consumer import visual contract missing: {contract}")
    for forbidden in (".import-queue-panel", ".import-file-list", ".import-advanced"):
        if forbidden in import_css:
            raise AssertionError(f"legacy workbench styling returned: {forbidden}")

    reset_source = assert_clean_text(HERE / "product" / "studio-reset.css")
    for contract in ("studio-add-modern", "#importWorkbenchHost", "[data-studio-intro]"):
        if contract not in reset_source:
            raise AssertionError(f"legacy-surface reset missing: {contract}")

    phone_source = assert_clean_text(HERE / "product" / "import-phone.js")
    for contract in ("sidewaysImportFiles", "input.multiple = true", "removeAttribute('webkitdirectory')"):
        if contract not in phone_source:
            raise AssertionError(f"native phone importer contract missing: {contract}")
    for forbidden in ("stopImmediatePropagation", "cloneNode", "PICK MORE FILES"):
        if forbidden in phone_source:
            raise AssertionError(f"phone importer reintroduced a patched visible control: {forbidden}")

    if not MANUAL.exists():
        print("manual studio and importer source layers are clean")
        return

    for name in (
        "app.js",
        "profile.js",
        "kernel.js",
        "studio.js",
        "copy.js",
        "import-studio.js",
        "import-phone.js",
        "imports/registry.js",
        "imports/runtime.js",
    ):
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

    for asset in (
        "studio.css",
        "studio-components.css",
        "studio-reset.css",
        "studio.js",
        "copy.js",
        "import-studio.css",
        "import-studio.js",
        "import-phone.js",
        "imports/registry.js",
        "imports/runtime.js",
    ):
        if not (MANUAL / asset).is_file():
            raise AssertionError(f"product asset not applied: {asset}")

    if index.count("data-studio-product") != 3:
        raise AssertionError("product layer must inject exactly two styles and one script")
    if index.count("data-studio-reset") != 1:
        raise AssertionError("product reset must inject exactly one stylesheet")
    if index.count("data-import-workbench") != 2:
        raise AssertionError("import workbench must inject exactly one style and one script")
    if index.count("data-import-phone") != 1:
        raise AssertionError("phone importer fallback must inject exactly one script")

    subprocess.run(["node", str(HERE / "imports" / "verify.mjs")], check=True)
    print("manual studio consumer product and import pipeline verified")


if __name__ == "__main__":
    main()
