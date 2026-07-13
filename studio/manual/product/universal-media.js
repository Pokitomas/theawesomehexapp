import { getAsset, getRecord } from './workspace-records.js';

const liveURLs = new Map();
const rendered = new Map();
let scheduled = false;

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
  node.className = `universal-file-surface is-${state}`;
  if (url) {
    node.href = url;
    node.download = record.originalName || record.title || 'file';
  }
  const code = document.createElement('strong');
  code.className = 'universal-file-code';
  code.textContent = state === 'missing' ? 'MISS' : extension(record.originalName || record.title, record.mime);
  const name = document.createElement('span');
  name.className = 'universal-file-name';
  name.textContent = record.originalName || record.title || 'UNTITLED';
  const meta = document.createElement('span');
  meta.className = 'universal-file-meta';
  meta.textContent = [kindFor(record) || 'FILE', formatBytes(record.size)].filter(Boolean).join(' / ');
  node.append(code, name, meta);
  return node;
}

function imageSurface(record, url) {
  const image = new Image();
  image.className = 'universal-image';
  image.alt = record.title || record.originalName || '';
  image.decoding = 'async';
  image.loading = 'lazy';
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
  stage.append(mark, audio);
  return stage;
}

function pdfSurface(record, url) {
  const frame = document.createElement('iframe');
  frame.className = 'universal-pdf';
  frame.title = record.title || record.originalName || 'PDF';
  frame.loading = 'lazy';
  frame.src = `${url}#view=FitH&toolbar=0`;
  return frame;
}

function surfaceFor(record, asset, url) {
  const kind = kindFor(record);
  if (!asset?.blob || !url) return fileSurface(record, '', 'missing');
  if (kind === 'image') return imageSurface(record, url);
  if (kind === 'video') return videoSurface(record, url);
  if (kind === 'audio') return audioSurface(record, url);
  if (kind === 'pdf') return pdfSurface(record, url);
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
  card.dataset.mediaKind = kindFor(record) || 'none';
}

async function renderCard(card) {
  const recordId = Number(card.dataset.id || 0);
  if (!recordId) return;
  const record = await getRecord(recordId);
  if (!record) return;
  const signature = `${record.updatedAt || record.addedAt || ''}:${record.assetKey || ''}:${record.mediaKind || ''}:${record.mime || ''}`;
  if (rendered.get(recordId) === signature && card.dataset.universalMedia === 'ready') return;

  const kind = kindFor(record);
  if (!kind && !record.assetKey) return;
  clearURL(recordId);
  const asset = record.assetKey ? await getAsset(record.assetKey) : null;
  const url = asset?.blob ? URL.createObjectURL(asset.blob) : '';
  if (url) liveURLs.set(recordId, url);

  const shell = mediaShell(card);
  shell.replaceChildren(surfaceFor(record, asset, url));
  applyGeometry(card, shell, record);
  card.classList.add('has-universal-media');
  card.classList.toggle('is-media-missing', !asset?.blob);
  card.dataset.universalMedia = 'ready';
  rendered.set(recordId, signature);
}

async function renderAll() {
  const cards = [...document.querySelectorAll('#feed .post')];
  const ids = new Set(cards.map(card => Number(card.dataset.id || 0)).filter(Boolean));
  for (const recordId of [...liveURLs.keys()]) if (!ids.has(recordId)) clearURL(recordId);
  await Promise.all(cards.map(renderCard));
  observeVideos();
  document.documentElement.dataset.universalMedia = 'ready';
}

const videoObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const video = entry.target;
    if (!entry.isIntersecting || entry.intersectionRatio < .35) video.pause();
  }
}, { threshold: [0, .35, .8] });

function observeVideos() {
  videoObserver.disconnect();
  for (const video of document.querySelectorAll('#feed .universal-video')) videoObserver.observe(video);
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(async () => {
    scheduled = false;
    await renderAll();
  });
}

for (const eventName of ['sideways:ready', 'sideways:feedrender', 'sideways:workspacechange', 'sideways:importcomplete', 'hashchange', 'popstate']) {
  window.addEventListener(eventName, schedule);
}
window.addEventListener('pagehide', () => {
  for (const recordId of [...liveURLs.keys()]) clearURL(recordId);
});
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
else schedule();
for (const delay of [120, 420, 1200]) setTimeout(schedule, delay);

window.SidewaysUniversalMedia = Object.freeze({ refresh: schedule, kindFor });
