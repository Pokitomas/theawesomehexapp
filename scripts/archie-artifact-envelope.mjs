import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ARCHIE_MODEL_MANIFEST_SCHEMA,
  ARCHIE_RUNTIME_ABI,
  canonical,
  manifestDigest,
  publicKeyFingerprint,
  pullModel,
  resolveArchieHome,
  sha256,
  signManifest,
  stableJSONStringify,
  validateManifestShape
} from './archie-runtime-core.mjs';

export const ARCHIE_ENCRYPTED_MANIFEST_SCHEMA = 'archie-encrypted-model-manifest/v1';
export const ARCHIE_ARTIFACT_ENVELOPE_SCHEMA = 'archie-artifact-envelope/v1';
export const ARCHIE_WRAPPED_DATA_KEY_SCHEMA = 'archie-wrapped-data-key/v1';
export const ARCHIE_ENCRYPTED_PULL_RECEIPT_SCHEMA = 'archie-encrypted-model-pull-receipt/v1';

const HEX_256 = /^[a-f0-9]{64}$/;
const WRAP_INFO = Buffer.from('archie-artifact-key-wrap/v1', 'utf8');
const MAX_CHUNK_BYTES = 256 * 1024 * 1024;
const clean = (value, limit = 20_000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function asPublicKey(input, expectedType) {
  const key = input?.type === 'public' && input?.asymmetricKeyType ? input : crypto.createPublicKey(input);
  if (expectedType && key.asymmetricKeyType !== expectedType) throw new Error(`Public key must be ${expectedType}.`);
  return key;
}

function asPrivateKey(input, expectedType) {
  const key = input?.type === 'private' && input?.asymmetricKeyType ? input : crypto.createPrivateKey(input);
  if (expectedType && key.asymmetricKeyType !== expectedType) throw new Error(`Private key must be ${expectedType}.`);
  return key;
}

function publicPem(key) {
  return asPublicKey(key).export({ type: 'spki', format: 'pem' });
}

function privatePem(key) {
  return asPrivateKey(key).export({ type: 'pkcs8', format: 'pem' });
}

function x25519Fingerprint(input) {
  const key = asPublicKey(input, 'x25519');
  return sha256(key.export({ type: 'spki', format: 'der' }));
}

function assertDigest(value, field) {
  const result = clean(value, 64).toLowerCase();
  if (!HEX_256.test(result)) throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  return result;
}

function assertInteger(value, field, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${field} must be a safe integer >= ${minimum}.`);
  return value;
}

function decodeBase64(value, field, expectedBytes) {
  const text = clean(value, 100_000);
  if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error(`${field} must be base64.`);
  const bytes = Buffer.from(text, 'base64');
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) throw new Error(`${field} must contain ${expectedBytes} bytes.`);
  return bytes;
}

async function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeJSONAtomic(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(canonical(value), null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filename);
}

async function readJSONSource(source, fetchImpl = globalThis.fetch) {
  const location = clean(source, 10_000);
  if (!location) throw new Error('Manifest source is required.');
  if (/^https?:\/\//i.test(location)) {
    if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation is available.');
    const response = await fetchImpl(location, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Manifest download failed with HTTP ${response.status}.`);
    return JSON.parse(await response.text());
  }
  const filename = /^file:/i.test(location) ? fileURLToPath(location) : path.resolve(location);
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

function chunkAad(manifestLike, chunk) {
  return canonical({
    schema: ARCHIE_ARTIFACT_ENVELOPE_SCHEMA,
    model_ref: `${manifestLike.model.id}@${manifestLike.model.version}`,
    runtime_abi: manifestLike.model.runtime_abi,
    artifact_digest: manifestLike.artifact.sha256,
    chunk_index: chunk.index,
    plaintext_bytes: chunk.plaintext_bytes,
    plaintext_sha256: chunk.plaintext_sha256
  });
}

function wrapAad(manifestLike, recipientFingerprint) {
  return canonical({
    schema: ARCHIE_WRAPPED_DATA_KEY_SCHEMA,
    recipient_fingerprint: recipientFingerprint,
    model_ref: `${manifestLike.model.id}@${manifestLike.model.version}`,
    runtime_abi: manifestLike.model.runtime_abi,
    artifact_digest: manifestLike.artifact.sha256
  });
}

