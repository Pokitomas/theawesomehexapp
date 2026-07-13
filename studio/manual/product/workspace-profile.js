import {
  DRAFT_STORE,
  META_STORE,
  PLACE_STORE,
  clean,
  deleteWorkspace,
  openWorkspaceDB,
  putWorkspace,
  readStore,
  uid
} from './workspace-db.js';

const PROFILE_KEY = 'sideways-workspace-profile-v1';
const LEGACY_PROFILE_KEYS = ['sideways-social-profile-v1', 'sideways-local-profile-v1'];
export const ACCENTS = Object.freeze(['#335cff', '#2f7d64', '#b24d6b', '#8a5b24', '#6554c0', '#24262b']);

function defaultProfile() {
  return { name: 'You', handle: '', bio: '', accent: ACCENTS[0] };
}

export function normalizeProfile(input = {}) {
  const name = clean(input.name || input.displayName || 'You').slice(0, 48) || 'You';
  const handle = clean(input.handle || '').replace(/^@/, '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 30);
  const bio = clean(input.bio || '').slice(0, 180);
  const accent = ACCENTS.includes(input.accent || input.color) ? (input.accent || input.color) : ACCENTS[0];
  return { name, handle, bio, accent };
}

export function readProfile() {
  try {
    const current = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
    if (current) return normalizeProfile(current);
  } catch {
    // Fall through to legacy profile migration.
  }
  for (const key of LEGACY_PROFILE_KEYS) {
    try {
      const legacy = JSON.parse(localStorage.getItem(key) || 'null');
      if (legacy) {
        const migrated = normalizeProfile(legacy);
        localStorage.setItem(PROFILE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    } catch {
      // Try the next legacy profile.
    }
  }
  return defaultProfile();
}

export function saveProfile(input) {
  const profile = normalizeProfile(input);
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  localStorage.setItem('sideways-local-profile-v1', JSON.stringify({ name: profile.name, handle: profile.handle }));
  window.dispatchEvent(new CustomEvent('sideways:profilechange', { detail: profile }));
  return profile;
}

export async function saveDraft(value) {
  const draft = {
    id: 'composer',
    text: clean(value.text || ''),
    placeId: value.placeId || '',
    editingRecordId: Number(value.editingRecordId || 0) || 0,
    updatedAt: new Date().toISOString()
  };
  await putWorkspace(DRAFT_STORE, draft);
  return draft;
}

export async function readDraft() {
  return (await readStore(openWorkspaceDB, DRAFT_STORE, 'composer')) || null;
}

export async function clearDraft() {
  await deleteWorkspace(DRAFT_STORE, 'composer');
}

export async function listPlaces() {
  const places = await readStore(openWorkspaceDB, PLACE_STORE);
  return (places || []).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function savePlace(input = {}) {
  const now = new Date().toISOString();
  const latitude = input.latitude === '' || input.latitude === null ? null : Number(input.latitude);
  const longitude = input.longitude === '' || input.longitude === null ? null : Number(input.longitude);
  const place = {
    id: input.id || uid('place'),
    name: clean(input.name || 'Untitled place').slice(0, 72) || 'Untitled place',
    detail: clean(input.detail || '').slice(0, 180),
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    createdAt: input.createdAt || now,
    updatedAt: now
  };
  await putWorkspace(PLACE_STORE, place);
  window.dispatchEvent(new CustomEvent('sideways:placeschange', { detail: place }));
  return place;
}

export async function deletePlace(placeId) {
  await deleteWorkspace(PLACE_STORE, placeId);
  window.dispatchEvent(new CustomEvent('sideways:placeschange', { detail: { deleted: placeId } }));
}

export function placeTag(placeId) {
  return placeId ? `place:${placeId}` : '';
}

export function recordPlaceId(record = {}) {
  const tag = (record.tags || []).find(value => String(value).startsWith('place:'));
  return tag ? String(tag).slice(6) : '';
}

export async function readMeta(key) {
  return (await readStore(openWorkspaceDB, META_STORE, key)) || null;
}

export async function setMeta(key, value) {
  return putWorkspace(META_STORE, { key, value, updatedAt: new Date().toISOString() });
}
