import { createDefaultRegistry } from './registry.js';

const DB_NAME = 'sideways-manual-corpus-v1';
const DB_VERSION = 1;
const RECORD_STORE = 'records';
const BLOB_STORE = 'blobs';
const PROFILE_KEY = 'sideways-local-profile-v1';
const MAX_SINGLE_FILE = 350 * 1024 * 1024;
const DEFAULT_CHUNK = 75;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORD_STORE)) {
        const store = db.createObjectStore(RECORD_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('hash', 'hash', { unique: false });
        store.createIndex('addedAt', 'addedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(storeName, mode, work) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let value;
      try { value = work(store); }
      catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new DOMException('Import stopped', 'AbortError'));
    });
  } finally {
    db.close();
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function existingKeys() {
  return transaction(RECORD_STORE, 'readonly', async store => {
    const rows = await requestResult(store.getAll());
    return {
      hashes: new Set(rows.map(row => row.hash).filter(Boolean)),
      native: new Set(rows.map(row => row.nativeId && `${row.source}\n${row.nativeId}`).filter(Boolean)),
      count: rows.length
    };
  });
}

function safeURL(value = '') {
  try {
    const parsed = new URL(String(value));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch { return ''; }
}

function clean(value = '') {
  return String(value).replace(/\u0000/g, '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

function localProfile() {
  try {
    const value = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
    return {
      displayName: clean(value.name || 'Me').slice(0, 80) || 'Me',
      handle: value.handle ? `@${clean(value.handle).replace(/^@/, '').slice(0, 47)}` : ''
    };
  } catch {
    return { displayName: 'Me', handle: '' };
  }
}

function currentProfile() {
  const core = window.SidewaysProfiles?.profile;
  if (core?.displayName && core.displayName !== 'Me') return core;
  return localProfile();
}

function normalize(input, file, digest) {
  const profile = currentProfile();
  const now = new Date().toISOString();
  const text = clean(input.text || '');
  const title = clean(input.title || input.name || text.split('\n')[0] || file.name || 'UNTITLED').slice(0, 240) || 'UNTITLED';
  const source = clean(input.source || file.name || 'MY IMPORT').slice(0, 120) || 'MY IMPORT';
  return {
    type: ['article', 'forum', 'social'].includes(input.type) ? input.type : 'social',
    title,
    summary: clean(input.summary || text.slice(0, 420)).slice(0, 900),
    text,
    body: Array.isArray(input.body) ? input.body.map(clean).filter(Boolean).slice(0, 100) : [],
    source,
    sourceUrl: safeURL(input.sourceUrl),
    outboundUrl: safeURL(input.outboundUrl),
    author: {
      name: clean(input.author?.name || profile.displayName || 'Me').slice(0, 80),
      handle: clean(input.author?.handle || profile.handle || '').slice(0, 48),
      url: safeURL(input.author?.url),
      avatar: safeURL(input.author?.avatar)
    },
    published: input.published || now,
    addedAt: now,
    updatedAt: now,
    originalName: clean(input.originalName || file.webkitRelativePath || file.name || title).slice(0, 260),
    mime: clean(input.mime || file.type || 'application/octet-stream').slice(0, 120),
    size: Number(input.size) || file.size || new Blob([text]).size,
    hash: input.hash || `${digest}:${input.nativeId || title}`,
    assetKey: '',
    mediaKind: '',
    width: 0,
    height: 0,
    nativeId: clean(input.nativeId || '').slice(0, 180),
    links: Array.isArray(input.links) ? input.links.map(item => ({ label: clean(item.label || item.url || 'LINK').slice(0, 120), url: safeURL(item.url) })).filter(item => item.url).slice(0, 100) : [],
    tags: Array.isArray(input.tags) ? input.tags.map(clean).filter(Boolean).slice(0, 30) : [],
    rank: input.rank && typeof input.rank === 'object' ? structuredClone(input.rank) : {}
  };
}

async function digestFile(file) {
  if (crypto?.subtle) {
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261 >>> 0;
  for (const char of `${file.name}|${file.size}|${file.lastModified}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

async function sampleFile(file, bytes = 96 * 1024) {
  return file.slice(0, bytes).text().catch(() => '');
}

async function capacityFor(files) {
  const estimate = await navigator.storage?.estimate?.().catch(() => ({})) || {};
  const requested = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  const remaining = Number(estimate.quota || 0) - Number(estimate.usage || 0);
  return { requested, usage: Number(estimate.usage || 0), quota: Number(estimate.quota || 0), remaining };
}

function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function abortIfNeeded(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('Import stopped', 'AbortError');
}

async function addRecords(records) {
  if (!records.length) return;
  await transaction(RECORD_STORE, 'readwrite', store => {
    for (const record of records) store.add(record);
  });
}

export class ImportRuntime extends EventTarget {
  constructor({ registry = createDefaultRegistry(), chunkSize = DEFAULT_CHUNK } = {}) {
    super();
    this.registry = registry;
    this.chunkSize = Math.max(10, Math.min(500, Number(chunkSize) || DEFAULT_CHUNK));
    this.controller = null;
  }

  stop() {
    this.controller?.abort(new DOMException('Import stopped', 'AbortError'));
  }

  async inspect(files) {
    const list = [...files].filter(Boolean);
    const capacity = await capacityFor(list);
    const found = [];
    for (const file of list) {
      const sample = await sampleFile(file);
      const adapter = this.registry.find(file, sample);
      found.push({ file, adapter, size: file.size });
    }
    return { files: found, capacity };
  }

  async import(files, options = {}) {
    if (this.controller) throw new Error('IMPORT ALREADY RUNNING');
    const list = [...files].filter(Boolean);
    if (!list.length) return { added: 0, skipped: 0, failed: 0, files: 0 };
    for (const file of list) if (file.size > MAX_SINGLE_FILE) throw new Error(`${file.name}: TOO BIG FOR ONE FILE`);

    const capacity = await capacityFor(list);
    if (capacity.quota && capacity.remaining < capacity.requested * 1.15) throw new Error('NOT ENOUGH BROWSER SPACE');
    if (options.persist !== false) await navigator.storage?.persist?.().catch(() => false);

    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    const keys = await existingKeys();
    const result = { added: 0, skipped: 0, failed: 0, files: list.length, startingCount: keys.count, errors: [] };
    this.dispatchEvent(new CustomEvent('start', { detail: { ...result, capacity } }));

    try {
      for (let fileIndex = 0; fileIndex < list.length; fileIndex += 1) {
        abortIfNeeded(signal);
        const file = list[fileIndex];
        const sample = await sampleFile(file);
        const adapter = this.registry.find(file, sample);
        const digest = await digestFile(file);
        this.dispatchEvent(new CustomEvent('file', { detail: { file, adapter, fileIndex, totalFiles: list.length } }));

        try {
          const parsed = await adapter.parse(file, {
            signal,
            profileName: currentProfile().displayName,
            profileHandle: currentProfile().handle
          });
          const normalized = parsed.map(item => normalize(item, file, digest));
          for (let offset = 0; offset < normalized.length; offset += this.chunkSize) {
            abortIfNeeded(signal);
            const chunk = [];
            for (const record of normalized.slice(offset, offset + this.chunkSize)) {
              const nativeKey = record.nativeId ? `${record.source}\n${record.nativeId}` : '';
              if (keys.hashes.has(record.hash) || (nativeKey && keys.native.has(nativeKey))) {
                result.skipped += 1;
                continue;
              }
              keys.hashes.add(record.hash);
              if (nativeKey) keys.native.add(nativeKey);
              chunk.push(record);
            }
            await addRecords(chunk);
            result.added += chunk.length;
            this.dispatchEvent(new CustomEvent('progress', { detail: { ...result, file, adapter, parsed: normalized.length, offset: Math.min(offset + this.chunkSize, normalized.length) } }));
            await nextFrame();
          }
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          result.failed += 1;
          result.errors.push({ file: file.name, adapter: adapter.id, message: error.message });
          this.dispatchEvent(new CustomEvent('fileerror', { detail: { file, adapter, error } }));
        }
      }
      this.dispatchEvent(new CustomEvent('complete', { detail: result }));
      window.dispatchEvent(new CustomEvent('sideways:import-complete', { detail: result }));
      return result;
    } finally {
      this.controller = null;
    }
  }
}

export function createImportRuntime(options) {
  return new ImportRuntime(options);
}
