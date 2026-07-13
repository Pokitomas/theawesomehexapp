from pathlib import Path

path = Path("studio/manual/tests/social-clickthrough.mjs")
text = path.read_text(encoding="utf-8")

replacements = {
    "page.locator('[data-social-post]').filter({ hasText: 'THE WINDOW IS THE PLACE' })": "page.locator('[data-social-post]').filter({ has: page.locator('.social-post-text', { hasText: 'THE WINDOW IS THE PLACE' }) })",
    "page.locator('[data-social-post]').filter({ hasText: 'THE WINDOW BECAME A ROOM' })": "page.locator('[data-social-post]').filter({ has: page.locator('.social-post-text', { hasText: 'THE WINDOW BECAME A ROOM' }) })",
}

changed = False
for old, new in replacements.items():
    if old in text:
        text = text.replace(old, new)
        changed = True
    elif new not in text:
        raise SystemExit(f"expected social-post selector not found: {old}")

if changed:
    path.write_text(text, encoding="utf-8")
    print("scoped social-post proof to each card's own text")
else:
    print("social-post proof selectors already scoped")
