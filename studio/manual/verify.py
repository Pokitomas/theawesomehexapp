from __future__ import annotations

import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
PRODUCT = HERE / "product"
IMPORTS = HERE / "imports"
SHARED = HERE / "shared"
MANUAL = ROOT / "manual-app"
REMOTE_SESSION = ROOT / "remote" / "session.json"

SOURCE_FILES = (
    PRODUCT / "copy.js",
    PRODUCT / "actions.js",
    PRODUCT / "studio.js",
    PRODUCT / "workspace-db.js",
    PRODUCT / "workspace-profile.js",
    PRODUCT / "workspace-records.js",
    PRODUCT / "workspace-migration.js",
    PRODUCT / "workspace.js",
    PRODUCT / "workspace-ui.js",
    PRODUCT / "core-actions.js",
    PRODUCT / "universal-media.js",
    PRODUCT / "media-modes.js",
    PRODUCT / "frontier.js",
    PRODUCT / "remote-terminal.js",
    PRODUCT / "studio.css",
    PRODUCT / "studio-components.css",
    PRODUCT / "studio-reset.css",
    PRODUCT / "workspace.css",
    PRODUCT / "frontier.css",
    PRODUCT / "remote-terminal.css",
    PRODUCT / "system-icons.svg",
    PRODUCT / "import-studio.js",
    PRODUCT / "import-studio.css",
    PRODUCT / "import-phone.js",
    SHARED / "corpus-db.js",
    IMPORTS / "registry.js",
    IMPORTS / "runtime.js",
    IMPORTS / "file-hash.js",
    IMPORTS / "hash-worker.js",
    IMPORTS / "corpus-writer.js",
    IMPORTS / "record-normalizer.js",
    IMPORTS / "apply.py",
    IMPORTS / "verify.mjs",
    HERE / "prepare-kernel.py",
    HERE / "apply.py",
)

JS_FILES = tuple(path for path in SOURCE_FILES if path.suffix in {".js", ".mjs"})
RETIRED = (
    PRODUCT / "social.js",
    PRODUCT / "social.css",
    PRODUCT / "workspace-sync.js",
)


