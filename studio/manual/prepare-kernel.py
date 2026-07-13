from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PATCH = ROOT / "manual-kernel" / "patch.py"

OLD_EXTRACTOR = "pattern=rf'^const {re.escape(name)}=.*$' if kind=='const' else rf'^function {re.escape(name)}\\([^\\n]*$'"
NEW_EXTRACTOR = "pattern=rf'^const {re.escape(name)}\\s*=.*$' if kind=='const' else rf'^function {re.escape(name)}\\([^\\n]*$'"
RENDER_GUARD = "state.records.length&&!els.feedView.hidden"
# A brace-aware scanner (PR #51) supersedes the whitespace-only patch this
# script knows how to apply -- it fixes both the '=' spacing AND the deeper
# bug the whitespace patch alone does not: multi-line consts/functions
# (root got reformatted multi-line; CONFIG and every WANTED_FUNCS entry were
# truncating to their opening brace/line, producing kernel.js that fails
# node --check). Recognize it and don't try to "fix" it into something worse.
SCANNER_MARKERS = ("def matching_close(", "def extract_const(", "def extract_function(")


def main() -> None:
    if not PATCH.is_file():
        raise SystemExit("manual-kernel/patch.py is missing; extract the kernel overlay first")

    source = PATCH.read_text(encoding="utf-8")

    if RENDER_GUARD not in source:
        raise SystemExit("manual kernel lost the bounded feed-render guard from PR #45")

    if all(marker in source for marker in SCANNER_MARKERS):
        print("manual kernel extractor already uses the brace-aware scanner (PR #51); nothing to patch")
        return

    old_count = source.count(OLD_EXTRACTOR)
    new_count = source.count(NEW_EXTRACTOR)

    if new_count == 1 and old_count == 0:
        print("manual kernel extractor already accepts whitespace around =")
        return

    if old_count != 1 or new_count != 0:
        raise SystemExit(
            "manual kernel extractor shape changed unexpectedly; refusing a blind compatibility patch"
        )

    PATCH.write_text(source.replace(OLD_EXTRACTOR, NEW_EXTRACTOR, 1), encoding="utf-8")

    verified = PATCH.read_text(encoding="utf-8")
    if verified.count(NEW_EXTRACTOR) != 1 or RENDER_GUARD not in verified:
        raise SystemExit("manual kernel compatibility patch did not verify")

    print("made manual kernel constant extraction whitespace-tolerant; render guard preserved")


if __name__ == "__main__":
    main()
