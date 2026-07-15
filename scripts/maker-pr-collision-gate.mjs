export const LEASE_MARKER = '<!-- sideways-path-lease:v1';
export const LEASE_END = '-->';

export function normalizeLeasePath(value) {
  const raw = String(value ?? '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/');
  if (!raw || raw.startsWith('/') || raw.includes('\0')) throw new Error(`invalid lease path: ${value}`);
  const wildcard = raw.endsWith('/**');
  const normalized = wildcard ? raw.slice(0, -3).replace(/\/$/, '') : raw.replace(/\/$/, '');
  if (!normalized || normalized.split('/').some(part => part === '..' || part === '.')) {
    throw new Error(`invalid lease path: ${value}`);
  }
  if (normalized.includes('*')) throw new Error(`only a terminal /** wildcard is supported: ${value}`);
  return wildcard ? `${normalized}/**` : normalized;
}

export function parsePathLease(body) {
  const source = String(body || '');
  const start = source.indexOf(LEASE_MARKER);
  if (start === -1) return null;
  if (source.indexOf(LEASE_MARKER, start + LEASE_MARKER.length) !== -1) {
    throw new Error('exactly one path lease is allowed');
  }
  const jsonStart = start + LEASE_MARKER.length;
  const end = source.indexOf(LEASE_END, jsonStart);
  if (end === -1) throw new Error('path lease marker is not closed');
  const parsed = JSON.parse(source.slice(jsonStart, end).trim());
  if (parsed?.version !== 'sideways-path-lease/v1') {
    throw new Error('path lease version must be sideways-path-lease/v1');
  }
  if (!Array.isArray(parsed.owned_paths) || parsed.owned_paths.length === 0) {
    throw new Error('path lease must declare owned_paths');
  }
  const owned_paths = [...new Set(parsed.owned_paths.map(normalizeLeasePath))].sort();
  const base_sha = String(parsed.base_sha || '').trim();
  if (!/^[0-9a-f]{40}$/i.test(base_sha)) throw new Error('path lease base_sha must be a full commit SHA');
  return {
    version: parsed.version,
    base_sha: base_sha.toLowerCase(),
    owner: String(parsed.owner || '').trim(),
    purpose: String(parsed.purpose || '').trim(),
    owned_paths
  };
}

export function pathPatternCovers(pattern, file) {
  const normalizedPattern = normalizeLeasePath(pattern);
  const normalizedFile = normalizeLeasePath(file);
  if (!normalizedPattern.endsWith('/**')) return normalizedPattern === normalizedFile;
  const prefix = normalizedPattern.slice(0, -3);
  return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`);
}

export function pathPatternsOverlap(left, right) {
  const a = normalizeLeasePath(left);
  const b = normalizeLeasePath(right);
  const aPrefix = a.endsWith('/**') ? a.slice(0, -3) : null;
  const bPrefix = b.endsWith('/**') ? b.slice(0, -3) : null;
  if (!aPrefix && !bPrefix) return a === b;
  if (aPrefix && bPrefix) {
    return aPrefix === bPrefix || aPrefix.startsWith(`${bPrefix}/`) || bPrefix.startsWith(`${aPrefix}/`);
  }
  if (aPrefix) return b === aPrefix || b.startsWith(`${aPrefix}/`);
  return a === bPrefix || a.startsWith(`${bPrefix}/`);
}

export function isMakerPullRequest(pr = {}) {
  const branch = String(pr.head?.ref || pr.head_ref || '');
  const title = String(pr.title || '');
  const body = String(pr.body || '');
  return branch.startsWith('maker/') ||
    branch.startsWith('agent/') ||
    /^\[maker:(?:build|fix|explore|audit)\]\s+/i.test(title) ||
    body.includes(LEASE_MARKER);
}

export function evaluatePathLease({ current, changed_files = [], open_pull_requests = [] }) {
  if (!isMakerPullRequest(current)) {
    return { status: 'not_applicable', collisions: [], uncovered_paths: [], invalid_peers: [] };
  }

  let lease;
  try {
    lease = parsePathLease(current.body);
  } catch (error) {
    return { status: 'blocked', reason: 'invalid_path_lease', error: error.message, collisions: [], uncovered_paths: [], invalid_peers: [] };
  }
  if (!lease) {
    return { status: 'blocked', reason: 'missing_path_lease', collisions: [], uncovered_paths: changed_files.map(normalizeLeasePath), invalid_peers: [] };
  }

  const currentBaseSha = String(current.base?.sha || current.base_sha || '').toLowerCase();
  if (currentBaseSha && lease.base_sha !== currentBaseSha) {
    return {
      status: 'blocked',
      reason: 'stale_base_sha',
      lease,
      expected_base_sha: currentBaseSha,
      collisions: [],
      uncovered_paths: [],
      invalid_peers: []
    };
  }

  const uncovered_paths = changed_files
    .map(normalizeLeasePath)
    .filter(file => !lease.owned_paths.some(pattern => pathPatternCovers(pattern, file)));
  const collisions = [];
  const invalid_peers = [];

  for (const peer of open_pull_requests) {
    if (Number(peer.number) === Number(current.number) || !isMakerPullRequest(peer)) continue;
    let peerLease;
    try {
      peerLease = parsePathLease(peer.body);
    } catch (error) {
      invalid_peers.push({ number: peer.number, reason: error.message });
      continue;
    }
    if (!peerLease) {
      invalid_peers.push({ number: peer.number, reason: 'missing_path_lease' });
      continue;
    }
    const overlaps = [];
    for (const owned of lease.owned_paths) {
      for (const other of peerLease.owned_paths) {
        if (pathPatternsOverlap(owned, other)) overlaps.push({ current: owned, peer: other });
      }
    }
    if (overlaps.length) collisions.push({ number: peer.number, title: peer.title, overlaps });
  }

  const status = uncovered_paths.length || collisions.length || invalid_peers.length ? 'blocked' : 'clear';
  return { status, lease, collisions, uncovered_paths, invalid_peers };
}
