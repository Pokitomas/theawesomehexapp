const WEB_SCHEMA = 'sideways-discovery-record/v1';
const PRIVATE_SCHEMA = 'sideways-private-discovery-save/v1';

function clean(value = '') {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

export function saveDiscoveryRecord(record, { explicit = false, savedAt = new Date().toISOString(), collectionId = 'library' } = {}) {
  if (!explicit) throw new Error('Saving a public discovery result requires an explicit user action.');
  if (!record || record.schema !== WEB_SCHEMA || record.state !== 'web') throw new Error('Only a public web discovery record can cross into the private library.');
  const id = clean(record.id);
  if (!id) throw new Error('Discovery record has no stable ID.');
  return Object.freeze({
    ...record,
    state: 'private',
    privateSave: Object.freeze({
      schema: PRIVATE_SCHEMA,
      sourceState: 'web',
      collectionId: clean(collectionId) || 'library',
      savedAt: new Date(savedAt).toISOString(),
      authority: 'user-owned-local-archive'
    })
  });
}

export function isPrivateDiscoverySave(record) {
  return Boolean(record?.state === 'private'
    && record?.privateSave?.schema === PRIVATE_SCHEMA
    && record?.privateSave?.sourceState === 'web'
    && record?.privateSave?.authority === 'user-owned-local-archive');
}

export { PRIVATE_SCHEMA, WEB_SCHEMA };
