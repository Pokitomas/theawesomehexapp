import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArguments } from '../archie-cli-core.mjs';
import {
  ARCHIE_GENERATION_ONE_SPLIT_SALT,
  canonicalJSON,
  createResearchCampaign,
  materializeResearchCampaign,
  normalizeResearchAllocation,
  researchCampaignStatus,
  sha256
} from '../archie-research-campaign.mjs';

const BASE_SHA = '018ff3e425ecaacc66fbbc72ae63ba55bf98d04d';
const CODE_DIGEST = 'a'.repeat(64);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-research-test-'));
  const source = path.join(REPOSITORY_ROOT, 'research', 'archie-generation-one-allocation.json');
  const allocationPath = path.join(root, 'research', 'archie-generation-one-allocation.json');
  await fs.mkdir(path.dirname(allocationPath), { recursive: true });
  await fs.copyFile(source, allocationPath);
  return { root, allocationPath };
}

async function cleanup(value) {
  await fs.rm(value.root, { recursive: true, force: true });
}

function descriptor(name, content) {
  return { name, bytes: Buffer.byteLength(content), rows: content.split(/\r?\n/).filter(Boolean).length, sha256: sha256(content) };
}

async function writeStudentPack(root, { splitSalt = ARCHIE_GENERATION_ONE_SPLIT_SALT } = {}) {
  const data = path.join(root, '.archie', 'campaigns', 'archie-generation-one', 'data');
  await fs.mkdir(data, { recursive: true });
  const contents = {
    train: '{"id":"train"}\n',
    heldout: '{"id":"heldout"}\n',
    negative_train: '{"id":"negative-train"}\n',
    negative_heldout: '{"id":"negative-heldout"}\n'
  };
  const names = {
    train: 'train.jsonl',
    heldout: 'heldout.jsonl',
    negative_train: 'negative-train.jsonl',
    negative_heldout: 'negative-heldout.jsonl'
  };
  for (const [partition, content] of Object.entries(contents)) await fs.writeFile(path.join(data, names[partition]), content);
  const body = {
    schema: 'archie-student-training-pack/v1',
    created_at: '2026-07-16T00:00:00.000Z',
    source: { corpus_root_digest: 'b'.repeat(64), examples: 4, source_groups: 4 },
    split: {
      algorithm: 'sha256-group-threshold/v1',
      holdout_rate: 0.2,
      split_salt_digest: sha256(splitSalt),
      source_groups: []
    },
    prompt_digest: 'c'.repeat(64),
    files: Object.fromEntries(Object.entries(contents).map(([partition, content]) => [partition, descriptor(names[partition], content)])),
    claim_boundary: 'fixture'
  };
  const manifest = { ...body, pack_digest: sha256(body) };
  await fs.writeFile(path.join(data, 'manifest.json'), canonicalJSON(manifest));
  return { data, manifest };
}

async function create(value) {
  return createResearchCampaign({
    root: value.root,
    campaign_id: 'archie-generation-one',
    base_sha: BASE_SHA,
    code_digest: CODE_DIGEST,
    credits: 100,
    evaluation_reserve: 20,
    allocation_path: path.relative(value.root, value.allocationPath)
  });
}

test('shared CLI parser preserves repeated, inline, boolean, and positional arguments', () => {
  const parsed = parseArguments(['research', 'create', 'archie-generation-one', '--credits=100', '--trust-key', 'one.pem', '--trust-key', 'two.pem', '--watch']);
  assert.deepEqual(parsed.positionals, ['research', 'create', 'archie-generation-one']);
  assert.deepEqual(parsed.flags.get('--credits'), ['100']);
  assert.deepEqual(parsed.flags.get('--trust-key'), ['one.pem', 'two.pem']);
  assert.deepEqual(parsed.flags.get('--watch'), ['true']);
});

