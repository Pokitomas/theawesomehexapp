import { COPY } from './copy.js';
import { actionButton, bindAction } from './actions.js';
import { Workspace } from './workspace.js';

let profileDialog;
let composerDialog;
let placeEditorDialog;
let placesView;
let composerImage = null;
let composerImageURL = '';
let editingRecord = null;
let selectedPlaceId = '';
let autosaveTimer = 0;
let renderScheduled = false;
let placesOpen = false;

const KNOWN_VIEWS = ['feedView', 'addView', 'savedView', 'profileView', 'detailView'];

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function icon(name, className = 'workspace-icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `./system-icons.svg#${name}`);
  svg.append(use);
  return svg;
}

function iconButton(actionId, iconName, handler, options = {}) {
  const button = actionButton(actionId, handler, options);
  const label = options.label || window.SidewaysActions.action(actionId).label;
  button.replaceChildren(icon(iconName), el('span', 'workspace-button-label', label));
  return button;
}

function closeDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === 'function' && dialog.open) dialog.close();
  else dialog.removeAttribute('open');
}

function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function setStatus(node, message = '', tone = '') {
  node.textContent = message;
  node.dataset.tone = tone;
  node.hidden = !message;
}

function routeTo(hash) {
  placesOpen = false;
  if (window.SidewaysCore?.routeTo) window.SidewaysCore.routeTo(hash);
  else location.hash = hash;
  scheduleRender();
}

function profileInitials(profile) {
  return String(profile.name || 'You')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join('') || 'Y';
}

function profileMark(profile, className = 'workspace-profile-mark') {
  const mark = el('span', className, profileInitials(profile));
  mark.style.setProperty('--profile-accent', profile.accent);
  return mark;
}

function applyProfile(profile = Workspace.profile()) {
  document.documentElement.style.setProperty('--workspace-accent', profile.accent);
  document.documentElement.dataset.workspaceProfile = profile.handle || 'local';
  const navProfile = document.getElementById('navProfile');
  if (navProfile) {
    const label = el('span', 'workspace-button-label', COPY.you);
    navProfile.replaceChildren(profileMark(profile, 'workspace-nav-avatar'), label);
  }
}

function buildProfileDialog() {
  const profile = Workspace.profile();
  const dialog = el('dialog', 'workspace-dialog workspace-profile-dialog');
  dialog.dataset.workspaceProfileDialog = 'true';
  const window = el('section', 'workspace-window');
  const bar = el('header', 'workspace-window-bar');
  const title = el('div', 'workspace-window-title');
  title.append(icon('user'), el('span', '', COPY.profileTitle));
  bar.append(title, iconButton('profile.close', 'close', () => closeDialog(dialog), { className: 'workspace-icon-button', label: 'Close' }));

  const body = el('div', 'workspace-window-body workspace-profile-body');
  const preview = el('div', 'workspace-profile-preview');
  const mark = profileMark(profile, 'workspace-profile-large');
  const previewCopy = el('div');
  const previewName = el('strong', '', profile.name);
  const previewHandle = el('span', '', profile.handle ? `@${profile.handle}` : 'Local profile');
  previewCopy.append(previewName, previewHandle);
  preview.append(mark, previewCopy);

  const note = el('p', 'workspace-explainer', COPY.profileBody);
  const form = el('div', 'workspace-form-grid');
  const name = field('Name', 'input', { name: 'workspaceName', value: profile.name === 'You' ? '' : profile.name, maxLength: 48, autocomplete: 'name' });
  const handle = field('Handle', 'input', { name: 'workspaceHandle', value: profile.handle ? `@${profile.handle}` : '', maxLength: 31, inputMode: 'text' });
  const bio = field('Bio', 'textarea', { name: 'workspaceBio', value: profile.bio, maxLength: 180, rows: 3 });
  form.append(name.wrap, handle.wrap, bio.wrap);

  const accents = el('fieldset', 'workspace-accent-picker');
  accents.append(el('legend', '', 'Accent'));
  let draftAccent = profile.accent;
  const paintAccents = () => {
    accents.querySelectorAll('button').forEach(button => button.classList.toggle('is-selected', button.dataset.value === draftAccent));
    mark.style.setProperty('--profile-accent', draftAccent);
  };
  for (const value of Workspace.accents) {
    const button = actionButton('profile.accent', () => {
      draftAccent = value;
      paintAccents();
      return { accent: value };
    }, { className: 'workspace-accent', label: value, ariaLabel: `Use ${value} accent`, payload: { value } });
    button.dataset.value = value;
    button.textContent = '';
    button.style.setProperty('--swatch', value);
    accents.append(button);
  }
  paintAccents();

  name.input.addEventListener('input', () => { previewName.textContent = name.input.value.trim() || 'You'; });
  handle.input.addEventListener('input', () => { previewHandle.textContent = handle.input.value.trim() || 'Local profile'; });

  const status = el('p', 'workspace-inline-status');
  status.hidden = true;
  const footer = el('footer', 'workspace-window-footer');
  footer.append(status, iconButton('profile.save', 'check', () => {
    const saved = Workspace.saveProfile({ name: name.input.value, handle: handle.input.value, bio: bio.input.value, accent: draftAccent });
    applyProfile(saved);
    closeDialog(dialog);
    scheduleRender();
    return saved;
  }, { className: 'workspace-primary', label: 'Save changes' }));

  body.append(preview, note, form, accents);
  window.append(bar, body, footer);
  dialog.append(window);
  document.body.append(dialog);
  return dialog;
}

