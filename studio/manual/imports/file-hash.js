const HASH_WORKER_URL = new URL('./hash-worker.js', import.meta.url);
let worker = null;
let sequence = 0;
const pending = new Map();

function ensureWorker() {
  if (worker || typeof Worker === 'undefined' || !crypto?.subtle) return worker;
  worker = new Worker(HASH_WORKER_URL, { type: 'module' });
  worker.onmessage = event => {
    const { id, digest, error } = event.data || {};
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    error ? job.reject(new Error(error)) : job.resolve(digest);
  };
  worker.onerror = error => {
    for (const job of pending.values()) job.reject(error);
    pending.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

async function sampledDigest(file) {
  const span = 128 * 1024;
  const middleStart = Math.max(0, Math.floor(file.size / 2) - Math.floor(span / 2));
  const parts = [
    new TextEncoder().encode(`${file.name}\n${file.size}\n${file.lastModified}\n`),
    file.slice(0, span),
    file.slice(middleStart, middleStart + span),
    file.slice(Math.max(0, file.size - span))
  ];
  if (crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', await new Blob(parts).arrayBuffer());
    return { digest: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''), mode: 'sha256-sampled' };
  }
  let hash = 2166136261 >>> 0;
  for (const char of `${file.name}|${file.size}|${file.lastModified}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return { digest: (hash >>> 0).toString(16), mode: 'fnv-metadata' };
}

export async function digestFile(file, signal) {
  const active = ensureWorker();
  if (!active) return sampledDigest(file);
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const abort = () => {
      pending.delete(id);
      reject(signal.reason || new DOMException('Import stopped', 'AbortError'));
    };
    pending.set(id, {
      resolve: value => {
        signal?.removeEventListener('abort', abort);
        resolve({ digest: value, mode: 'sha256-worker' });
      },
      reject: error => {
        signal?.removeEventListener('abort', abort);
        reject(error);
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    active.postMessage({ id, file });
  }).catch(error => {
    if (error?.name === 'AbortError') throw error;
    return sampledDigest(file);
  });
}
