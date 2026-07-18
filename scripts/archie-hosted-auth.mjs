import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceAuthorityError, WorkspaceError, sha256, stableJSONStringify } from './archie-workspace-core.mjs';

export const ARCHIE_HOSTED_AUTH_SCHEMA = 'archie-hosted-auth/v1';
export const ARCHIE_HOSTED_SHARE_SCHEMA = 'archie-hosted-share-registry/v1';
const PRINCIPAL_PATTERN = /^[a-z][a-z0-9_-]{2,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COOKIE_NAMES = Object.freeze({ operator: 'archie_operator', share: 'archie_share' });

function text(value, label, { min = 1, max = 512 } = {}) {
  const normalized = String(value ?? '').trim();
  if (normalized.length < min || normalized.length > max) throw new WorkspaceError(`${label} must contain ${min}-${max} characters.`);
  return normalized;
}

function assertDigest(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw new WorkspaceError(`${label} must be a SHA-256 hex digest.`);
  return normalized;
}

function assertPrincipal(value) {
  const normalized = String(value || '').trim();
  if (!PRINCIPAL_PATTERN.test(normalized)) throw new WorkspaceError('Hosted principal_id is invalid.');
  return normalized;
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(request) {
  const source = String(request?.headers?.cookie || '');
  const entries = source.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    if (index < 1) return null;
    try {
      return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
    } catch {
      return null;
    }
  }).filter(Boolean);
  return Object.fromEntries(entries);
}

function bearerToken(request) {
  const value = String(request?.headers?.authorization || '');
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function cookie(name, value, { secure = true, maxAge = 43_200 } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function expiredCookie(name, { secure = true } = {}) {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

async function readJson(filename, fallback) {
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(fallback);
    throw error;
  }
}

async function writePrivateJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, filename);
  await fs.chmod(filename, 0o600).catch(() => {});
}

function normalizeAuthConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== ARCHIE_HOSTED_AUTH_SCHEMA) {
    throw new WorkspaceError(`Hosted auth config must use ${ARCHIE_HOSTED_AUTH_SCHEMA}.`);
  }
  if (!Array.isArray(value.principals) || !value.principals.length) throw new WorkspaceError('Hosted auth config requires at least one principal.');
  const principals = value.principals.map(item => {
    const principalId = assertPrincipal(item?.principal_id);
    const role = text(item?.role, 'hosted role', { max: 32 });
    if (!['founder', 'developer'].includes(role)) throw new WorkspaceError('Hosted role must be founder or developer.');
    return Object.freeze({
      principal_id: principalId,
      role,
      token_sha256: assertDigest(item?.token_sha256, `token_sha256 for ${principalId}`),
      label: text(item?.label || principalId, 'hosted principal label', { max: 120 })
    });
  });
  if (new Set(principals.map(item => item.principal_id)).size !== principals.length) throw new WorkspaceError('Hosted principal IDs must be unique.');
  if (new Set(principals.map(item => item.token_sha256)).size !== principals.length) throw new WorkspaceError('Hosted token digests must be unique.');
  if (!principals.some(item => item.role === 'founder' && item.principal_id === 'owner_local')) {
    throw new WorkspaceError('Hosted auth config requires founder principal owner_local for local/hosted workspace parity.');
  }
  return Object.freeze({ schema: ARCHIE_HOSTED_AUTH_SCHEMA, principals: Object.freeze(principals) });
}

export async function loadHostedAuthConfig(filename) {
  const target = path.resolve(filename);
  const stats = await fs.stat(target);
  if (process.platform !== 'win32' && (stats.mode & 0o077)) throw new WorkspaceError('Hosted auth config must not be readable by group or other users.');
  return normalizeAuthConfig(JSON.parse(await fs.readFile(target, 'utf8')));
}

export class HostedShareRegistry {
  constructor(root) {
    this.filename = path.join(path.resolve(root), 'hosted', 'shares.json');
  }

  async read() {
    const value = await readJson(this.filename, { schema: ARCHIE_HOSTED_SHARE_SCHEMA, shares: [] });
    if (value.schema !== ARCHIE_HOSTED_SHARE_SCHEMA || !Array.isArray(value.shares)) throw new WorkspaceError('Hosted share registry is invalid.');
    return value;
  }

  async add({ workspaceId, principalId, token, expiresAt, createdBy, createdAt = new Date().toISOString() }) {
    const registry = await this.read();
    const tokenDigest = sha256(text(token, 'share token', { min: 32, max: 256 }));
    const record = {
      share_id: `share_${tokenDigest.slice(0, 24)}`,
      workspace_id: text(workspaceId, 'share workspace_id', { max: 128 }),
      principal_id: assertPrincipal(principalId),
      token_sha256: tokenDigest,
      created_by: assertPrincipal(createdBy),
      created_at: new Date(createdAt).toISOString(),
      expires_at: new Date(expiresAt).toISOString(),
      revoked_at: null
    };
    if (registry.shares.some(item => item.share_id === record.share_id || item.token_sha256 === tokenDigest)) throw new WorkspaceError('Hosted share token collision.');
    const next = { schema: ARCHIE_HOSTED_SHARE_SCHEMA, shares: [...registry.shares, record] };
    await writePrivateJson(this.filename, next);
    return Object.freeze({ ...record, token_sha256: undefined });
  }

