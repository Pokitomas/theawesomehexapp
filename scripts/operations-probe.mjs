#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const SNAPSHOT_SCHEMA = 'sideways-operations-snapshot/v1';
export const RECEIPT_SCHEMA = 'sideways-operations-probe-receipt/v1';
const SHA40 = /^[0-9a-f]{40}$/i;
const SECRET_KEY = /(^|_)(password|passwd|secret|token|credential|api_?key|private_?key|bearer|jwt|cookie_value)(_|$)/i;
const STATES = new Set(['verified', 'unknown']);

function clean(value, limit = 10_000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
}

function exactSha(value, label) {
  const normalized = clean(value, 80).toLowerCase();
  if (!SHA40.test(normalized)) throw new Error(`${label} must be an exact 40-character commit SHA.`);
  return normalized;
}

export function assertRedacted(value, path = 'snapshot') {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new Error(`Secret-bearing field is forbidden at ${path}.${key}.`);
    if (typeof nested === 'string' && /:\/\/[^/@\s]+:[^/@\s]+@/.test(nested)) throw new Error(`Credential-bearing URL is forbidden at ${path}.${key}.`);
    assertRedacted(nested, `${path}.${key}`);
  }
}

function iso(value, label) {
  const raw = clean(value, 100);
  const time = Date.parse(raw);
  if (!raw || !Number.isFinite(time) || new Date(time).toISOString() !== raw) throw new Error(`${label} must be a canonical ISO timestamp.`);
  return { raw, time };
}

function evidenceList(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} requires non-empty redacted evidence.`);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${label}[${index}] must be an object.`);
    const source = clean(item.source, 500);
    const observed = iso(item.observed_at, `${label}[${index}].observed_at`).raw;
    if (!source) throw new Error(`${label}[${index}].source is required.`);
    return Object.freeze({ source, observed_at: observed, digest: clean(item.digest, 128) || null });
  });
}

function fact(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is required.`);
  const state = clean(value.state, 30);
  if (!STATES.has(state)) throw new Error(`${label}.state must be verified or unknown.`);
  if (state === 'unknown') {
    if (Array.isArray(value.evidence) && value.evidence.length) throw new Error(`${label} cannot attach evidence while unknown.`);
    return Object.freeze({ state, evidence: [], note: clean(value.note, 1_000) || null });
  }
  return Object.freeze({ state, evidence: evidenceList(value.evidence, `${label}.evidence`), note: clean(value.note, 1_000) || null });
}

function authority(value, label) {
  const text = clean(value, 200);
  if (!text) throw new Error(`${label} human authority is required.`);
  return text;
}

function procedure(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} procedure is required.`);
  const commands = Array.isArray(value.commands) ? value.commands.map(item => clean(item, 2_000)).filter(Boolean) : [];
  const rollback = Array.isArray(value.rollback) ? value.rollback.map(item => clean(item, 2_000)).filter(Boolean) : [];
  const stop = Array.isArray(value.stop_conditions) ? value.stop_conditions.map(item => clean(item, 1_000)).filter(Boolean) : [];
  if (!commands.length || !rollback.length || !stop.length) throw new Error(`${label} requires commands, rollback, and stop_conditions.`);
  return Object.freeze({ commands, rollback, stop_conditions: stop, authority: authority(value.authority, `${label}.authority`) });
}

function rejectProductionTarget(database) {
  const target = clean(database.target, 500);
  if (!target) throw new Error('database.target is required for verified database evidence.');
  if (/\b(prod|production|live|primary)\b/i.test(target)) throw new Error('Production database targets are forbidden. Use a disposable target.');
  if (database.target_kind !== 'disposable') throw new Error('database.target_kind must be disposable.');
  if (database.confirmation !== 'I_USED_A_DISPOSABLE_DATABASE') throw new Error('Disposable database confirmation is missing.');
  return target;
}

function successfulWitness(value, label) {
  if (!value || value.success !== true) throw new Error(`${label} requires success=true.`);
  const observedAt = iso(value.observed_at, `${label}.observed_at`).raw;
  const evidence = evidenceList(value.evidence, `${label}.evidence`);
  return Object.freeze({ success: true, observed_at: observedAt, evidence });
}

