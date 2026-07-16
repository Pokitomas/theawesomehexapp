#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  ARCHIE_ENCRYPTED_MANIFEST_SCHEMA,
  createEncryptedArtifactPackage,
  inspectEncryptedTransport,
  pullEncryptedModel,
  readManifestSchema,
  writeArtifactKeyPair
} from './archie-artifact-envelope.mjs';
import {
  benchmarkModel,
  inspectModel,
  listModels,
  pullModel,
  removeModel,
  resolveArchieHome,
  runModel
} from './archie-runtime-core.mjs';

function parseArguments(argv) {
  const positionals = [];
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const [name, inline] = value.split('=', 2);
    if (inline !== undefined) {
      const list = flags.get(name) || [];
      list.push(inline);
      flags.set(name, list);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      const list = flags.get(name) || [];
      list.push(next);
      flags.set(name, list);
      index += 1;
    } else {
      flags.set(name, ['true']);
    }
  }
  return { positionals, flags };
}

function last(flags, name, fallback = '') {
  const values = flags.get(name);
  return values?.length ? values[values.length - 1] : fallback;
}

function has(flags, name) {
  return flags.has(name);
}

function integer(flags, name, fallback) {
  const value = last(flags, name, String(fallback));
  if (!/^-?\d+$/.test(value)) throw new Error(`${name} requires an integer.`);
  return Number(value);
}

function number(flags, name, fallback) {
  const value = Number(last(flags, name, String(fallback)));
  if (!Number.isFinite(value)) throw new Error(`${name} requires a finite number.`);
  return value;
}

async function keyFiles(flags, name) {
  const files = flags.get(name) || [];
  return Promise.all(files.map(filename => fs.readFile(path.resolve(filename), 'utf8')));
}

