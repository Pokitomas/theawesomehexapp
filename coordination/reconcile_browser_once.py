from pathlib import Path


def replace_once(path: Path, old: str, new: str, label: str) -> bool:
    text = path.read_text(encoding="utf-8")
    if new in text:
        return False
    if old not in text:
        raise SystemExit(f"{label}: expected source shape not found")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    return True


phone = Path("manual-phone-check.mjs")
replace_once(
    phone,
    "await touch(page, page.locator('[data-action-id=\"nav.create\"]'));",
    "await touch(page, page.locator('[data-os-dock] [data-action-id=\"nav.create\"]'));",
    "CREATE proof selector",
)

shell = Path("studio/manual/product/shell.js")
text = shell.read_text(encoding="utf-8")
if "let placesRenderToken = 0;" not in text:
    anchor = "let workspaceReady = false;\n"
    if anchor not in text:
        raise SystemExit("shell render-token insertion point not found")
    text = text.replace(
        anchor,
        anchor + "let placesRenderToken = 0;\nlet meRenderToken = 0;\n",
        1,
    )
    shell.write_text(text, encoding="utf-8")

replace_once(
    shell,
    """async function renderPlaces() {
  if (!placesView) return;
  const content = placesView.querySelector('.os-view-content');
  content.replaceChildren();
  const toolbar = el('div', 'os-view-toolbar');
  toolbar.append(actionButton('place.create', openPlaceCreator, { className: 'ui-button is-primary' }));
  const grid = el('div', 'os-places-grid');
  for (const place of await getPlaces()) grid.append(placeCard(place));
  content.append(toolbar, grid);
}
""",
    """async function renderPlaces() {
  if (!placesView) return;
  const token = ++placesRenderToken;
  const places = await getPlaces();
  if (token !== placesRenderToken || !placesView) return;
  const content = placesView.querySelector('.os-view-content');
  content.replaceChildren();
  const toolbar = el('div', 'os-view-toolbar');
  toolbar.append(actionButton('place.create', openPlaceCreator, { className: 'ui-button is-primary' }));
  const grid = el('div', 'os-places-grid');
  for (const place of places) grid.append(placeCard(place));
  content.append(toolbar, grid);
}
""",
    "Places render ordering",
)