  async authenticateToken(token, now = Date.now()) {
    const digest = sha256(String(token || ''));
    const registry = await this.read();
    const record = registry.shares.find(item => constantTimeEqual(item.token_sha256, digest));
    if (!record || record.revoked_at || Date.parse(record.expires_at) <= now) return null;
    return Object.freeze({
      principal_id: record.principal_id,
      role: 'share',
      workspace_id: record.workspace_id,
      share_id: record.share_id,
      expires_at: record.expires_at
    });
  }

  async list(workspaceId, now = Date.now()) {
    const registry = await this.read();
    return registry.shares.filter(item => item.workspace_id === workspaceId).map(item => Object.freeze({
      share_id: item.share_id,
      workspace_id: item.workspace_id,
      principal_id: item.principal_id,
      created_by: item.created_by,
      created_at: item.created_at,
      expires_at: item.expires_at,
      status: item.revoked_at ? 'revoked' : Date.parse(item.expires_at) <= now ? 'expired' : 'active',
      revoked_at: item.revoked_at
    }));
  }

  async revoke(shareId, revokedAt = new Date().toISOString()) {
    const registry = await this.read();
    const index = registry.shares.findIndex(item => item.share_id === shareId);
    if (index < 0) throw new WorkspaceError('Hosted share was not found.', { code: 'not_found', status: 404 });
    const shares = registry.shares.map((item, itemIndex) => itemIndex === index ? { ...item, revoked_at: item.revoked_at || new Date(revokedAt).toISOString() } : item);
    await writePrivateJson(this.filename, { schema: ARCHIE_HOSTED_SHARE_SCHEMA, shares });
    return Object.freeze({ share_id: shareId, status: 'revoked', revoked_at: shares[index].revoked_at });
  }

  async digest() {
    const registry = await this.read();
    return sha256(stableJSONStringify({ schema: registry.schema, shares: registry.shares.map(item => ({
      share_id: item.share_id,
      workspace_id: item.workspace_id,
      principal_id: item.principal_id,
      created_at: item.created_at,
      expires_at: item.expires_at,
      revoked_at: item.revoked_at
    })) }));
  }
}

export function createHostedAuth({ config, shareRegistry, secureCookies = true } = {}) {
  const normalized = normalizeAuthConfig(config);
  if (!shareRegistry) throw new WorkspaceError('Hosted authentication requires a share registry.');

  function authenticateOperatorToken(token) {
    const digest = sha256(String(token || ''));
    const principal = normalized.principals.find(item => constantTimeEqual(item.token_sha256, digest));
    return principal ? Object.freeze({ principal_id: principal.principal_id, role: principal.role, label: principal.label }) : null;
  }

  async function authenticate(request) {
    const cookies = parseCookies(request);
    const operatorToken = bearerToken(request) || cookies[COOKIE_NAMES.operator];
    const operator = operatorToken ? authenticateOperatorToken(operatorToken) : null;
    if (operator) return operator;
    const shareToken = cookies[COOKIE_NAMES.share];
    return shareToken ? shareRegistry.authenticateToken(shareToken) : null;
  }

  return Object.freeze({
    schema: ARCHIE_HOSTED_AUTH_SCHEMA,
    authenticate,
    authenticateOperatorToken,
    requireOperator: async (request, roles = ['founder', 'developer']) => {
      const identity = await authenticate(request);
      if (!identity || !roles.includes(identity.role)) throw new WorkspaceAuthorityError('Private founder/developer authentication is required.');
      return identity;
    },
    operatorCookie: token => cookie(COOKIE_NAMES.operator, token, { secure: secureCookies }),
    shareCookie: token => cookie(COOKIE_NAMES.share, token, { secure: secureCookies, maxAge: 30 * 24 * 60 * 60 }),
    clearCookies: () => [expiredCookie(COOKIE_NAMES.operator, { secure: secureCookies }), expiredCookie(COOKIE_NAMES.share, { secure: secureCookies })],
    descriptor: Object.freeze({
      schema: ARCHIE_HOSTED_AUTH_SCHEMA,
      principal_count: normalized.principals.length,
      roles: [...new Set(normalized.principals.map(item => item.role))].sort(),
      raw_tokens_in_config: false,
      cookie_transport_requires_tls: secureCookies
    })
  });
}

export function generateHostedToken(bytes = 32) {
  if (!Number.isInteger(bytes) || bytes < 24 || bytes > 128) throw new WorkspaceError('Hosted token size is invalid.');
  return crypto.randomBytes(bytes).toString('base64url');
}
