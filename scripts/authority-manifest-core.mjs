import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REQUIRED_ROW_FIELDS = [
  'id', 'family', 'operation', 'originActor', 'principalSource', 'requiredAuthority',
  'mutableObject', 'authorityOwner', 'denialConditions', 'replayBoundary', 'residue',
  'status', 'surfaces', 'implementation', 'allowWitness', 'denyWitness'
];

const REQUIRED_EXTERNAL_UNKNOWN_FRAGMENTS = [
  'branch protection',
  'environment protection',
  'GitHub App',
  'secret values',
  'Pages deployment',
  'Netlify team roles',
  'PostgreSQL role grants'
];

function rootPath(root) {
  if (root instanceof URL) return fileURLToPath(root);
  return path.resolve(String(root));
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

async function textAt(root, relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

async function walkFiles(directory) {
  const output = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walkFiles(absolute));
    else output.push(absolute);
  }
  return output.sort();
}

function quotedValues(block) {
  return [...block.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]);
}

function discoverRemoteCapabilities(source) {
  const match = source.match(/export const CAPABILITIES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\);/);
  if (!match) return [];
  return quotedValues(match[1]).map(value => `remote-capability:${value}`);
}

function discoverRemoteControls(source) {
  return sortedUnique(
    [...source.matchAll(/\bop\s*===\s*'([^']+)'/g)]
      .map(match => `remote-control:${match[1]}`)
  );
}

function discoverSocialRoutes(source) {
  return sortedUnique(
    [...source.matchAll(/\bop\s*===\s*'([^']+)'/g)]
      .map(match => `social-route:${match[1]}`)
  );
}

function discoverSocialOperations(sources) {
  return sortedUnique(
    sources.flatMap(source =>
      [...source.matchAll(/\boperation:\s*'([^']+)'/g)]
        .map(match => `social-operation:${match[1]}`)
    )
  );
}

function discoverPublicProjections(source) {
  return sortedUnique(
    [...source.matchAll(/export function (public[A-Za-z0-9_]*Projection)\b/g)]
      .map(match => `public-projection:${match[1]}`)
  );
}