function deriveWrappingKey(privateKeyInput, publicKeyInput, salt) {
  const shared = crypto.diffieHellman({
    privateKey: asPrivateKey(privateKeyInput, 'x25519'),
    publicKey: asPublicKey(publicKeyInput, 'x25519')
  });
  try {
    return Buffer.from(crypto.hkdfSync('sha256', shared, salt, WRAP_INFO, 32));
  } finally {
    shared.fill(0);
  }
}

function encryptAead(plaintext, key, nonce, aad) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(stableJSONStringify(aad)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ciphertext, cipher.getAuthTag()]);
}

function decryptAead(payload, key, nonce, aad) {
  if (payload.length < 16) throw new Error('AEAD payload is shorter than its authentication tag.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(stableJSONStringify(aad)));
  decipher.setAuthTag(payload.subarray(payload.length - 16));
  return Buffer.concat([decipher.update(payload.subarray(0, -16)), decipher.final()]);
}

function normalizeTrustedKeys(values = []) {
  const trusted = new Set();
  for (const value of values) {
    const text = clean(value, 50_000);
    if (!text) continue;
    trusted.add(HEX_256.test(text) ? text : publicKeyFingerprint(text));
  }
  return trusted;
}

function validateSharedMetadata(manifest) {
  validateManifestShape({
    schema: ARCHIE_MODEL_MANIFEST_SCHEMA,
    model: manifest.model,
    sizes: { download_bytes: manifest.sizes.installed_bytes, installed_bytes: manifest.sizes.installed_bytes },
    artifact: manifest.artifact,
    chunks: [{ index: 0, url: 'file:///archie/install-projection', bytes: manifest.sizes.installed_bytes, sha256: manifest.artifact.sha256 }],
    hardware: manifest.hardware,
    provenance: manifest.provenance,
    state: manifest.state,
    benchmarks: manifest.benchmarks,
    runtime: manifest.runtime,
    manifest_digest: '0'.repeat(64),
    signature: manifest.signature
  });
}

export function validateEncryptedManifestShape(manifest) {
  if (!manifest || manifest.schema !== ARCHIE_ENCRYPTED_MANIFEST_SCHEMA) throw new Error('Unsupported encrypted Archie manifest schema.');
  if (manifest.model?.runtime_abi !== ARCHIE_RUNTIME_ABI) throw new Error(`runtime ABI mismatch: expected ${ARCHIE_RUNTIME_ABI}.`);
  validateSharedMetadata(manifest);
  assertInteger(manifest.sizes?.download_bytes, 'sizes.download_bytes', 17);
  assertInteger(manifest.sizes?.installed_bytes, 'sizes.installed_bytes', 1);
  assertDigest(manifest.artifact?.sha256, 'artifact.sha256');
  if (!Array.isArray(manifest.chunks) || !manifest.chunks.length) throw new Error('Encrypted manifest chunks must be non-empty.');

  let encryptedBytes = 0;
  let plaintextBytes = 0;
  const nonces = new Set();
  manifest.chunks.forEach((chunk, index) => {
    if (chunk.index !== index) throw new Error(`Encrypted chunk index ${index} is not contiguous.`);
    if (!clean(chunk.url, 10_000)) throw new Error(`chunks[${index}].url is required.`);
    const bytes = assertInteger(chunk.bytes, `chunks[${index}].bytes`, 17);
    const plain = assertInteger(chunk.plaintext_bytes, `chunks[${index}].plaintext_bytes`, 1);
    if (bytes !== plain + 16) throw new Error(`chunks[${index}] must contain plaintext bytes plus one GCM tag.`);
    assertDigest(chunk.sha256, `chunks[${index}].sha256`);
    assertDigest(chunk.plaintext_sha256, `chunks[${index}].plaintext_sha256`);
    assertDigest(chunk.aad_digest, `chunks[${index}].aad_digest`);
    const nonce = decodeBase64(chunk.nonce_base64, `chunks[${index}].nonce_base64`, 12).toString('hex');
    if (nonces.has(nonce)) throw new Error('Encrypted chunk nonces must be unique.');
    nonces.add(nonce);
    encryptedBytes += bytes;
    plaintextBytes += plain;
  });
  if (encryptedBytes !== manifest.sizes.download_bytes) throw new Error('Encrypted chunk total does not match sizes.download_bytes.');
  if (plaintextBytes !== manifest.sizes.installed_bytes) throw new Error('Plaintext chunk total does not match sizes.installed_bytes.');

  const envelope = manifest.encryption;
  if (envelope?.schema !== ARCHIE_ARTIFACT_ENVELOPE_SCHEMA) throw new Error('Encrypted manifest requires the Archie artifact envelope.');
  if (envelope.content_cipher !== 'aes-256-gcm') throw new Error('Unsupported artifact content cipher.');
  if (envelope.key_wrap !== 'x25519-hkdf-sha256-aes-256-gcm') throw new Error('Unsupported artifact key-wrap protocol.');
  if (!Array.isArray(envelope.recipients) || !envelope.recipients.length) throw new Error('Artifact envelope requires at least one recipient.');
  const recipients = new Set();
  envelope.recipients.forEach((recipient, index) => {
    if (recipient.schema !== ARCHIE_WRAPPED_DATA_KEY_SCHEMA) throw new Error(`recipients[${index}] has an unsupported schema.`);
    const fingerprint = assertDigest(recipient.recipient_fingerprint, `recipients[${index}].recipient_fingerprint`);
    if (recipients.has(fingerprint)) throw new Error(`Duplicate wrapped-key recipient ${fingerprint}.`);
    recipients.add(fingerprint);
    asPublicKey(recipient.ephemeral_public_key_pem, 'x25519');
    decodeBase64(recipient.salt_base64, `recipients[${index}].salt_base64`, 32);
    decodeBase64(recipient.nonce_base64, `recipients[${index}].nonce_base64`, 12);
    decodeBase64(recipient.wrapped_key_base64, `recipients[${index}].wrapped_key_base64`, 48);
    assertDigest(recipient.aad_digest, `recipients[${index}].aad_digest`);
  });
  assertDigest(manifest.manifest_digest, 'manifest_digest');
  if (manifest.signature?.algorithm !== 'ed25519') throw new Error('Encrypted manifest requires an Ed25519 outer signature.');
  return true;
}

export function verifyEncryptedManifest(manifest, { trusted_public_keys = [], allow_untrusted = false } = {}) {
  validateEncryptedManifestShape(manifest);
  const expectedDigest = manifestDigest(manifest);
  if (expectedDigest !== manifest.manifest_digest) throw new Error('Encrypted manifest digest mismatch.');
  const publisherFingerprint = publicKeyFingerprint(manifest.signature.public_key_pem);
  if (publisherFingerprint !== manifest.signature.key_fingerprint) throw new Error('Encrypted manifest signing-key fingerprint mismatch.');
  const { signature, manifest_digest, ...body } = manifest;
  const valid = crypto.verify(
    null,
    Buffer.from(stableJSONStringify({ ...body, manifest_digest })),
    manifest.signature.public_key_pem,
    Buffer.from(manifest.signature.value_base64, 'base64')
  );
  if (!valid) throw new Error('Encrypted manifest signature verification failed.');
  const trusted = normalizeTrustedKeys(trusted_public_keys);
  if (!allow_untrusted && !trusted.has(publisherFingerprint)) throw new Error(`Encrypted manifest key is not trusted: ${publisherFingerprint}.`);
  return Object.freeze({
    manifest_digest: expectedDigest,
    key_fingerprint: publisherFingerprint,
    trust: trusted.has(publisherFingerprint) ? 'trusted' : 'self-signed-untrusted'
  });
}

export function generateArtifactKeyPair(type = 'recipient') {
  if (!['recipient', 'signing'].includes(type)) throw new Error('Key type must be recipient or signing.');
  const algorithm = type === 'recipient' ? 'x25519' : 'ed25519';
  const { publicKey, privateKey } = crypto.generateKeyPairSync(algorithm);
  const publicKeyPem = publicPem(publicKey);
  const privateKeyPem = privatePem(privateKey);
  return Object.freeze({
    type,
    algorithm,
    public_key_pem: publicKeyPem,
    private_key_pem: privateKeyPem,
    fingerprint: type === 'recipient' ? x25519Fingerprint(publicKeyPem) : publicKeyFingerprint(publicKeyPem)
  });
}

export async function writeArtifactKeyPair(outputDirectory, type = 'recipient') {
  const pair = generateArtifactKeyPair(type);
  const directory = path.resolve(outputDirectory);
  const prefix = type === 'recipient' ? 'archie-device-x25519' : 'archie-publisher-ed25519';
  await fs.mkdir(directory, { recursive: true });
  const publicPath = path.join(directory, `${prefix}-public.pem`);
  const privatePath = path.join(directory, `${prefix}-private.pem`);
  await fs.writeFile(publicPath, pair.public_key_pem, { mode: 0o644 });
  await fs.writeFile(privatePath, pair.private_key_pem, { mode: 0o600 });
  return Object.freeze({ type, algorithm: pair.algorithm, fingerprint: pair.fingerprint, public_path: publicPath, private_path: privatePath });
}

function chunkLocation(directory, filename, baseUrl) {
  return baseUrl
    ? `${clean(baseUrl, 10_000).replace(/\/$/, '')}/${encodeURIComponent(filename)}`
    : pathToFileURL(path.join(directory, filename)).href;
}

export async function createEncryptedArtifactPackage({
  artifact_path,
  output_directory,
  metadata,
  recipient_public_keys,
  signing_private_key_pem,
  signing_public_key_pem,
  chunk_bytes = 64 * 1024 * 1024,
  chunk_base_url = ''
}) {
  const artifactPath = path.resolve(artifact_path);
  const outputDirectory = path.resolve(output_directory);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Artifact package metadata must be an object.');
  if (!Array.isArray(recipient_public_keys) || !recipient_public_keys.length) throw new Error('At least one recipient public key is required.');
  const chunkBytes = assertInteger(Number(chunk_bytes), 'chunk_bytes', 1);
  if (chunkBytes > MAX_CHUNK_BYTES) throw new Error(`chunk_bytes may not exceed ${MAX_CHUNK_BYTES}.`);
  const stat = await fs.stat(artifactPath);
  if (!stat.isFile() || stat.size < 1) throw new Error('Artifact path must identify a non-empty regular file.');
  if (metadata.model?.runtime_abi !== ARCHIE_RUNTIME_ABI) throw new Error(`Package metadata must declare runtime ABI ${ARCHIE_RUNTIME_ABI}.`);
  await fs.mkdir(outputDirectory, { recursive: true });

  const artifact = { filename: path.basename(artifactPath), sha256: await hashFile(artifactPath) };
  const manifestLike = { model: metadata.model, artifact };
  const dataKey = crypto.randomBytes(32);
  const chunks = [];
  let downloadBytes = 0;
  const handle = await fs.open(artifactPath, 'r');
  try {
    let offset = 0;
    let index = 0;
    while (offset < stat.size) {
      const plaintextLength = Math.min(chunkBytes, stat.size - offset);
      const plaintext = Buffer.allocUnsafe(plaintextLength);
      const { bytesRead } = await handle.read(plaintext, 0, plaintextLength, offset);
      if (bytesRead !== plaintextLength) throw new Error(`Artifact read stopped early at chunk ${index}.`);
      const identity = { index, plaintext_bytes: plaintextLength, plaintext_sha256: sha256(plaintext) };
      const aad = chunkAad(manifestLike, identity);
      const nonce = crypto.randomBytes(12);
      const payload = encryptAead(plaintext, dataKey, nonce, aad);
      plaintext.fill(0);
      const filename = `${String(index).padStart(6, '0')}.archie.enc`;
      await fs.writeFile(path.join(outputDirectory, filename), payload, { mode: 0o600 });
      chunks.push(Object.freeze({
        index,
        url: chunkLocation(outputDirectory, filename, chunk_base_url),
        bytes: payload.length,
        sha256: sha256(payload),
        plaintext_bytes: identity.plaintext_bytes,
        plaintext_sha256: identity.plaintext_sha256,
        nonce_base64: nonce.toString('base64'),
        aad_digest: sha256(aad)
      }));
      downloadBytes += payload.length;
      offset += plaintextLength;
      index += 1;
    }

    const recipients = recipient_public_keys.map(input => {
      const recipientPublic = asPublicKey(input, 'x25519');
      const fingerprint = x25519Fingerprint(recipientPublic);
      const ephemeral = crypto.generateKeyPairSync('x25519');
      const salt = crypto.randomBytes(32);
      const nonce = crypto.randomBytes(12);
      const aad = wrapAad(manifestLike, fingerprint);
      const wrappingKey = deriveWrappingKey(ephemeral.privateKey, recipientPublic, salt);
      try {
        return Object.freeze({
          schema: ARCHIE_WRAPPED_DATA_KEY_SCHEMA,
          recipient_fingerprint: fingerprint,
          ephemeral_public_key_pem: publicPem(ephemeral.publicKey),
          salt_base64: salt.toString('base64'),
          nonce_base64: nonce.toString('base64'),
          wrapped_key_base64: encryptAead(dataKey, wrappingKey, nonce, aad).toString('base64'),
          aad_digest: sha256(aad)
        });
      } finally {
        wrappingKey.fill(0);
      }
    }).sort((left, right) => left.recipient_fingerprint.localeCompare(right.recipient_fingerprint));

    const body = {
      schema: ARCHIE_ENCRYPTED_MANIFEST_SCHEMA,
      model: canonical(metadata.model),
      sizes: { download_bytes: downloadBytes, installed_bytes: stat.size },
      artifact,
      chunks,
      hardware: canonical(metadata.hardware),
      provenance: canonical(metadata.provenance),
      state: canonical(metadata.state),
      benchmarks: canonical(metadata.benchmarks),
      runtime: canonical(metadata.runtime),
      encryption: {
        schema: ARCHIE_ARTIFACT_ENVELOPE_SCHEMA,
        content_cipher: 'aes-256-gcm',
        key_wrap: 'x25519-hkdf-sha256-aes-256-gcm',
        recipients
      }
    };
    const manifest = signManifest(body, { private_key_pem: signing_private_key_pem, public_key_pem: signing_public_key_pem });
    validateEncryptedManifestShape(manifest);
    const manifestPath = path.join(outputDirectory, 'manifest.json');
    await writeJSONAtomic(manifestPath, manifest);
    return Object.freeze({ manifest, manifest_path: manifestPath, output_directory: outputDirectory });
  } finally {
    await handle.close();
    dataKey.fill(0);
  }
}

function unwrapDataKey(manifest, privateKeyInputs) {
  if (!Array.isArray(privateKeyInputs) || !privateKeyInputs.length) throw new Error('At least one device or recovery private key is required.');
  for (const input of privateKeyInputs) {
    const privateKey = asPrivateKey(input, 'x25519');
    const publicKey = crypto.createPublicKey(privateKey);
    const fingerprint = x25519Fingerprint(publicKey);
    const recipient = manifest.encryption.recipients.find(item => item.recipient_fingerprint === fingerprint);
    if (!recipient) continue;
    const aad = wrapAad(manifest, fingerprint);
    if (sha256(aad) !== recipient.aad_digest) throw new Error('Wrapped-key authenticated metadata digest mismatch.');
    const wrappingKey = deriveWrappingKey(privateKey, recipient.ephemeral_public_key_pem, decodeBase64(recipient.salt_base64, 'key-wrap salt', 32));
    try {
      const dataKey = decryptAead(
        decodeBase64(recipient.wrapped_key_base64, 'wrapped data key', 48),
        wrappingKey,
        decodeBase64(recipient.nonce_base64, 'key-wrap nonce', 12),
        aad
      );
      if (dataKey.length !== 32) throw new Error('Unwrapped data key has the wrong length.');
      return { data_key: dataKey, recipient_fingerprint: fingerprint };
    } catch (error) {
      throw new Error(`Wrapped data key authentication failed for recipient ${fingerprint}: ${error.message}`);
    } finally {
      wrappingKey.fill(0);
    }
  }
  throw new Error('No wrapped data key matches the supplied device or recovery keys.');
}

async function sourceReadable(source, offset, fetchImpl) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetchImpl(source, { headers: offset ? { Range: `bytes=${offset}-` } : {}, redirect: 'follow' });
    if (!response.ok) throw new Error(`Encrypted chunk download failed with HTTP ${response.status}.`);
    if (offset && response.status !== 206) return { readable: Readable.fromWeb(response.body), resumed: false };
    return { readable: Readable.fromWeb(response.body), resumed: Boolean(offset) };
  }
  const filename = /^file:/i.test(source) ? fileURLToPath(source) : path.resolve(source);
  return { readable: createReadStream(filename, offset ? { start: offset } : undefined), resumed: Boolean(offset) };
}

