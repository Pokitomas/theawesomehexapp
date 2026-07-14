export const COPY = Object.freeze({
  brand: 'Sideways',
  feed: 'Feed',
  places: 'Places',
  library: 'Library',
  you: 'You',
  ready: 'Ready',
  emptyTitle: 'This is your internet.',
  emptyBody: 'Make one thing, or tap once and give the feed a pulse.',
  emptyPost: 'WRITE',
  emptyImport: 'START ME OFF',
  feedTitle: 'Your feed',
  feedSubtitle: 'What you make and what you recover live together.',
  newPost: 'New post',
  editPost: 'Edit post',
  composerPlaceholder: 'Put something into the world…',
  draftRestored: 'Draft restored',
  addPhoto: 'Add photo',
  addPlace: 'Add place',
  noPlace: 'No place',
  profileTitle: 'Your profile',
  profileBody: 'Three fields. No résumé. No personality quiz.',
  placesTitle: 'Places',
  placesBody: 'Pin a thought to somewhere real, remembered, or invented.',
  placesEmpty: 'No places yet.',
  placeName: 'Place name',
  placeDetail: 'A note, address, memory, or context',
  libraryTitle: 'Bring your life back in',
  importTitle: 'Where did it come from?',
  importBusy: 'Pulling it together…',
  importDone: 'It is in your feed.',
  importOpen: 'OPEN FEED',
  importRetry: 'Try again'
});

export function copy(key, fallback = '') {
  return COPY[key] ?? fallback;
}
