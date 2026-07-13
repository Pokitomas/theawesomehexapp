import { ACCENTS, clearDraft, deletePlace, listPlaces, readDraft, readProfile, recordPlaceId, saveDraft, savePlace, saveProfile } from './workspace-profile.js';
import { deleteEntry, getAsset, getRecord, listRecords, ownedEntries, prepareImage, publishEntry, recordsByPlace, updateEntry } from './workspace-records.js';
import { configureSync, flushOutbox, outboxCount, persistEvent } from './workspace-sync.js';
import { migrateLegacySocial } from './workspace-migration.js';

window.addEventListener('sideways:action', event => void persistEvent(event.detail).catch(error => console.warn('[workspace] event persistence failed', error)));
window.addEventListener('online', () => void flushOutbox().catch(error => console.warn('[workspace] sync failed', error)));

export const Workspace = Object.freeze({
  accents: ACCENTS,
  profile: readProfile,
  saveProfile,
  readDraft,
  saveDraft,
  clearDraft,
  listPlaces,
  savePlace,
  deletePlace,
  recordPlaceId,
  prepareImage,
  publishEntry,
  updateEntry,
  deleteEntry,
  getRecord,
  getAsset,
  listRecords,
  ownedEntries,
  recordsByPlace,
  configureSync,
  flushOutbox,
  outboxCount,
  migrateLegacySocial
});

window.SidewaysWorkspace = Workspace;
