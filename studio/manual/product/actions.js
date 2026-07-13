const define = (id, label, surface, intent, payload = {}) => Object.freeze({
  id,
  label,
  surface,
  intent,
  payload: Object.freeze(payload)
});

export const ACTIONS = Object.freeze({
  'nav.feed': define('nav.feed', 'FEED', 'nav', 'navigate', { route: '#/feed' }),
  'nav.import': define('nav.import', 'ADD', 'nav', 'navigate', { route: '#/add' }),
  'nav.saved': define('nav.saved', 'SAVED', 'nav', 'navigate', { route: '#/saved' }),
  'nav.profile': define('nav.profile', 'ME', 'nav', 'open_profile'),
  'feed.post': define('feed.post', 'POST', 'feed', 'open_composer'),
  'feed.import': define('feed.import', 'IMPORT', 'feed', 'navigate', { route: '#/add' }),

  'profile.open': define('profile.open', 'ME', 'profile', 'open_profile'),
  'profile.save': define('profile.save', 'SAVE', 'profile', 'save_profile', { fields: ['name', 'handle', 'avatar', 'color'] }),
  'profile.random': define('profile.random', 'RANDOM', 'profile', 'randomize_profile'),
  'profile.close': define('profile.close', 'CLOSE', 'profile', 'close_profile'),
  'profile.avatar': define('profile.avatar', 'AVATAR', 'profile', 'select_avatar', { value: 'string' }),
  'profile.color': define('profile.color', 'COLOR', 'profile', 'select_color', { value: 'string' }),

  'post.open': define('post.open', 'POST', 'composer', 'open_composer'),
  'post.publish': define('post.publish', 'POST IT', 'composer', 'create_post', { fields: ['text', 'image', 'mood', 'style', 'remixOf'] }),
  'post.cancel': define('post.cancel', 'CANCEL', 'composer', 'close_composer'),
  'post.attach': define('post.attach', 'PHOTO', 'composer', 'attach_image', { accepts: ['image/*'] }),
  'post.mood': define('post.mood', 'MOOD', 'composer', 'select_mood', { value: 'string' }),
  'post.style': define('post.style', 'STYLE', 'composer', 'select_style', { value: 'string' }),
  'post.react': define('post.react', 'REACT', 'post', 'react', { reaction: 'string', postId: 'string' }),
  'post.remix': define('post.remix', 'REMIX', 'post', 'open_remix', { postId: 'string' }),
  'post.save': define('post.save', 'SAVE', 'post', 'toggle_save', { postId: 'string' }),
  'post.share': define('post.share', 'SEND', 'post', 'share', { postId: 'string' }),
  'post.delete': define('post.delete', 'DELETE', 'post', 'delete_post', { postId: 'string' }),

  'import.instagram': define('import.instagram', 'IMPORT INSTAGRAM', 'import', 'pick_import', { platform: 'instagram' }),
  'import.reddit': define('import.reddit', 'IMPORT REDDIT', 'import', 'pick_import', { platform: 'reddit' }),
  'import.tiktok': define('import.tiktok', 'IMPORT TIKTOK', 'import', 'pick_import', { platform: 'tiktok' }),
  'import.youtube': define('import.youtube', 'IMPORT YOUTUBE', 'import', 'pick_import', { platform: 'youtube' }),
  'import.spotify': define('import.spotify', 'IMPORT SPOTIFY', 'import', 'pick_import', { platform: 'spotify' }),
  'import.x': define('import.x', 'IMPORT X', 'import', 'pick_import', { platform: 'x' }),
  'import.browser': define('import.browser', 'IMPORT BOOKMARKS', 'import', 'pick_import', { platform: 'browser' }),
  'import.anything': define('import.anything', 'IMPORT SOMETHING', 'import', 'pick_import', { platform: 'anything' }),
  'import.help': define('import.help', 'GET DOWNLOAD', 'import', 'open_export_help', { platform: 'string' }),
  'import.stop': define('import.stop', 'STOP', 'import', 'cancel_import'),
  'import.retry': define('import.retry', 'TRY AGAIN', 'import', 'retry_import'),
  'import.open_feed': define('import.open_feed', 'OPEN FEED', 'import', 'navigate', { route: '#/feed' })
});

export function action(id) {
  const value = ACTIONS[id];
  if (!value) throw new Error(`UNKNOWN ACTION: ${id}`);
  return value;
}

export function emitAction(id, detail = {}) {
  const definition = action(id);
  const event = Object.freeze({
    actionId: id,
    surface: definition.surface,
    intent: definition.intent,
    at: new Date().toISOString(),
    ...detail
  });
  window.dispatchEvent(new CustomEvent('sideways:action', { detail: event }));
  return event;
}

export function bindAction(node, id, handler, options = {}) {
  const definition = action(id);
  node.dataset.actionId = id;
  node.dataset.actionIntent = definition.intent;
  node.setAttribute('aria-label', options.ariaLabel || definition.label);
  const eventName = options.eventName || 'click';
  node.addEventListener(eventName, async event => {
    const payload = typeof options.payload === 'function' ? options.payload(event) : (options.payload || {});
    emitAction(id, { phase: 'start', ...payload });
    try {
      const result = await handler?.(event, definition);
      emitAction(id, { phase: 'success', result: result ?? null, ...payload });
    } catch (error) {
      emitAction(id, { phase: 'error', error: error?.message || String(error), ...payload });
      throw error;
    }
  });
  return node;
}

export function actionButton(id, handler, options = {}) {
  const definition = action(id);
  const tag = options.tag || 'button';
  const node = document.createElement(tag);
  node.className = options.className || '';
  node.textContent = options.label || definition.label;
  if (tag === 'button') node.type = options.type || 'button';
  return bindAction(node, id, handler, options);
}

export function actionContract() {
  return Object.values(ACTIONS).map(item => ({
    id: item.id,
    label: item.label,
    surface: item.surface,
    intent: item.intent,
    payload: item.payload
  }));
}

window.SidewaysActions = Object.freeze({ ACTIONS, action, emitAction, bindAction, actionButton, actionContract });
