import { getAssets, getRecord } from './workspace-records.js';

const liveURLs = new Map();
const rendered = new Map();
const recordCache = new Map();
const pendingCards = new Set();
let batchScheduled = false;
let scanScheduled = false;

function kindFor(record = {}) {
  if (record.mediaKind) return record.mediaKind;
  const mime = String(record.mime || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (/zip|gzip|tar|rar|7z/.test(mime)) return 'archive';
  if (mime && mime !== 'text/plain' && mime !== 'application/octet-stream') return 'binary';
  return '';
}

function extension(name = '', mime = '') {
  const ext = String(name).split('.').pop();
  if (ext && ext !== name) return ext.slice(0, 8).toUpperCase();
  const tail = String(mime).split('/').pop();
  return (tail || 'FILE').replace(/[^a-z0-9]+/gi, '').slice(0, 8).toUpperCase() || 'FILE';
}

function fileCode(record, state) {
  if (state === 'missing') return 'MISS';
  const kind = kindFor(record);
  if (kind === 'binary') return 'BIN';
  if (kind === 'archive') return 'ARC';
  if (kind === 'pdf') return 'PDF';
  if (kind === 'audio') return 'AUD';
  if (kind === 'video') return 'VID';
  if (kind === 'image') return 'IMG';
  return extension(record.originalName || record.title, record.mime);
}

function formatBytes(value = 0) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function clearURL(recordId) {
  const current = liveURLs.get(recordId);
  if (current) URL.revokeObjectURL(current);
  liveURLs.delete(recordId);
}

function mediaShell(card) {
  let shell = card.querySelector('.media-shell');
  if (!shell) {
    shell = document.createElement('div');
    shell.className = 'media-shell universal-media-shell';
    const copy = card.querySelector('.post-copy, .title, .engagement, .actions');
    if (copy) copy.before(shell);
    else card.append(shell);
  }
  shell.classList.add('universal-media-shell');
  return shell;
}

function fileSurface(record, url, state = 'ready') {
  const node = document.createElement(url ? 'a' : 'div');
  const kind = kindFor(record);
  node.className = `universal-file-surface is-${state} is-${kind || 'file'}`;
  if (url) {
    node.href = url;
    if (kind === 'pdf') {
      node.target = '_blank';
      node.rel = 'noopener';
      node.setAttribute('aria-label', `Open ${record.originalName || record.title || 'PDF'}`);
    } else {
      node.download = record.originalName || record.title || 'file';
      node.setAttribute('aria-label', `Download ${record.originalName || record.title || 'file'}`);
    }
  }
  const code = document.createElement('strong');
  code.className = 'universal-file-code';
  code.textContent = fileCode(record, state);
  const name = document.createElement('span');
  name.className = 'universal-file-name';
  name.textContent = record.originalName || record.title || 'UNTITLED';
  const meta = document.createElement('span');
  meta.className = 'universal-file-meta';
  meta.textContent = [kind || 'FILE', formatBytes(record.size)].filter(Boolean).join(' / ');
  node.append(code, name, meta);
  return node;
}

function imageSurface(record, url, release) {
  const image = new Image();
  image.className = 'universal-image';
  image.alt = record.title || record.originalName || '';
  image.decoding = 'async';
  image.loading = 'lazy';
  image.addEventListener('load', release, { once: true });
  image.addEventListener('error', () => {
    release();
    image.replaceWith(fileSurface(record, '', 'broken'));
  }, { once: true });
  image.src = url;
  return image;
}

function videoSurface(record, url) {
  const video = document.createElement('video');
  video.className = 'universal-video';
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = url;
  video.setAttribute('aria-label', record.title || 'Video');
  video.addEventListener('error', () => video.replaceWith(fileSurface(record, '', 'broken')), { once: true });
  return video;
}

function audioSurface(record, url) {
  const stage = document.createElement('div');
  stage.className = 'universal-audio';
  const mark = document.createElement('div');
  mark.className = 'universal-audio-mark';
  mark.textContent = 'AUDIO';
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'metadata';
  audio.src = url;
  audio.addEventListener('error', () => stage.replaceWith(fileSurface(record, '', 'broken')), { once: true });
  stage.append(mark, audio);
  return stage;
}

function surfaceFor(recordId, record, renderBlob, url) {
  const kind = kindFor(record);
  if (!renderBlob || !url) return fileSurface(record, '', 'missing');
  if (kind === 'image') return imageSurface(record, url, () => clearURL(recordId));
  if (kind === 'video') return videoSurface(record, url);
  if (kind === 'audio') return audioSurface(record, url);
  return fileSurface(record, url);
}

function applyGeometry(card, shell, record) {
  const width = Number(record.width) || 0;
  const height = Number(record.height) || 0;
  if (width && height) {
    const ratio = width / height;
    shell.style.setProperty('--media-ratio', String(ratio));
    card.dataset.mediaOrientation = ratio > 1.15 ? 'wide' : ratio < .86 ? 'tall' : 'square';
  } else {
    shell.style.removeProperty('--media-ratio');
    card.dataset.mediaOrientation = 'unknown';
  }
  shell.dataset.mediaTitle = record.title || record.originalName || '';
  card.dataset.mediaKind = kindFor(record) || 'none';
}

function recordFromCore(recordId) {
  const records = window.SidewaysCore?.state?.records;
  if (!Array.isArray(records)) return null;
  return records.find(record => Number(record.id) === recordId) || null;
}

async function resolveRecord(card) {
  const recordId = Number(card.dataset.id || 0);
  if (!recordId) return null;
  const coreRecord = recordFromCore(recordId);
  if (coreRecord) {
    recordCache.set(recordId, coreRecord);
    return coreRecord;
  }
  if (recordCache.has(recordId)) return recordCache.get(recordId);
  const record = await getRecord(recordId);
  if (record) recordCache.set(recordId, record);
  return record;
}

function signatureFor(record) {
  return `${record.updatedAt || record.addedAt || ''}:${record.assetKey || ''}:${record.mediaKind || ''}:${record.mime || ''}`;
}

function renderResolved(card, record, asset) {
  const recordId = Number(card.dataset.id || 0);
  const signature = signatureFor(record);
  if (rendered.get(recordId) === signature && card.dataset.universalMedia === 'ready') return;

  const kind = kindFor(record);
  if (!kind && !record.assetKey) return;
  clearURL(recordId);
  const storedBlob = asset?.blob || null;
  const declaredMime = asset?.mime || record.mime || '';
  const renderBlob = storedBlob && !storedBlob.type && declaredMime
    ? new Blob([storedBlob], { type: declaredMime })
    : storedBlob;
  const url = renderBlob ? URL.createObjectURL(renderBlob) : '';
  if (url) liveURLs.set(recordId, url);

  const shell = mediaShell(card);
  shell.replaceChildren(surfaceFor(recordId, record, renderBlob, url));
  applyGeometry(card, shell, record);
  card.classList.add('has-universal-media');
  card.classList.toggle('is-media-missing', !renderBlob);
  card.dataset.universalMedia = 'ready';
  rendered.set(recordId, signature);
  for (const video of shell.querySelectorAll('.universal-video')) videoObserver.observe(video);
}

async function flushBatch() {
  batchScheduled = false;
  const cards = [...pendingCards].filter(card => card.isConnected);
  pendingCards.clear();
  if (!cards.length) return;

  const pairs = (await Promise.all(cards.map(async card => [card, await resolveRecord(card)]))).filter(([, record]) => record);
  const assets = await getAssets(pairs.map(([, record]) => record.assetKey));
  for (const [card, record] of pairs) renderResolved(card, record, assets.get(record.assetKey) || null);
  document.documentElement.dataset.universalMedia = 'ready';
}

function enqueue(card) {
  if (!card?.isConnected) return;
  pendingCards.add(card);
  if (batchScheduled) return;
  batchScheduled = true;
  requestAnimationFrame(() => void flushBatch().catch(error => console.warn('[media] hydrate failed', error)));
}

function dehydrate(card) {
  const recordId = Number(card.dataset.id || 0);
  const record = recordCache.get(recordId);
  const kind = kindFor(record || {});
  const media = card.querySelector('video, audio');
  media?.pause?.();
  if (!record || kind === 'image' || !liveURLs.has(recordId)) return;
  clearURL(recordId);
  const shell = mediaShell(card);
  shell.replaceChildren(fileSurface(record, '', 'cold'));
  card.dataset.universalMedia = 'cold';
  rendered.delete(recordId);
}

const mediaObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (entry.isIntersecting) enqueue(entry.target);
    else dehydrate(entry.target);
  }
}, { rootMargin: '900px 0px', threshold: 0.01 });

const videoObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting || entry.intersectionRatio < .35) entry.target.pause();
  }
}, { threshold: [0, .35, .8] });

function nearViewport(card) {
  const rect = card.getBoundingClientRect();
  return rect.bottom > -900 && rect.top < innerHeight + 900;
}

function scan() {
  scanScheduled = false;
  const cards = [...document.querySelectorAll('#feed .post')];
  const ids = new Set(cards.map(card => Number(card.dataset.id || 0)).filter(Boolean));
  for (const recordId of [...liveURLs.keys()]) if (!ids.has(recordId)) clearURL(recordId);
  for (const recordId of [...recordCache.keys()]) if (!ids.has(recordId)) recordCache.delete(recordId);
  mediaObserver.disconnect();
  videoObserver.disconnect();
  for (const card of cards) {
    mediaObserver.observe(card);
    if (nearViewport(card)) enqueue(card);
  }
  document.documentElement.dataset.universalMedia = 'ready';
}

function schedule() {
  if (scanScheduled) return;
  scanScheduled = true;
  requestAnimationFrame(scan);
}

for (const eventName of ['sideways:ready', 'sideways:feedrender', 'sideways:workspacechange', 'sideways:importcomplete', 'hashchange', 'popstate']) {
  window.addEventListener(eventName, schedule);
}
window.addEventListener('pagehide', () => {
  mediaObserver.disconnect();
  videoObserver.disconnect();
  for (const recordId of [...liveURLs.keys()]) clearURL(recordId);
});
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
else schedule();

window.SidewaysUniversalMedia = Object.freeze({ refresh: schedule, kindFor });
