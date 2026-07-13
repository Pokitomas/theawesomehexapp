export const COPY = Object.freeze({
  brand: 'SIDEWAYS',
  kicker: 'YOUR STUFF. ONE FEED.',
  headline: 'BRING YOUR INTERNET WITH YOU.',
  intro: 'Instagram, Reddit, TikTok, YouTube, Spotify, X, bookmarks—bring it over.',
  privacy: 'Private on this device.',
  emptyTitle: 'BRING SOMETHING OVER.',
  emptyBody: 'Instagram? Reddit? Whatever. Tap it.',
  emptyAction: 'PICK AN APP',
  sourceLabel: 'FROM YOUR STUFF',
  localBadge: 'PRIVATE',
  addHint: 'INSTAGRAM, REDDIT, TIKTOK, YOUTUBE, SPOTIFY, X, BOOKMARKS, OR ANYTHING',
  ready: 'NEW FEED',
  saved: 'SAVED',
  profile: 'PROFILE',
  footer: 'YOUR STUFF, RECOMPOSED',
  feedLearning: 'GOOD START.',
  feedLearningBody: 'Bring over another app or just use the feed. It changes as you use it.',
  feedAwake: 'YOUR FEED IS READY.',
  feedAwakeBody: 'Keep what you like. Skip what you do not. Bring over more whenever.',
  importTitle: 'WHAT ARE YOU BRINGING OVER?',
  importBody: 'Tap an app.',
  chooseSource: 'PICK AN APP',
  chooseSourceBody: 'Instagram, Reddit, TikTok—whatever you use.',
  importBusy: 'BRINGING IT OVER…',
  importDone: 'IT’S IN.',
  importOpen: 'OPEN MY FEED',
  importRetry: 'TRY AGAIN'
});

export function copy(key, fallback = '') {
  return COPY[key] ?? fallback;
}