replace_once(
    shell,
    """async function renderMe() {
  if (!meView) return;
  const content = meView.querySelector('.os-view-content');
  content.replaceChildren();
  const profile = window.SidewaysSocial?.profile?.() || { name: 'You', handle: '', avatar: '◉', color: '#9cc7ff' };
  const hero = el('section', 'os-me-hero');
  const avatar = el('span', 'os-me-avatar', profile.avatar || '◉');
  avatar.style.setProperty('--profile-color', profile.color || '#9cc7ff');
  const copy = el('div', 'os-me-copy');
  copy.append(el('h2', '', profile.name || 'You'), el('span', '', profile.handle ? `@${profile.handle}` : 'Local profile'));
  hero.append(avatar, copy, actionButton('profile.open', () => window.SidewaysSocial?.openProfile?.(), { className: 'ui-button', label: 'Edit' }));

  const stats = el('div', 'os-me-stats');
  const posts = window.SidewaysSocial?.posts?.() || [];
  const drafts = window.SidewaysWorkspace?.listDrafts ? await window.SidewaysWorkspace.listDrafts() : [];
  for (const [value, label] of [[posts.length, 'Posts'], [drafts.length, 'Drafts'], [(await getPlaces()).filter(place => !place.virtual).length, 'Places']]) {
    const stat = el('div', 'os-stat');
    stat.append(el('strong', '', String(value)), el('span', '', label));
    stats.append(stat);
  }

  const sections = el('div', 'os-me-sections');
  const draftSection = el('section', 'os-me-section');
  draftSection.append(el('h3', '', 'Drafts'));
  if (drafts.length) {
    for (const draft of drafts) {
      const row = el('article', 'os-list-row');
      row.append(icon('draft'), el('span', '', draft.text?.slice(0, 60) || 'Untitled draft'), actionButton('draft.resume', () => window.SidewaysSocial?.openComposer?.({ draft }), { className: 'os-row-action', iconOnly: true, payload: { draftId: draft.id } }));
      draftSection.append(row);
    }
  } else draftSection.append(el('p', 'os-empty-note', 'No drafts'));

  const archiveSection = el('section', 'os-me-section');
  archiveSection.append(el('h3', '', 'Archive'));
  const archive = window.SidewaysWorkspace?.listArchived ? await window.SidewaysWorkspace.listArchived() : [];
  if (archive.length) archiveSection.append(...archive.slice(0, 8).map(item => el('div', 'os-list-row', item.text || item.title || 'Archived item')));
  else archiveSection.append(el('p', 'os-empty-note', 'Nothing archived'));

  sections.append(draftSection, archiveSection);
  content.append(hero, stats, sections);
}
""",
    """async function renderMe() {
  if (!meView) return;
  const token = ++meRenderToken;
  const profile = window.SidewaysSocial?.profile?.() || { name: 'You', handle: '', avatar: '◉', color: '#9cc7ff' };
  const posts = window.SidewaysSocial?.posts?.() || [];
  const [drafts, places, archive] = await Promise.all([
    window.SidewaysWorkspace?.listDrafts ? window.SidewaysWorkspace.listDrafts() : [],
    getPlaces(),
    window.SidewaysWorkspace?.listArchived ? window.SidewaysWorkspace.listArchived() : []
  ]);
  if (token !== meRenderToken || !meView) return;

  const content = meView.querySelector('.os-view-content');
  content.replaceChildren();
  const hero = el('section', 'os-me-hero');
  const avatar = el('span', 'os-me-avatar', profile.avatar || '◉');
  avatar.style.setProperty('--profile-color', profile.color || '#9cc7ff');
  const copy = el('div', 'os-me-copy');
  copy.append(el('h2', '', profile.name || 'You'), el('span', '', profile.handle ? `@${profile.handle}` : 'Local profile'));
  hero.append(avatar, copy, actionButton('profile.open', () => window.SidewaysSocial?.openProfile?.(), { className: 'ui-button', label: 'Edit' }));

  const stats = el('div', 'os-me-stats');
  for (const [value, label] of [[posts.length, 'Posts'], [drafts.length, 'Drafts'], [places.filter(place => !place.virtual).length, 'Places']]) {
    const stat = el('div', 'os-stat');
    stat.append(el('strong', '', String(value)), el('span', '', label));
    stats.append(stat);
  }

  const sections = el('div', 'os-me-sections');
  const draftSection = el('section', 'os-me-section');
  draftSection.append(el('h3', '', 'Drafts'));
  if (drafts.length) {
    for (const draft of drafts) {
      const row = el('article', 'os-list-row');
      row.append(icon('draft'), el('span', '', draft.text?.slice(0, 60) || 'Untitled draft'), actionButton('draft.resume', () => window.SidewaysSocial?.openComposer?.({ draft }), { className: 'os-row-action', iconOnly: true, payload: { draftId: draft.id } }));
      draftSection.append(row);
    }
  } else draftSection.append(el('p', 'os-empty-note', 'No drafts'));

  const archiveSection = el('section', 'os-me-section');
  archiveSection.append(el('h3', '', 'Archive'));
  if (archive.length) archiveSection.append(...archive.slice(0, 8).map(item => el('div', 'os-list-row', item.text || item.title || 'Archived item')));
  else archiveSection.append(el('p', 'os-empty-note', 'Nothing archived'));

  sections.append(draftSection, archiveSection);
  content.append(hero, stats, sections);
}
""",
    "Me render ordering",
)

print("browser reconciliation complete")