function field(labelText, kind = 'input', attributes = {}) {
  const wrap = el('label', 'workspace-field');
  wrap.append(el('span', 'workspace-field-label', labelText));
  const input = document.createElement(kind);
  input.className = 'workspace-input';
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'value') input.value = value || '';
    else if (value !== undefined && value !== null) input[key] = value;
  }
  wrap.append(input);
  return { wrap, input };
}

function openProfile() {
  profileDialog?.remove();
  profileDialog = buildProfileDialog();
  openDialog(profileDialog);
}

function clearComposerImage() {
  composerImage = null;
  if (composerImageURL) URL.revokeObjectURL(composerImageURL);
  composerImageURL = '';
  composerDialog?._workspace?.imagePreview?.replaceChildren();
  composerDialog?._workspace?.removeImage?.setAttribute('hidden', '');
}

function renderImagePreview(image) {
  const api = composerDialog?._workspace;
  if (!api) return;
  api.imagePreview.replaceChildren();
  if (!image) {
    api.removeImage.hidden = true;
    return;
  }
  const img = new Image();
  if (image.blob) {
    if (composerImageURL) URL.revokeObjectURL(composerImageURL);
    composerImageURL = URL.createObjectURL(image.blob);
    img.src = composerImageURL;
  } else if (image.url) img.src = image.url;
  img.alt = '';
  api.imagePreview.append(img);
  api.removeImage.hidden = false;
}

async function currentComposerPayload() {
  const api = composerDialog._workspace;
  return {
    text: api.textarea.value,
    placeId: selectedPlaceId,
    image: composerImage,
    removeImage: api.removeExistingImage.checked
  };
}

function queueDraftSave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(async () => {
    const api = composerDialog?._workspace;
    if (!api || !composerDialog.open) return;
    await Workspace.saveDraft({ text: api.textarea.value, placeId: selectedPlaceId, editingRecordId: editingRecord?.id || 0 });
    setStatus(api.draftStatus, 'Saved on this device');
  }, 350);
}

async function renderComposerPlace() {
  const api = composerDialog?._workspace;
  if (!api) return;
  const places = await Workspace.listPlaces();
  const place = places.find(item => item.id === selectedPlaceId);
  api.placeButton.querySelector('.workspace-button-label').textContent = place?.name || COPY.addPlace;
  api.placeButton.classList.toggle('has-value', Boolean(place));
  api.clearPlace.hidden = !place;
}

