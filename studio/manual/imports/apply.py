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
NETWORK_SCRIPT = '<script type="module" src="./network/index.js" data-sideways-network></script>'


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

    index = MANUAL / "index.html"
    html = index.read_text(encoding="utf-8")
    html = inject_once(html, STYLE, "</head>")
    html = inject_once(html, SCRIPT, "</body>")
    html = inject_once(html, PHONE_SCRIPT, "</body>")
    html = inject_once(html, NETWORK_SCRIPT, "</body>")
    index.write_text(html, encoding="utf-8")
    print("applied manual import workbench, off-thread hashing, and the SidewaysNetwork client boundary")


if __name__ == "__main__":
    main()
