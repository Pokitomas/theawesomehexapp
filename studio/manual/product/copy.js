export const COPY = Object.freeze({
  brand: 'SIDEWAYS',
  ready: 'NEW',
  emptyTitle: 'START HERE.',
  emptyPost: 'POST',
  emptyImport: 'IMPORT',
  saved: 'SAVED',
  profile: 'ME',
  feedLearning: '1 THING',
  feedAwake: 'FEED',
  importTitle: 'IMPORT',
  importBusy: 'IMPORTING…',
  importDone: 'IT’S IN.',
  importOpen: 'OPEN FEED',
  importRetry: 'TRY AGAIN'
});

export function copy(key, fallback = '') {
  return COPY[key] ?? fallback;
}
