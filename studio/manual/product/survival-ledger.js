import {
  BLOB_STORE,
  LEDGER_STORE,
  PLACE_STORE,
  RECORD_STORE,
  ledgerEntry,
  openCorpusDB,
  openWorkspaceDB,
  readCorpusLedger,
  readStore,
  storageDurability,
  transactionDone
} from './workspace-db.js';

const PROFILE_KEY = 'sideways-workspace-profile-v1';
const LEGACY_PROFILE_KEY = 'sideways-local-profile-v1';
const ARK_MAGIC = 'SIDEWAYS-ARK/1\n';
const VAULT_DIR = 'sideways-vault';
const ASSET_DIR = 'assets';
export const MAX_IN_MEMORY_ARK_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const isServerProjection = record => String(record?.nativeId || '').startsWith('network:');
const safeName = value => encodeURIComponent(String(value || 'asset')).replaceAll('%', '_').slice(0, 220);

async function appendLedger(op, detail = {}) {
  const db = await openCorpusDB();
  try {
    const tx = db.transaction(LEDGER_STORE, 'readwrite');
    tx.objectStore(LEDGER_STORE).add(ledgerEntry(op, detail));
    await transactionDone(tx);
  } finally { db.close(); }
  window.dispatchEvent(new CustomEvent('sideways:survivalchange', { detail: { op, ...detail } }));
}

async function snapshot() {
  const [allRecords, allAssets, ledger, places] = await Promise.all([
    readStore(openCorpusDB, RECORD_STORE),
    readStore(openCorpusDB, BLOB_STORE),
    readCorpusLedger({ limit: 10000 }),
    readStore(openWorkspaceDB, PLACE_STORE).catch(() => [])
  ]);
  const records = (allRecords || []).filter(record => !isServerProjection(record));
  const referenced = new Set(records.map(record => record.assetKey).filter(Boolean));
  const assets = (allAssets || []).filter(asset => referenced.has(asset.key));
  let profile = {};
  try { profile = JSON.parse(localStorage.getItem(PROFILE_KEY) || localStorage.getItem(LEGACY_PROFILE_KEY) || '{}'); } catch {}
  return { records, assets, ledger: ledger || [], places: places || [], profile };
}

async function captureRestoreState() {
  const [records, assets, ledger, places] = await Promise.all([
    readStore(openCorpusDB, RECORD_STORE),
    readStore(openCorpusDB, BLOB_STORE),
    readStore(openCorpusDB, LEDGER_STORE),
    readStore(openWorkspaceDB, PLACE_STORE).catch(() => [])
  ]);
  return {
    records: records || [], assets: assets || [], ledger: ledger || [], places: places || [],
    profile: localStorage.getItem(PROFILE_KEY), legacyProfile: localStorage.getItem(LEGACY_PROFILE_KEY)
  };
}

async function opfs(create = true) {
  if (typeof navigator.storage?.getDirectory !== 'function') return null;
  const root = await navigator.storage.getDirectory();
  const vault = await root.getDirectoryHandle(VAULT_DIR, { create });
  const assets = await vault.getDirectoryHandle(ASSET_DIR, { create });
  return { vault, assets };
}

async function writeFile(directory, name, value) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(value);
    await writable.close();
  } catch (error) {
    if (typeof writable.abort === 'function') await writable.abort(error).catch(() => {});
    else await writable.close().catch(() => {});
    throw error;
  }
}

async function removeEntry(directory, name, options = {}) {
  if (typeof directory?.removeEntry === 'function') await directory.removeEntry(name, options);
}

async function prepareGeneration(dirs, generation) {
  if (typeof dirs.vault?.getDirectoryHandle !== 'function') return { assets: dirs.assets, generation: null, cleanup: async () => {} };
  const generations = await dirs.vault.getDirectoryHandle('generations', { create: true });
  const root = await generations.getDirectoryHandle(generation, { create: true });
  const assets = await root.getDirectoryHandle(ASSET_DIR, { create: true });
  return {
    assets,
    generation,
    cleanup: () => removeEntry(generations, generation, { recursive: true }).catch(() => {})
  };
}

function mirrorErrorCode(error) {
  if (error?.name === 'QuotaExceededError') return 'quota-exceeded';
  if (error?.name === 'AbortError') return 'interrupted';
  return 'write-failed';
}

