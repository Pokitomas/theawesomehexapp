import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceAuthorityError, WorkspaceError, sha256, stableJSONStringify } from './archie-workspace-core.mjs';

export const ARCHIE_HOSTED_SESSION_SCHEMA = 'archie-hosted-session/v1';
export const ARCHIE_HOSTED_SHARE_SCHEMA = 'archie-hosted-share-registry/v1';
export const ARCHIE_SECRET_STORE_SCHEMA = 'archie-encrypted-secret-store/v1';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const NAME_PATTERN = /^[a-z][a-z0-9_.-]{2,127}$/;
const SESSION_COOKIE = 'archie_hosted_session';

function hash(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!HASH_PATTERN.test(normalized)) throw new WorkspaceError(`${label} must be a lowercase SHA-256 hex digest.`);
  return normalized;
}

function keyBytes(value, label) {
  const raw = String(value || '').trim();
  let bytes = Buffer.alloc(0);
  try { bytes = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64'); }
  catch { bytes = Buffer.alloc(0); }
  if (bytes.length !== 32) throw new WorkspaceError(`${label} must encode exactly 32 bytes.`);
  return bytes;
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookies(request) {
  const result = {};
  for (const part of String(request.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    try { result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); }
    catch {}
  }
  return result;
}

function bearer(request) {
  const value = String(request.headers.authorization || '');
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function atomicWrite(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, filename);
  await fs.chmod(filename, 0o600).catch(() => {});
}

async function readJson(filename, fallback) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(fallback);
    throw error;
  }
}

export function tokenSha256(token) {
  return sha256(String(token || ''));
}

export function deriveHostedKey(label, ...parts) {
  const hashValue = crypto.createHash('sha256');
  hashValue.update(`archie-hosted-derived-key/v1\0${String(label)}\0`);
  for (const part of parts) hashValue.update(String(part || '')).update('\0');
  return hashValue.digest('base64');
}