test('exact allocation and campaign creation are deterministic and idempotent', async t => {
  const value = await fixture();
  t.after(() => cleanup(value));
  const allocation = normalizeResearchAllocation(JSON.parse(await fs.readFile(value.allocationPath, 'utf8')));
  assert.equal(allocation.lanes.length, 12);
  assert.equal(allocation.lanes.reduce((sum, lane) => sum + lane.credits, 0), 80);
  assert.equal(allocation.independent_evaluation.credits, 20);
  const first = await create(value);
  const campaignPath = path.join(first.campaign_directory, 'campaign.json');
  const firstBytes = await fs.readFile(campaignPath);
  const second = await create(value);
  const secondBytes = await fs.readFile(campaignPath);
  assert.deepEqual(secondBytes, firstBytes);
  assert.deepEqual(second.created_paths, []);
  const status = await researchCampaignStatus({ root: value.root, campaign_id: 'archie-generation-one', base_sha: BASE_SHA, code_digest: CODE_DIGEST });
  assert.equal(status.state, 'awaiting-data');
  assert.equal(status.workers_required, false);
});

test('materialization verifies the hidden split and emits twelve lanes plus independent evaluation without workers', async t => {
  const value = await fixture();
  t.after(() => cleanup(value));
  await create(value);
  await writeStudentPack(value.root);
  const first = await materializeResearchCampaign({ root: value.root, campaign_id: 'archie-generation-one', base_sha: BASE_SHA, code_digest: CODE_DIGEST });
  assert.equal(first.discovery_lanes, 12);
  assert.equal(first.independent_evaluation_manifests, 1);
  const names = await fs.readdir(first.output_directory);
  assert.equal(names.filter(name => name.endsWith('.json')).length, 14);
  const before = await Promise.all(names.sort().map(async name => [name, await fs.readFile(path.join(first.output_directory, name), 'utf8')]));
  const second = await materializeResearchCampaign({ root: value.root, campaign_id: 'archie-generation-one', base_sha: BASE_SHA, code_digest: CODE_DIGEST });
  assert.deepEqual(second.created_paths, []);
  const after = await Promise.all(names.sort().map(async name => [name, await fs.readFile(path.join(first.output_directory, name), 'utf8')]));
  assert.deepEqual(after, before);
  const status = await researchCampaignStatus({ root: value.root, campaign_id: 'archie-generation-one', base_sha: BASE_SHA, code_digest: CODE_DIGEST });
  assert.equal(status.state, 'materialized');
  assert.equal(status.discovery_lanes, 12);
  assert.equal(status.independent_evaluation_reserve, 20);
  assert.equal(status.hidden_scores_exposed, false);
});

test('allocation totals, runtime drift, hidden split substitution, and data mutation fail closed', async t => {
  const value = await fixture();
  t.after(() => cleanup(value));
  const raw = JSON.parse(await fs.readFile(value.allocationPath, 'utf8'));
  const invalid = structuredClone(raw);
  invalid.lanes[0].credits += 1;
  assert.throws(() => normalizeResearchAllocation(invalid), /must total 80/);
  await create(value);
  await assert.rejects(
    researchCampaignStatus({ root: value.root, campaign_id: 'archie-generation-one', base_sha: 'f'.repeat(40) }),
    /base SHA drift/
  );
  await assert.rejects(
    researchCampaignStatus({ root: value.root, campaign_id: 'archie-generation-one', base_sha: BASE_SHA, code_digest: 'f'.repeat(64) }),
    /code digest drift/
  );
  await writeStudentPack(value.root, { splitSalt: 'substituted-hidden-split' });
  await assert.rejects(
    materializeResearchCampaign({ root: value.root, campaign_id: 'archie-generation-one', base_sha: BASE_SHA, code_digest: CODE_DIGEST }),
    /hidden split salt drift/
  );
  await fs.rm(path.join(value.root, '.archie', 'campaigns', 'archie-generation-one', 'data'), { recursive: true, force: true });
  const pack = await writeStudentPack(value.root);
  await fs.appendFile(path.join(pack.data, 'heldout.jsonl'), '{"mutated":true}\n');
  await assert.rejects(
    materializeResearchCampaign({ root: value.root, campaign_id: 'archie-generation-one', base_sha: BASE_SHA, code_digest: CODE_DIGEST }),
    /byte drift detected for heldout/
  );
});