export async function mirrorAll({
  capture = snapshot,
  open = opfs,
  write = writeFile,
  record = appendLedger,
  makeGeneration = prepareGeneration,
  generationId = () => `g-${Date.now().toString(36)}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`
} = {}) {
  const { records, assets } = await capture();
  const dirs = await open(true).catch(() => null);
  if (!dirs) {
    const result = { status: 'unavailable', records: records.length, assets: assets.length, sameOrigin: true, canonicalStore: 'IndexedDB' };
    await record('survival.mirror.unavailable', result);
    return result;
  }
  const generation = generationId();
  let stage = null;
  let bytes = 0;
  let writtenAssets = 0;
  try {
    stage = await makeGeneration(dirs, generation);
    const manifestAssets = [];
    for (const asset of assets) {
      const filename = `${safeName(asset.key)}.bin`;
      await write(stage.assets, filename, asset.blob);
      writtenAssets += 1;
      bytes += Number(asset.blob?.size || 0);
      manifestAssets.push({ key: asset.key, filename, size: Number(asset.blob?.size || 0), mime: asset.mime || asset.blob?.type || '' });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const manifest = JSON.stringify({
      version: 2,
      at: new Date().toISOString(),
      generation: stage.generation,
      sameOrigin: true,
      externalBackup: false,
      canonicalStore: 'IndexedDB',
      records: records.map(record => ({ id: record.id, hash: record.hash, assetKey: record.assetKey || '' })),
      assets: manifestAssets
    }, null, 2);
    await write(dirs.vault, 'manifest.pending.json', manifest);
    await write(dirs.vault, 'manifest.json', manifest);
    await removeEntry(dirs.vault, 'manifest.pending.json').catch(() => {});
  } catch (error) {
    await stage?.cleanup?.().catch(() => {});
    await removeEntry(dirs.vault, 'manifest.pending.json').catch(() => {});
    const failure = {
      status: 'failed', records: records.length, assets: assets.length, writtenAssets, bytes,
      sameOrigin: true, canonicalStore: 'IndexedDB', promoted: false,
      errorCode: mirrorErrorCode(error), error: String(error?.message || error).slice(0, 500)
    };
    await record('survival.mirror.failed', failure);
    throw error;
  }
  const result = { status: 'ready', records: records.length, assets: assets.length, bytes, sameOrigin: true, canonicalStore: 'IndexedDB', generation: stage?.generation || null, promoted: true };
  await record('survival.mirror.checkpoint', result);
  return result;
}

function makeManifest(data) {
  let offset = 0;
  const assets = data.assets.map(asset => {
    const size = Number(asset.blob?.size || 0);
    const entry = { key: asset.key, offset, size, mime: asset.mime || asset.blob?.type || 'application/octet-stream', mediaKind: asset.mediaKind || '', width: Number(asset.width || 0), height: Number(asset.height || 0), duration: Number(asset.duration || 0), originalName: asset.originalName || '' };
    offset += size;
    return entry;
  });
  return { format: 'SIDEWAYS-ARK', version: 1, createdAt: new Date().toISOString(), records: data.records, assets, ledger: data.ledger, profile: data.profile, places: data.places, payloadBytes: offset };
}

function arkParts(data, manifest) {
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const parts = [ARK_MAGIC, `${json.byteLength}\n`, json, ...data.assets.map(asset => asset.blob)];
  const bytes = new TextEncoder().encode(ARK_MAGIC).byteLength + new TextEncoder().encode(`${json.byteLength}\n`).byteLength + json.byteLength + manifest.payloadBytes;
  return { parts, bytes };
}

async function writeParts(writable, parts) {
  for (const part of parts) {
    await writable.write(part);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

async function saveArkParts(parts, filename, bytes, { maxMemoryBytes = MAX_IN_MEMORY_ARK_BYTES } = {}) {
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: 'Sideways Ark', accept: { 'application/x-sideways-ark': ['.sideways'] } }] });
      const writable = await handle.createWritable();
      try {
        await writeParts(writable, parts);
        await writable.close();
      } catch (error) {
        if (typeof writable.abort === 'function') await writable.abort(error).catch(() => {});
        throw error;
      }
      return { status: 'external-written', method: 'file-system-access', blob: null, bytes };
    } catch (error) {
      if (error?.name === 'AbortError') return { status: 'cancelled', method: 'file-system-access', blob: null, bytes: 0 };
      throw error;
    }
  }
  if (bytes > maxMemoryBytes) {
    const error = new Error(`ARK EXCEEDS BOUNDED MEMORY FALLBACK (${bytes} > ${maxMemoryBytes})`);
    error.code = 'ARK_MEMORY_LIMIT';
    error.bytes = bytes;
    error.limitBytes = maxMemoryBytes;
    throw error;
  }
  const blob = new Blob(parts, { type: 'application/x-sideways-ark' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  return { status: 'download-issued', method: 'browser-download', blob, bytes: blob.size };
}

export async function exportArk({ download = true, capture = snapshot, save = saveArkParts, record = appendLedger, maxMemoryBytes = MAX_IN_MEMORY_ARK_BYTES } = {}) {
  const data = await capture();
  const manifest = makeManifest(data);
  const { parts, bytes } = arkParts(data, manifest);
  const filename = `sideways-${new Date().toISOString().slice(0, 10)}.sideways`;
  let saveResult;
  try {
    if (download) saveResult = await save(parts, filename, bytes, { maxMemoryBytes });
    else {
      if (bytes > maxMemoryBytes) {
        const error = new Error(`ARK EXCEEDS BOUNDED MEMORY FALLBACK (${bytes} > ${maxMemoryBytes})`);
        error.code = 'ARK_MEMORY_LIMIT';
        error.bytes = bytes;
        error.limitBytes = maxMemoryBytes;
        throw error;
      }
      saveResult = { status: 'created-not-saved', method: 'memory', blob: new Blob(parts, { type: 'application/x-sideways-ark' }), bytes };
    }
  } catch (error) {
    await record('survival.ark.export.failed', { status: 'failed', errorCode: error.code || 'write-failed', bytes: Number(error.bytes || bytes), limitBytes: Number(error.limitBytes || maxMemoryBytes), filename });
    throw error;
  }
  if (saveResult.status !== 'cancelled') await record('survival.ark.export', { status: saveResult.status, method: saveResult.method, filename, records: data.records.length, assets: data.assets.length, ledgerEntries: data.ledger.length, bytes: saveResult.bytes || bytes, portable: saveResult.status === 'external-written' ? true : 'not_proven' });
  return { cancelled: saveResult.status === 'cancelled', blob: saveResult.blob || null, filename, manifest, save: saveResult, bytes };
}

export async function parseArk(file) {
  const head = await file.slice(0, 512).text();
  if (!head.startsWith(ARK_MAGIC)) throw new Error('NOT A SIDEWAYS ARK');
  const end = head.indexOf('\n', ARK_MAGIC.length);
  const length = Number(head.slice(ARK_MAGIC.length, end));
  if (end < 0 || !Number.isSafeInteger(length) || length < 2 || length > MAX_MANIFEST_BYTES) throw new Error('ARK HEADER IS INVALID');
  const start = end + 1;
  const manifest = JSON.parse(await file.slice(start, start + length).text());
  if (manifest.format !== 'SIDEWAYS-ARK' || manifest.version !== 1) throw new Error('ARK VERSION IS NOT SUPPORTED');
  if (Number(manifest.payloadBytes || 0) < 0 || start + length + Number(manifest.payloadBytes || 0) > file.size) throw new Error('ARK PAYLOAD IS TRUNCATED');
  return { manifest, payloadStart: start + length };
}

function stageRestore(file, manifest, payloadStart, existing = []) {
  const hashes = new Set((existing || []).map(record => record.hash).filter(Boolean));
  const assets = (manifest.assets || []).map(entry => {
    const offset = Number(entry.offset || 0);
    const size = Number(entry.size || 0);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > Number(manifest.payloadBytes || 0)) throw new Error('ARK ASSET RANGE IS INVALID');
    return { ...entry, blob: file.slice(payloadStart + offset, payloadStart + offset + size, entry.mime || 'application/octet-stream') };
  });
  const records = [];
  let skipped = 0;
  for (const source of manifest.records || []) {
    if (source.hash && hashes.has(source.hash)) { skipped += 1; continue; }
    const record = structuredClone(source);
    delete record.id;
    records.push(record);
    if (record.hash) hashes.add(record.hash);
  }
  return { assets, records, places: structuredClone(manifest.places || []), profile: structuredClone(manifest.profile || {}), skipped, ledgerEntries: Number(manifest.ledger?.length || 0), sourceCreatedAt: manifest.createdAt || '' };
}

