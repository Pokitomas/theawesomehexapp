const ROUTE_LABELS = Object.freeze({
  '#/feed': 'Feed',
  '#/places': 'Places',
  '#/add': 'Add to Sideways',
  '#/saved': 'Saved pages',
  '#/profile': 'Your profile',
  '#/community': 'Community',
  '#/communities': 'Communities',
  '#/detail': 'Reading',
  '#/read': 'Reading',
  '#/post': 'Conversation'
});

const DEVELOPER_PATH = /(^|\/)(maker|founder)(\/|$)/;
const DEVELOPER_QUERY = 'developer';
let scheduled = false;

function explicitDeveloperView() {
  const params = new URLSearchParams(location.search);
  return params.get(DEVELOPER_QUERY) === '1' || location.hash === '#live-work';
}

function routeLabel() {
  const hash = location.hash || '#/feed';
  if (ROUTE_LABELS[hash]) return ROUTE_LABELS[hash];
  const prefix = Object.keys(ROUTE_LABELS).find(route => hash.startsWith(`${route}/`));
  return ROUTE_LABELS[prefix] || 'Sideways';
}

function separateDeveloperSurfaces() {
  if (explicitDeveloperView()) {
    document.documentElement.dataset.sidewaysDeveloperView = 'explicit';
    return;
  }

  delete document.documentElement.dataset.sidewaysDeveloperView;
  for (const selector of [
    '[data-sideways-remote-launch]',
    '[data-sideways-remote-terminal]',
    '#live-work'
  ]) {
    for (const node of document.querySelectorAll(selector)) node.remove();
  }

  for (const anchor of document.querySelectorAll('a[href]')) {
    let url;
    try { url = new URL(anchor.href, location.href); }
    catch { continue; }
    if (DEVELOPER_PATH.test(url.pathname.toLowerCase())) {
      anchor.dataset.developerBoundary = 'hidden';
      anchor.hidden = true;
      anchor.tabIndex = -1;
      anchor.setAttribute('aria-hidden', 'true');
    }
  }

  for (const id of ['debugPanel', 'debugPolicy', 'debugState']) {
    const node = document.getElementById(id);
    if (!node) continue;
    node.hidden = true;
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('inert', '');
  }
}

function normalizeExternalLinks() {
  for (const anchor of document.querySelectorAll('a[href^="http"]')) {
    let url;
    try { url = new URL(anchor.href); }
    catch { continue; }
    if (url.origin === location.origin) continue;
    anchor.rel = 'noreferrer noopener';
    if (!anchor.title) anchor.title = `Open ${url.hostname}`;
    anchor.dataset.sourceHost = url.hostname.replace(/^www\./, '');
  }
}

function normalizeChromeLanguage() {
  const commandbar = document.querySelector('[data-workspace-commandbar]');
  if (commandbar) commandbar.setAttribute('aria-label', 'Site navigation');

  const contract = document.querySelector('.future-status-contract');
  if (contract && contract.textContent.trim().toLowerCase() === 'things') contract.textContent = ' items';
}

function installLocationBar() {
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;
  let bar = document.querySelector('[data-sideways-location]');
  if (!bar) {
    bar = document.createElement('nav');
    bar.className = 'sideways-location-bar';
    bar.dataset.sidewaysLocation = 'true';
    bar.setAttribute('aria-label', 'Current location');

    const home = document.createElement('a');
    home.href = '#/feed';
    home.textContent = 'Sideways';

    const separator = document.createElement('span');
    separator.setAttribute('aria-hidden', 'true');
    separator.textContent = '›';

    const path = document.createElement('strong');
    path.className = 'sideways-location-path';

    const note = document.createElement('span');
    note.className = 'sideways-location-note';
    note.textContent = 'People, pages, and collections you chose';

    bar.append(home, separator, path, note);
    topbar.insertAdjacentElement('afterend', bar);
  }
  const path = bar.querySelector('.sideways-location-path');
  if (path) path.textContent = routeLabel();
}

function exposeExistingProvenance() {
  for (const post of document.querySelectorAll('.post')) {
    post.dataset.humanRecord = 'true';
    const time = post.querySelector('time[datetime]');
    if (time && !time.title) time.title = time.getAttribute('datetime') || '';
    const source = [...post.querySelectorAll('a[href^="http"]')]
      .find(anchor => {
        try { return new URL(anchor.href).origin !== location.origin; }
        catch { return false; }
      });
    if (source) post.dataset.sourceHost = source.dataset.sourceHost || '';
  }
}

function install() {
  document.documentElement.classList.add('sideways-human-web');
  document.documentElement.dataset.sidewaysHuman = 'ready';
  separateDeveloperSurfaces();
  normalizeExternalLinks();
  normalizeChromeLanguage();
  installLocationBar();
  exposeExistingProvenance();
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    install();
  });
}

for (const eventName of [
  'sideways:ready',
  'sideways:feedrender',
  'sideways:workspacechange',
  'sideways:profilechange',
  'sideways:importcomplete',
  'sideways:remoteupdate',
  'hashchange',
  'popstate'
]) window.addEventListener(eventName, schedule);

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
else schedule();
for (const delay of [80, 280, 900, 1800]) setTimeout(schedule, delay);

window.SidewaysHuman = Object.freeze({ refresh: schedule, routeLabel, explicitDeveloperView });