export function createHostedSecurity({
  founderTokenSha256,
  developerTokenSha256,
  sessionKey,
  secureCookies = true,
  clock = () => Date.now(),
  sessionTtlMs = 12 * 60 * 60 * 1000
}) {
  const founderHash = hash(founderTokenSha256, 'ARCHIED_FOUNDER_TOKEN_SHA256');
  const developerHash = hash(developerTokenSha256, 'ARCHIED_DEVELOPER_TOKEN_SHA256');
  if (secureEqual(founderHash, developerHash)) throw new WorkspaceError('Founder and developer token hashes must differ.');
  const signingKey = keyBytes(sessionKey, 'ARCHIED_SESSION_KEY');

  function identityForToken(token) {
    const candidate = tokenSha256(token);
    if (secureEqual(candidate, founderHash)) return Object.freeze({ principal_id: 'owner_local', role: 'founder' });
    if (secureEqual(candidate, developerHash)) return Object.freeze({ principal_id: 'developer_local', role: 'developer' });
    return null;
  }

  function issueSession(identity) {
    const now = Number(clock());
    const payload = {
      schema: ARCHIE_HOSTED_SESSION_SCHEMA,
      principal_id: identity.principal_id,
      role: identity.role,
      issued_at_ms: now,
      expires_at_ms: now + sessionTtlMs,
      nonce: crypto.randomBytes(12).toString('hex')
    };
    const encoded = Buffer.from(stableJSONStringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', signingKey).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  function verifySession(token) {
    const [encoded, signature, extra] = String(token || '').split('.');
    if (!encoded || !signature || extra) return null;
    const expected = crypto.createHmac('sha256', signingKey).update(encoded).digest('base64url');
    if (!secureEqual(signature, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      if (payload.schema !== ARCHIE_HOSTED_SESSION_SCHEMA || !['founder', 'developer'].includes(payload.role)) return null;
      if (!Number.isFinite(payload.expires_at_ms) || payload.expires_at_ms <= Number(clock())) return null;
      const expectedPrincipal = payload.role === 'founder' ? 'owner_local' : 'developer_local';
      if (payload.principal_id !== expectedPrincipal) return null;
      return Object.freeze({ principal_id: payload.principal_id, role: payload.role });
    } catch {
      return null;
    }
  }

  function authenticate(request) {
    const bearerToken = bearer(request);
    if (bearerToken) return identityForToken(bearerToken);
    return verifySession(cookies(request)[SESSION_COOKIE]);
  }

  function cookie(token, { clear = false } = {}) {
    const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
    if (secureCookies) parts.push('Secure');
    parts.push(clear ? 'Max-Age=0' : `Max-Age=${Math.floor(sessionTtlMs / 1000)}`);
    return parts.join('; ');
  }

  return Object.freeze({
    identityForToken,
    issueSession,
    authenticate,
    sessionCookie: identity => cookie(issueSession(identity)),
    clearCookie: () => cookie('', { clear: true }),
    descriptor: Object.freeze({
      schema: ARCHIE_HOSTED_SESSION_SCHEMA,
      roles: ['developer', 'founder'],
      session_ttl_seconds: Math.floor(sessionTtlMs / 1000),
      raw_tokens_persisted: false,
      secure_cookie: secureCookies
    })
  });
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

  async issue({ workspaceId, principalId, grantId, createdBy, expiresInMs = 24 * 60 * 60 * 1000 }) {
    const duration = Number(expiresInMs);
    if (!Number.isInteger(duration) || duration < 60_000 || duration > 30 * 24 * 60 * 60 * 1000) {
      throw new WorkspaceError('Share expiry must be from one minute through 30 days.');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const digest = tokenSha256(token);
    const createdAt = new Date().toISOString();
    const record = {
      share_id: `share_${digest.slice(0, 24)}`,
      workspace_id: String(workspaceId),
      principal_id: String(principalId),
      grant_id: String(grantId),
      token_sha256: digest,
      created_by: String(createdBy),
      created_at: createdAt,
      expires_at: new Date(Date.parse(createdAt) + duration).toISOString(),
      revoked_at: null
    };
    const registry = await this.read();
    await atomicWrite(this.filename, { schema: ARCHIE_HOSTED_SHARE_SCHEMA, shares: [...registry.shares, record] });
    const { token_sha256: _tokenDigest, ...publicRecord } = record;
    return Object.freeze({ token, record: publicRecord });
  }

  async authenticate(token, now = Date.now()) {
    const digest = tokenSha256(token);
    const registry = await this.read();
    const record = registry.shares.find(item => secureEqual(item.token_sha256, digest));
    if (!record || record.revoked_at || Date.parse(record.expires_at) <= now) return null;
    const { token_sha256: _tokenDigest, ...publicRecord } = record;
    return Object.freeze(publicRecord);
  }

  async list(workspaceId, now = Date.now()) {
    const registry = await this.read();
    return registry.shares.filter(item => item.workspace_id === workspaceId).map(item => ({
      share_id: item.share_id,
      workspace_id: item.workspace_id,
      principal_id: item.principal_id,
      grant_id: item.grant_id,
      created_by: item.created_by,
      created_at: item.created_at,
      expires_at: item.expires_at,
      revoked_at: item.revoked_at,
      status: item.revoked_at ? 'revoked' : Date.parse(item.expires_at) <= now ? 'expired' : 'active'
    }));
  }

  async revoke(shareId, revokedAt = new Date().toISOString()) {
    const registry = await this.read();
    const index = registry.shares.findIndex(item => item.share_id === shareId);
    if (index < 0) throw new WorkspaceError('Hosted share was not found.', { code: 'not_found', status: 404 });
    const shares = registry.shares.map((item, itemIndex) => itemIndex === index ? { ...item, revoked_at: item.revoked_at || new Date(revokedAt).toISOString() } : item);
    await atomicWrite(this.filename, { schema: ARCHIE_HOSTED_SHARE_SCHEMA, shares });
    const { token_sha256: _tokenDigest, ...publicRecord } = shares[index];
    return Object.freeze(publicRecord);
  }

  async status() {
    const registry = await this.read();
    return Object.freeze({
      share_count: registry.shares.length,
      registry_digest: sha256(stableJSONStringify(registry.shares.map(item => ({
        share_id: item.share_id,
        workspace_id: item.workspace_id,
        principal_id: item.principal_id,
        grant_id: item.grant_id,
        expires_at: item.expires_at,
        revoked_at: item.revoked_at
      }))))
    });
  }
}

export class EncryptedSecretStore {
  constructor(filename, key) {
    this.filename = path.resolve(filename);
    this.key = keyBytes(key, 'ARCHIED_SECRET_KEY');
    this.keyId = sha256(this.key).slice(0, 16);
  }

  async envelope() {
    const value = await readJson(this.filename, { schema: ARCHIE_SECRET_STORE_SCHEMA, key_id: this.keyId, entries: {} });
    if (value.schema !== ARCHIE_SECRET_STORE_SCHEMA || value.key_id !== this.keyId || !value.entries || typeof value.entries !== 'object') {
      throw new WorkspaceError('Encrypted secret store envelope is invalid or belongs to another key.');
    }
    return value;
  }

  async set(name, value) {
    const secretName = String(name || '').trim();
    if (!NAME_PATTERN.test(secretName)) throw new WorkspaceError(`Secret name must match ${NAME_PATTERN}.`);
    const plaintext = String(value ?? '');
    if (!plaintext || plaintext.length > 256_000) throw new WorkspaceError('Secret value must contain 1-256000 characters.');
    const envelope = await this.envelope();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${ARCHIE_SECRET_STORE_SCHEMA}:${secretName}`));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    envelope.entries[secretName] = {
      cipher: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      updated_at: new Date().toISOString()
    };
    await atomicWrite(this.filename, envelope);
    return Object.freeze({ name: secretName, key_id: this.keyId, updated_at: envelope.entries[secretName].updated_at });
  }

  async status({ includeNames = false } = {}) {
    const envelope = await this.envelope();
    const names = Object.keys(envelope.entries).sort();
    return Object.freeze({
      schema: ARCHIE_SECRET_STORE_SCHEMA,
      key_id: this.keyId,
      configured_count: names.length,
      secrets: includeNames ? names.map(name => ({ name, updated_at: envelope.entries[name].updated_at })) : undefined
    });
  }

  async encryptedEnvelope() {
    return structuredClone(await this.envelope());
  }
}

export function requireRole(identity, roles) {
  if (!identity || !roles.includes(identity.role)) throw new WorkspaceAuthorityError('Private hosted Archie authority is required.');
  return identity;
}