def read_clean(path: Path) -> str:
    raw = path.read_bytes()
    if b"\x00" in raw:
        raise AssertionError(f"{path} contains NUL bytes")
    bad = [byte for byte in raw if byte < 32 and byte not in (9, 10, 13)]
    if bad:
        raise AssertionError(f"{path} contains binary control bytes")
    return raw.decode("utf-8")


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
    for path in RETIRED:
        if path.exists():
            raise AssertionError(f"retired subsystem remains: {path.name}")

    source = {path: read_clean(path) for path in SOURCE_FILES}
    for path in JS_FILES:
        node_check(path)

    all_product = "\n".join(source[path] for path in SOURCE_FILES if PRODUCT in path.parents)
    forbid(all_product, ("new MutationObserver", "location.reload()", "configureSync", "flushOutbox"), "runtime regression")

    apply_source = source[HERE / "apply.py"]
    require(
        apply_source,
        (
            "CORE_REFRESH_BRIDGE",
            "sideways:importcomplete",
            "await rebuildState()",
            '"workspace-records.js"',
            '"universal-media.js"',
            '"media-modes.js"',
            '"frontier.js"',
            '"remote-terminal.js"',
            '"remote-terminal.css"',
            "REMOTE_TERMINAL_SCRIPT_MARKER",
            "REMOTE_TERMINAL_STYLE_MARKER",
            "REMOTE_SESSION",
            '"remote-session.json"',
            "shared_target",
            '"corpus-db.js"',
            '"workspace-sync.js"',
            "path.unlink()",
            "release_core_schema_ownership",
            "CORE_DB_OPEN_CURRENT",
            "db.onversionchange=()=>db.close()",
        ),
        "workspace installer",
    )

    db_source = source[SHARED / "corpus-db.js"]
    require(
        db_source,
        (
            "CORPUS_VERSION = 2",
            "LEDGER_STORE",
            "createIndex('assetKey'",
            "storageDurability",
            "readCorpusLedger",
            "navigator.storage",
        ),
        "corpus schema",
    )

    records_source = source[PRODUCT / "workspace-records.js"]
    require(
        records_source,
        (
            "ledgerEntry('record.insert'",
            "ledgerEntry('record.update'",
            "ledgerEntry('record.delete'",
            "records.index('assetKey').getAll",
            "getAssets",
            "transactionDone",
        ),
        "atomic workspace records",
    )

    workspace_source = source[PRODUCT / "workspace.js"]
    require(workspace_source, ("storageDurability({ request: true })", "readCorpusLedger", "getAssets"), "workspace runtime")
    forbid(workspace_source, ("sideways:action", "persistEvent", "flushOutbox"), "retired action outbox")

    hash_source = source[IMPORTS / "file-hash.js"]
    require(hash_source, ("FULL_HASH_MAX", "sha256-worker", "sha256-sampled", "new Worker"), "bounded hashing")

    writer_source = source[IMPORTS / "corpus-writer.js"]
    require(writer_source, ("LEDGER_STORE", "record.import", "addMediaRecord", "addRecords"), "atomic import writer")

    normalizer_source = source[IMPORTS / "record-normalizer.js"]
    require(normalizer_source, ("normalizeRecord", "compatibility", "canonicalMime"), "compatibility normalizer")

    media_source = source[PRODUCT / "universal-media.js"]
    require(
        media_source,
        ("getAssets", "IntersectionObserver", "rootMargin: '900px 0px'", "dehydrate", "clearURL", "pendingCards"),
        "viewport media runtime",
    )
    forbid(media_source, ("Promise.all(cards.map(renderCard))", "for (const delay of", "new MutationObserver"), "full-feed hydration")

    actions_source = source[PRODUCT / "actions.js"]
    for action_id in ("nav.feed", "feed.post", "post.delete", "record.open", "places.create", "import.anything", "remote.open", "remote.close", "remote.refresh"):
        if actions_source.count(f"'{action_id}'") < 2:
            raise AssertionError(f"action contract is incomplete: {action_id}")

    remote_source = source[PRODUCT / "remote-terminal.js"]
    require(
        remote_source,
        (
            "/api/remote/state",
            "public",
            "data-sideways-remote-state",
            "sideways:remoteupdate",
            "remote-session.json",
            "window.SidewaysRemoteTerminal",
        ),
        "public live terminal",
    )
    forbid(remote_source, ("REMOTE_ROOT_KEY", "x-remote-signature", "localStorage.setItem(\'remote", "method: \'POST\'"), "browser remote authority")

    if not REMOTE_SESSION.is_file():
        raise AssertionError("machine-readable remote session pointer is missing")
    remote_bootstrap = json.loads(read_clean(REMOTE_SESSION))
    if not remote_bootstrap.get("thought_location") or not remote_bootstrap.get("human_report"):
        raise AssertionError("remote bootstrap does not expose report and thought locations")

    if not MANUAL.exists():
        print("local-first runtime and public live terminal sources verified")
        return

    generated_js = (
        "app.js", "profile.js", "kernel.js", "studio.js", "copy.js", "actions.js",
        "workspace-db.js", "workspace-profile.js", "workspace-records.js", "workspace-migration.js",
        "workspace.js", "workspace-ui.js", "core-actions.js", "universal-media.js", "media-modes.js",
        "frontier.js", "remote-terminal.js", "import-studio.js", "import-phone.js", "shared/corpus-db.js",
        "imports/registry.js", "imports/runtime.js", "imports/file-hash.js", "imports/hash-worker.js",
        "imports/corpus-writer.js", "imports/record-normalizer.js",
    )
    for name in generated_js:
        path = MANUAL / name
        read_clean(path)
        node_check(path)

    for generated in ("frontier.css", "remote-terminal.css", "remote-session.json"):
        read_clean(MANUAL / generated)

    for retired in ("social.js", "social.css", "workspace-sync.js"):
        if (MANUAL / retired).exists():
            raise AssertionError(f"retired generated asset remains: {retired}")

    app_text = read_clean(MANUAL / "app.js")
    if app_text.count("'sideways:corpusrefresh'") != 1 or "await rebuildState()" not in app_text:
        raise AssertionError("generated core refresh bridge is invalid")
    require(app_text, ("indexedDB.open(DB_NAME)", "db.onversionchange=()=>db.close()"), "generated core database client")
    forbid(app_text, ("const DB_VERSION=", "indexedDB.open(DB_NAME,DB_VERSION)"), "duplicate core schema ownership")

    index = read_clean(MANUAL / "index.html")
    for hook in ("corpusStatus", "debugPolicy", "debugState", "debugPanel"):
        if f'id="{hook}"' not in index:
            raise AssertionError(f"stable DOM hook missing: {hook}")
    if index.count("data-workspace-product") != 2 or index.count("data-universal-media") != 1 or index.count("data-media-modes") != 1:
        raise AssertionError("generated runtime layers are duplicated or missing")
    if index.count("data-frontier-product") != 2 or index.count("data-remote-terminal") != 2:
        raise AssertionError("generated frontier or live terminal layers are duplicated or missing")

    subprocess.run(["node", str(IMPORTS / "verify.mjs")], check=True)
    print("local-first runtime, atomic ledger, profile frontier, and public live terminal contracts verified")


if __name__ == "__main__":
    main()
