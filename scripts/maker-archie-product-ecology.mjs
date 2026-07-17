import crypto from 'node:crypto';

export const ARCHIE_APP_MANIFEST_SCHEMA = 'archie-app-manifest/v1';
export const ARCHIE_APP_RESOLUTION_SCHEMA = 'archie-app-resolution/v1';

const clean = (value, limit = 200000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');

function strings(value, limit = 300) {
  return [...new Set((Array.isArray(value) ? value : []).map(item => clean(item, limit)).filter(Boolean))].sort();
}

export function normalizeArchieAppManifest(value = {}) {
  const appId = clean(value?.app_id || value?.id, 300);
  const version = clean(value?.version, 100);
  const humanOutcome = clean(value?.human_outcome, 5000);
  if (!appId || !version || !humanOutcome) throw new Error('Archie app_id, version, and human_outcome are required.');
  const requirements = value?.requirements || {};
  const body = {
    schema: ARCHIE_APP_MANIFEST_SCHEMA,
    app_id: appId,
    version,
    human_outcome: humanOutcome,
    required_faculties: strings(value?.required_faculties),
    optional_faculties: strings(value?.optional_faculties),
    requirements: {
      permissions: strings(requirements.permissions),
      tools: strings(requirements.tools),
      sensors: strings(requirements.sensors),
      connectivity: clean(requirements.connectivity || 'any', 100),
      minimum_memory_mb: Math.max(0, Number(requirements.minimum_memory_mb || 0)),
      maximum_latency_ms: requirements.maximum_latency_ms == null ? null : Math.max(0, Number(requirements.maximum_latency_ms)),
      continuity: clean(requirements.continuity || 'session', 100)
    },
    interaction_forms: strings(value?.interaction_forms, 200),
    evidence_gates: Array.isArray(value?.evidence_gates) ? value.evidence_gates : [],
    degradation: value?.degradation ?? null,
    retirement: value?.retirement ?? null,
    metadata: value?.metadata ?? null
  };
  return Object.freeze({ ...body, manifest_digest: digest(body) });
}

function missing(required, available) {
  const set = new Set(available || []);
  return required.filter(item => !set.has(item));
}

export function resolveArchieApps(manifests, environment = {}) {
  const normalized = (Array.isArray(manifests) ? manifests : []).map(normalizeArchieAppManifest);
  const admitted = [];
  const blocked = [];
  for (const manifest of normalized) {
    const reasons = [];
    for (const faculty of missing(manifest.required_faculties, environment.faculties)) reasons.push({ kind: 'missing-faculty', value: faculty });
    for (const permission of missing(manifest.requirements.permissions, environment.permissions)) reasons.push({ kind: 'missing-permission', value: permission });
    for (const tool of missing(manifest.requirements.tools, environment.tools)) reasons.push({ kind: 'missing-tool', value: tool });
    for (const sensor of missing(manifest.requirements.sensors, environment.sensors)) reasons.push({ kind: 'missing-sensor', value: sensor });
    if (manifest.requirements.connectivity !== 'any' && manifest.requirements.connectivity !== clean(environment.connectivity || 'offline', 100)) {
      reasons.push({ kind: 'connectivity', required: manifest.requirements.connectivity, observed: clean(environment.connectivity || 'offline', 100) });
    }
    if (Number(environment.memory_mb || 0) < manifest.requirements.minimum_memory_mb) {
      reasons.push({ kind: 'memory', required: manifest.requirements.minimum_memory_mb, observed: Number(environment.memory_mb || 0) });
    }
    if (manifest.requirements.maximum_latency_ms != null && Number(environment.latency_ms ?? Number.POSITIVE_INFINITY) > manifest.requirements.maximum_latency_ms) {
      reasons.push({ kind: 'latency', required: manifest.requirements.maximum_latency_ms, observed: Number(environment.latency_ms ?? Number.POSITIVE_INFINITY) });
    }
    if (reasons.length) blocked.push({ app_id: manifest.app_id, version: manifest.version, manifest_digest: manifest.manifest_digest, reasons });
    else admitted.push({ app_id: manifest.app_id, version: manifest.version, manifest_digest: manifest.manifest_digest, human_outcome: manifest.human_outcome, interaction_forms: manifest.interaction_forms });
  }
  admitted.sort((left, right) => left.app_id.localeCompare(right.app_id) || left.version.localeCompare(right.version));
  blocked.sort((left, right) => left.app_id.localeCompare(right.app_id) || left.version.localeCompare(right.version));
  const body = {
    schema: ARCHIE_APP_RESOLUTION_SCHEMA,
    brain_package_digest: clean(environment.brain_package_digest, 300) || null,
    environment_digest: digest(environment),
    admitted,
    blocked
  };
  return Object.freeze({ ...body, resolution_digest: digest(body) });
}
