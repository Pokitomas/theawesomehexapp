const STARTER_PATH = '/api/starter';
const STATIC_STARTER_MARKER = '__sidewaysStaticStarterFallbackV1';

function builtInStarterPack(profile = {}, now = Date.now()) {
  const first = String(profile.name || '').trim().split(/\s+/)[0] || 'you';
  const minute = 60_000;
  const item = (id, age, author, title, text, tags = []) => ({
    id,
    type: 'social',
    source: 'Sideways starter',
    published: new Date(now - age * minute).toISOString(),
    author,
    title,
    text,
    summary: text,
    tags
  });
  return [
    item('small-internet', 3, { name: 'Mara V.', handle: '@marav', url: '', avatar: '' }, 'A smaller internet can feel bigger.', 'The good part was never infinite content. It was noticing the same people becoming more themselves.', ['conversation']),
    item('camera-roll', 11, { name: 'Niko', handle: '@niko', url: '', avatar: '' }, 'Your camera roll is already a magazine.', 'Pick six photos from one ordinary week. The sequence usually knows what the week was about before you do.', ['photo']),
    item('reply-shape', 24, { name: 'June Park', handle: '@june', url: '', avatar: '' }, 'Replies should change the shape of the post.', 'A good reply is not a number under the original. It is a door the original did not know it had.', ['conversation']),
    item('hello', 38, { name: 'Sideways', handle: '@sideways', url: '', avatar: '' }, `Welcome, ${first}.`, 'Like something. Reply to it. Remix it into your own post. Nothing here needs permission from an algorithm.', ['welcome']),
    item('desktop', 62, { name: 'Inez', handle: '@inez', url: '', avatar: '' }, 'The desktop is a social gesture.', 'When you move two posts beside each other, you are making an argument without writing a paragraph.', ['desktop']),
    item('boring-feature', 96, { name: 'Alex B.', handle: '@alexb', url: '', avatar: '' }, 'The most advanced feature is a button that feels inevitable.', 'No tutorial. No mysterious icon. The action is exactly where your thumb expected it to be.', ['design']),
    item('local', 140, { name: 'Rae', handle: '@rae', url: '', avatar: '' }, 'Local-first is emotional, not technical.', 'It means the thing you made still feels like yours when the network disappears.', ['local-first']),
    item('remix', 215, { name: 'Tomas', handle: '@tomas', url: '', avatar: '' }, 'Remix is a better share button.', 'Sharing moves the object. Remixing admits that the object moved you.', ['remix'])
  ];
}

function starterProfile(init = {}) {
  try {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    return body.profile && typeof body.profile === 'object' ? body.profile : {};
  } catch {
    return {};
  }
}

function installStaticStarterFallback() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function' || window[STATIC_STARTER_MARKER]) return;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const target = input instanceof Request ? input.url : String(input);
    const url = new URL(target, location.href);
    const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.pathname !== STARTER_PATH || method !== 'POST') return nativeFetch(input, init);
    try {
      const response = await nativeFetch(input, init);
      if (response.ok) return response;
    } catch {
      // A static Drop has no function endpoint. The built-in pack keeps onboarding useful.
    }
    return new Response(JSON.stringify({ version: 1, items: builtInStarterPack(starterProfile(init)) }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-sideways-source': 'built-in' }
    });
  };
  window[STATIC_STARTER_MARKER] = true;
}

installStaticStarterFallback();

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
