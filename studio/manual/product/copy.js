export const COPY = Object.freeze({
  brand: 'Sideways',
  feed: 'Feed',
  places: 'Places',
  library: 'Library',
  you: 'You',
  ready: 'Ready',
  emptyTitle: 'Make something, or bring something in.',
  emptyBody: 'Your feed starts with what you add and changes as you use it.',
  emptyPost: 'New post',
  emptyImport: 'Import',
  feedTitle: 'Your feed',
  feedSubtitle: 'Posts and imports live together here.',
  newPost: 'New post',
  editPost: 'Edit post',
  composerPlaceholder: 'Write something…',
  draftRestored: 'Draft restored',
  addPhoto: 'Add photo',
  addPlace: 'Add place',
  noPlace: 'No place',
  profileTitle: 'Your profile',
  profileBody: 'This name travels with posts and future imports on this device.',
  placesTitle: 'Places',
  placesBody: 'Attach a place when it matters. Nothing is shared unless you publish it.',
  placesEmpty: 'No places yet.',
  placeName: 'Place name',
  placeDetail: 'A note, address, or context',
  libraryTitle: 'Bring things in',
  importTitle: 'Choose where it came from',
  importBusy: 'Importing…',
  importDone: 'Added to your feed.',
  importOpen: 'OPEN FEED',
  importRetry: 'Try again'
});

export function copy(key, fallback = '') {
  return COPY[key] ?? fallback;
}