function validateDatabase(value, { allowDatabaseEvidence }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('database section is required.');
  const state = clean(value.state, 30);
  if (!STATES.has(state)) throw new Error('database.state must be verified or unknown.');
  if (state === 'unknown') {
    if (value.backup?.success === true && value.restore?.success !== true) throw new Error('A backup without a successful restore witness is inadmissible.');
    return Object.freeze({ state: 'unknown', target_kind: null, target: null, migration: null, backup: null, restore: null, rollback: null });
  }
  if (!allowDatabaseEvidence) throw new Error('Verified database evidence requires --accept-disposable-database.');
  const target = rejectProductionTarget(value);
  const migration = successfulWitness(value.migration, 'database.migration');
  const backup = successfulWitness(value.backup, 'database.backup');
  const restore = successfulWitness(value.restore, 'database.restore');
  const rollback = successfulWitness(value.rollback, 'database.rollback');
  return Object.freeze({ state: 'verified', target_kind: 'disposable', target, migration, backup, restore, rollback });
}

function validateEndpoint(value, expectedSha) {
  const endpoint = value && typeof value === 'object' && !Array.isArray(value) ? value : { state: 'unknown' };
  const state = clean(endpoint.state, 30);
  if (!STATES.has(state)) throw new Error('endpoint.state must be verified or unknown.');
  if (state === 'unknown') return Object.freeze({ state, served_commit: null, sentinel: null, function: null, cookie_security: null, rate_limit: null, service_unavailable: null, evidence: [] });
  const servedCommit = exactSha(endpoint.served_commit, 'endpoint.served_commit');
  if (servedCommit !== expectedSha) throw new Error('Live served commit does not match the authorized commit.');
  const sentinel = fact(endpoint.sentinel, 'endpoint.sentinel');
  const functionFact = fact(endpoint.function, 'endpoint.function');
  const cookie = fact(endpoint.cookie_security, 'endpoint.cookie_security');
  const rateLimit = fact(endpoint.rate_limit, 'endpoint.rate_limit');
  const unavailable = fact(endpoint.service_unavailable, 'endpoint.service_unavailable');
  if ([sentinel, functionFact].some(item => item.state !== 'verified')) throw new Error('Verified endpoint state requires verified sentinel and function evidence.');
  return Object.freeze({ state, served_commit: servedCommit, sentinel, function: functionFact, cookie_security: cookie, rate_limit: rateLimit, service_unavailable: unavailable, evidence: evidenceList(endpoint.evidence, 'endpoint.evidence') });
}

export function validateSnapshot(snapshot, {
  expectedSha,
  now = Date.now(),
  maxAgeHours = 168,
  allowDatabaseEvidence = false
} = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Operations snapshot must be an object.');
  assertRedacted(snapshot);
  if (snapshot.schema !== SNAPSHOT_SCHEMA) throw new Error(`Snapshot schema must be ${SNAPSHOT_SCHEMA}.`);
  const expected = exactSha(expectedSha, 'expected_sha');
  const authorizedCommit = exactSha(snapshot.authorized_commit, 'snapshot.authorized_commit');
  if (authorizedCommit !== expected) throw new Error('Snapshot authorized_commit is stale or does not match expected_sha.');
  const observed = iso(snapshot.observed_at, 'snapshot.observed_at');
  const age = now - observed.time;
  if (age < -5 * 60 * 1000) throw new Error('Snapshot observed_at is in the future.');
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) throw new Error('maxAgeHours must be finite and positive.');
  if (age > maxAgeHours * 60 * 60 * 1000) throw new Error(`Snapshot is older than ${maxAgeHours} hours.`);
  const authorities = {
    release: authority(snapshot.authorities?.release, 'authorities.release'),
    database: authority(snapshot.authorities?.database, 'authorities.database'),
    incident: authority(snapshot.authorities?.incident, 'authorities.incident')
  };
  const settings = {
    branch_rules: fact(snapshot.settings?.branch_rules, 'settings.branch_rules'),
    environment_rules: fact(snapshot.settings?.environment_rules, 'settings.environment_rules'),
    application_grants: fact(snapshot.settings?.application_grants, 'settings.application_grants')
  };
  const endpoint = validateEndpoint(snapshot.endpoint, expected);
  const database = validateDatabase(snapshot.database, { allowDatabaseEvidence });
  const release = procedure(snapshot.release_procedure, 'release_procedure');
  const incident = procedure(snapshot.incident_procedure, 'incident_procedure');
  return Object.freeze({ schema: SNAPSHOT_SCHEMA, observed_at: observed.raw, authorized_commit: authorizedCommit, authorities, settings, endpoint, database, release_procedure: release, incident_procedure: incident });
}

