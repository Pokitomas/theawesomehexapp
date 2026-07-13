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

    node_check(HERE / "product" / "copy.js")
    node_check(HERE / "product" / "studio.js")

    if not MANUAL.exists():
        print("manual-app not assembled; source layer itself is clean")
        return

    for name in ("app.js", "profile.js", "kernel.js"):
        path = MANUAL / name
        assert_clean_text(path)
        node_check(path)

    index = assert_clean_text(MANUAL / "index.html")
    for hook in ("corpusStatus", "debugPolicy", "debugState", "debugPanel"):
        if f'id="{hook}"' not in index:
            raise AssertionError(f"stable DOM hook missing: {hook}")
    for label in ("ADD", "KEEP", "READ", "SEND", "FILES +"):
        corpus = index + (MANUAL / "app.js").read_text(encoding="utf-8")
        if label not in corpus:
            raise AssertionError(f"stable phone-test label missing: {label}")
    for asset in ("studio.css", "studio.js", "copy.js"):
        if not (MANUAL / asset).is_file():
            raise AssertionError(f"product asset not applied: {asset}")
    if "data-studio-product" not in index:
        raise AssertionError("product layer was not injected into index.html")

    print("manual studio product layer verified")


if __name__ == "__main__":
    main()
