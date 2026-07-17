import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ARCHIE_TRAINER_PROPOSAL_SCHEMA,
  createArchiePersistentCore
} from '../maker-archie-persistent-core.mjs';

async function temporaryRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'archie-persistent-'));
}

test('persistent cognition can cycle without a prompt and truthfully choose no-op', async () => {
  const root = await temporaryRoot();
  const clockValues = [Date.UTC(2026, 6, 17, 16, 0, 0), Date.UTC(2026, 6, 17, 16, 0, 1), Date.UTC(2026, 6, 17, 16, 0, 2)];
  const core = createArchiePersistentCore({ root, clock: () => clockValues.shift() ?? Date.UTC(2026, 6, 17, 16, 0, 3) });
  const receipt = await core.cycle({ trigger: 'internal' });
  assert.equal(receipt.selected.candidate.effect_class, 'no-op');
  assert.equal(receipt.disposition, 'no-op');
  assert.equal(receipt.state_revision, 1);
  const state = await core.state();
  assert.equal(state.cycles.length, 1);
  assert.equal(state.observations.length, 0);
  assert.equal('messages' in state, false);
});

test('candidate kinds are open and not limited to a term-based operator list', async () => {
  const root = await temporaryRoot();
  const core = createArchiePersistentCore({
    root,
    candidate_generator: async () => [{
      kind: 'reframe-the-representation-into-a-third-thing',
      effect_class: 'internal',
      description: 'Construct a new representation rather than answer the stimulus.'
    }],
    capacity_estimator: async candidate => ({
      utility: candidate.kind.startsWith('reframe-') ? 3 : -1,
      expected_capacity_gain: 2.4,
      verification_probability: 0.7,
      uncertainty: 0.3,
      estimator: 'fixture-capacity-model'
    })
  });
  const receipt = await core.cycle({ observations: [{ source: 'environment', kind: 'novel-pattern', payload: { value: 7 } }] });
  assert.equal(receipt.selected.candidate.kind, 'reframe-the-representation-into-a-third-thing');
  assert.equal(receipt.disposition, 'retained-in-working-state');
  const state = await core.state();
  assert.equal(state.observations.length, 1);
});

test('external effects fail closed without explicit runtime authority', async () => {
  const root = await temporaryRoot();
  let executed = false;
  const core = createArchiePersistentCore({
    root,
    candidate_generator: async () => [{ kind: 'publish-an-invention', effect_class: 'external' }],
    capacity_estimator: async () => ({ utility: 100, verification_probability: 1, uncertainty: 0, estimator: 'fixture' }),
    executor: async () => { executed = true; }
  });
  const receipt = await core.cycle({ allow_external: false });
  assert.equal(receipt.selected.candidate.effect_class, 'no-op');
  assert.equal(receipt.rejected[0].reason, 'external-effects-disabled');
  assert.equal(executed, false);
});

test('Core can propose training but cannot mutate a durable brain package', async () => {
  const root = await temporaryRoot();
  const core = createArchiePersistentCore({
    root,
    candidate_generator: async () => [{
      kind: 'invent-new-memory-architecture',
      effect_class: 'durable-training',
      proposal: { architecture: { external_memory: true }, evidence_needed: ['controlled-ablation'] }
    }],
    capacity_estimator: async () => ({ utility: 2, expected_capacity_gain: 1.5, verification_probability: 0.4, uncertainty: 0.6, estimator: 'fixture' })
  });
  const receipt = await core.cycle();
  assert.equal(receipt.disposition, 'propose-to-trainer');
  assert.equal(receipt.result.schema, ARCHIE_TRAINER_PROPOSAL_SCHEMA);
  assert.equal(receipt.result.status, 'proposal-only');
  const state = await core.state();
  assert.equal(state.trainer_proposals.length, 1);
});