async function trustedKeys(flags) {
  return keyFiles(flags, '--trust-key');
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requiredFlag(flags, name) {
  const value = last(flags, name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function usage() {
  return `Archie local model runtime

Usage:
  archie keygen --type recipient|signing --output-dir <directory>
  archie package <artifact> --metadata <json> --output-dir <directory> \\
    --recipient-key <x25519-public.pem> --signing-private <ed25519-private.pem> \\
    --signing-public <ed25519-public.pem>
  archie pull <manifest> --trust-key <publisher-public.pem> [--device-key <x25519-private.pem>]
  archie run <id@version> --prompt <text> [--runner <path>]
  archie inspect <id@version>
  archie benchmark <id@version> --suite <suite.json> [--runner <path>]
  archie remove <id@version>
  archie list

Packaging:
  --recipient-key <path>    Repeat for device and optional recovery recipients.
  --chunk-bytes <n>         Plaintext bytes per independently authenticated chunk.
  --chunk-base-url <url>    Publishable base URL; local file URLs are used when omitted.

Pull:
  --device-key <path>       Repeat to try device or recovery private keys.
  --trust-key <path>        Repeat for admitted publisher Ed25519 public keys.

Global:
  --home <path>             Override ARCHIE_HOME.
  --allow-untrusted         Verify a self-signature without admitting its key as trusted.

Run:
  --prompt-file <path>      Read the prompt from a file.
  --max-tokens <n>          Default 256.
  --context <n>             Defaults to the manifest context limit.
  --temperature <n>         Default 0.
  --seed <n>                Default 0.
  --timeout-ms <n>          Default 300000.

The runtime never invokes a frontier API. Model-artifact keys are separate from Maker's ephemeral execution HMAC.`;
}

export async function main(argv = process.argv.slice(2)) {
  const { positionals, flags } = parseArguments(argv);
  const command = positionals[0] || (has(flags, '--help') ? 'help' : '');
  const home = path.resolve(last(flags, '--home', resolveArchieHome()));

  if (!command || command === 'help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (command === 'keygen') {
    const type = last(flags, '--type', 'recipient');
    const outputDirectory = requiredFlag(flags, '--output-dir');
    print(await writeArtifactKeyPair(outputDirectory, type));
    return;
  }

  if (command === 'package') {
    const artifact = positionals[1];
    if (!artifact) throw new Error('package requires an artifact path.');
    const metadataPath = requiredFlag(flags, '--metadata');
    const metadata = JSON.parse(await fs.readFile(path.resolve(metadataPath), 'utf8'));
    const recipients = await keyFiles(flags, '--recipient-key');
    const signingPrivate = await fs.readFile(path.resolve(requiredFlag(flags, '--signing-private')), 'utf8');
    const signingPublic = await fs.readFile(path.resolve(requiredFlag(flags, '--signing-public')), 'utf8');
    const result = await createEncryptedArtifactPackage({
      artifact_path: artifact,
      output_directory: requiredFlag(flags, '--output-dir'),
      metadata,
      recipient_public_keys: recipients,
      signing_private_key_pem: signingPrivate,
      signing_public_key_pem: signingPublic,
      chunk_bytes: integer(flags, '--chunk-bytes', 64 * 1024 * 1024),
      chunk_base_url: last(flags, '--chunk-base-url')
    });
    print({
      schema: 'archie-encrypted-package-result/v1',
      manifest_path: result.manifest_path,
      manifest_digest: result.manifest.manifest_digest,
      artifact_digest: result.manifest.artifact.sha256,
      exact_download_bytes: result.manifest.sizes.download_bytes,
      exact_installed_bytes: result.manifest.sizes.installed_bytes,
      chunk_count: result.manifest.chunks.length,
      recipient_fingerprints: result.manifest.encryption.recipients.map(item => item.recipient_fingerprint)
    });
    return;
  }

  if (command === 'pull') {
    const source = positionals[1];
    if (!source) throw new Error('pull requires a manifest source.');
    const schema = await readManifestSchema(source);
    const common = {
      home,
      trusted_public_keys: await trustedKeys(flags),
      allow_untrusted: has(flags, '--allow-untrusted')
    };
    const result = schema === ARCHIE_ENCRYPTED_MANIFEST_SCHEMA
      ? await pullEncryptedModel(source, { ...common, recipient_private_keys: await keyFiles(flags, '--device-key') })
      : await pullModel(source, common);
    print(result.receipt);
    return;
  }

  if (command === 'list') {
    print({ schema: 'archie-model-list/v1', home, models: await listModels({ home }) });
    return;
  }

  const reference = positionals[1];
  if (!reference) throw new Error(`${command} requires a model reference in id@version form.`);

  if (command === 'inspect') {
    const installed = await inspectModel(reference, { home });
    const transport = await inspectEncryptedTransport(installed.artifact_path);
    print({ ...installed, ...(transport ? { encrypted_transport: transport } : {}) });
    return;
  }

  if (command === 'remove') {
    print(await removeModel(reference, { home }));
    return;
  }

  const runner_path = last(flags, '--runner', process.env.ARCHIE_RUNNER || 'llama-cli');
  const runOptions = {
    home,
    runner_path,
    max_tokens: integer(flags, '--max-tokens', 256),
    context: last(flags, '--context') ? integer(flags, '--context', 0) : undefined,
    temperature: number(flags, '--temperature', 0),
    seed: integer(flags, '--seed', 0),
    timeout_ms: integer(flags, '--timeout-ms', 300000)
  };

  if (command === 'run') {
    let prompt = last(flags, '--prompt');
    const promptFile = last(flags, '--prompt-file');
    if (promptFile) prompt = await fs.readFile(path.resolve(promptFile), 'utf8');
    const result = await runModel(reference, { ...runOptions, prompt });
    if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
    if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
    process.stderr.write(`${JSON.stringify(result.receipt)}\n`);
    if (result.code !== 0) process.exitCode = result.code;
    return;
  }

  if (command === 'benchmark') {
    const suite = last(flags, '--suite');
    if (!suite) throw new Error('benchmark requires --suite <path-or-url>.');
    const report = await benchmarkModel(reference, suite, runOptions);
    print(report);
    if (report.summary.failed) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown command: ${command}.`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archie: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
