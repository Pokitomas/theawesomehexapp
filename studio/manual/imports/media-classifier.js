const EXTENSION_HINTS = Object.freeze({
  png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], gif: ['image', 'image/gif'], webp: ['image', 'image/webp'], avif: ['image', 'image/avif'], svg: ['image', 'image/svg+xml'], heic: ['image', 'image/heic'], heif: ['image', 'image/heif'],
  mp4: ['video', 'video/mp4'], m4v: ['video', 'video/mp4'], mov: ['video', 'video/quicktime'], webm: ['video', 'video/webm'], ogv: ['video', 'video/ogg'],
  mp3: ['audio', 'audio/mpeg'], m4a: ['audio', 'audio/mp4'], wav: ['audio', 'audio/wav'], aac: ['audio', 'audio/aac'], flac: ['audio', 'audio/flac'], ogg: ['audio', 'audio/ogg'], opus: ['audio', 'audio/opus'],
  pdf: ['pdf', 'application/pdf'],
  zip: ['archive', 'application/zip'], tar: ['archive', 'application/x-tar'], gz: ['archive', 'application/gzip'], tgz: ['archive', 'application/gzip'], rar: ['archive', 'application/vnd.rar'], '7z': ['archive', 'application/x-7z-compressed'],
  txt: ['text', 'text/plain'], md: ['text', 'text/markdown'], html: ['text', 'text/html'], htm: ['text', 'text/html'], css: ['text', 'text/css'], js: ['text', 'text/javascript'], json: ['text', 'application/json'], jsonl: ['text', 'application/x-ndjson'], ndjson: ['text', 'application/x-ndjson'], csv: ['text', 'text/csv'], xml: ['text', 'application/xml'], rss: ['text', 'application/rss+xml'], atom: ['text', 'application/atom+xml']
});

const MIME_KIND = Object.freeze({
  image: 'image', video: 'video', audio: 'audio', text: 'text'
});

function extension(name = '') {
  return String(name).split('.').pop()?.toLowerCase() || '';
}

function starts(bytes, signature) {
  if (bytes.length < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function magic(bytes) {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return ['image', 'image/png'];
  if (starts(bytes, [0xff, 0xd8, 0xff])) return ['image', 'image/jpeg'];
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return ['image', 'image/gif'];
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return ['image', 'image/webp'];
  if (ascii(bytes, 4, 4) === 'ftyp' && /avif|avis/.test(ascii(bytes, 8, 4))) return ['image', 'image/avif'];
  if (ascii(bytes, 4, 4) === 'ftyp' && /heic|heix|hevc|hevx|mif1|msf1/.test(ascii(bytes, 8, 4))) return ['image', 'image/heic'];
  if (ascii(bytes, 0, 4) === '%PDF') return ['pdf', 'application/pdf'];
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x50, 0x4b, 0x05, 0x06]) || starts(bytes, [0x50, 0x4b, 0x07, 0x08])) return ['archive', 'application/zip'];
  if (starts(bytes, [0x1f, 0x8b])) return ['archive', 'application/gzip'];
  if (starts(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return ['archive', 'application/x-7z-compressed'];
  if (ascii(bytes, 0, 4) === 'Rar!') return ['archive', 'application/vnd.rar'];
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return ['audio', 'audio/wav'];
  if (ascii(bytes, 0, 3) === 'ID3' || starts(bytes, [0xff, 0xfb]) || starts(bytes, [0xff, 0xf3]) || starts(bytes, [0xff, 0xf2])) return ['audio', 'audio/mpeg'];
  if (ascii(bytes, 0, 4) === 'OggS') return ['audio', 'application/ogg'];
  if (ascii(bytes, 0, 4) === '\u001aE\udf\ua3' || starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return ['video', 'video/webm'];
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (/M4A|M4B|mp4a/.test(brand)) return ['audio', 'audio/mp4'];
    if (/qt  /.test(brand)) return ['video', 'video/quicktime'];
    return ['video', 'video/mp4'];
  }
  return null;
}

function looksLikeText(bytes) {
  if (!bytes.length) return true;
  let controls = 0;
  let zeros = 0;
  for (const byte of bytes) {
    if (byte === 0) zeros += 1;
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  if (zeros) return false;
  return controls / bytes.length < 0.025;
}

function mimeHint(type = '') {
  const normalized = String(type).toLowerCase().split(';')[0].trim();
  if (!normalized) return null;
  const family = normalized.split('/')[0];
  if (MIME_KIND[family]) return [MIME_KIND[family], normalized];
  if (normalized === 'application/pdf') return ['pdf', normalized];
  if (/zip|gzip|tar|rar|7z/.test(normalized)) return ['archive', normalized];
  if (/json|xml|javascript|csv/.test(normalized)) return ['text', normalized];
  return null;
}

export async function classifyFile(file) {
  const bytes = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const byMagic = magic(bytes);
  if (byMagic) return { kind: byMagic[0], mime: byMagic[1], confidence: 'magic', direct: byMagic[0] !== 'text' };

  const ext = extension(file.name);
  const byExtension = EXTENSION_HINTS[ext];
  const byMime = mimeHint(file.type);
  if (byExtension && byMime && byExtension[0] === byMime[0]) {
    return { kind: byExtension[0], mime: byMime[1] || byExtension[1], confidence: 'mime+extension', direct: byExtension[0] !== 'text' };
  }
  if (byExtension) return { kind: byExtension[0], mime: byExtension[1], confidence: 'extension', direct: byExtension[0] !== 'text' };
  if (byMime) return { kind: byMime[0], mime: byMime[1], confidence: 'mime', direct: byMime[0] !== 'text' };
  if (looksLikeText(bytes)) return { kind: 'text', mime: file.type || 'text/plain', confidence: 'content', direct: false };
  return { kind: 'binary', mime: file.type || 'application/octet-stream', confidence: 'content', direct: true };
}

function objectURLProbe(file, build) {
  const url = URL.createObjectURL(file);
  return build(url).finally(() => URL.revokeObjectURL(url));
}

async function probeImage(file) {
  if ('createImageBitmap' in window) {
    try {
      const bitmap = await createImageBitmap(file);
      const result = { width: bitmap.width, height: bitmap.height, duration: 0 };
      bitmap.close();
      return result;
    } catch {}
  }
  return objectURLProbe(file, url => new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || 0, height: image.naturalHeight || 0, duration: 0 });
    image.onerror = () => resolve({ width: 0, height: 0, duration: 0 });
    image.src = url;
  }));
}

async function probePlayable(file, tagName) {
  return objectURLProbe(file, url => new Promise(resolve => {
    const media = document.createElement(tagName);
    const done = () => resolve({
      width: Number(media.videoWidth || 0),
      height: Number(media.videoHeight || 0),
      duration: Number.isFinite(media.duration) ? media.duration : 0
    });
    media.preload = 'metadata';
    media.onloadedmetadata = done;
    media.onerror = done;
    media.src = url;
  }));
}

export async function probeFile(file, classification) {
  if (classification.kind === 'image') return probeImage(file);
  if (classification.kind === 'video') return probePlayable(file, 'video');
  if (classification.kind === 'audio') return probePlayable(file, 'audio');
  return { width: 0, height: 0, duration: 0 };
}

export function mediaTitle(file) {
  return String(file.name || 'UNTITLED').replace(/^[-–—]+/, '').trim() || 'UNTITLED';
}