function buildComposerDialog() {
  const dialog = el('dialog', 'workspace-dialog workspace-composer-dialog');
  dialog.dataset.workspaceComposer = 'true';
  const window = el('section', 'workspace-window');
  const bar = el('header', 'workspace-window-bar');
  const title = el('div', 'workspace-window-title');
  title.append(icon('compose'), el('span', 'workspace-composer-title', COPY.newPost));
  bar.append(title, iconButton('post.cancel', 'close', () => closeDialog(dialog), { className: 'workspace-icon-button', label: 'Close' }));

  const body = el('div', 'workspace-window-body workspace-composer-body');
  const author = el('button', 'workspace-author-button');
  author.type = 'button';
  bindAction(author, 'profile.open', () => openProfile());
  const renderAuthor = () => {
    const profile = Workspace.profile();
    author.replaceChildren(profileMark(profile, 'workspace-nav-avatar'), el('span', '', profile.name));
  };
  renderAuthor();

  const textarea = el('textarea', 'workspace-composer-text');
  textarea.maxLength = 4000;
  textarea.placeholder = COPY.composerPlaceholder;
  textarea.setAttribute('aria-label', 'Post text');
  textarea.addEventListener('input', queueDraftSave);

  const imagePreview = el('div', 'workspace-image-preview');
  const removeExistingImage = el('input');
  removeExistingImage.type = 'checkbox';
  removeExistingImage.hidden = true;

  const imageInput = el('input');
  imageInput.type = 'file';
  imageInput.accept = 'image/*';
  imageInput.hidden = true;
  imageInput.addEventListener('change', async () => {
    const file = imageInput.files?.[0];
    imageInput.value = '';
    if (!file) return;
    setStatus(draftStatus, 'Preparing photo…');
    composerImage = await Workspace.prepareImage(file);
    removeExistingImage.checked = false;
    renderImagePreview(composerImage);
    setStatus(draftStatus, 'Photo ready');
  });
  document.body.append(imageInput);

  const tools = el('div', 'workspace-composer-tools');
  const attach = iconButton('post.attach', 'image', () => imageInput.click(), { className: 'workspace-tool-button', label: COPY.addPhoto });
  const placeButton = iconButton('composer.place', 'pin', () => openPlacePicker(), { className: 'workspace-tool-button', label: COPY.addPlace });
  const clearPlace = iconButton('composer.clear_place', 'close', () => {
    selectedPlaceId = '';
    queueDraftSave();
    void renderComposerPlace();
  }, { className: 'workspace-tool-button workspace-clear-place', label: 'Remove place' });
  clearPlace.hidden = true;
  const removeImage = iconButton('post.remove_attachment', 'trash', () => {
    if (editingRecord?.assetKey) removeExistingImage.checked = true;
    clearComposerImage();
    setStatus(draftStatus, 'Photo removed');
  }, { className: 'workspace-tool-button workspace-remove-image', label: 'Remove photo' });
  removeImage.hidden = true;
  tools.append(attach, placeButton, clearPlace, removeImage);

  const draftStatus = el('p', 'workspace-inline-status', '');
  draftStatus.hidden = true;
  const publish = iconButton('post.publish', 'send', async () => {
    const payload = await currentComposerPayload();
    try {
      publish.disabled = true;
      setStatus(draftStatus, editingRecord ? 'Saving changes…' : 'Publishing…');
      const result = editingRecord
        ? await Workspace.updateEntry(editingRecord.id, payload)
        : await Workspace.publishEntry(payload);
      closeDialog(dialog);
      routeTo('#/feed');
      return { recordId: result.id };
    } catch (error) {
      setStatus(draftStatus, error.message || 'Could not save', 'error');
      return { error: error.message };
    } finally {
      publish.disabled = false;
    }
  }, { className: 'workspace-primary', label: 'Publish' });

  const footer = el('footer', 'workspace-window-footer');
  footer.append(draftStatus, publish);
  body.append(author, textarea, imagePreview, tools, removeExistingImage);
  window.append(bar, body, footer);
  dialog.append(window);
  dialog.addEventListener('close', () => {
    clearTimeout(autosaveTimer);
    clearComposerImage();
    editingRecord = null;
    selectedPlaceId = '';
    textarea.value = '';
    removeExistingImage.checked = false;
    title.querySelector('span').textContent = COPY.newPost;
    publish.querySelector('.workspace-button-label').textContent = 'Publish';
    setStatus(draftStatus, '');
  });
  dialog._workspace = { textarea, imagePreview, removeImage, removeExistingImage, placeButton, clearPlace, draftStatus, title, publish, renderAuthor };
  document.body.append(dialog);
  return dialog;
}