async function downloadCiphertext(chunk, destination, fetchImpl) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  let existing = 0;
  try { existing = (await fs.stat(destination)).size; } catch {}
  if (existing > chunk.bytes) {
    await fs.rm(destination, { force: true });
    existing = 0;
  }
  let source = await sourceReadable(chunk.url, existing, fetchImpl);
  if (existing && !source.resumed) {
    await fs.rm(destination, { force: true });
    existing = 0;
    source = await sourceReadable(chunk.url, 0, fetchImpl);
  }
  await pipeline(source.readable, createWriteStream(destination, { flags: existing ? 'a' : 'w', mode: 0o600 }));
  const stat = await fs.stat(destination);
  if (stat.size !== chunk.bytes) throw new Error(`Encrypted chunk ${chunk.index} byte mismatch.`);
  const digest = await hashFile(destination);
  if (digest !== chunk.sha256) throw new Error(`Encrypted chunk ${chunk.index} digest mismatch.`);
  return { bytes: stat.size, sha256: digest, resumed_from_bytes: existing };
}

async function decryptChunk(manifest, chunk, encryptedPath, plaintextPath, dataKey) {
  const payload = await fs.readFile(encryptedPath);
  const aad = chunkAad(manifest, chunk);
  if (sha256(aad) !== chunk.aad_digest) throw new Error(`Encrypted chunk ${chunk.index} authenticated metadata mismatch.`);
  let plaintext;
  try {
    plaintext = decryptAead(payload, dataKey, decodeBase64(chunk.nonce_base64, 'chunk nonce', 12), aad);
  } catch (error) {
    throw new Error(`Encrypted chunk ${chunk.index} authentication failed: ${error.message}`);
  }
  try {
    if (plaintext.length !== chunk.plaintext_bytes) throw new Error(`Encrypted chunk ${chunk.index} plaintext byte mismatch.`);
    const digest = sha256(plaintext);
    if (digest !== chunk.plaintext_sha256) throw new Error(`Encrypted chunk ${chunk.index} plaintext digest mismatch.`);
    await fs.writeFile(plaintextPath, plaintext, { mode: 0o600 });
    return { plaintext_bytes: plaintext.length, plaintext_sha256: digest };
  } finally {
    plaintext.fill(0);
    payload.fill(0);
  }
}

