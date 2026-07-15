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
  try {
    profile = JSON.parse(localStorage.getItem(PROFILE_KEY) || localStorage.getItem(LEGACY_PROFILE_KEY) || '{}');
  } catch {}
  return { records, assets, ledger: ledger || [], places: places || [], profile };
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
  try { await writable.write(value); } finally { await writable.close(); }
}

export async function mirrorAll({ capture = snapshot, open = opfs, write = writeFile, record = appendLedger } = {}) {
  const { records, assets } = await capture();
  const dirs = await open(true).catch(() => null);
  if (!dirs) {
    const result = { status: 'unavailable', records: records.length, assets: assets.length, sameOrigin: true };
    await record('survival.mirror.unavailable', result);
    return result;
  }
  let bytes = 0;
  let writtenAssets = 0;
  try {
    for (const asset of assets) {
      await write(dirs.assets, `${safeName(asset.key)}.bin`, asset.blob);
      writtenAssets += 1;
      bytes += Number(asset.blob?.size || 0);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    await write(dirs.vault, 'manifest.json', JSON.stringify({
      version: 1,
      at: new Date().toISOString(),
      sameOrigin: true,
      externalBackup: false,
      records: records.map(record => ({ id: record.id, hash: record.hash, assetKey: record.assetKey || '' })),
      assets: assets.map(asset => ({ key: asset.key, size: Number(asset.blob?.size || 0), mime: asset.mime || asset.blob?.type || '' }))
    }, null, 2));
  } catch (error) {
    const failure = {
      status: 'failed',
      records: records.length,
      assets: assets.length,
      writtenAssets,
      bytes,
      sameOrigin: true,
      error: String(error?.message || error).slice(0, 500)
    };
    await record('survival.mirror.failed', failure);
    throw error;
  }
  const result = { status: 'ready', records: records.length, assets: assets.length, bytes, sameOrigin: true };
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

async function saveArk(blob, filename) {
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: 'Sideways Ark', accept: { 'application/x-sideways-ark': ['.sideways'] } }] });
      const writable = await handle.createWritable();
      try { await writable.write(blob); } finally { await writable.close(); }
      return { status: 'external-written', method: 'file-system-access' };
    } catch (error) {
      if (error?.name === 'AbortError') return { status: 'cancelled', method: 'file-system-access' };
      throw error;
    }
  }
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
  return { status: 'download-issued', method: 'browser-download' };
}

export async function exportArk({ download = true } = {}) {
  const data = await snapshot();
  const manifest = makeManifest(data);
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const blob = new Blob([ARK_MAGIC, `${json.byteLength}\n`, json, ...data.assets.map(asset => asset.blob)], { type: 'application/x-sideways-ark' });
  const filename = `sideways-${new Date().toISOString().slice(0, 10)}.sideways`;
  const save = download ? await saveArk(blob, filename) : { status: 'created-not-saved', method: 'memory' };
  if (save.status !== 'cancelled') await appendLedger('survival.ark.export', { status: save.status, method: save.method, filename, records: data.records.length, assets: data.assets.length, ledgerEntries: data.ledger.length, bytes: blob.size });
  return { cancelled: save.status === 'cancelled', blob, filename, manifest, save };
}

async function parseArk(file) {
  const head = await file.slice(0, 512).text();
  if (!head.startsWith(ARK_MAGIC)) throw new Error('NOT A SIDEWAYS ARK');
  const end = head.indexOf('\n', ARK_MAGIC.length);
  const length = Number(head.slice(ARK_MAGIC.length, end));
  if (end < 0 || !Number.isSafeInteger(length) || length < 2 || length > 64 * 1024 * 1024) throw new Error('ARK HEADER IS INVALID');
  const start = end + 1;
  const manifest = JSON.parse(await file.slice(start, start + length).text());
  if (manifest.format !== 'SIDEWAYS-ARK' || manifest.version !== 1) throw new Error('ARK VERSION IS NOT SUPPORTED');
  return { manifest, payloadStart: start + length };
}

