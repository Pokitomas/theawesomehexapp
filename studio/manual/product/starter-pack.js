const clean = value => String(value || '').replace(/\u0000/g, '').trim();

export function starterPack(profile = {}, now = Date.now()) {
  const first = clean(profile.name).split(/\s+/)[0] || 'you';
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