function securityHeaders(headers) {
  return Object.freeze({
    content_security_policy: Boolean(headers.get('content-security-policy')),
    strict_transport_security: Boolean(headers.get('strict-transport-security')),
    content_type_options: headers.get('x-content-type-options') || null,
    referrer_policy: headers.get('referrer-policy') || null
  });
}

export async function probePublicEndpoint(endpoint, { expectedSha, fetchImpl = fetch } = {}) {
  const base = new URL(endpoint);
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('Public endpoint probing requires HTTPS.');
  const sentinelUrl = new URL('/sideways-deployment.json', base);
  const socialUrl = new URL('/api/social?op=session', base);
  const [sentinelResponse, socialResponse] = await Promise.all([
    fetchImpl(sentinelUrl, { method: 'GET', redirect: 'error' }),
    fetchImpl(socialUrl, { method: 'GET', redirect: 'error' })
  ]);
  const sentinel = await sentinelResponse.json().catch(() => ({}));
  const servedCommit = exactSha(sentinel.commit || sentinel.sha || sentinel.head_sha, 'live sentinel commit');
  const expected = exactSha(expectedSha, 'expected_sha');
  return Object.freeze({
    endpoint: base.origin,
    served_commit: servedCommit,
    commit_matches: servedCommit === expected,
    sentinel: { status: sentinelResponse.status, ok: sentinelResponse.ok, security_headers: securityHeaders(sentinelResponse.headers) },
    function: { status: socialResponse.status, ok: socialResponse.ok, content_type: socialResponse.headers.get('content-type') || null },
    cookie_security: { set_cookie_present: Boolean(socialResponse.headers.get('set-cookie')), observable_from_server_fetch: true },
    rate_limit: { state: 'not_exercised', reason: 'Read-only probe never hammers a production endpoint.' },
    service_unavailable: { state: socialResponse.status === 503 ? 'observed' : 'not_observed' }
  });
}

export function buildProbeReceipt(snapshot, { live = null } = {}) {
  const claims = [
    ['branch_rules', snapshot.settings.branch_rules.state],
    ['environment_rules', snapshot.settings.environment_rules.state],
    ['application_grants', snapshot.settings.application_grants.state],
    ['endpoint', snapshot.endpoint.state],
    ['database', snapshot.database.state]
  ].map(([id, state]) => ({ id, state }));
  if (live && live.commit_matches !== true) throw new Error('Live endpoint serves a commit other than the authorized commit.');
  return Object.freeze({
    schema: RECEIPT_SCHEMA,
    observed_at: snapshot.observed_at,
    authorized_commit: snapshot.authorized_commit,
    status: claims.every(item => item.state === 'verified') && (!live || live.commit_matches) ? 'verified' : 'partial',
    claims,
    live,
    database: snapshot.database,
    procedures: { release: snapshot.release_procedure, incident: snapshot.incident_procedure },
    authorities: snapshot.authorities,
    safety: { read_only_default: true, production_database_forbidden: true, secret_values_forbidden: true, destructive_execution_performed: false }
  });
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) throw new Error(`Unexpected argument: ${item}`);
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else { result[key] = next; index += 1; }
  }
  return result;
}

function required(args, name) {
  const value = args[name];
  if (!value || value === true) throw new Error(`--${name} is required.`);
  return String(value);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const expectedSha = required(args, 'expected-sha');
  const snapshot = JSON.parse(await readFile(required(args, 'snapshot'), 'utf8'));
  const validated = validateSnapshot(snapshot, {
    expectedSha,
    now: args['now'] ? Date.parse(String(args.now)) : Date.now(),
    maxAgeHours: args['max-age-hours'] === undefined ? 168 : Number(args['max-age-hours']),
    allowDatabaseEvidence: args['accept-disposable-database'] === true
  });
  let live = null;
  if (args.endpoint) {
    if (args['allow-network'] !== true) throw new Error('--endpoint requires --allow-network.');
    live = await probePublicEndpoint(String(args.endpoint), { expectedSha });
  }
  const receipt = buildProbeReceipt(validated, { live });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.status !== 'verified') process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
