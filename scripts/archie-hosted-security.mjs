import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceAuthorityError, WorkspaceError, sha256, stableJSONStringify } from './archie-workspace-core.mjs';

export const ARCHIE_HOSTED_AUTH_SCHEMA = 'archie-hosted-auth/v1';
export const ARCHIE_READ_SHARE_SCHEMA = 'archie-read-share/v1';
export const ARCHIE_SECRET_STORE_SCHEMA = 'archie-encrypted-secret-store/v1';

const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;
const SECRET_NAME_PATTERN = /^[a-z][a-z0-9_.-]{2,127}$/;

function normalizedHash(value, label) {
  const result = String(value || '').trim().toLowerCase();
  if (!TOKEN_HASH_PATTERN.test(result)) throw new WorkspaceError(`${label} must be a lowercase SHA-256 hex digest.`);
  return result;
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authorizationHeader(request) {
  const value = request.headers.authorization;
  return Array.isArray(value) ? value[0] : value || '';
}

function credentials(request) {
  const header = authorizationHeader(request);
  if (/^Bearer\s+/i.test(header)) return { method: 'bearer', username: null, token: header.replace(/^Bearer\s+/i, '').trim() };
  if (/^Basic\s+/i.test(header)) {
    try {
      const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator < 0) return null;
      return { method: 'basic', username: decoded.slice(0, separator).trim().toLowerCase(), token: decoded.slice(separator + 1) };
    } catch {
      return null;
    }
  }
  return null;
}

export function tokenSha256(token) {
  return sha256(String(token || ''));
}

export function createHostedAuthenticator({ founderTokenSha256, developerTokenSha256 }) {
  const founderHash = normalizedHash(founderTokenSha256, 'ARCHIED_FOUNDER_TOKEN_SHA256');
  const developerHash = normalizedHash(developerTokenSha256, 'ARCHIED_DEVELOPER_TOKEN_SHA256');
  if (secureEqual(founderHash, developerHash)) throw new WorkspaceError('Founder and developer tokens must be distinct.');

  return async request => {
    const supplied = credentials(request);
    if (!supplied?.token) return null;
    const candidate = tokenSha256(supplied.token);
    const basicRole = supplied.method === 'basic' ? supplied.username : null;
    if ((basicRole === null || basicRole === 'founder') && secureEqual(candidate, founderHash)) {
      return Object.freeze({ schema: ARCHIE_HOSTED_AUTH_SCHEMA, principal_id: 'owner_local', role: 'founder', method: supplied.method });
    }
    if ((basicRole === null || basicRole === 'developer') && secureEqual(candidate, developerHash)) {
      return Object.freeze({ schema: ARCHIE_HOSTED_AUTH_SCHEMA, principal_id: 'developer_local', role: 'developer', method: supplied.method });
    }
    return null;
  };
}

function keyBytes(value, label) {
  const raw = String(value || '').trim();
  let bytes;
  if (/^[a-f0-9]{64}$/i.test(raw)) bytes = Buffer.from(raw, 'hex');
  else {
    try { bytes = Buffer.from(raw, 'base64'); } catch { bytes = Buffer.alloc(0); }
  }
  if (bytes.length !== 32) throw new WorkspaceError(`${label} must encode exactly 32 bytes as base64 or 64 hex characters.`);
  return bytes;
}