async function openComposer(options = {}) {
  if (!composerDialog?.isConnected) composerDialog = buildComposerDialog();
  const api = composerDialog._workspace;
  editingRecord = options.record || null;
  composerImage = null;
  selectedPlaceId = options.placeId || '';
  api.removeExistingImage.checked = false;
  api.renderAuthor();

  let text = options.text || '';
  let restored = false;
  if (editingRecord) {
    text = editingRecord.text || editingRecord.summary || '';
    selectedPlaceId = Workspace.recordPlaceId(editingRecord);
    api.title.querySelector('span').textContent = COPY.editPost;
    api.publish.querySelector('.workspace-button-label').textContent = 'Save changes';
    if (editingRecord.assetKey) {
      const asset = await Workspace.getAsset(editingRecord.assetKey);
      if (asset?.blob) renderImagePreview({ blob: asset.blob });
    }
  } else {
    const draft = await Workspace.readDraft();
    if (draft && (draft.text || draft.placeId) && !draft.editingRecordId) {
      text = draft.text || '';
      if (!options.placeId) selectedPlaceId = draft.placeId || '';
      restored = true;
    }
    api.title.querySelector('span').textContent = COPY.newPost;
    api.publish.querySelector('.workspace-button-label').textContent = 'Publish';
  }
  api.textarea.value = text;
  await renderComposerPlace();
  setStatus(api.draftStatus, restored ? COPY.draftRestored : '');
  openDialog(composerDialog);
  setTimeout(() => api.textarea.focus(), 40);
}

async function shareRecord(recordId) {
  const record = await Workspace.getRecord(recordId);
  if (!record) return { recordId };
  const text = record.text || record.title || '';
  if (navigator.share) await navigator.share({ title: record.title || COPY.brand, text });
  else await navigator.clipboard.writeText(text);
  return { recordId };
}

async function deleteOwnedRecord(recordId) {
  if (!confirm('Delete this post from this device?')) return { cancelled: true };
  await Workspace.deleteEntry(recordId);
  scheduleRender();
  return { recordId };
}

async function enhanceOwnedPosts() {
  const records = await Workspace.ownedEntries();
  const owned = new Map(records.map(record => [String(record.id), record]));
  const places = new Map((await Workspace.listPlaces()).map(place => [place.id, place]));
  for (const card of document.querySelectorAll('#feed .post')) {
    const record = owned.get(String(card.dataset.id || ''));
    const existing = card.querySelector('[data-workspace-post-controls]');
    if (!record) {
      existing?.remove();
      continue;
    }
    card.dataset.workspaceOwned = 'true';
    const placeId = Workspace.recordPlaceId(record);
    const place = places.get(placeId);
    let meta = card.querySelector('[data-workspace-post-meta]');
    if (place && !meta) {
      meta = el('div', 'workspace-post-meta');
      meta.dataset.workspacePostMeta = 'true';
      meta.append(icon('pin'), el('span', '', place.name));
      const head = card.querySelector('.post-head') || card.firstElementChild;
      head?.append(meta);
    } else if (!place) meta?.remove();

    if (existing) continue;
    const actions = card.querySelector('.actions');
    if (!actions) continue;
    const controls = el('div', 'workspace-owned-actions');
    controls.dataset.workspacePostControls = 'true';
    controls.append(
      iconButton('post.edit', 'edit', () => openComposer({ record }), { className: 'workspace-inline-action', label: 'Edit', payload: { recordId: record.id } }),
      iconButton('post.share', 'share', () => shareRecord(record.id), { className: 'workspace-inline-action', label: 'Send', payload: { recordId: record.id } }),
      iconButton('post.delete', 'trash', () => deleteOwnedRecord(record.id), { className: 'workspace-inline-action is-danger', label: 'Delete', payload: { recordId: record.id } })
    );
    actions.append(controls);
  }
}