export async function restoreArk(file) {
  const { manifest, payloadStart } = await parseArk(file);
  const existing = await readStore(openCorpusDB, RECORD_STORE);
  const hashes = new Set((existing || []).map(record => record.hash).filter(Boolean));
  let added = 0;
  let skipped = 0;
  const db = await openCorpusDB();
  try {
    const tx = db.transaction([RECORD_STORE, BLOB_STORE, LEDGER_STORE], 'readwrite');
    const records = tx.objectStore(RECORD_STORE);
    const blobs = tx.objectStore(BLOB_STORE);
    const ledger = tx.objectStore(LEDGER_STORE);
    for (const entry of manifest.assets || []) {
      const start = payloadStart + Number(entry.offset || 0);
      blobs.put({ ...entry, blob: file.slice(start, start + Number(entry.size || 0), entry.mime || 'application/octet-stream') });
    }
    for (const source of manifest.records || []) {
      if (source.hash && hashes.has(source.hash)) { skipped += 1; continue; }
      const record = structuredClone(source);
      delete record.id;
      records.add(record);
      if (record.hash) hashes.add(record.hash);
      added += 1;
    }
    ledger.add(ledgerEntry('survival.ark.restore', { added, skipped, assets: Number(manifest.assets?.length || 0), ledgerEntries: Number(manifest.ledger?.length || 0), sourceCreatedAt: manifest.createdAt || '' }));
    await transactionDone(tx);
  } finally { db.close(); }
  if (manifest.profile) {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(manifest.profile));
    localStorage.setItem(LEGACY_PROFILE_KEY, JSON.stringify({ name: manifest.profile.name || 'You', handle: manifest.profile.handle || '' }));
  }
  if (manifest.places?.length) {
    const workspace = await openWorkspaceDB();
    try {
      const tx = workspace.transaction(PLACE_STORE, 'readwrite');
      const store = tx.objectStore(PLACE_STORE);
      for (const place of manifest.places) store.put(place);
      await transactionDone(tx);
    } finally { workspace.close(); }
  }
  const result = { added, skipped, assets: Number(manifest.assets?.length || 0), ledgerEntries: Number(manifest.ledger?.length || 0) };
  window.dispatchEvent(new CustomEvent('sideways:importcomplete', { detail: { source: 'ark', ...result } }));
  window.dispatchEvent(new CustomEvent('sideways:survivalchange', { detail: { op: 'survival.ark.restore', ...result } }));
  window.dispatchEvent(new CustomEvent('sideways:profilechange', { detail: manifest.profile || {} }));
  return result;
}

export async function audit({ record = true } = {}) {
  const data = await snapshot();
  const referenced = new Set(data.records.map(record => record.assetKey).filter(Boolean));
  const available = new Set(data.assets.map(asset => asset.key));
  const durability = await storageDurability();
  const result = { records: data.records.length, assets: data.assets.length, bytes: data.assets.reduce((sum, asset) => sum + Number(asset.blob?.size || 0), 0), missingAssets: [...referenced].filter(key => !available.has(key)), orphanAssets: data.assets.filter(asset => !referferenced.has(asset.key)).map(asset => asset.key), durability };
  if (record) await appendLedger('survival.audit', { ...result, durability: { persisted: durability.persisted, bestEffort: durability.bestEffort } });
  return result;
}

export async function status() {
  const [durability, ledger] = await Promise.all([storageDurability(), readCorpusLedger({ limit: 1000 })]);
  const external = ledger.find(entry => entry.op === 'survival.ark.export' && entry.status === 'external-written');
  const ark = ledger.find(entry => entry.op === 'survival.ark.export' && entry.status !== 'created-not-saved');
  const mirror = ledger.find(entry => entry.op === 'survival.mirror.checkpoint');
  return { grade: external ? 'EXTERNAL' : ark ? 'ARK' : mirror ? 'MIRROR' : durability.persisted ? 'PINNED' : 'HOT', durability, external: external || null, mirror: mirror || null };
}

export const Survival = Object.freeze({ status, audit, mirrorAll, exportArk, restoreArk });
window.SidewaysSurvival = Survival;