async function applyCorpusStage(stage) {
  const db = await openCorpusDB();
  try {
    const tx = db.transaction([RECORD_STORE, BLOB_STORE], 'readwrite');
    const records = tx.objectStore(RECORD_STORE);
    const blobs = tx.objectStore(BLOB_STORE);
    for (const asset of stage.assets) blobs.put(asset);
    for (const record of stage.records) records.add(record);
    await transactionDone(tx);
  } finally { db.close(); }
}

async function applyPlacesStage(stage) {
  if (!stage.places.length) return;
  const workspace = await openWorkspaceDB();
  try {
    const tx = workspace.transaction(PLACE_STORE, 'readwrite');
    const store = tx.objectStore(PLACE_STORE);
    for (const place of stage.places) store.put(place);
    await transactionDone(tx);
  } finally { workspace.close(); }
}

async function applyProfileStage(stage) {
  if (!stage.profile) return;
  localStorage.setItem(PROFILE_KEY, JSON.stringify(stage.profile));
  localStorage.setItem(LEGACY_PROFILE_KEY, JSON.stringify({ name: stage.profile.name || 'You', handle: stage.profile.handle || '' }));
}

async function replaceStore(open, storeName, values) {
  const db = await open();
  try {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.clear();
    for (const value of values || []) store.put(value);
    await transactionDone(tx);
  } finally { db.close(); }
}

