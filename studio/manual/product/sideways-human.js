const ROUTE_LABELS = Object.freeze({
  '#/feed': 'Feed',
  '#/places': 'Places',
  '#/add': 'Library',
  '#/saved': 'Saved pages',
  '#/profile': 'Your profile',
  '#/detail': 'Reading'
});

let scheduled = false;
let observer;

function routeLabel() {
  const hash = location.hash || '#/feed';
  if (ROUTE_LABELS[hash]) return ROUTE_LABELS[hash];
  const prefix = Object.keys(ROUTE_LABELS).find(route => hash.startsWith(`${route}/`));
  return ROUTE_LABELS[prefix] || 'Sideways';
}

function hideDeveloperEntrypoints() {
  for (const anchor of document.querySelectorAll('a[href]')) {
    let url;
    try { url = new URL(anchor.href, location.href); }
    catch { continue; }
    const path = url.pathname.toLowerCase();
    if (/(^|\/)(maker|founder)(\/|$)/.test(path)) {
      anchor.dataset.developerBoundary = 'hidden';
      anchor.hidden = true;
      anchor.tabIndex = -1;
      anchor.setAttribute('aria-hidden', 'true');
    }
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
  hideDeveloperEntrypoints();
  normalizeExternalLinks();
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
  'hashchange',
  'popstate'
]) window.addEventListener(eventName, schedule);

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
else schedule();
for (const delay of [80, 280, 900]) setTimeout(schedule, delay);

observer = new MutationObserver(schedule);
observer.observe(document.documentElement, { childList: true, subtree: true });

window.SidewaysHuman = Object.freeze({ refresh: schedule, routeLabel });