export function createReadShareAuthority({ secret, publicBaseUrl, clock = () => new Date() }) {
  const key = keyBytes(secret, 'ARCHIED_SHARE_KEY');
  const baseUrl = new URL(publicBaseUrl);

  function sign(encoded) {
    return crypto.createHmac('sha256', key).update(encoded).digest('base64url');
  }

  function issue({ workspaceId, issuedBy, expiresInMs = 24 * 60 * 60 * 1000 }) {
    const duration = Number(expiresInMs);
    if (!Number.isInteger(duration) || duration < 60_000 || duration > 30 * 24 * 60 * 60 * 1000) {
      throw new WorkspaceError('Read-share expiry must be from one minute through 30 days.');
    }
    const issuedAt = new Date(clock()).toISOString();
    const expiresAt = new Date(new Date(issuedAt).getTime() + duration).toISOString();
    const payload = {
      schema: ARCHIE_READ_SHARE_SCHEMA,
      share_id: `share_${crypto.randomBytes(12).toString('hex')}`,
      workspace_id: String(workspaceId),
      principal_id: String(issuedBy),
      capabilities: ['read'],
      issued_at: issuedAt,
      expires_at: expiresAt
    };
    const encoded = Buffer.from(stableJSONStringify(payload)).toString('base64url');
    const token = `${encoded}.${sign(encoded)}`;
    return Object.freeze({ ...payload, token, share_url: new URL(`v1/hosted/shares/${token}`, baseUrl).href });
  }

  function verify(token) {
    const [encoded, signature, ...rest] = String(token || '').split('.');
    if (!encoded || !signature || rest.length || !secureEqual(signature, sign(encoded))) {
      throw new WorkspaceAuthorityError('Read-share token is invalid.');
    }
    let payload;
    try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
    catch { throw new WorkspaceAuthorityError('Read-share token is invalid.'); }
    if (payload.schema !== ARCHIE_READ_SHARE_SCHEMA || payload.capabilities?.length !== 1 || payload.capabilities[0] !== 'read') {
      throw new WorkspaceAuthorityError('Read-share token has an invalid authority envelope.');
    }
    if (new Date(payload.expires_at).getTime() <= new Date(clock()).getTime()) throw new WorkspaceAuthorityError('Read-share token has expired.');
    return Object.freeze(payload);
  }

  return Object.freeze({ issue, verify });
}

export class EncryptedSecretStore {
  constructor(filename, key) {
    this.filename = path.resolve(filename);
    this.key = keyBytes(key, 'ARCHIED_SECRET_KEY');
    this.keyId = sha256(this.key).slice(0, 16);
  }

  async readEnvelope() {
    try {
      const value = JSON.parse(await fs.readFile(this.filename, 'utf8'));
      if (value.schema !== ARCHIE_SECRET_STORE_SCHEMA || value.key_id !== this.keyId || !value.entries || typeof value.entries !== 'object') {
        throw new WorkspaceError('Encrypted secret store envelope is invalid or belongs to another key.');
      }
      return value;
    } catch (error) {
      if (error?.code === 'ENOENT') return { schema: ARCHIE_SECRET_STORE_SCHEMA, key_id: this.keyId, entries: {} };
      throw error;
    }
  }

  async writeEnvelope(value) {
    await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, this.filename);
  }

  async set(name, value, { updatedAt = new Date().toISOString() } = {}) {
    const secretName = String(name || '').trim();
    if (!SECRET_NAME_PATTERN.test(secretName)) throw new WorkspaceError(`Secret name must match ${SECRET_NAME_PATTERN}.`);
    const plaintext = String(value ?? '');
    if (!plaintext || plaintext.length > 256_000) throw new WorkspaceError('Secret value must contain 1-256000 characters.');
    const envelope = await this.readEnvelope();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${ARCHIE_SECRET_STORE_SCHEMA}:${secretName}`));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    envelope.entries[secretName] = {
      cipher: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      updated_at: new Date(updatedAt).toISOString()
    };
    await this.writeEnvelope(envelope);
    return Object.freeze({ name: secretName, updated_at: envelope.entries[secretName].updated_at, key_id: this.keyId });
  }

  async get(name) {
    const secretName = String(name || '').trim();
    const envelope = await this.readEnvelope();
    const entry = envelope.entries[secretName];
    if (!entry) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(entry.iv, 'base64'));
    decipher.setAAD(Buffer.from(`${ARCHIE_SECRET_STORE_SCHEMA}:${secretName}`));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }

  async status() {
    const envelope = await this.readEnvelope();
    const names = Object.entries(envelope.entries)
      .map(([name, entry]) => ({ name, updated_at: entry.updated_at }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return Object.freeze({ schema: ARCHIE_SECRET_STORE_SCHEMA, key_id: this.keyId, configured_count: names.length, secrets: names });
  }

  async encryptedEnvelope() {
    return structuredClone(await this.readEnvelope());
  }
}