function buildPlaceEditor(place = null, options = {}) {
  const dialog = el('dialog', 'workspace-dialog workspace-place-editor');
  dialog.dataset.workspacePlaceEditor = 'true';
  const window = el('section', 'workspace-window');
  const bar = el('header', 'workspace-window-bar');
  const title = el('div', 'workspace-window-title');
  title.append(icon('pin'), el('span', '', place ? 'Edit place' : 'New place'));
  bar.append(title, iconButton('places.close', 'close', () => closeDialog(dialog), { className: 'workspace-icon-button', label: 'Close' }));

  const body = el('div', 'workspace-window-body');
  const name = field(COPY.placeName, 'input', { name: 'placeName', value: place?.name || '', maxLength: 72 });
  const detail = field(COPY.placeDetail, 'textarea', { name: 'placeDetail', value: place?.detail || '', maxLength: 180, rows: 3 });
  const coords = el('div', 'workspace-coordinate-row');
  const latitude = field('Latitude', 'input', { name: 'placeLatitude', value: place?.latitude ?? '', inputMode: 'decimal' });
  const longitude = field('Longitude', 'input', { name: 'placeLongitude', value: place?.longitude ?? '', inputMode: 'decimal' });
  coords.append(latitude.wrap, longitude.wrap);
  const locateStatus = el('p', 'workspace-inline-status');
  locateStatus.hidden = true;
  const locate = iconButton('places.locate', 'location', () => new Promise(resolve => {
    if (!navigator.geolocation) {
      setStatus(locateStatus, 'Location is not available in this browser.', 'error');
      resolve({ available: false });
      return;
    }
    setStatus(locateStatus, 'Finding your location…');
    navigator.geolocation.getCurrentPosition(position => {
      latitude.input.value = position.coords.latitude.toFixed(6);
      longitude.input.value = position.coords.longitude.toFixed(6);
      setStatus(locateStatus, 'Location added.');
      resolve({ available: true });
    }, error => {
      setStatus(locateStatus, error.message || 'Location permission was not granted.', 'error');
      resolve({ available: false });
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  }), { className: 'workspace-secondary', label: 'Use current location' });

  const footer = el('footer', 'workspace-window-footer');
  const save = iconButton('places.save', 'check', async () => {
    const saved = await Workspace.savePlace({
      ...place,
      name: name.input.value,
      detail: detail.input.value,
      latitude: latitude.input.value === '' ? null : Number(latitude.input.value),
      longitude: longitude.input.value === '' ? null : Number(longitude.input.value)
    });
    if (options.select) {
      selectedPlaceId = saved.id;
      await renderComposerPlace();
      queueDraftSave();
    }
    closeDialog(dialog);
    renderPlacesRoute();
    return saved;
  }, { className: 'workspace-primary', label: options.select ? 'Save and use' : 'Save place' });
  footer.append(locateStatus, save);
  body.append(name.wrap, detail.wrap, coords, locate);
  window.append(bar, body, footer);
  dialog.append(window);
  document.body.append(dialog);
  return dialog;
}

function openPlaceEditor(place = null, options = {}) {
  placeEditorDialog?.remove();
  placeEditorDialog = buildPlaceEditor(place, options);
  openDialog(placeEditorDialog);
  setTimeout(() => placeEditorDialog.querySelector('[name="placeName"]')?.focus(), 40);
}

async function openPlacePicker() {
  const places = await Workspace.listPlaces();
  const dialog = el('dialog', 'workspace-dialog workspace-place-picker');
  dialog.dataset.workspacePlacePicker = 'true';
  const window = el('section', 'workspace-window');
  const bar = el('header', 'workspace-window-bar');
  const title = el('div', 'workspace-window-title');
  title.append(icon('pin'), el('span', '', 'Choose a place'));
  const close = iconButton('places.close', 'close', () => closeDialog(dialog), { className: 'workspace-icon-button', label: 'Close' });
  bar.append(title, close);
  const body = el('div', 'workspace-window-body workspace-place-list');
  if (!places.length) body.append(el('p', 'workspace-empty-note', COPY.placesEmpty));
  for (const place of places) {
    const button = actionButton('places.use', () => {
      selectedPlaceId = place.id;
      void renderComposerPlace();
      queueDraftSave();
      closeDialog(dialog);
      return { placeId: place.id };
    }, { className: 'workspace-place-choice', label: place.name, payload: { placeId: place.id } });
    button.append(el('span', '', place.detail || 'Saved place'));
    body.append(button);
  }
  const footer = el('footer', 'workspace-window-footer');
  footer.append(el('span'), iconButton('places.create', 'plus', () => {
    closeDialog(dialog);
    openPlaceEditor(null, { select: true });
  }, { className: 'workspace-secondary', label: 'New place' }));
  window.append(bar, body, footer);
  dialog.append(window);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  openDialog(dialog);
}

function setKnownViewsHidden(hidden) {
  for (const id of KNOWN_VIEWS) {
    const view = document.getElementById(id);
    if (!view) continue;
    if (hidden) {
      if (!('workspaceWasHidden' in view.dataset)) view.dataset.workspaceWasHidden = view.hidden ? 'yes' : 'no';
      view.hidden = true;
    }
  }
  const feed = document.getElementById('feed');
  if (feed && hidden && !document.getElementById('feedView')) {
    if (!('workspaceWasHidden' in feed.dataset)) feed.dataset.workspaceWasHidden = feed.hidden ? 'yes' : 'no';
    feed.hidden = true;
  }
}

function restoreKnownViews() {
  for (const node of document.querySelectorAll('[data-workspace-was-hidden]')) {
    if (node.dataset.workspaceWasHidden === 'no') node.hidden = false;
    delete node.dataset.workspaceWasHidden;
  }
}

async function placeCard(place, records) {
  const card = el('article', 'workspace-place-card');
  const head = el('header', 'workspace-place-card-head');
  const marker = el('span', 'workspace-place-marker');
  marker.append(icon('pin'));
  const copy = el('div');
  copy.append(el('h3', '', place.name), el('p', '', place.detail || 'Saved place'));
  head.append(marker, copy);
  const metadata = el('div', 'workspace-place-card-meta');
  const count = records.length;
  metadata.append(el('span', '', `${count} ${count === 1 ? 'item' : 'items'}`));
  if (Number.isFinite(place.latitude) && Number.isFinite(place.longitude)) metadata.append(el('span', '', `${place.latitude.toFixed(3)}, ${place.longitude.toFixed(3)}`));
  const actions = el('div', 'workspace-place-card-actions');
  actions.append(
    iconButton('places.use', 'compose', () => {
      void openComposer({ placeId: place.id });
      return { placeId: place.id };
    }, { className: 'workspace-secondary', label: 'Post here', payload: { placeId: place.id } }),
    iconButton('places.delete', 'trash', async () => {
      if (confirm(`Delete “${place.name}”? Existing posts will stay in your feed.`)) await Workspace.deletePlace(place.id);
      renderPlacesRoute();
      return { placeId: place.id };
    }, { className: 'workspace-quiet-danger', label: 'Delete', payload: { placeId: place.id } })
  );
  card.append(head, metadata, actions);
  return card;
}

function ensurePlacesView() {
  if (placesView?.isConnected) return placesView;
  placesView = el('section', 'workspace-route-view workspace-places-view');
  placesView.id = 'workspacePlacesView';
  placesView.hidden = true;
  const main = document.querySelector('main, .shell, .app') || document.body;
  main.append(placesView);
  return placesView;
}

async function renderPlacesRoute() {
  if (!placesOpen && location.hash !== '#/places') return;
  placesOpen = true;
  const view = ensurePlacesView();
  setKnownViewsHidden(true);
  const places = await Workspace.listPlaces();
  const records = await Workspace.recordsByPlace();
  const header = el('header', 'workspace-route-header');
  const copy = el('div');
  copy.append(el('p', 'workspace-eyebrow', 'On this device'), el('h1', '', COPY.placesTitle), el('p', '', COPY.placesBody));
  header.append(copy, iconButton('places.create', 'plus', () => openPlaceEditor(), { className: 'workspace-primary', label: 'New place' }));
  const grid = el('div', 'workspace-place-grid');
  if (!places.length) {
    const empty = el('section', 'workspace-empty-panel');
    empty.append(icon('pin', 'workspace-empty-icon'), el('h2', '', COPY.placesEmpty), el('p', '', 'Create one for a room, a city, a trail, or anywhere else you want to remember.'));
    grid.append(empty);
  } else {
    for (const place of places) grid.append(await placeCard(place, records.get(place.id) || []));
  }
  view.replaceChildren(header, grid);
  view.hidden = false;
  document.documentElement.dataset.workspaceRoute = 'places';
}

function closePlacesRoute() {
  if (!placesOpen && location.hash !== '#/places') return;
  placesOpen = false;
  const view = ensurePlacesView();
  view.hidden = true;
  restoreKnownViews();
  delete document.documentElement.dataset.workspaceRoute;
}

function routeChanged() {
  if (location.hash === '#/places') void renderPlacesRoute();
  else closePlacesRoute();
  scheduleRender();
}

function installTopbarHooks() {
  const navProfile = document.getElementById('navProfile');
  if (navProfile && navProfile.dataset.workspaceBound !== 'true') {
    const replacement = navProfile.cloneNode(false);
    replacement.id = 'navProfile';
    replacement.className = `${navProfile.className || ''} workspace-nav-button`.trim();
    replacement.dataset.workspaceBound = 'true';
    bindAction(replacement, 'profile.open', event => {
      event.preventDefault();
      openProfile();
    });
    navProfile.replaceWith(replacement);
    applyProfile();
  }
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(async () => {
    renderScheduled = false;
    installTopbarHooks();
    applyProfile();
    if (location.hash === '#/places') await renderPlacesRoute();
    else await enhanceOwnedPosts();
  });
}

async function boot() {
  applyProfile();
  installTopbarHooks();
  await Workspace.migrateLegacySocial().catch(error => console.warn('[workspace] legacy migration failed', error));
  scheduleRender();
  routeChanged();
  for (const delay of [80, 320, 1000]) setTimeout(scheduleRender, delay);
}

for (const eventName of ['sideways:ready', 'sideways:feedrender', 'sideways:workspacechange', 'sideways:profilechange', 'sideways:placeschange']) {
  window.addEventListener(eventName, scheduleRender);
}
window.addEventListener('hashchange', routeChanged);
window.addEventListener('popstate', routeChanged);

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
else void boot();

window.SidewaysWorkspaceUI = Object.freeze({
  openProfile,
  openComposer,
  openPlaces: () => {
    location.hash = '#/places';
    routeChanged();
  },
  openPlaceEditor,
  refresh: scheduleRender
});