async function rollbackRestore(prior) {
  await replaceStore(openCorpusDB, RECORD_STORE, prior.records);
  await replaceStore(openCorpusDB, BLOB_STORE, prior.assets);
  await replaceStore(openCorpusDB, LEDGER_STORE, prior.ledger);
  await replaceStore(openWorkspaceDB, PLACE_STORE, prior.places).catch(() => {});
  if (prior.profile === null) localStorage.removeItem(PROFILE_KEY); else localStorage.setItem(PROFILE_KEY, prior.profile);
  if (prior.legacyProfile === null) localStorage.removeItem(LEGACY_PROFILE_KEY); else localStorage.setItem(LEGACY_PROFILE_KEY, prior.legacyProfile);
}

export async function restoreArkTransaction(stage, {
  prior,
  applyCorpus = applyCorpusStage,
  applyPlaces = applyPlacesStage,
  applyProfile = applyProfileStage,
  rollback = rollbackRestore,
  record = appendLedger,
  dispatch = detail => {
    window.dispatchEvent(new CustomEvent('sideways:importcomplete', { detail: { source: 'ark', ...detail } }));
    window.dispatchEvent(new CustomEvent('sideways:survivalchange', { detail: { op: 'survival.ark.restore', ...detail } }));
    window.dispatchEvent(new CustomEvent('sideways:profilechange', { detail: stage.profile || {} }));
  }
} = {}) {
  if (!prior) throw new Error('Restore rollback snapshot is required.');
  let phase = 'corpus';
  try {
    await applyCorpus(stage);
    phase = 'places';
    await applyPlaces(stage);
    phase = 'profile';
    await applyProfile(stage);
    phase = 'receipt';
    const result = { added: stage.records.length, skipped: stage.skipped, assets: stage.assets.length, ledgerEntries: stage.ledgerEntries };
    await record('survival.ark.restore', { ...result, sourceCreatedAt: stage.sourceCreatedAt, transaction: 'committed' });
    dispatch(result);
    return result;
  } catch (error) {
    let rollbackError = null;
    try { await rollback(prior); } catch (failure) { rollbackError = failure; }
    const failure = { status: 'failed', phase, rollback: rollbackError ? 'failed' : 'complete', error: String(error?.message || error).slice(0, 500), rollbackError: rollbackError ? String(rollbackError?.message || rollbackError).slice(0, 500) : '' };
    await record('survival.ark.restore.failed', failure).catch(() => {});
    if (rollbackError) throw new AggregateError([error, rollbackError], 'ARK RESTORE AND ROLLBACK FAILED');
    throw error;
  }
}

export async function restoreArk(file, {
  capturePrior = captureRestoreState,
  readExisting = () => readStore(openCorpusDB, RECORD_STORE),
  transaction = restoreArkTransaction
} = {}) {
  const { manifest, payloadStart } = await parseArk(file);
  const [prior, existing] = await Promise.all([capturePrior(), readExisting()]);
  const stage = stageRestore(file, manifest, payloadStart, existing);
  return transaction(stage, { prior });
}

export async function audit({ record = true } = {}) {
  const data = await snapshot();
  const referenced = new Set(data.records.map(record => record.assetKey).filter(Boolean));
  const available = new Set(data.assets.map(asset => asset.key));
  const durability = await storageDurability();
  const result = { records: data.records.length, assets: data.assets.length, bytes: data.assets.reduce((sum, asset) => sum + Number(asset.blob?.size || 0), 0), missingAssets: [...referenced].filter(key => !available.has(key)), orphanAssets: data.assets.filter(asset => !referenced.has(asset.key)).map(asset => asset.key), durability };
  if (record) await appendLedger('survival.audit', { ...result, durability: { persisted: durability.persisted, bestEffort: durability.bestEffort } });
  return result;
}

export async function status() {
  const [durability, ledger] = await Promise.all([storageDurability(), readCorpusLedger({ limit: 1000 })]);
  const external = ledger.find(entry => entry.op === 'survival.ark.export' && entry.status === 'external-written');
  const ark = ledger.find(entry => entry.op === 'survival.ark.export' && entry.status === 'download-issued');
  const mirror = ledger.find(entry => entry.op === 'survival.mirror.checkpoint');
  return { grade: external ? 'EXTERNAL' : ark ? 'ARK' : mirror ? 'MIRROR' : durability.persisted ? 'PINNED' : 'HOT', durability, external: external || null, ark: ark || null, mirror: mirror || null };
}

export const Survival = Object.freeze({ status, audit, mirrorAll, exportArk, restoreArk });
window.SidewaysSurvival = Survival;
