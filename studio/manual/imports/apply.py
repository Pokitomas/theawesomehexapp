from __future__ import annotations

from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
PRODUCT = HERE.parent / "product"
MANUAL = ROOT / "manual-app"

STYLE = '<link rel="stylesheet" href="./import-studio.css" data-import-workbench>'
SCRIPT = '<script type="module" src="./import-studio.js" data-import-workbench></script>'
PHONE_SCRIPT = '<script type="module" src="./import-phone.js" data-import-phone></script>'
NETWORK_STYLE = '<link rel="stylesheet" href="./network.css" data-sideways-network>'
NETWORK_SCRIPT = '<script type="module" src="./network-ui.js" data-sideways-network></script>'
NETWORK_OBSERVER = "new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });"
NETWORK_EVENTS = "document.addEventListener('click', () => setTimeout(schedule, 0), true);"
NETWORK_TOGGLE = "{ className: 'network-secondary', label: 'I already have an account' }"
NETWORK_TOGGLE_A11Y = "{ className: 'network-secondary', label: 'I already have an account', ariaLabel: 'I already have an account' }"
NETWORK_MODE_COPY = "submit.textContent = signup ? 'Create account' : 'Log in';\n    toggle.textContent = signup ? 'I already have an account' : 'Create a new account';"
NETWORK_MODE_A11Y = "submit.textContent = signup ? 'Create account' : 'Log in';\n    submit.setAttribute('aria-label', signup ? 'Create account' : 'Log in');\n    toggle.textContent = signup ? 'I already have an account' : 'Create a new account';\n    toggle.setAttribute('aria-label', signup ? 'I already have an account' : 'Create a new account');"
NETWORK_AUTH_SYNC = "await SidewaysNetwork.sync.following();\n      setStatus(status, `Signed in as @${result.user.handle}.`, 'good');"
NETWORK_AUTH_SYNC_ASYNC = "void SidewaysNetwork.sync.following().catch(error => console.warn('[network] initial sync failed', error));\n      setStatus(status, `Signed in as @${result.user.handle}.`, 'good');"


def inject_once(text: str, marker: str, before: str) -> str:
    if marker in text:
        return text
    if before not in text:
        raise RuntimeError(f"cannot inject before {before!r}")
    return text.replace(before, f"  {marker}\n{before}", 1)


def main() -> None:
    if not MANUAL.exists():
        raise SystemExit("manual-app is missing; assemble the canonical product first")

    target = MANUAL / "imports"
    target.mkdir(parents=True, exist_ok=True)
    for name in ("registry.js", "runtime.js", "media-classifier.js", "hash-worker.js", "file-hash.js", "corpus-writer.js", "record-normalizer.js"):
        shutil.copyfile(HERE / name, target / name)
    shutil.copyfile(PRODUCT / "import-studio.js", MANUAL / "import-studio.js")
    shutil.copyfile(PRODUCT / "import-studio.css", MANUAL / "import-studio.css")
    shutil.copyfile(PRODUCT / "import-phone.js", MANUAL / "import-phone.js")

    network_source = PRODUCT / "network"
    network_target = MANUAL / "network"
    if network_target.exists():
        shutil.rmtree(network_target)
    shutil.copytree(network_source, network_target)
    network_ui = MANUAL / "network-ui.js"
    shutil.copyfile(PRODUCT / "network-ui.js", network_ui)
    network_text = network_ui.read_text(encoding="utf-8")
    if NETWORK_OBSERVER not in network_text and NETWORK_EVENTS not in network_text:
        raise RuntimeError("network scheduler shape changed unexpectedly")
    if NETWORK_TOGGLE not in network_text and NETWORK_TOGGLE_A11Y not in network_text:
        raise RuntimeError("network auth toggle shape changed unexpectedly")
    if NETWORK_MODE_COPY not in network_text and NETWORK_MODE_A11Y not in network_text:
        raise RuntimeError("network auth mode copy shape changed unexpectedly")
    if NETWORK_AUTH_SYNC not in network_text and NETWORK_AUTH_SYNC_ASYNC not in network_text:
        raise RuntimeError("network auth sync shape changed unexpectedly")
    network_text = network_text.replace(NETWORK_OBSERVER, NETWORK_EVENTS, 1)
    network_text = network_text.replace(NETWORK_TOGGLE, NETWORK_TOGGLE_A11Y, 1)
    network_text = network_text.replace(NETWORK_MODE_COPY, NETWORK_MODE_A11Y, 1)
    network_text = network_text.replace(NETWORK_AUTH_SYNC, NETWORK_AUTH_SYNC_ASYNC, 1)
    network_ui.write_text(network_text, encoding="utf-8")
    shutil.copyfile(PRODUCT / "network.css", MANUAL / "network.css")

    index = MANUAL / "index.html"
    html = index.read_text(encoding="utf-8")
    html = inject_once(html, STYLE, "</head>")
    html = inject_once(html, NETWORK_STYLE, "</head>")
    html = inject_once(html, SCRIPT, "</body>")
    html = inject_once(html, PHONE_SCRIPT, "</body>")
    html = inject_once(html, NETWORK_SCRIPT, "</body>")
    index.write_text(html, encoding="utf-8")
    print("applied import workbench plus the authoritative public social-network adapter")


if __name__ == "__main__":
    main()
