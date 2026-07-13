import { createDefaultRegistry } from './registry.js';
import { classifyFile, mediaTitle, probeFile } from './media-classifier.js';
import { storageDurability } from '../shared/corpus-db.js';
import { addMediaRecord, addRecords, existingKeys, uniqueRecord } from './corpus-writer.js';
import { digestFile } from './file-hash.js';
import { currentProfile, normalizeRecord } from './record-normalizer.js';

const MAX_SINGLE_FILE = 350 * 1024 * 1024;
const DEFAULT_CHUNK = 75;

async function sampleFile(file, bytes = 96 * 1024) {
  return file.slice(0, bytes).text().catch(() => '');
}

async function capacityFor(files) {
  const estimate = await navigator.storage?.estimate?.().catch(() => ({})) || {};
  const requested = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  return {
    requested,
    usage: Number(estimate.usage || 0),
    quota: Number(estimate.quota || 0),
    remaining: Number(estimate.quota || 0) - Number(estimate.usage || 0)
  };
}

function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}

function abortIfNeeded(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('Import stopped', 'AbortError');
}

async function directMediaRecord(file, digest, classification) {
  const measured = await probeFile(file, classification);
  const assetKey = `import-asset-${digest}`;
  const record = normalizeRecord({
    type: 'social',
    title: mediaTitle(file),
    summary: '',
    text: '',
    source: 'FILES',
    published: file.lastModified || Date.now(),
    originalName: file.webkitRelativePath || file.name,
    mime: classification.mime,
    size: file.size,
    hash: `${digest}:file`,
    assetKey,
    mediaKind: classification.kind,
    mediaConfidence: classification.confidence,
    width: measured.width,
    height: measured.height,
    duration: measured.duration,
    nativeId: `file:${digest}`,
    tags: [`media:${classification.kind}`, `classification:${classification.confidence}`],
    compatibility: {
      classifier: classification.confidence,
      sourceMime: file.type || '',
      canonicalMime: classification.mime,
      surface: ['image', 'video', 'audio'].includes(classification.kind) ? 'native-media' : classification.kind === 'pdf' ? 'document-link' : 'download',
      digestMode: classification.digestMode
    }
  }, file, digest);
  return {
    record,
    asset: {
      key: assetKey,
      blob: file,
      mime: classification.mime,
      mediaKind: classification.kind,
      width: measured.width,
      height: measured.height,
      duration: measured.duration,
      originalName: file.webkitRelativePath || file.name
    }
  };
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
    const [capacity, durability] = await Promise.all([capacityFor(list), storageDurability()]);
    const found = [];
    for (const file of list) {
      const classification = await classifyFile(file);
      if (classification.direct) {
        found.push({ file, adapter: { id: `direct-${classification.kind}`, label: classification.kind.toUpperCase() }, classification, size: file.size });
      } else {
        found.push({ file, adapter: this.registry.find(file, await sampleFile(file)), classification, size: file.size });
      }
    }
    return { files: found, capacity, durability };
  }

  async import(files, options = {}) {
    if (this.controller) throw new Error('IMPORT ALREADY RUNNING');
    const list = [...files].filter(Boolean);
    if (!list.length) return { added: 0, skipped: 0, failed: 0, files: 0 };
    for (const file of list) if (file.size > MAX_SINGLE_FILE) throw new Error(`${file.name}: TOO BIG FOR ONE FILE`);

    const [capacity, durability] = await Promise.all([
      capacityFor(list),
      storageDurability({ request: options.persist !== false })
    ]);
    if (capacity.quota && capacity.remaining < capacity.requested * 1.2) throw new Error('NOT ENOUGH BROWSER SPACE');

    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    const keys = await existingKeys();
    const result = { added: 0, skipped: 0, failed: 0, files: list.length, startingCount: keys.count, errors: [], durability };
    this.dispatchEvent(new CustomEvent('start', { detail: { ...result, capacity } }));

    try {
      for (let fileIndex = 0; fileIndex < list.length; fileIndex += 1) {
        abortIfNeeded(signal);
        const file = list[fileIndex];
        const classification = await classifyFile(file);
        const fingerprint = await digestFile(file, signal);

        if (classification.direct) {
          const adapter = { id: `direct-${classification.kind}`, label: classification.kind.toUpperCase() };
          this.dispatchEvent(new CustomEvent('file', { detail: { file, adapter, classification, fileIndex, totalFiles: list.length } }));
          try {
            const pair = await directMediaRecord(file, fingerprint.digest, { ...classification, digestMode: fingerprint.mode });
            if (!uniqueRecord(pair.record, keys)) result.skipped += 1;
            else {
              await addMediaRecord(pair.record, pair.asset);
              result.added += 1;
            }
            this.dispatchEvent(new CustomEvent('progress', { detail: { ...result, file, adapter, parsed: 1, offset: 1 } }));
            await nextFrame();
          } catch (error) {
            if (error?.name === 'AbortError') throw error;
            result.failed += 1;
            result.errors.push({ file: file.name, adapter: adapter.id, message: error.message });
            this.dispatchEvent(new CustomEvent('fileerror', { detail: { file, adapter, error } }));
          }
          continue;
        }

        const adapter = this.registry.find(file, await sampleFile(file));
        this.dispatchEvent(new CustomEvent('file', { detail: { file, adapter, classification, fileIndex, totalFiles: list.length } }));
        try {
          const profile = currentProfile();
          const parsed = await adapter.parse(file, { signal, profileName: profile.displayName, profileHandle: profile.handle });
          const normalized = parsed.map(item => normalizeRecord({
            ...item,
            compatibility: {
              ...(item.compatibility || {}),
              adapter: adapter.id,
              sourceMime: file.type || '',
              classifiedAs: classification.kind,
              classificationConfidence: classification.confidence,
              digestMode: fingerprint.mode
            }
          }, file, fingerprint.digest));
          for (let offset = 0; offset < normalized.length; offset += this.chunkSize) {
            abortIfNeeded(signal);
            const chunk = normalized.slice(offset, offset + this.chunkSize).filter(record => {
              if (uniqueRecord(record, keys)) return true;
              result.skipped += 1;
              return false;
            });
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
