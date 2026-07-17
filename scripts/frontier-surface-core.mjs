export const clean = (value, limit = 20_000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
export const exactSha = value => {
  const normalized = clean(value, 40);
  if (!/^[0-9a-f]{40}$/i.test(normalized)) throw new Error('Frontier assembly requires an exact 40-character base SHA.');
  return normalized.toLowerCase();
};
export const identifier = (value, field = 'identifier') => {
  const normalized = clean(value, 180).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
};
export const relativePrefix = value => {
  const normalized = clean(value, 600).replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/$/, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Frontier assembly output must be a bounded repository-relative path.');
  }
  return normalized;
};
export const escapeHTML = value => clean(value, 12_000).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export const title = value => clean(value, 500).split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

export function marker(candidate, extra = '') {
  return `data-frontier-candidate="${escapeHTML(candidate.candidate_id)}" data-frontier-role="${escapeHTML(candidate.role)}" ${extra}`.trim();
}

export function visibleDirective(directive) {
  if (!directive) return '';
  return `<aside class="redirect-note" aria-label="Redirected branch">New branch direction: ${escapeHTML(directive)}</aside>`;
}
