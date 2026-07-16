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
import { createCheckpointUpdatePackage } from './archie-checkpoint-update.mjs';
import { runArchieSelfHostingSample } from './archie-self-hosting-sample.mjs';
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

async function packageKeys(flags) {
  return {
    recipient_public_keys: await keyFiles(flags, '--recipient-key'),
    signing_private_key_pem: await fs.readFile(path.resolve(requiredFlag(flags, '--signing-private')), 'utf8'),
    signing_public_key_pem: await fs.readFile(path.resolve(requiredFlag(flags, '--signing-public')), 'utf8')
  };
}

function usage() {
  return `Archie local model runtime

Usage:
  archie keygen --type recipient|signing --output-dir <directory>
  archie package <artifact> --metadata <json> --output-dir <directory> \\
    --recipient-key <x25519-public.pem> --signing-private <ed25519-private.pem> \\
    --signing-public <ed25519-public.pem>
  archie checkpoint <parent-id@version> <artifact> --metadata <json> --lineage <json> \\
    --output-dir <directory> --recipient-key <x25519-public.pem> \\
    --signing-private <ed25519-private.pem> --signing-public <ed25519-public.pem>
  archie self-host-sample --base-sha <sha> --branch <branch> [--seed <n>] \\
    [--target-prefix <path>] [--state-path <path>]
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

Checkpoint:
  --lineage <path>          Parent expectations plus training, authority, and evaluation digests.
  The installed parent must match exactly. Model ID, architecture, ABI, format,
  quantization, context limit, runtime template, immutable digest, and mutable-region
  declaration may not change. The version, mutable digest, and benchmark receipt must change.

Self-host sample:
  --root <path>             Repository checkout to modify through Maker. Defaults to cwd.
  --repository <owner/name> Receipt identity. Defaults to Pokitomas/theawesomehexapp.
  --target-prefix <path>    Maker-owned sample path. Defaults to samples/archie-self-hosting-app.
  --state-path <path>       External Maker event state; defaults to the OS temporary directory.
  Sideways generates the deterministic task, Archie emits AIL, and only Maker writes.

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

  if (command === 'self-host-sample') {
    const result = await runArchieSelfHostingSample({
      root: path.resolve(last(flags, '--root', process.cwd())),
      repository: last(flags, '--repository', 'Pokitomas/theawesomehexapp'),
      base_sha: requiredFlag(flags, '--base-sha'),
      branch: requiredFlag(flags, '--branch'),
      seed: integer(flags, '--seed', 0),
      target_prefix: last(flags, '--target-prefix'),
      state_path: last(flags, '--state-path')
    });
    print({
      schema: 'archie-self-hosting-sample-result/v1',
      scenario_id: result.scenario.scenario_id,
      scenario_digest: result.scenario.scenario_digest,
      semantic_digest: result.plan.semantic_digest,
      schedule_digest: result.plan.schedule_digest,
      maker_receipt_digest: result.maker_receipt.receipt_digest,
      trajectory_digest: result.trajectory.trajectory_digest,
      changed_paths: result.maker_receipt.changed_paths,
      state_path: result.state_path,
      trajectory_path: result.trajectory_path,
      human_gates: result.maker_receipt.human_gates
    });
    return;
  }

  if (command === 'package') {
    const artifact = positionals[1];
    if (!artifact) throw new Error('package requires an artifact path.');
    const metadataPath = requiredFlag(flags, '--metadata');
    const metadata = JSON.parse(await fs.readFile(path.resolve(metadataPath), 'utf8'));
    const keys = await packageKeys(flags);
    const result = await createEncryptedArtifactPackage({
      artifact_path: artifact,
      output_directory: requiredFlag(flags, '--output-dir'),
      metadata,
      ...keys,
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

  if (command === 'checkpoint') {
    const parentReference = positionals[1];
    const artifact = positionals[2];
    if (!parentReference || !artifact) throw new Error('checkpoint requires <parent-id@version> and a candidate artifact path.');
    const metadata = JSON.parse(await fs.readFile(path.resolve(requiredFlag(flags, '--metadata')), 'utf8'));
    const lineage = JSON.parse(await fs.readFile(path.resolve(requiredFlag(flags, '--lineage')), 'utf8'));
    const keys = await packageKeys(flags);
    const result = await createCheckpointUpdatePackage({
      parent_reference: parentReference,
      candidate_artifact_path: artifact,
      metadata,
      lineage,
      output_directory: requiredFlag(flags, '--output-dir'),
      ...keys,
      home,
      chunk_bytes: integer(flags, '--chunk-bytes', 64 * 1024 * 1024),
      chunk_base_url: last(flags, '--chunk-base-url')
    });
    print({
      schema: 'archie-checkpoint-package-result/v1',
      manifest_path: result.manifest_path,
      manifest_digest: result.manifest.manifest_digest,
      artifact_digest: result.manifest.artifact.sha256,
      transition_receipt_path: result.transition_receipt_path,
      transition_receipt_digest: result.transition_receipt.receipt_digest,
      parent_model_ref: result.transition_receipt.payload.parent.model_ref,
      candidate_model_ref: result.transition_receipt.payload.candidate.model_ref,
      exact_download_bytes: result.manifest.sizes.download_bytes,
      exact_installed_bytes: result.manifest.sizes.installed_bytes
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
