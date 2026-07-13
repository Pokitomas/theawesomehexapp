const PATHS = Object.freeze({
  feed: '<path d="M4 6.5h16M4 12h16M4 17.5h10"/>',
  places: '<path d="M3.5 7.5h6l1.7 2H20.5v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M3.5 7.5V6a2 2 0 0 1 2-2h4l1.7 2h7.3a2 2 0 0 1 2 2v1.5"/>',
  create: '<path d="M12 5v14M5 12h14"/>',
  me: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-4.1 3.1-6.2 7-6.2s6.2 2.1 7 6.2"/>',
  later: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3.5 2"/>',
  archive: '<path d="M4 7h16v12H4zM3 4h18v3H3zM9 11h6"/>',
  import: '<path d="M12 3v12M7.5 10.5 12 15l4.5-4.5"/><path d="M4 19h16"/>',
  post: '<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m5.5 17 4.2-4.2 3.1 3.1 2.1-2.1 3.6 3.2"/>',
  link: '<path d="M9.5 14.5 14.5 9.5M7.5 16.5l-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0M16.5 7.5l1-1a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0"/>',
  send: '<path d="m3.5 4 17 8-17 8 3-8zM6.5 12h14"/>',
  edit: '<path d="M5 19h4l10-10-4-4L5 15zM13.5 6.5l4 4"/>',
  move: '<path d="M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4M12 7v10M7 12h10"/>',
  remix: '<path d="M7 7h8.5a3.5 3.5 0 0 1 0 7H14M7 7l3-3M7 7l3 3M17 17H8.5a3.5 3.5 0 0 1 0-7H10M17 17l-3-3M17 17l-3 3"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  trash: '<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>',
  undo: '<path d="M9 7 4 12l5 5M5 12h8.5a5.5 5.5 0 0 1 5.5 5.5"/>',
  spark: '<path d="m12 3 1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6z"/>',
  folder: '<path d="M3.5 7h6l2-2h9v14h-17z"/>',
  draft: '<path d="M6 3.5h9l3 3V20.5H6zM15 3.5v4h4M9 12h6M9 16h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  window: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 8.5h17"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>'
});

export function icon(name, options = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add(options.className || 'ui-icon');
  svg.innerHTML = PATHS[name] || PATHS.window;
  return svg;
}

export function iconMarkup(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="ui-icon">${PATHS[name] || PATHS.window}</svg>`;
}

export const ICON_NAMES = Object.freeze(Object.keys(PATHS));