function workflowPermissionTokens(relativePath, source) {
  const tokens = [];
  const lines = source.split(/\r?\n/);
  let permissionIndent = null;

  for (const line of lines) {
    const indent = line.match(/^\s*/)?.[0].length || 0;
    const trimmed = line.trim();
    const inline = trimmed.match(/^permissions:\s*(read-all|write-all|\{\})\s*$/);
    if (inline) {
      tokens.push(`workflow-permission:${relativePath}:*:${inline[1]}`);
      permissionIndent = null;
      continue;
    }
    if (trimmed === 'permissions:') {
      permissionIndent = indent;
      continue;
    }
    if (permissionIndent === null) continue;
    if (trimmed && indent <= permissionIndent) {
      permissionIndent = null;
      continue;
    }
    const permission = trimmed.match(/^([A-Za-z0-9-]+):\s*(read|write|none)\s*(?:#.*)?$/);
    if (permission) {
      tokens.push(`workflow-permission:${relativePath}:${permission[1]}:${permission[2]}`);
    }
  }

  return sortedUnique(tokens);
}

function workflowSecretTokens(relativePath, source) {
  return sortedUnique(
    [...source.matchAll(/\bsecrets\.([A-Z0-9_]+)/g)]
      .map(match => `workflow-secret:${relativePath}:${match[1]}`)
  );
}

export async function discoverAuthoritySurfaces(root = process.cwd()) {
  const repositoryRoot = rootPath(root);
  const [
    remoteCore,
    remoteService,
    socialRoutes,
    socialStore,
    socialCommunity
  ] = await Promise.all([
    textAt(repositoryRoot, 'netlify/functions/remote-core.mjs'),
    textAt(repositoryRoot, 'netlify/functions/remote-service.mjs'),
    textAt(repositoryRoot, 'netlify/functions/social-relational-core.mjs'),
    textAt(repositoryRoot, 'netlify/functions/social-postgres-store.mjs'),
    textAt(repositoryRoot, 'netlify/functions/social-postgres-community.mjs')
  ]);

  const workflowRoot = path.join(repositoryRoot, '.github/workflows');
  const workflowFiles = (await walkFiles(workflowRoot))
    .filter(file => /\.ya?ml$/i.test(file));

  const workflowSurfaces = [];
  for (const absolutePath of workflowFiles) {
    const relativePath = path.relative(repositoryRoot, absolutePath).split(path.sep).join('/');
    const source = await readFile(absolutePath, 'utf8');
    workflowSurfaces.push(
      ...workflowPermissionTokens(relativePath, source),
      ...workflowSecretTokens(relativePath, source)
    );
  }

  return sortedUnique([
    ...discoverRemoteCapabilities(remoteCore),
    ...discoverRemoteControls(remoteService),
    ...discoverSocialRoutes(socialRoutes),
    ...discoverSocialOperations([socialStore, socialCommunity]),
    ...discoverPublicProjections(remoteCore),
    ...workflowSurfaces
  ]);
}

function manifestSurfaceOwnership(manifest) {
  const owners = new Map();
  for (const row of manifest.rows || []) {
    for (const surface of row.surfaces || []) {
      const list = owners.get(surface) || [];
      list.push(row.id);
      owners.set(surface, list);
    }
  }
  return owners;
}

export function compareSurfaceCoverage(manifest, discoveredSurfaces) {
  const errors = [];
  const owners = manifestSurfaceOwnership(manifest);
  const discovered = new Set(discoveredSurfaces);

  for (const surface of discoveredSurfaces) {
    const mapped = owners.get(surface) || [];
    if (mapped.length === 0) errors.push(`unmapped authority surface: ${surface}`);
    if (mapped.length > 1) errors.push(`authority surface has multiple owners (${mapped.join(', ')}): ${surface}`);
  }

  for (const [surface, mapped] of owners) {
    if (!discovered.has(surface)) {
      errors.push(`manifest surface no longer exists in repository truth (${mapped.join(', ')}): ${surface}`);
    }
  }

  return errors.sort();
}

async function validateReferences(repositoryRoot, row, field, cache) {
  const errors = [];
  const references = row[field];
  if (!Array.isArray(references) || references.length === 0) {
    return [`${row.id}: ${field} must contain at least one file reference`];
  }

  for (const reference of references) {
    const relativePath = reference?.path;
    if (typeof relativePath !== 'string' || !relativePath) {
      errors.push(`${row.id}: ${field} has a reference without a path`);
      continue;
    }
    let source = cache.get(relativePath);
    if (source === undefined) {
      try {
        source = await textAt(repositoryRoot, relativePath);
      } catch {
        source = null;
      }
      cache.set(relativePath, source);
    }
    if (source === null) {
      errors.push(`${row.id}: ${field} references missing file ${relativePath}`);
      continue;
    }

    if (!Array.isArray(reference.anchors) || reference.anchors.length === 0) {
      errors.push(`${row.id}: ${field} reference ${relativePath} must include anchors`);
      continue;
    }
    for (const anchor of reference.anchors) {
      if (typeof anchor !== 'string' || !anchor) {
        errors.push(`${row.id}: ${field} reference ${relativePath} has an empty anchor`);
      } else if (!source.includes(anchor)) {
        errors.push(`${row.id}: ${field} anchor missing from ${relativePath}: ${JSON.stringify(anchor)}`);
      }
    }
  }
  return errors;
}

function validateRowShape(row, ids) {
  const errors = [];
  for (const field of REQUIRED_ROW_FIELDS) {
    if (!(field in row)) errors.push(`${row.id || '<unknown>'}: missing required field ${field}`);
  }

  if (typeof row.id !== 'string' || !row.id) errors.push('row id must be a non-empty string');
  else if (ids.has(row.id)) errors.push(`duplicate row id: ${row.id}`);
  else ids.add(row.id);

  for (const field of [
    'family', 'operation', 'originActor', 'principalSource', 'requiredAuthority',
    'mutableObject', 'authorityOwner', 'replayBoundary'
  ]) {
    if (typeof row[field] !== 'string' || !row[field].trim()) {
      errors.push(`${row.id}: ${field} must be a non-empty string`);
    }
  }

  if (!Array.isArray(row.denialConditions) || row.denialConditions.length === 0) {
    errors.push(`${row.id}: denialConditions must be non-empty`);
  }
  if (!row.residue || typeof row.residue.public !== 'string' || typeof row.residue.private !== 'string') {
    errors.push(`${row.id}: residue must declare public and private strings`);
  }
  if (!['enforced', 'tracked-gap', 'declaration-only'].includes(row.status)) {
    errors.push(`${row.id}: unsupported status ${JSON.stringify(row.status)}`);
  }
  if (!Array.isArray(row.surfaces) || row.surfaces.length === 0) {
    errors.push(`${row.id}: surfaces must be non-empty`);
  }

  if (row.status === 'tracked-gap') {
    if (!Array.isArray(row.trackers) || row.trackers.length === 0 || row.trackers.some(value => !/^#\d+$/.test(value))) {
      errors.push(`${row.id}: tracked-gap rows require one or more #issue trackers`);
    }
    if (!Array.isArray(row.gapCharacterization) || row.gapCharacterization.length === 0) {
      errors.push(`${row.id}: tracked-gap rows require gapCharacterization references`);
    }
  } else {
    if (row.trackers || row.gapCharacterization) {
      errors.push(`${row.id}: only tracked-gap rows may carry trackers or gapCharacterization`);
    }
  }

  return errors;
}

export async function validateManifest({ root = process.cwd(), manifest, discoveredSurfaces }) {
  const repositoryRoot = rootPath(root);
  const errors = [];
  if (!manifest || manifest.schemaVersion !== 1) errors.push('manifest schemaVersion must equal 1');
  if (!Array.isArray(manifest?.rows) || manifest.rows.length === 0) errors.push('manifest rows must be non-empty');
  if (!Array.isArray(manifest?.externalUnknowns)) errors.push('manifest externalUnknowns must be an array');

  const externalText = (manifest?.externalUnknowns || []).join('\n');
  for (const fragment of REQUIRED_EXTERNAL_UNKNOWN_FRAGMENTS) {
    if (!externalText.toLowerCase().includes(fragment.toLowerCase())) {
      errors.push(`external unknown is not explicit: ${fragment}`);
    }
  }

  const ids = new Set();
  const cache = new Map();
  for (const row of manifest?.rows || []) {
    errors.push(...validateRowShape(row, ids));
    for (const field of ['implementation', 'allowWitness', 'denyWitness']) {
      errors.push(...await validateReferences(repositoryRoot, row, field, cache));
    }
    if (row.status === 'tracked-gap') {
      errors.push(...await validateReferences(repositoryRoot, row, 'gapCharacterization', cache));
    }
  }

  errors.push(...compareSurfaceCoverage(manifest || { rows: [] }, discoveredSurfaces || []));
  return sortedUnique(errors);
}

export async function auditRepository(root = process.cwd()) {
  const repositoryRoot = rootPath(root);
  const manifestPath = path.join(repositoryRoot, 'audit/authority-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const discoveredSurfaces = await discoverAuthoritySurfaces(repositoryRoot);
  const errors = await validateManifest({ root: repositoryRoot, manifest, discoveredSurfaces });
  return {
    manifest,
    discoveredSurfaces,
    errors,
    summary: {
      rows: manifest.rows.length,
      surfaces: discoveredSurfaces.length,
      trackedGaps: manifest.rows.filter(row => row.status === 'tracked-gap').length,
      declarationOnly: manifest.rows.filter(row => row.status === 'declaration-only').length,
      externalUnknowns: manifest.externalUnknowns.length
    }
  };
}

async function main() {
  const root = process.argv[2] || process.cwd();
  const result = await auditRepository(root);
  if (result.errors.length) {
    console.error('Authority manifest drift detected:');
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  const { rows, surfaces, trackedGaps, declarationOnly, externalUnknowns } = result.summary;
  console.log(`authority manifest ok: ${rows} rows, ${surfaces} surfaces, ${trackedGaps} tracked gaps, ${declarationOnly} declaration-only rows, ${externalUnknowns} external unknowns`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