function createEncryptedReceipt(observedAt, payload) {
  const body = { schema: ARCHIE_ENCRYPTED_PULL_RECEIPT_SCHEMA, observed_at: observedAt, payload: canonical(payload) };
  return Object.freeze({ ...body, receipt_digest: sha256(body) });
}

export async function pullEncryptedModel(manifestSource, {
  home = resolveArchieHome(),
  trusted_public_keys = [],
  recipient_private_keys = [],
  allow_untrusted = false,
  fetchImpl = globalThis.fetch
} = {}) {
  const manifest = await readJSONSource(manifestSource, fetchImpl);
  const trust = verifyEncryptedManifest(manifest, { trusted_public_keys, allow_untrusted });
  const unwrapped = unwrapDataKey(manifest, recipient_private_keys);
  const staging = path.join(home, 'staging', `encrypted-${manifest.model.id}-${crypto.randomBytes(8).toString('hex')}`);
  const chunkReceipts = [];
  try {
    await fs.mkdir(staging, { recursive: true });
    for (const chunk of manifest.chunks) {
      const encryptedPath = path.join(staging, `${String(chunk.index).padStart(6, '0')}.enc`);
      const plaintextPath = path.join(staging, `${String(chunk.index).padStart(6, '0')}.plain`);
      const transport = await downloadCiphertext(chunk, encryptedPath, fetchImpl);
      const decrypted = await decryptChunk(manifest, chunk, encryptedPath, plaintextPath, unwrapped.data_key);
      chunkReceipts.push({
        index: chunk.index,
        ...transport,
        ...decrypted,
        nonce_digest: sha256(decodeBase64(chunk.nonce_base64, 'chunk nonce', 12)),
        aad_digest: chunk.aad_digest
      });
    }

    const assembled = path.join(staging, manifest.artifact.filename);
    await fs.rm(assembled, { force: true });
    for (const chunk of manifest.chunks) {
      const part = path.join(staging, `${String(chunk.index).padStart(6, '0')}.plain`);
      await pipeline(createReadStream(part), createWriteStream(assembled, { flags: 'a', mode: 0o600 }));
    }
    const assembledStat = await fs.stat(assembled);
    if (assembledStat.size !== manifest.sizes.installed_bytes) throw new Error('Decrypted artifact installed-size mismatch.');
    if (await hashFile(assembled) !== manifest.artifact.sha256) throw new Error('Decrypted artifact digest mismatch.');

    const localSigner = generateArtifactKeyPair('signing');
    const projection = signManifest({
      schema: ARCHIE_MODEL_MANIFEST_SCHEMA,
      model: manifest.model,
      sizes: { download_bytes: manifest.sizes.installed_bytes, installed_bytes: manifest.sizes.installed_bytes },
      artifact: manifest.artifact,
      chunks: [{ index: 0, url: pathToFileURL(assembled).href, bytes: manifest.sizes.installed_bytes, sha256: manifest.artifact.sha256 }],
      hardware: manifest.hardware,
      provenance: { ...manifest.provenance, encrypted_transport_manifest_digest: manifest.manifest_digest },
      state: manifest.state,
      benchmarks: manifest.benchmarks,
      runtime: manifest.runtime,
      installation_projection: {
        schema: 'archie-installation-projection/v1',
        outer_manifest_digest: manifest.manifest_digest,
        envelope_schema: manifest.encryption.schema,
        recipient_fingerprint: unwrapped.recipient_fingerprint
      }
    }, { private_key_pem: localSigner.private_key_pem, public_key_pem: localSigner.public_key_pem });
    const projectionPath = path.join(staging, 'installation-manifest.json');
    await writeJSONAtomic(projectionPath, projection);
    const installed = await pullModel(projectionPath, { home, allow_untrusted: true });
    const directory = path.dirname(installed.artifact_path);
    await writeJSONAtomic(path.join(directory, 'outer-manifest.json'), manifest);
    const receipt = createEncryptedReceipt(installed.receipt.observed_at, {
      model_ref: `${manifest.model.id}@${manifest.model.version}`,
      outer_manifest_digest: trust.manifest_digest,
      installation_manifest_digest: projection.manifest_digest,
      artifact_digest: manifest.artifact.sha256,
      exact_download_bytes: manifest.sizes.download_bytes,
      exact_installed_bytes: manifest.sizes.installed_bytes,
      runtime_abi: manifest.model.runtime_abi,
      envelope: {
        schema: manifest.encryption.schema,
        content_cipher: manifest.encryption.content_cipher,
        key_wrap: manifest.encryption.key_wrap,
        recipient_fingerprint: unwrapped.recipient_fingerprint,
        publisher_key_fingerprint: trust.key_fingerprint,
        publisher_trust: trust.trust
      },
      chunks: chunkReceipts,
      hardware: manifest.hardware,
      provenance: manifest.provenance,
      state: manifest.state,
      benchmarks: manifest.benchmarks,
      installed_path: installed.artifact_path
    });
    await writeJSONAtomic(path.join(directory, 'encrypted-pull-receipt.json'), receipt);
    return Object.freeze({ manifest, installation_manifest: projection, receipt, artifact_path: installed.artifact_path });
  } finally {
    unwrapped.data_key.fill(0);
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function readManifestSchema(source, fetchImpl = globalThis.fetch) {
  return (await readJSONSource(source, fetchImpl))?.schema || null;
}

export async function inspectEncryptedTransport(artifactPath) {
  const directory = path.dirname(path.resolve(artifactPath));
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'outer-manifest.json'), 'utf8'));
    const receipt = JSON.parse(await fs.readFile(path.join(directory, 'encrypted-pull-receipt.json'), 'utf8'));
    const expected = sha256({ schema: receipt.schema, observed_at: receipt.observed_at, payload: receipt.payload });
    if (receipt.schema !== ARCHIE_ENCRYPTED_PULL_RECEIPT_SCHEMA || receipt.receipt_digest !== expected) throw new Error('Encrypted pull receipt integrity failure.');
    verifyEncryptedManifest(manifest, { allow_untrusted: true });
    return Object.freeze({ outer_manifest: manifest, encrypted_pull_receipt: receipt });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
