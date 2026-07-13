from pathlib import Path


def patch(path: Path, old: str, new: str, label: str) -> bool:
    text = path.read_text(encoding="utf-8")
    if new in text:
        return False
    if old not in text:
        raise SystemExit(f"{label}: expected source shape not found")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    return True


studio = Path("studio/manual/product/studio.js")
patch(
    studio,
    """function recordCount() {
  return Number(window.SidewaysCore?.state?.records?.length || document.querySelectorAll('#feed .post').length || 0);
}

function enhanceBrand() {
""",
    """function recordCount() {
  return Number(window.SidewaysCore?.state?.records?.length || document.querySelectorAll('#feed .post').length || 0);
}

function updateCorpusStatus(total) {
  const status = document.getElementById('corpusStatus');
  if (!status) return;
  const target = status.querySelector('.os-status-text') || status;
  const value = `${total} ${total === 1 ? 'THING' : 'THINGS'}`;
  if (target.textContent !== value) target.textContent = value;
  status.dataset.visibleCount = String(total);
}

function enhanceBrand() {
""",
    "consumer-visible corpus status helper",
)
patch(
    studio,
    """  if (!corePosts && !socialPosts && coreTotal === 0 && nativeEmpty) {
    if (!existingHero) feed.prepend(emptyCard());
    existingProgress?.remove();
    return;
  }

  existingHero?.remove();
  const total = coreTotal + socialPosts;
""",
    """  if (!corePosts && !socialPosts && coreTotal === 0 && nativeEmpty) {
    if (!existingHero) feed.prepend(emptyCard());
    existingProgress?.remove();
    updateCorpusStatus(0);
    return;
  }

  existingHero?.remove();
  const total = coreTotal + socialPosts;
  updateCorpusStatus(total);
""",
    "feed status update",
)
patch(
    studio,
    """for (const eventName of ['sideways:feedrender', 'sideways:profilechange', 'sideways:workspacechange', 'hashchange', 'popstate']) {
""",
    """for (const eventName of ['sideways:feedrender', 'sideways:socialrender', 'sideways:profilechange', 'sideways:workspacechange', 'hashchange', 'popstate']) {
""",
    "social render listener",
)

social = Path("studio/manual/product/social.js")
patch(
    social,
    """  stream.replaceChildren(...posts.map(postCard));
  stream.hidden = posts.length === 0;
  document.documentElement.dataset.activePlace = currentPlaceId;
}
""",
    """  stream.replaceChildren(...posts.map(postCard));
  stream.hidden = posts.length === 0;
  document.documentElement.dataset.activePlace = currentPlaceId;
  window.dispatchEvent(new CustomEvent('sideways:socialrender', { detail: { count: posts.length, placeId: currentPlaceId } }));
}
""",
    "social render event",
)

test = Path("studio/manual/tests/social-clickthrough.mjs")
patch(
    test,
    """await page.waitForFunction(() => window.SidewaysWorkspace && document.querySelectorAll('[data-social-post]').length === 2, { timeout: 15000 });
const savedProfile = await page.evaluate(() => window.SidewaysSocial.profile());
""",
    """await page.waitForFunction(() => window.SidewaysWorkspace && document.querySelectorAll('[data-social-post]').length === 2, { timeout: 15000 });
await page.locator('.os-status-text').filter({ hasText: '2 THINGS' }).waitFor({ state: 'visible', timeout: 10000 });
const savedProfile = await page.evaluate(() => window.SidewaysSocial.profile());
""",
    "local-post status assertion",
)
patch(
    test,
    """await page.screenshot({ path: 'manual-os-phone.png', fullPage: true });
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(350);
await page.screenshot({ path: 'manual-os-desktop.png', fullPage: true });

console.log(JSON.stringify({
""",
    """await page.evaluate(() => scrollTo(0, 0));
await page.waitForTimeout(250);
await page.screenshot({ path: 'manual-os-phone.png', fullPage: false });

await openDock('nav.places');
await page.locator('#osPlacesView').waitFor({ state: 'visible', timeout: 10000 });
await page.evaluate(() => scrollTo(0, 0));
await page.screenshot({ path: 'manual-os-places-phone.png', fullPage: false });

await openDock('nav.me');
await page.locator('#osMeView').waitFor({ state: 'visible', timeout: 10000 });
await page.evaluate(() => scrollTo(0, 0));
await page.screenshot({ path: 'manual-os-me-phone.png', fullPage: false });

await openDock('nav.feed');
await page.setViewportSize({ width: 1280, height: 900 });
await page.evaluate(() => scrollTo(0, 0));
await page.waitForTimeout(350);
await page.screenshot({ path: 'manual-os-desktop.png', fullPage: false });

await openDock('nav.create');
await page.locator('[data-os-create]').waitFor({ state: 'visible', timeout: 10000 });
await page.screenshot({ path: 'manual-os-create-desktop.png', fullPage: false });

console.log(JSON.stringify({
""",
    "viewport-accurate visual proof",
)
patch(
    test,
    """  screenshots: ['manual-os-phone.png', 'manual-os-desktop.png']
""",
    """  screenshots: ['manual-os-phone.png', 'manual-os-places-phone.png', 'manual-os-me-phone.png', 'manual-os-desktop.png', 'manual-os-create-desktop.png']
""",
    "visual proof manifest",
)

print("visual proof reconciliation complete")
