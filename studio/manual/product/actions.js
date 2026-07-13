import { icon } from './icons.js';

const define = (id, config) => Object.freeze({
  id,
  label: config.label,
  icon: config.icon,
  surface: config.surface,
  intent: config.intent,
  command: config.command || config.intent,
  payload: Object.freeze(config.payload || {}),
  result: Object.freeze(config.result || {}),
  optimistic: Boolean(config.optimistic),
  undoable: Boolean(config.undoable),
  destructive: Boolean(config.destructive)
});

export const ACTIONS = Object.freeze({
  'nav.feed': define('nav.feed', { label: 'Feed', icon: 'feed', surface: 'dock', intent: 'navigate', payload: { route: '#/feed' } }),
  'nav.places': define('nav.places', { label: 'Places', icon: 'places', surface: 'dock', intent: 'navigate', payload: { route: '#/places' } }),
  'nav.create': define('nav.create', { label: 'Create', icon: 'create', surface: 'dock', intent: 'open_create' }),
  'nav.me': define('nav.me', { label: 'Me', icon: 'me', surface: 'dock', intent: 'navigate', payload: { route: '#/me' } }),

  'create.post': define('create.post', { label: 'Post', icon: 'post', surface: 'create', intent: 'open_composer' }),
  'create.import': define('create.import', { label: 'Import', icon: 'import', surface: 'create', intent: 'open_import' }),
  'create.place': define('create.place', { label: 'New place', icon: 'folder', surface: 'create', intent: 'create_place' }),
  'create.close': define('create.close', { label: 'Close', icon: 'close', surface: 'create', intent: 'close_sheet' }),

  'profile.open': define('profile.open', { label: 'Me', icon: 'me', surface: 'profile', intent: 'open_profile' }),
  'profile.save': define('profile.save', { label: 'Done', icon: 'check', surface: 'profile', intent: 'save_profile', command: 'profile.upsert', payload: { fields: ['name', 'handle', 'avatar', 'color'] }, result: { profileId: 'string' }, optimistic: true }),
  'profile.random': define('profile.random', { label: 'Shuffle', icon: 'spark', surface: 'profile', intent: 'randomize_profile' }),
  'profile.close': define('profile.close', { label: 'Close', icon: 'close', surface: 'profile', intent: 'close_profile' }),
  'profile.avatar': define('profile.avatar', { label: 'Face', icon: 'me', surface: 'profile', intent: 'select_avatar', payload: { value: 'string' }, optimistic: true }),
  'profile.color': define('profile.color', { label: 'Color', icon: 'spark', surface: 'profile', intent: 'select_color', payload: { value: 'string' }, optimistic: true }),

  'post.open': define('post.open', { label: 'Post', icon: 'post', surface: 'composer', intent: 'open_composer' }),
  'post.publish': define('post.publish', { label: 'Post', icon: 'send', surface: 'composer', intent: 'publish', command: 'workspace.publishDraft', payload: { draftId: 'string', fields: ['text', 'image', 'style', 'placeId', 'remixOf'] }, result: { entityId: 'string' } }),
  'post.update': define('post.update', { label: 'Save changes', icon: 'check', surface: 'composer', intent: 'update_post', command: 'workspace.updateEntity', payload: { entityId: 'string', patch: 'object' }, result: { entityId: 'string' }, optimistic: true, undoable: true }),
  'post.cancel': define('post.cancel', { label: 'Close', icon: 'close', surface: 'composer', intent: 'close_composer' }),
  'post.attach': define('post.attach', { label: 'Photo', icon: 'image', surface: 'composer', intent: 'attach_image', payload: { accepts: ['image/*'] } }),
  'post.link': define('post.link', { label: 'Link', icon: 'link', surface: 'composer', intent: 'attach_link', payload: { url: 'url' } }),
  'post.style': define('post.style', { label: 'Look', icon: 'spark', surface: 'composer', intent: 'select_style', payload: { value: 'string' }, optimistic: true }),
  'post.place': define('post.place', { label: 'Place', icon: 'places', surface: 'composer', intent: 'select_place', payload: { placeId: 'string' }, optimistic: true }),
  'post.edit': define('post.edit', { label: 'Edit', icon: 'edit', surface: 'entity', intent: 'edit_post', payload: { entityId: 'string' } }),
  'post.remix': define('post.remix', { label: 'Remix', icon: 'remix', surface: 'entity', intent: 'open_remix', payload: { entityId: 'string' } }),
  'post.move': define('post.move', { label: 'Move', icon: 'move', surface: 'entity', intent: 'move_entity', command: 'workspace.moveEntity', payload: { entityId: 'string', placeId: 'string' }, result: { entityId: 'string', placeId: 'string' }, optimistic: true, undoable: true }),
  'post.later': define('post.later', { label: 'Later', icon: 'later', surface: 'entity', intent: 'move_later', command: 'workspace.moveEntity', payload: { entityId: 'string', placeId: 'later' }, result: { entityId: 'string', placeId: 'later' }, optimistic: true, undoable: true }),
  'post.share': define('post.share', { label: 'Send', icon: 'send', surface: 'entity', intent: 'share', payload: { entityId: 'string' } }),
  'post.archive': define('post.archive', { label: 'Archive', icon: 'archive', surface: 'entity', intent: 'archive', command: 'workspace.archiveEntity', payload: { entityId: 'string' }, result: { entityId: 'string' }, optimistic: true, undoable: true }),
  'post.restore': define('post.restore', { label: 'Restore', icon: 'undo', surface: 'entity', intent: 'restore', command: 'workspace.restoreEntity', payload: { entityId: 'string' }, result: { entityId: 'string' }, optimistic: true }),
  'post.delete': define('post.delete', { label: 'Delete', icon: 'trash', surface: 'entity', intent: 'delete_post', command: 'workspace.deleteEntity', payload: { entityId: 'string' }, result: { entityId: 'string' }, undoable: true, destructive: true }),
  'post.more': define('post.more', { label: 'More', icon: 'more', surface: 'entity', intent: 'open_entity_menu', payload: { entityId: 'string' } }),

  'draft.resume': define('draft.resume', { label: 'Continue', icon: 'draft', surface: 'me', intent: 'resume_draft', payload: { draftId: 'string' } }),
  'draft.discard': define('draft.discard', { label: 'Discard', icon: 'trash', surface: 'me', intent: 'discard_draft', command: 'workspace.deleteDraft', payload: { draftId: 'string' }, undoable: true, destructive: true }),
  'draft.autosave': define('draft.autosave', { label: 'Saved', icon: 'check', surface: 'system', intent: 'autosave_draft', command: 'workspace.saveDraft', payload: { draft: 'object' }, result: { draftId: 'string' } }),

  'place.open': define('place.open', { label: 'Open', icon: 'chevron', surface: 'places', intent: 'open_place', payload: { placeId: 'string' } }),
  'place.create': define('place.create', { label: 'New place', icon: 'create', surface: 'places', intent: 'create_place', command: 'workspace.createPlace', payload: { name: 'string', icon: 'string', color: 'string' }, result: { placeId: 'string' } }),
  'place.rename': define('place.rename', { label: 'Rename', icon: 'edit', surface: 'places', intent: 'rename_place', command: 'workspace.renamePlace', payload: { placeId: 'string', name: 'string' }, optimistic: true, undoable: true }),
  'place.delete': define('place.delete', { label: 'Delete place', icon: 'trash', surface: 'places', intent: 'delete_place', command: 'workspace.deletePlace', payload: { placeId: 'string' }, result: { movedEntities: 'number' }, undoable: true, destructive: true }),
  'place.reorder': define('place.reorder', { label: 'Reorder', icon: 'move', surface: 'places', intent: 'reorder_place', command: 'workspace.reorderPlaces', payload: { orderedIds: 'array' }, optimistic: true, undoable: true }),

  'undo.last': define('undo.last', { label: 'Undo', icon: 'undo', surface: 'toast', intent: 'undo_last', command: 'workspace.undo', result: { restored: 'boolean' } }),

  'import.instagram': define('import.instagram', { label: 'Instagram', icon: 'image', surface: 'import', intent: 'pick_import', payload: { platform: 'instagram' } }),
  'import.reddit': define('import.reddit', { label: 'Reddit', icon: 'globe', surface: 'import', intent: 'pick_import', payload: { platform: 'reddit' } }),
  'import.tiktok': define('import.tiktok', { label: 'TikTok', icon: 'spark', surface: 'import', intent: 'pick_import', payload: { platform: 'tiktok' } }),
  'import.youtube': define('import.youtube', { label: 'YouTube', icon: 'window', surface: 'import', intent: 'pick_import', payload: { platform: 'youtube' } }),
  'import.spotify': define('import.spotify', { label: 'Spotify', icon: 'feed', surface: 'import', intent: 'pick_import', payload: { platform: 'spotify' } }),
  'import.x': define('import.x', { label: 'X', icon: 'post', surface: 'import', intent: 'pick_import', payload: { platform: 'x' } }),
  'import.browser': define('import.browser', { label: 'Bookmarks', icon: 'folder', surface: 'import', intent: 'pick_import', payload: { platform: 'browser' } }),
  'import.anything': define('import.anything', { label: 'Files', icon: 'import', surface: 'import', intent: 'pick_import', payload: { platform: 'anything' } }),
  'import.help': define('import.help', { label: 'Get download', icon: 'link', surface: 'import', intent: 'open_export_help', payload: { platform: 'string' } }),
  'import.stop': define('import.stop', { label: 'Stop', icon: 'close', surface: 'import', intent: 'cancel_import' }),
  'import.retry': define('import.retry', { label: 'Try again', icon: 'undo', surface: 'import', intent: 'retry_import' }),
  'import.open_feed': define('import.open_feed', { label: 'Open feed', icon: 'feed', surface: 'import', intent: 'navigate', payload: { route: '#/feed' } })
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
    command: definition.command,
    optimistic: definition.optimistic,
    undoable: definition.undoable,
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
  node.dataset.actionCommand = definition.command;
  node.dataset.actionOptimistic = String(definition.optimistic);
  node.dataset.actionUndoable = String(definition.undoable);
  if (definition.destructive) node.dataset.actionDestructive = 'true';
  node.setAttribute('aria-label', options.ariaLabel || definition.label);
  const eventName = options.eventName || 'click';
  node.addEventListener(eventName, async event => {
    const payload = typeof options.payload === 'function' ? options.payload(event) : (options.payload || {});
    emitAction(id, { phase: 'start', ...payload });
    try {
      const result = await handler?.(event, definition);
      emitAction(id, { phase: 'success', result: result ?? null, ...payload });
      return result;
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
  node.className = options.className || 'ui-button';
  if (tag === 'button') node.type = options.type || 'button';
  const iconName = options.icon === false ? null : (options.icon || definition.icon);
  if (iconName) node.append(icon(iconName));
  if (!options.iconOnly) {
    const label = document.createElement('span');
    label.className = 'ui-button-label';
    label.textContent = options.label || definition.label;
    node.append(label);
  }
  if (options.badge !== undefined) {
    const badge = document.createElement('span');
    badge.className = 'ui-button-badge';
    badge.textContent = String(options.badge);
    node.append(badge);
  }
  return bindAction(node, id, handler, options);
}

export function actionContract() {
  return Object.values(ACTIONS).map(item => ({
    id: item.id,
    label: item.label,
    icon: item.icon,
    surface: item.surface,
    intent: item.intent,
    command: item.command,
    payload: item.payload,
    result: item.result,
    optimistic: item.optimistic,
    undoable: item.undoable,
    destructive: item.destructive
  }));
}

window.SidewaysActions = Object.freeze({ ACTIONS, action, emitAction, bindAction, actionButton, actionContract });
