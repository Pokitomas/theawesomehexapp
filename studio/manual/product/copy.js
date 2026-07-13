export const COPY = Object.freeze({
  brand: 'Sideways',
  ready: 'Ready',
  emptyTitle: 'Start',
  emptyPost: 'Post',
  emptyImport: 'Import',
  profile: 'Me',
  feedAwake: 'Feed',
  importTitle: 'Import',
  importBusy: 'Importing…',
  importDone: 'Done',
  importOpen: 'Open feed',
  importRetry: 'Try again'
});

export function copy(key, fallback = '') {
  return COPY[key] ?? fallback;
}
