const define = (id, label, surface, intent, payload = {}) => Object.freeze({
  id,
  label,
  surface,
  intent,
  payload: Object.freeze(payload)
});

export const ACTIONS = Object.freeze({
  'nav.feed': define('nav.feed', 'Feed', 'navigation', 'navigate', { route: '#/feed' }),
  'nav.places': define('nav.places', 'Places', 'navigation', 'navigate', { route: '#/places' }),
  'nav.library': define('nav.library', 'Library', 'navigation', 'navigate', { route: '#/add' }),
  'nav.import': define('nav.import', 'Library', 'navigation', 'navigate', { route: '#/add' }),
  'nav.saved': define('nav.saved', 'Saved', 'navigation', 'navigate', { route: '#/saved' }),
  'nav.profile': define('nav.profile', 'You', 'navigation', 'open_profile'),

  'feed.post': define('feed.post', 'New', 'feed', 'open_composer'),
  'feed.import': define('feed.import', 'Import', 'feed', 'navigate', { route: '#/add' }),

  'view.flow': define('view.flow', 'Flow', 'view', 'set_feed_mode', { mode: 'flow' }),
  'view.stage': define('view.stage', 'Stage', 'view', 'set_feed_mode', { mode: 'stage' }),
  'view.grid': define('view.grid', 'Grid', 'view', 'set_feed_mode', { mode: 'grid' }),

  'profile.open': define('profile.open', 'You', 'profile', 'open_profile'),
  'profile.save': define('profile.save', 'Save changes', 'profile', 'save_profile', { fields: ['name', 'handle', 'bio', 'accent'] }),
  'profile.close': define('profile.close', 'Close', 'profile', 'close_profile'),
  'profile.accent': define('profile.accent', 'Accent', 'profile', 'select_accent', { value: 'string' }),

  'post.open': define('post.open', 'New post', 'composer', 'open_composer'),
  'post.publish': define('post.publish', 'Publish', 'composer', 'publish_entry', { fields: ['text', 'image', 'placeId'] }),
  'post.cancel': define('post.cancel', 'Close', 'composer', 'close_composer'),
  'post.attach': define('post.attach', 'Add photo', 'composer', 'attach_image', { accepts: ['image/*'] }),
  'post.remove_attachment': define('post.remove_attachment', 'Remove photo', 'composer', 'remove_image'),
  'post.edit': define('post.edit', 'Edit', 'post', 'edit_entry', { recordId: 'number' }),
  'post.delete': define('post.delete', 'Delete', 'post', 'delete_entry', { recordId: 'number' }),
  'post.save': define('post.save', 'Save', 'post', 'toggle_save', { recordId: 'number' }),
  'post.share': define('post.share', 'Send', 'post', 'share', { recordId: 'number' }),

  'record.source': define('record.source', 'Open source', 'record', 'open_source', { recordId: 'number' }),
  'record.author': define('record.author', 'Open author', 'record', 'open_author', { recordId: 'number' }),
  'record.open': define('record.open', 'Read', 'record', 'open_record', { recordId: 'number' }),
  'record.save': define('record.save', 'Save', 'record', 'toggle_save', { recordId: 'number' }),
  'record.collect': define('record.collect', 'Add to collection', 'record', 'collect', { recordId: 'number' }),
  'record.share': define('record.share', 'Send', 'record', 'share', { recordId: 'number' }),

  'composer.place': define('composer.place', 'Add place', 'composer', 'open_place_picker'),
  'composer.clear_place': define('composer.clear_place', 'Remove place', 'composer', 'clear_place'),

  'places.open': define('places.open', 'Places', 'places', 'navigate', { route: '#/places' }),
  'places.create': define('places.create', 'New place', 'places', 'open_place_editor'),
  'places.save': define('places.save', 'Save place', 'places', 'save_place', { fields: ['name', 'detail', 'latitude', 'longitude'] }),
  'places.use': define('places.use', 'Use place', 'places', 'select_place', { placeId: 'string' }),
  'places.locate': define('places.locate', 'Use current location', 'places', 'request_location'),
  'places.delete': define('places.delete', 'Delete place', 'places', 'delete_place', { placeId: 'string' }),
  'places.close': define('places.close', 'Close', 'places', 'close_places'),

  'library.saved': define('library.saved', 'Open saved', 'library', 'navigate', { route: '#/saved' }),

  'import.instagram': define('import.instagram', 'IMPORT INSTAGRAM', 'import', 'pick_import', { platform: 'instagram' }),
  'import.reddit': define('import.reddit', 'IMPORT REDDIT', 'import', 'pick_import', { platform: 'reddit' }),
  'import.tiktok': define('import.tiktok', 'IMPORT TIKTOK', 'import', 'pick_import', { platform: 'tiktok' }),
  'import.youtube': define('import.youtube', 'IMPORT YOUTUBE', 'import', 'pick_import', { platform: 'youtube' }),
  'import.spotify': define('import.spotify', 'IMPORT SPOTIFY', 'import', 'pick_import', { platform: 'spotify' }),
  'import.x': define('import.x', 'IMPORT X', 'import', 'pick_import', { platform: 'x' }),
  'import.browser': define('import.browser', 'IMPORT BOOKMARKS', 'import', 'pick_import', { platform: 'browser' }),
  'import.anything': define('import.anything', 'IMPORT SOMETHING', 'import', 'pick_import', { platform: 'anything' }),
  'import.help': define('import.help', 'Get download', 'import', 'open_export_help', { platform: 'string' }),
  'import.stop': define('import.stop', 'Stop', 'import', 'cancel_import'),
  'import.retry': define('import.retry', 'Try again', 'import', 'retry_import'),
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
  node.dataset.actionLabel = definition.label;
  node.setAttribute('aria-label', options.ariaLabel || definition.label);
  const eventName = options.eventName || 'click';
  node.addEventListener(eventName, async event => {
    const payload = typeof options.payload === 'function' ? options.payload(event) : (options.payload || {});
    emitAction(id, { phase: 'start', ...payload });
    try {
      const result = await handler?.(event, definition);
      const phase = result?.cancelled === true ? 'cancelled' : 'success';
      emitAction(id, { phase, result: result ?? null, ...payload });
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
