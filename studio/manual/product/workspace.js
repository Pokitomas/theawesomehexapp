import { ACCENTS, clearDraft, deletePlace, listPlaces, readDraft, readProfile, recordPlaceId, saveDraft, savePlace, saveProfile } from './workspace-profile.js';
import { deleteEntry, getAsset, getAssets, getRecord, listRecords, ownedEntries, prepareImage, publishEntry, recordsByPlace, updateEntry } from './workspace-records.js';
import { readCorpusLedger, storageDurability } from './workspace-db.js';
import { migrateLegacySocial } from './workspace-migration.js';
import { Survival } from './survival-ledger.js';

void storageDurability({ request: true })
  .then(detail => window.dispatchEvent(new CustomEvent('sideways:durability', { detail })))
  .catch(error => console.warn('[workspace] durability request failed', error));

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
  getAssets,
  listRecords,
  ownedEntries,
  recordsByPlace,
  durability: storageDurability,
  ledger: readCorpusLedger,
  survival: Survival,
  migrateLegacySocial
});

window.SidewaysWorkspace = Workspace;
