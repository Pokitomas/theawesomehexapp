export const COPY = Object.freeze({
  brand: 'SIDEWAYS',
  kicker: 'YOUR INTERNET. ON PURPOSE.',
  headline: 'START WITH WHAT YOU ALREADY CARE ABOUT.',
  intro: 'Drop in files, links, exports, screenshots, notes—whatever is actually yours. Sideways turns that pile into a feed that changes shape as you use it.',
  privacy: 'Stays in this browser unless you choose to export it.',
  emptyTitle: 'NOTHING IN HERE YET.',
  emptyBody: 'Add a few things. The feed wakes up from your material instead of guessing who you are.',
  sourceLabel: 'FROM YOUR SOURCES',
  localBadge: 'LOCAL FIRST',
  addHint: 'FILES, FOLDERS, LINKS, PASTE, OR A SAVED PACK',
  ready: 'READY FOR YOUR STUFF',
  storage: 'YOUR LIBRARY LIVES ON THIS DEVICE',
  saved: 'THINGS YOU KEPT',
  profile: 'MAKE IT YOURS',
  footer: 'BUILT FROM WHAT YOU PUT IN'
});

export function copy(key, fallback = '') {
  return COPY[key] ?? fallback;
}
