export const COPY = Object.freeze({
  brand: 'SIDEWAYS',
  kicker: 'YOUR INTERNET. ON PURPOSE.',
  headline: 'START WITH WHAT YOU ALREADY CARE ABOUT.',
  intro: 'Drop in files, links, exports, screenshots, notes—whatever is actually yours. Sideways turns that pile into a feed that changes shape as you use it.',
  privacy: 'Stays in this browser unless you choose to export it.',
  emptyTitle: 'NOTHING IN HERE YET.',
  emptyBody: 'Add a few things. The feed wakes up from your material instead of guessing who you are.',
  emptyAction: 'ADD YOUR FIRST THING',
  openPackAction: 'OPEN A SAVED PACK',
  sourceLabel: 'FROM YOUR SOURCES',
  localBadge: 'LOCAL FIRST',
  addHint: 'FILES, FOLDERS, LINKS, PASTE, OR A SAVED PACK',
  ready: 'READY FOR YOUR STUFF',
  storage: 'YOUR LIBRARY LIVES ON THIS DEVICE',
  storageUnknown: 'STORAGE CHECKING…',
  storagePersistent: 'BROWSER STORAGE PROTECTED',
  storageTemporary: 'ASK THIS BROWSER TO KEEP IT',
  storageAction: 'PROTECT LOCAL LIBRARY',
  saved: 'THINGS YOU KEPT',
  profile: 'MAKE IT YOURS',
  footer: 'BUILT FROM WHAT YOU PUT IN',
  feedLearning: 'YOUR FEED IS LEARNING',
  feedLearningBody: 'Mix sources and formats. The feed gets more useful when it has more than one angle to work with.',
  feedAwake: 'YOUR FEED IS AWAKE',
  feedAwakeBody: 'Keep, read, skip, and add. Those actions reshape what comes next.',
  importTitle: 'BRING IN A REAL PILE',
  importBody: 'Start messy. Sideways deduplicates files, reads common archives, and keeps everything local.',
  formats: ['TEXT + CODE', 'PDF + OFFICE', 'JSON + CSV', 'IMAGES + AUDIO + VIDEO', 'ZIP ARCHIVES', 'LINKS + PASTE']
});

export function copy(key, fallback = '') {
  return COPY[key] ?? fallback;
}
