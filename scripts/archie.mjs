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
  has,
  integer,
  last,
  number,
  parseArguments,
  printJSON,
  requiredFlag
} from './archie-cli-core.mjs';
import { createCheckpointUpdatePackage } from './archie-checkpoint-update.mjs';
import { runResearchCommand } from './archie-research-campaign.mjs';
import { runArchieSelfHostingSample } from './archie-self-hosting-sample.mjs';
import { runArchieFirstRun } from './archie-first-run.mjs';
import { runDistillCommand } from './archie-distill.mjs';
import { runWorkspaceCommand } from './archie-workspace.mjs';
import { runServeCommand } from './archie-serve.mjs';
import {
  benchmarkModel,
  inspectModel,
  listModels,
  pullModel,
  removeModel,
  resolveArchieHome,
  runModel
} from './archie-runtime-core.mjs';

async function keyFiles(flags, name) {
  const files = flags.get(name) || [];
  return Promise.all(files.map(filename => fs.readFile(path.resolve(filename), 'utf8')));
}

async function trustedKeys(flags) {
  return keyFiles(flags, '--trust-key');
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
  archie package <artifact> --metadata <json> --output-dir <directory> \
    --recipient-key <x25519-public.pem> --signing-private <ed25519-private.pem> \
    --signing-public <ed25519-public.pem>
  archie checkpoint <parent-id@version> <artifact> --metadata <json> --lineage <json> \
    --output-dir <directory> --recipient-key <x25519-public.pem> \
    --signing-private <ed25519-private.pem> --signing-public <ed25519-public.pem>
  archie self-host-sample --base-sha <sha> --branch <branch> [--seed <n>] \
    [--target-prefix <path>] [--state-path <path>]
  archie research create <campaign> --base-sha <sha> --credits 100 \
    --evaluation-reserve 20 --allocation <allocation.json>
  archie research materialize --campaign <campaign> [--output <directory>]
  archie research status --campaign <campaign>
  archie serve [--port <n>] [--runner <path>]
  archie workspace <init|list|inspect|command|serve|demo> [flags]
  archie pull <manifest> --trust-key <publisher-public.pem> [--device-key <x25519-private.pem>]
  archie run <id@version> --prompt <text> [--runner <path>]
  archie inspect <id@version>
  archie benchmark <id@version> --suite <suite.json> [--runner <path>]
  archie remove <id@version>
  archie list
  archie setup [--json] [--no-color]
  archie distill <init|doctor|teach|attest-teacher|import-teacher> [flags]

Local chat server:
  serve starts a local chat server at 127.0.0.1:7474 (override with --port).
  Open http://127.0.0.1:7474 in a browser to talk to any installed model.
  --port <n>                Port to listen on. Defaults to 7474.
  --runner <path>           Path to llama-cli. Defaults to ARCHIE_RUNNER or 'llama-cli'.

Native workspace:
  init creates a public, private, or locally sealed provider-neutral workspace.
  serve starts the local anonymous-read workspace service on 127.0.0.1:8787.
  demo executes objective → task → lease → run → review → repair → evidence → promotion → publication → rollback.
  Workspace state lives outside Git under ARCHIE_HOME unless --root is supplied.

Research campaign:
  --root <path>             Repository root. Defaults to cwd.
  --code-digest <sha256>    Explicit code binding; otherwise derived from base SHA and engine contract.
  --split-salt <text>       Defaults to archie-generation-one-hidden-v1.
  --holdout-rate <number>   Defaults to 0.20.
  create freezes policy, allocation, base/code binding, and expected hidden split.
  materialize verifies the student pack and writes twelve discovery manifests plus
  one independent-evaluation manifest without requiring a compute worker.
  status is intentionally non-watching in this tranche and fails closed on drift.

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

  if (!command) {
    await runArchieFirstRun(argv);
    return;
  }

  if (command === 'setup' || command === 'welcome') {
    const commandIndex = argv.indexOf(command);
    await runArchieFirstRun(argv.filter((_, index) => index !== commandIndex));
    return;
  }

  if (command === 'help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (command === 'distill') {
    printJSON(await runDistillCommand({ positionals, flags }));
    return;
  }

  if (command === 'serve') {
    const port = integer(flags, '--port', 7474);
    const runner = last(flags, '--runner', process.env.ARCHIE_RUNNER || 'llama-cli');
    await runServeCommand({ port, host: '127.0.0.1', home, runner_path: runner });
    return;
  }

  if (command === 'workspace') {
    const result = await runWorkspaceCommand({ positionals, flags, home });
    if (result) printJSON(result);
    return;
  }

  if (command === 'research') {
    printJSON(await runResearchCommand({ positionals, flags, root: process.cwd() }));
    return;
  }

  if (command === 'keygen') {
    const type = last(flags, '--type', 'recipient');
    const outputDirectory = requiredFlag(flags, '--output-dir');
    printJSON(await writeArtifactKeyPair(outputDirectory, type));
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
    printJSON({
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
    printJSON({
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
    printJSON({
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
    printJSON(result.receipt);
    return;
  }

  if (command === 'list') {
    printJSON({ schema: 'archie-model-list/v1', home, models: await listModels({ home }) });
    return;
  }

  const reference = positionals[1];
  if (!reference) throw new Error(`${command} requires a model reference in id@version form.`);

  if (command === 'inspect') {
    const installed = await inspectModel(reference, { home });
    const transport = await inspectEncryptedTransport(installed.artifact_path);
    printJSON({ ...installed, ...(transport ? { encrypted_transport: transport } : {}) });
    return;
  }

  if (command === 'remove') {
    printJSON(await removeModel(reference, { home }));
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
    printJSON(report);
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
